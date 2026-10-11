import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { goalRunPrompt, type GoalService } from '../src/server/goal-tools.js';
import { completion } from './fixtures/model-stream.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Request = Record<string, any>;

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};

function markDone(summary: string) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'done-1',
          type: 'function',
          function: {
            name: 'mark_goal_done',
            arguments: JSON.stringify({ summary }),
          },
        },
      ],
    },
    'tool_calls',
  );
}
const text = (content: string) => completion({ role: 'assistant', content });

function setup(replies: Response[]) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Goal');
  const goals: GoalService = {
    isOpenGoal: (id) => {
      const task = store.task(id);
      return task?.kind === 'goal' && !task.summary;
    },
    complete: (id, summary) => !!store.completeGoal(id, summary),
  };
  const agent = new DotAgent(store, workspace, config, dot.id, { goals });
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply;
  });
  const run = (metadata?: Record<string, unknown>) => {
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      context: [],
      messages: [
        {
          id: 'user',
          role: 'user',
          content: 'Go on.',
          ...(metadata ? { metadata } : {}),
        } as RunAgentInput['messages'][number],
      ],
      tools: [],
      forwardedProps: {},
    };
    return lastValueFrom(agent.run(input).pipe(toArray()));
  };
  return { store, requests, run };
}

const toolNames = (request: Request) =>
  (request.tools ?? []).map((tool: Request) => tool.function?.name);

describe('standing goals', () => {
  it("lets the goal's own turn close it", async () => {
    const { store, requests, run } = setup([
      markDone('The release notes are current.'),
      text('Done: the notes are current, so the goal is closed.'),
    ]);
    const goal = store.createTask('Keep the release notes current', {
      kind: 'goal',
      intervalSeconds: 3600,
    });
    await run({ source: 'task', ref: goal.id });
    expect(toolNames(requests[0])).toContain('mark_goal_done');
    expect(JSON.stringify(requests[0].messages)).toContain('standing goal');
    expect(store.task(goal.id)!.summary).toBe('The release notes are current.');
  });

  it('does not offer the tool in a chat turn or for an ordinary task', async () => {
    const { store, requests, run } = setup([text('Hi.'), text('Done.')]);
    const task = store.createTask('Check the inbox', 3600);
    await run();
    await run({ source: 'task', ref: task.id });
    for (const request of requests)
      expect(toolNames(request)).not.toContain('mark_goal_done');
  });

  it('does not offer the tool once the goal is closed', async () => {
    const { store, requests, run } = setup([text('Nothing left.')]);
    const goal = store.createTask('Ship it', {
      kind: 'goal',
      intervalSeconds: 600,
    });
    store.completeGoal(goal.id, 'Shipped.');
    await run({ source: 'task', ref: goal.id });
    expect(toolNames(requests[0])).not.toContain('mark_goal_done');
  });

  it('numbers each run in the prompt that starts it', () => {
    expect(
      goalRunPrompt({ prompt: 'Triage new issues', runCount: 2, maxRuns: 10 }),
    ).toMatch(/^Standing goal, run 3 of at most 10: Triage new issues/);
    expect(
      goalRunPrompt({ prompt: 'Triage', runCount: 0, maxRuns: null }),
    ).toMatch(/^Standing goal, run 1: Triage/);
  });
});

describe('goal API', () => {
  function app() {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(store, workspace);
    const platform = new Platform(store, workspace, config);
    workspace.bindThread('thread', workspace.dots()[0].id, 'Goals');
    const server = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      platform,
    });
    return { store, server };
  }
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('creates a goal with a check interval and a run limit', async () => {
    const { store, server } = app();
    const response = await server.request(
      '/api/tasks',
      post({
        prompt: 'Keep the changelog current',
        threadId: 'thread',
        kind: 'goal',
        intervalSeconds: 3600,
        maxRuns: 12,
      }),
    );
    expect(response.status).toBe(201);
    expect(store.tasks()[0]).toMatchObject({
      kind: 'goal',
      intervalSeconds: 3600,
      maxRuns: 12,
    });
  });

  it('refuses a goal without a check interval and keeps once tasks single', async () => {
    const { store, server } = app();
    const goal = await server.request(
      '/api/tasks',
      post({ prompt: 'Ship it', threadId: 'thread', kind: 'goal' }),
    );
    expect(goal.status).toBe(400);
    await server.request(
      '/api/tasks',
      post({
        prompt: 'Just once',
        threadId: 'thread',
        kind: 'once',
        intervalSeconds: 60,
      }),
    );
    expect(store.tasks()[0]).toMatchObject({
      kind: 'once',
      intervalSeconds: null,
    });
  });
});
