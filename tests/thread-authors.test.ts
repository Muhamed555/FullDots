// thread_authors: which Dot wrote which assistant message, written with each stored run.
import { afterEach, describe, expect, it } from 'vitest';
import { Observable } from 'rxjs';
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { runThreadTurn } from '../src/server/headless.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

/** Replies with one text message and, optionally, one tool call message. */
class ReplyAgent extends AbstractAgent {
  constructor(
    agentId: string,
    private withToolCall = false,
  ) {
    super({ agentId });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `reply-${input.runId}`;
      const events: Record<string, unknown>[] = [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ];
      if (this.withToolCall)
        events.push(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: `call-${input.runId}`,
            toolCallName: 'look',
            parentMessageId: `tool-${input.runId}`,
          },
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: `call-${input.runId}`,
            delta: '{}',
          },
          { type: EventType.TOOL_CALL_END, toolCallId: `call-${input.runId}` },
        );
      events.push(
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Done.' },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      );
      for (const event of events)
        subscriber.next(event as unknown as BaseEvent);
      subscriber.complete();
    });
  }
}

const turn = (
  runner: SqliteAgentRunner,
  agent: AbstractAgent,
  threadId: string,
) =>
  runThreadTurn(runner, agent, threadId, 'Go.', new AbortController().signal);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('thread_authors', () => {
  it('records the Dot of every assistant message each stored run produced', async () => {
    const runner = new SqliteAgentRunner(':memory:');
    cleanups.push(() => runner.close());
    await turn(runner, new ReplyAgent('dot-1', true), 'thread');
    await turn(runner, new ReplyAgent('dot-2'), 'thread');
    const messages = runner.getThreadMessages('thread');
    const assistant = messages.filter(
      (message) => message.role === 'assistant',
    );
    expect(assistant.length).toBeGreaterThanOrEqual(3);
    const authors = runner.authors('thread');
    // Every assistant message is attributed, user messages are not.
    expect(Object.keys(authors).sort()).toEqual(
      assistant.map((message) => message.id).sort(),
    );
    for (const message of messages.filter((item) => item.role === 'user'))
      expect(authors[message.id]).toBeUndefined();
    const second = Object.entries(authors).filter(([, dot]) => dot === 'dot-2');
    expect(second).toHaveLength(1);
    expect(second[0][0]).toMatch(/^reply-/);
    expect(
      Object.values(authors).filter((dot) => dot === 'dot-1'),
    ).toHaveLength(assistant.length - 1);
    expect(runner.authors('other-thread')).toEqual({});
  });

  it('removes the rows with the thread', async () => {
    const runner = new SqliteAgentRunner(':memory:');
    cleanups.push(() => runner.close());
    await turn(runner, new ReplyAgent('dot-1'), 'drop');
    await turn(runner, new ReplyAgent('dot-1'), 'keep');
    runner.deleteThread('drop');
    expect(runner.authors('drop')).toEqual({});
    expect(Object.keys(runner.authors('keep'))).toHaveLength(1);
    runner.clearThreads();
    expect(runner.authors('keep')).toEqual({});
  });

  it('GET /api/conversations/:id/authors returns them for an owned conversation', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const platform = new Platform(store, workspace, {
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
    });
    cleanups.push(async () => {
      await platform.stop();
      store.close();
      workspace.close();
    });
    const research = { mode: 'sample' as const, baseUrl: '' };
    const app = createApp({
      store,
      runner: new Runner(store, research),
      config: research,
      platform,
    });
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Authors');
    await turn(platform.runner, new ReplyAgent(dot.id), 'thread');
    const response = await app.request('/api/conversations/thread/authors');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authors: Record<string, string> };
    expect(Object.values(body.authors)).toEqual([dot.id]);
    expect(body).toEqual({ authors: platform.runner.authors('thread') });
    expect(
      (await app.request('/api/conversations/not-mine/authors')).status,
    ).toBe(404);
  });
});
