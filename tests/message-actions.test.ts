// P9 message actions on the server: branching (history copy across the runner and workspace
// databases), edit = branch at the message before, pins.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, from, lastValueFrom, toArray } from 'rxjs';
import {
  AbstractAgent,
  verifyEvents,
  type BaseEvent,
  type Message,
} from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { runThreadTurn } from '../src/server/headless.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import {
  BranchPointError,
  LEFT_IN_SOURCE,
  branchConversation,
} from '../src/server/thread-branch.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { branchPointBefore } from '../src/client/message-actions/retries.js';

const PENDING = JSON.stringify({
  status: 'pending_approval',
  approvalId: 'approval-1',
  summary: 'Send the email',
  exact: '{}',
});

/** Replies "Reply N"; with `ask`, first calls a tool whose result asks the owner for approval. */
class ReplyAgent extends AbstractAgent {
  constructor(
    agentId: string,
    private reply: string,
    private ask = false,
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
      if (this.ask)
        events.push(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: `call-${input.runId}`,
            toolCallName: 'request_approval',
            parentMessageId: `ask-${input.runId}`,
          },
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: `call-${input.runId}`,
            delta: '{}',
          },
          { type: EventType.TOOL_CALL_END, toolCallId: `call-${input.runId}` },
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `result-${input.runId}`,
            toolCallId: `call-${input.runId}`,
            content: PENDING,
            role: 'tool',
          },
        );
      events.push(
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: this.reply,
        },
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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A runner and a workspace on one file (two handles, as in the app) and a reader for checks. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-branch-'));
  const path = join(dir, 'fulldots.sqlite');
  const runner = new SqliteAgentRunner(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const reader = new DatabaseSync(path);
  cleanups.push(() => {
    reader.close();
    runner.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const dot = workspace.dots()[0];
  return { path, runner, workspace, reader, dot };
}

type Setup = ReturnType<typeof setup>;

/** Three owner turns in "source": Q1/Reply 1, Q2/Reply 2 (asks for approval), Q3/Reply 3. */
async function seed({ runner, workspace, dot }: Setup) {
  workspace.bindThread('source', dot.id, 'Trip plan');
  for (const [prompt, reply, ask] of [
    ['Q1', 'Reply 1', false],
    ['Q2', 'Reply 2', true],
    ['Q3', 'Reply 3', false],
  ] as const)
    await runThreadTurn(
      runner,
      new ReplyAgent(dot.id, reply, ask),
      'source',
      prompt,
      new AbortController().signal,
    );
  return runner.getThreadMessages('source');
}

const text = (messages: Message[]) =>
  messages.map((message) =>
    typeof message.content === 'string' ? message.content : '',
  );

function snapshot({ runner, reader }: Setup, threadId: string) {
  return {
    runs: reader
      .prepare(
        'SELECT runId, events FROM chat_runs WHERE threadId=? ORDER BY id',
      )
      .all(threadId),
    messages: runner.getThreadMessages(threadId),
    authors: runner.authors(threadId),
  };
}

const replay = (runner: SqliteAgentRunner, threadId: string) =>
  lastValueFrom(runner.connect({ threadId }).pipe(toArray()));

describe('branch', () => {
  it('holds exactly the history up to a reply, readable through connect()', async () => {
    const env = setup();
    const messages = await seed(env);
    const reply2 = messages.find((message) => message.content === 'Reply 2')!;
    const before = snapshot(env, 'source');

    const branch = branchConversation(env, 'source', reply2.id);

    expect(branch).toMatchObject({
      dotId: env.dot.id,
      title: 'Branch of Trip plan',
      branchedFrom: { threadId: 'source', messageId: reply2.id },
    });
    const kept = env.runner.getThreadMessages(branch.id);
    expect(text(kept)).toEqual([
      'Q1',
      'Reply 1',
      'Q2',
      '',
      LEFT_IN_SOURCE,
      'Reply 2',
    ]);
    // Message ids are kept.
    expect(kept.map((message) => message.id)).toEqual(
      messages.slice(0, kept.length).map((message) => message.id),
    );
    // The source is unchanged.
    expect(snapshot(env, 'source')).toEqual(before);

    const events = await replay(env.runner, branch.id);
    // A valid event stream: verifyEvents throws on a broken run sequence.
    await lastValueFrom(from(events).pipe(verifyEvents(false), toArray()));
    const runIds = env.reader
      .prepare('SELECT runId FROM chat_runs WHERE threadId=?')
      .all(branch.id)
      .map((row) => String(row.runId));
    const sourceRunIds = before.runs.map((row) => String(row.runId));
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    expect(runIds.some((id) => sourceRunIds.includes(id))).toBe(false);
    for (const event of events as (BaseEvent & Record<string, unknown>)[]) {
      if (typeof event.threadId === 'string')
        expect(event.threadId).toBe(branch.id);
      if (typeof event.runId === 'string')
        expect(runIds).toContain(event.runId);
    }
    const replies = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_START)
      .map((event) => (event as BaseEvent & { messageId: string }).messageId);
    expect(replies).toEqual(
      messages
        .filter((message) =>
          ['Reply 1', 'Reply 2'].includes(String(message.content)),
        )
        .map((message) => message.id),
    );
    // No duplicate run ids anywhere, and a new turn in the branch runs on the copied history.
    const total = env.reader
      .prepare(
        'SELECT COUNT(*) AS n, COUNT(DISTINCT runId) AS d FROM chat_runs',
      )
      .get();
    expect(total?.n).toBe(total?.d);
    await runThreadTurn(
      env.runner,
      new ReplyAgent(env.dot.id, 'Branch reply'),
      branch.id,
      'Q3 again',
      new AbortController().signal,
    );
    expect(text(env.runner.getThreadMessages(branch.id)).slice(-2)).toEqual([
      'Q3 again',
      'Branch reply',
    ]);
    expect(text(env.runner.getThreadMessages('source')).at(-1)).toBe('Reply 3');
  });

  it('cuts at an owner message: the reply to it is not copied', async () => {
    const env = setup();
    const messages = await seed(env);
    const q3 = messages.find((message) => message.content === 'Q3')!;
    const branch = branchConversation(env, 'source', q3.id);
    expect(text(env.runner.getThreadMessages(branch.id)).slice(-2)).toEqual([
      'Reply 2',
      'Q3',
    ]);
    const events = await replay(env.runner, branch.id);
    await lastValueFrom(from(events).pipe(verifyEvents(false), toArray()));
    expect(JSON.stringify(events)).not.toContain('Reply 3');
    expect(JSON.stringify(events)).toContain('Q3');
  });

  it('never copies approvals: rows stay with the source and the card is replaced', async () => {
    const env = setup();
    const messages = await seed(env);
    env.workspace.approvals.create({
      threadId: 'source',
      dotId: env.dot.id,
      toolCallId: 'call-x',
      tool: 'request_approval',
      argsHash: null,
      summary: 'Send the email',
      argsRedacted: '{}',
      ttlMs: 60_000,
    });
    const branch = branchConversation(env, 'source', messages.at(-1)!.id);
    expect(env.workspace.approvals.list({ threadId: 'source' })).toHaveLength(
      1,
    );
    expect(env.workspace.approvals.list({ threadId: branch.id })).toEqual([]);
    expect(env.workspace.approvals.pendingThreadIds()).not.toContain(branch.id);
    const copied = JSON.stringify(snapshot(env, branch.id));
    expect(copied).not.toContain('pending_approval');
    expect(JSON.stringify(snapshot(env, 'source'))).toContain(
      'pending_approval',
    );
  });

  it('copies the authors of the kept messages', async () => {
    const env = setup();
    const messages = await seed(env);
    const reply1 = messages.find((message) => message.content === 'Reply 1')!;
    const branch = branchConversation(env, 'source', reply1.id);
    expect(env.runner.authors(branch.id)).toEqual({ [reply1.id]: env.dot.id });
  });

  it('copies participants when the group chat table exists', async () => {
    const env = setup();
    await seed(env);
    env.reader.exec(
      'CREATE TABLE IF NOT EXISTS thread_participants(threadId TEXT NOT NULL, dotId TEXT NOT NULL, addedAt INTEGER NOT NULL, PRIMARY KEY(threadId, dotId))',
    );
    env.reader
      .prepare('INSERT INTO thread_participants VALUES (?, ?, ?)')
      .run('source', 'dot-guest', 5);
    const branch = branchConversation(env, 'source', null);
    expect(
      env.reader
        .prepare(
          'SELECT dotId, addedAt FROM thread_participants WHERE threadId=?',
        )
        .all(branch.id),
    ).toEqual([{ dotId: 'dot-guest', addedAt: 5 }]);
  });

  it('a failed binding leaves no copied runs behind', async () => {
    const env = setup();
    const messages = await seed(env);
    vi.spyOn(env.workspace, 'bindBranch').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      branchConversation(env, 'source', messages.at(-1)!.id),
    ).toThrow('disk full');
    for (const table of ['chat_runs', 'chat_threads', 'thread_authors'])
      expect(
        env.reader
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE threadId<>?`)
          .get('source')?.n,
        table,
      ).toBe(0);
    expect(env.workspace.conversations().map((item) => item.id)).toEqual([
      'source',
    ]);
  });

  it('refuses a message that is not in the stored history', async () => {
    const env = setup();
    await seed(env);
    expect(() => branchConversation(env, 'source', 'nope')).toThrow(
      BranchPointError,
    );
    expect(env.workspace.conversations()).toHaveLength(1);
  });

  it('edit branches at the message before, so the edited version is never copied', async () => {
    const env = setup();
    const messages = await seed(env);
    const q2 = messages.find((message) => message.content === 'Q2')!;
    const at = branchPointBefore(messages, q2.id);
    expect(at).toBe(messages.find((m) => m.content === 'Reply 1')!.id);
    const branch = branchConversation(env, 'source', at);
    expect(text(env.runner.getThreadMessages(branch.id))).toEqual([
      'Q1',
      'Reply 1',
    ]);
    // Editing the first message starts an empty branch.
    expect(branchPointBefore(messages, messages[0].id)).toBeNull();
    const empty = branchConversation(env, 'source', null);
    expect(env.runner.getThreadMessages(empty.id)).toEqual([]);
    expect(empty.branchedFrom).toEqual({ threadId: 'source', messageId: null });
  });
});

describe('routes', () => {
  function app() {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-actions-'));
    const path = join(dir, 'fulldots.sqlite');
    const store = new Store(path);
    const workspace = new WorkspaceStore(path, 'owner');
    const platform = new Platform(
      store,
      workspace,
      { baseUrl: 'https://unused.invalid/v1', voiceName: 'marin' },
      path,
    );
    cleanups.push(async () => {
      await platform.stop();
      store.close();
      workspace.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    const research = { mode: 'sample' as const, baseUrl: '' };
    const http = createApp({
      store,
      runner: new Runner(store, research),
      config: research,
      platform,
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await http.request(`/api${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    return { platform, workspace, call, dot: workspace.dots()[0] };
  }

  it('pins: add, list, remove; only stored messages; a pinned chat is linked', async () => {
    const { platform, workspace, call, dot } = app();
    workspace.bindThread('chat', dot.id, 'Chat');
    await runThreadTurn(
      platform.runner,
      new ReplyAgent(dot.id, 'Hello'),
      'chat',
      'Hi',
      new AbortController().signal,
    );
    const [question, answer] = platform.runner.getThreadMessages('chat');
    expect((await call('GET', '/conversations/chat/pins')).body).toEqual({
      pins: [],
    });
    const added = await call('POST', `/conversations/chat/pins/${answer.id}`);
    expect(added.status).toBe(201);
    expect(added.body.pins).toEqual([
      { messageId: answer.id, createdAt: expect.any(Number) },
    ]);
    // Pinning twice keeps one pin.
    await call('POST', `/conversations/chat/pins/${answer.id}`);
    await call('POST', `/conversations/chat/pins/${question.id}`);
    expect(
      (await call('GET', '/conversations/chat/pins')).body.pins.map(
        (pin: { messageId: string }) => pin.messageId,
      ),
    ).toEqual([answer.id, question.id]);
    expect(workspace.linkedThreadIds().has('chat')).toBe(true);
    expect(
      (await call('POST', '/conversations/chat/pins/not-a-message')).status,
    ).toBe(404);
    expect((await call('GET', '/conversations/missing/pins')).status).toBe(404);
    const removed = await call(
      'DELETE',
      `/conversations/chat/pins/${answer.id}`,
    );
    expect(
      removed.body.pins.map((pin: { messageId: string }) => pin.messageId),
    ).toEqual([question.id]);
  });

  it('a pinned conversation counts as non-empty', () => {
    const { workspace, dot } = app();
    workspace.bindThread('quiet', dot.id, 'Quiet');
    expect(workspace.linkedThreadIds().has('quiet')).toBe(false);
    workspace.pins.pin('quiet', 'message-1');
    expect(workspace.linkedThreadIds().has('quiet')).toBe(true);
  });

  it('POST /conversations/:id/branch returns the new conversation, listed with its source', async () => {
    const { platform, workspace, call, dot } = app();
    workspace.bindThread('chat', dot.id, 'Chat');
    await runThreadTurn(
      platform.runner,
      new ReplyAgent(dot.id, 'Hello'),
      'chat',
      'Hi',
      new AbortController().signal,
    );
    const [, answer] = platform.runner.getThreadMessages('chat');
    const created = await call('POST', '/conversations/chat/branch', {
      atMessageId: answer.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Branch of Chat',
      dotId: dot.id,
      branchedFrom: { threadId: 'chat', messageId: answer.id },
    });
    const listed = (await call('GET', '/workspace')).body.conversations.find(
      (item: { id: string }) => item.id === created.body.id,
    );
    expect(listed).toMatchObject({
      branchedFrom: { threadId: 'chat', messageId: answer.id },
      empty: false,
    });
    expect(
      (await call('POST', '/conversations/chat/branch', { atMessageId: 'x' }))
        .status,
    ).toBe(400);
    expect((await call('POST', '/conversations/chat/branch', {})).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', '/conversations/missing/branch', {
          atMessageId: answer.id,
        })
      ).status,
    ).toBe(404);
  });
});
