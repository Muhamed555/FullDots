import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore, usageDay } from '../src/server/usage-store.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { completion } from './fixtures/model-stream.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 11, 12);

describe('usage store', () => {
  it('adds turns per Dot and UTC day', () => {
    const usage = new UsageStore(new DatabaseSync(':memory:'));
    expect(usage.record('scout', { input: 100, output: 20 }, NOON)).toBe(120);
    expect(usage.record('scout', { input: 50, output: 5 }, NOON + 1000)).toBe(
      175,
    );
    expect(usage.record('scout', null, NOON + 2000)).toBe(175);
    usage.record('scout', { input: 10, output: 0 }, NOON + DAY);
    usage.record('builder', { input: 7, output: 3 }, NOON);
    const summary = usage.summary('scout', NOON + DAY);
    expect(summary.today).toBe(10);
    expect(summary.month).toBe(185);
    expect(summary.days.map((day) => day.day)).toEqual([
      usageDay(NOON + DAY),
      usageDay(NOON),
    ]);
    expect(summary.days[1]).toMatchObject({
      inputTokens: 150,
      outputTokens: 25,
      turns: 3,
      unreportedTurns: 1,
    });
  });

  it('warns once per Dot and day', () => {
    const usage = new UsageStore(new DatabaseSync(':memory:'));
    usage.record('scout', { input: 1, output: 1 }, NOON);
    expect(usage.claimWarning('scout', NOON)).toBe(true);
    expect(usage.claimWarning('scout', NOON + 1000)).toBe(false);
    usage.record('scout', { input: 1, output: 1 }, NOON + DAY);
    expect(usage.claimWarning('scout', NOON + DAY)).toBe(true);
  });

  it('lists Dots over their daily budget, today only', () => {
    const usage = new UsageStore(new DatabaseSync(':memory:'));
    usage.setBudget('scout', 1000);
    usage.setBudget('builder', 1000);
    usage.record('scout', { input: 900, output: 100 }, NOON);
    usage.record('builder', { input: 10, output: 10 }, NOON);
    usage.record('herald', { input: 99_999, output: 0 }, NOON);
    expect(usage.overBudgetDots(NOON)).toEqual(['scout']);
    expect(usage.overBudgetDots(NOON + DAY)).toEqual([]);
    usage.setBudget('scout', null);
    expect(usage.overBudgetDots(NOON)).toEqual([]);
    expect(usage.budget('scout')).toBeNull();
  });
});

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
  notifyWebhookUrl: 'https://hooks.example/notify',
  dailyTokenWarn: 1000,
};

function platform() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const instance = new Platform(store, workspace, config);
  closers.push(store, workspace);
  return { store, workspace, platform: instance };
}

describe('usage warnings', () => {
  it('notifies once when a Dot passes the warning level', async () => {
    const notified: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      notified.push(JSON.parse(String(init?.body)).title);
      return new Response('{}');
    });
    const { workspace, platform: p } = platform();
    const dot = workspace.dots()[0];
    p.recordUsage(dot.id, { input: 600, output: 0 }, NOON);
    p.recordUsage(dot.id, { input: 600, output: 0 }, NOON + 1);
    p.recordUsage(dot.id, { input: 600, output: 0 }, NOON + 2);
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(notified[0]).toBe(`${dot.name} has used 1,200 tokens today`);
  });

  it('says when the budget is reached, below the warning level', async () => {
    const notified: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      notified.push(JSON.parse(String(init?.body)).title);
      return new Response('{}');
    });
    const { workspace, platform: p } = platform();
    const dot = workspace.dots()[0];
    workspace.usage.setBudget(dot.id, 500);
    p.recordUsage(dot.id, { input: 499, output: 1 }, NOON);
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(notified[0]).toBe(`${dot.name} reached its daily token budget`);
    expect(workspace.usage.overBudgetDots(NOON)).toEqual([dot.id]);
  });
});

describe('usage from turns', () => {
  it('records the tokens a provider reports at the end of a turn', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Usage');
    const recorded: unknown[] = [];
    const agent = new DotAgent(store, workspace, config, dot.id, {
      usage: (dotId, tokens) => recorded.push({ dotId, tokens }),
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Hi.' }, 'stop', {
          prompt_tokens: 120,
          completion_tokens: 30,
        }),
      )
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Again.' }),
      );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      context: [],
      messages: [{ id: 'u', role: 'user', content: 'Hello' }],
      tools: [],
      forwardedProps: {},
    };
    await lastValueFrom(agent.run(input).pipe(toArray()));
    await lastValueFrom(
      agent.run({ ...input, runId: 'run-2' }).pipe(toArray()),
    );
    expect(recorded).toEqual([
      { dotId: dot.id, tokens: { input: 120, output: 30 } },
      { dotId: dot.id, tokens: null },
    ]);
  });
});

describe('usage API', () => {
  it('lists usage per Dot and sets a budget', async () => {
    const { store, workspace, platform: p } = platform();
    const dot = workspace.dots()[0];
    workspace.usage.record(dot.id, { input: 40, output: 2 });
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      platform: p,
    });
    const listed = await app.request('/api/usage');
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      warnAt: number;
      dots: { dotId: string; today: number }[];
    };
    expect(body.warnAt).toBe(1000);
    expect(body.dots.find((item) => item.dotId === dot.id)!.today).toBe(42);
    const put = (dailyTokens: unknown) =>
      app.request(`/api/usage/${dot.id}/budget`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyTokens }),
      });
    expect((await put(50_000)).status).toBe(200);
    expect(workspace.usage.budget(dot.id)).toBe(50_000);
    expect((await put(5)).status).toBe(400);
    expect((await put(null)).status).toBe(200);
    expect(workspace.usage.budget(dot.id)).toBeNull();
    const missing = await app.request('/api/usage/nope/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyTokens: 5000 }),
    });
    expect(missing.status).toBe(404);
  });
});
