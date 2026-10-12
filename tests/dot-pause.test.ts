import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { TriggerStore } from '../src/server/trigger-store.js';
import { TriggerService } from '../src/server/trigger-service.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function setup() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(store, workspace);
  const platform = new Platform(store, workspace, config);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
    config: { mode: 'sample', baseUrl: '' },
    platform,
  });
  return { store, workspace, platform, app, dot: workspace.dots()[0] };
}

describe('pausing one Dot', () => {
  it('pauses and resumes through the API', async () => {
    const { app, workspace, dot } = setup();
    const paused = await app.request(
      `/api/dots/${dot.id}/pause`,
      json('POST', { paused: true }),
    );
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { paused: boolean }).paused).toBe(true);
    expect(workspace.pausedDotIds()).toEqual([dot.id]);
    await app.request(
      `/api/dots/${dot.id}/pause`,
      json('POST', { paused: false }),
    );
    expect(workspace.dot(dot.id)!.paused).toBe(false);
    expect(
      (
        await app.request(
          '/api/dots/nope/pause',
          json('POST', { paused: true }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/dots/${dot.id}/pause`, json('POST', {}))).status,
    ).toBe(400);
  });

  it('interrupts the background runs of the paused Dot only', async () => {
    const { app, store, workspace, dot } = setup();
    const other = workspace.createDot(
      dot.spaceId,
      'Other',
      'Help.',
      true,
      true,
    );
    workspace.bindThread('mine', dot.id, 'Mine');
    workspace.bindThread('theirs', other.id, 'Theirs');
    const mine = store.createTask('Mine');
    const theirs = store.createTask('Theirs');
    workspace.bindTask(mine.id, 'mine');
    workspace.bindTask(theirs.id, 'theirs');
    store.claim();
    store.claim();
    await app.request(
      `/api/dots/${dot.id}/pause`,
      json('POST', { paused: true }),
    );
    expect(store.task(mine.id)!.status).toBe('interrupted');
    expect(store.task(mine.id)!.error).toContain('the Dot was paused');
    expect(store.task(theirs.id)!.status).toBe('running');
  });

  it('refuses a turn with a clear reason', async () => {
    const { store, workspace, dot } = setup();
    workspace.bindThread('thread', dot.id, 'Chat');
    workspace.setDotPaused(dot.id, true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const agent = new DotAgent(store, workspace, config, dot.id);
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      context: [],
      messages: [{ id: 'u', role: 'user', content: 'Hello' }],
      tools: [],
      forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(JSON.stringify(events)).toContain(`${dot.name} is paused`);
    // No model request was made (telemetry is switched off by privacy.ts in the real server).
    expect(
      fetch.mock.calls.filter((c) =>
        String(c[0]).startsWith('https://unused.invalid'),
      ),
    ).toEqual([]);
  });

  it('defers resume turns until the Dot is resumed', async () => {
    const db = new DatabaseSync(':memory:');
    const resumes = new ResumeStore(db);
    let paused = true;
    const turn = vi.fn().mockResolvedValue('done');
    const queue = new ResumeQueue({
      store: resumes,
      registry: new TurnRegistry(),
      turn,
      isPaused: () => paused,
      sweepMs: 3_600_000,
    });
    const marker = resumes.add({
      kind: 'approval',
      refId: 'a1',
      threadId: 't1',
      dotId: 'scout',
      prompt: 'Go on.',
      source: 'approval',
    });
    expect(await queue.attempt(marker.id)).toBe('deferred');
    expect(turn).not.toHaveBeenCalled();
    paused = false;
    expect(await queue.attempt(marker.id)).toBe('delivered');
    queue.stop();
  });

  it('skips polls of a paused Dot', async () => {
    const call = vi.fn();
    const triggers = new TriggerService({
      triggers: new TriggerStore(new DatabaseSync(':memory:'), randomBytes(32)),
      createEventTask: () => 'task',
      connectors: { call, toolsCached: () => [] },
      isPaused: () => true,
    });
    triggers.create({
      dotId: 'scout',
      threadId: 't',
      kind: 'poll',
      name: 'Poll',
      prompt: 'Check.',
      connectorId: 'c',
      tool: 'list',
    });
    await triggers.pollDue(1_000);
    expect(call).not.toHaveBeenCalled();
  });
});
