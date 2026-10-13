// P6 needs-you inbox: the store and routes, ask_owner, the resume it causes, and the result items of
// finished background turns.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { approvalGate, gateParse } from '../src/server/approval-gate.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { ApprovalStore } from '../src/server/approval-store.js';
import { ComputerStore } from '../src/server/computer-store.js';
import { InboxService, excerpt } from '../src/server/inbox-service.js';
import { InboxStore } from '../src/server/inbox-store.js';
import { Platform } from '../src/server/platform.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { createBackgroundRunner } from '../src/server/task-executor.js';
import type { TurnBudget } from '../src/server/turn-budget.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { InboxItem, InboxResponse } from '../src/shared/inbox.js';
import { completion } from './fixtures/model-stream.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Inbox store + service over one database, with a real resume queue whose turn is a mock. */
function services() {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  const inbox = new InboxStore(db);
  const registry = new TurnRegistry({
    openQuestionThreads: () => inbox.openQuestionThreadIds(),
  });
  const turn = vi.fn(
    async (
      _threadId: string,
      _prompt: string,
      _signal: AbortSignal,
      _metadata: { source: string; ref?: string },
    ) => 'Done.',
  );
  const resumeStore = new ResumeStore(db);
  const resumes = new ResumeQueue({
    store: resumeStore,
    registry,
    turn,
    log: () => {},
  });
  const changed = vi.fn();
  const notify = vi.fn(async () => {});
  const service = new InboxService({
    inbox,
    resumes,
    dotName: () => 'Scout',
    changed,
    notify,
    log: () => {},
  });
  return {
    db,
    inbox,
    registry,
    turn,
    resumeStore,
    resumes,
    changed,
    notify,
    service,
  };
}

const ask = (svc: ReturnType<typeof services>, threadId = 'thread') =>
  svc.service.ask({
    dotId: 'dot',
    threadId,
    question: 'Which of the two venues should I book?',
  });

describe('InboxService', () => {
  it('stores one open question per thread and tells the owner once', () => {
    const svc = services();
    const first = ask(svc);
    const again = ask(svc);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({
      kind: 'question',
      title: 'Scout has a question',
      text: 'Which of the two venues should I book?',
      answer: null,
    });
    expect(svc.notify).toHaveBeenCalledTimes(1);
    expect(svc.changed).toHaveBeenCalledTimes(1);
    expect(svc.inbox.counts()).toEqual({ questions: 1, results: 0, unread: 0 });
  });

  it('excludes the thread of an open question from the scheduler until it is answered', async () => {
    const svc = services();
    const question = ask(svc);
    expect(svc.registry.exclusions().threadIds).toContain('thread');
    svc.service.answer(question.id, 'The one by the river.');
    expect(svc.registry.exclusions().threadIds).not.toContain('thread');
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
  });

  it('answering resumes the Dot exactly once, with the answer, in the same thread', async () => {
    const svc = services();
    const question = ask(svc);
    const answered = svc.service.answer(question.id, 'The one by the river.');
    expect(answered).toMatchObject({
      answer: 'The one by the river.',
      answeredAt: expect.any(Number),
      readAt: expect.any(Number),
    });
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    const [threadId, prompt, , metadata] = svc.turn.mock.calls[0];
    expect(threadId).toBe('thread');
    expect(prompt).toContain('The one by the river.');
    expect(metadata).toEqual({ source: 'question', ref: question.id });
    // A second answer and a later archive change nothing and resume nothing.
    expect(() => svc.service.answer(question.id, 'No, the other.')).toThrow(
      'This question is no longer open.',
    );
    svc.service.archive(question.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(svc.turn).toHaveBeenCalledTimes(1);
    expect(svc.resumeStore.all()).toEqual([]);
    expect(svc.inbox.list('question')).toEqual([]);
  });

  it('archiving an open question resumes the Dot once, told there is no answer', async () => {
    const svc = services();
    const question = ask(svc);
    svc.service.archive(question.id);
    expect(svc.registry.exclusions().threadIds).not.toContain('thread');
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    const [, prompt, , metadata] = svc.turn.mock.calls[0];
    expect(prompt).toContain('no answer');
    expect(metadata).toEqual({ source: 'question', ref: question.id });
    svc.service.archive(question.id);
    expect(() => svc.service.answer(question.id, 'Late.')).toThrow(
      'no longer open',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(svc.turn).toHaveBeenCalledTimes(1);
  });

  it('writes a short result, skips one while the thread waits for the owner, and never throws', () => {
    const svc = services();
    const long = 'x'.repeat(2000);
    const result = svc.service.finished({
      dotId: 'dot',
      threadId: 'thread',
      work: 'task',
      text: long,
    });
    expect(result).toMatchObject({
      kind: 'result',
      title: 'Scout finished a scheduled task',
    });
    expect(Array.from(result!.text)).toHaveLength(600);
    expect(result!.text.endsWith('…')).toBe(true);
    expect(excerpt('  short  ')).toBe('short');

    const waiting = new InboxService({
      inbox: svc.inbox,
      resumes: svc.resumes,
      dotName: () => 'Scout',
      waitsForOwner: () => true,
    });
    expect(
      waiting.finished({
        dotId: 'dot',
        threadId: 'other',
        work: 'task',
        text: 'Waiting.',
      }),
    ).toBeUndefined();

    const broken = new InboxService({
      inbox: svc.inbox,
      resumes: svc.resumes,
      dotName: () => 'Scout',
      waitsForOwner: () => {
        throw new Error('boom');
      },
      log: () => {},
    });
    expect(
      broken.finished({ dotId: 'd', threadId: 't', work: 'goal', text: 'x' }),
    ).toBeUndefined();
  });
});

describe('ask_owner in the approval gate', () => {
  function rig(withQuestions = true) {
    const svc = services();
    const approvals = new ApprovalStore(svc.db);
    const approvalService = new ApprovalService({
      approvals,
      resumes: svc.resumes,
      audit: new ComputerStore(svc.db),
      notify: async () => {},
      ttlMs: 60_000,
      log: () => {},
    });
    const budget: TurnBudget = {};
    const { middleware, gate } = approvalGate({
      dotId: 'dot',
      dotName: 'Scout',
      threadId: 'thread',
      source: 'task',
      mode: 'sensitive',
      budget,
      approvals: approvalService,
      handoffs: { start: async () => Promise.reject(new Error('unused')) },
      mcpInfo: () => undefined,
      parse: gateParse,
      ...(withQuestions ? { questions: svc.service } : {}),
    });
    let seq = 0;
    const before = (toolName: string, args: unknown) =>
      middleware.onBeforeToolCall!({} as never, {
        toolCall: {} as never,
        tool: undefined,
        args,
        toolName,
        toolCallId: `call-${++seq}`,
      });
    return { svc, approvals, budget, gate, before };
  }

  it('stores the question, wraps up the turn and unlocks nothing', () => {
    const r = rig();
    const decision = r.before('ask_owner', {
      question: 'Book the river venue?',
    }) as { type: string; result: Record<string, unknown> };
    expect(decision.type).toBe('skip');
    expect(decision.result).toMatchObject({
      status: 'question',
      questionId: expect.any(String),
    });
    expect(r.budget.wrapUp).toBe('question');
    expect(r.gate.paused).toEqual({
      kind: 'question',
      ref: decision.result.questionId,
    });
    expect(r.svc.inbox.list('question')).toHaveLength(1);
    // Nothing was approved: no approval row exists and a sibling tool call is held back.
    expect(r.approvals.list()).toEqual([]);
    const sibling = r.before('computer_exec', { command: 'rm -rf build' }) as {
      type: string;
      result: Record<string, unknown>;
    };
    expect(sibling.result).toEqual({
      paused: 'question pending',
      ref: decision.result.questionId,
    });
  });

  it('rejects an empty question without storing anything', () => {
    const r = rig();
    const decision = r.before('ask_owner', { question: ' ' }) as {
      result: Record<string, unknown>;
    };
    expect(decision.result.error).toBeTruthy();
    expect(r.gate.paused).toBeUndefined();
    expect(r.svc.inbox.list('question')).toEqual([]);
  });

  it('leaves ask_owner alone on a turn that does not offer it', () => {
    const r = rig(false);
    expect(r.before('ask_owner', { question: 'Hello?' })).toBeUndefined();
    expect(r.svc.inbox.list('question')).toEqual([]);
  });
});

/** The real platform, its routes and the background runner, with a scripted model. */
function platformRig(
  replies: Array<() => Response> = [],
  fallback = 'Deliverable.',
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
  });
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const prompts: string[] = [];
  const systems: string[] = [];
  const queue = [...replies];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    prompts.push(
      String(body.messages.findLast((m) => m.role === 'user')?.content),
    );
    systems.push(
      JSON.stringify(body.messages.filter((m) => m.role === 'system')),
    );
    return (
      queue.shift()?.() ?? completion({ role: 'assistant', content: fallback })
    );
  });
  const research = { mode: 'sample' as const, baseUrl: '' };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  const runner = createBackgroundRunner(platform, research);
  const dot = workspace.dots()[0];
  const schedule = (threadId: string, prompt = 'Check the news.') => {
    if (!workspace.conversations().some((item) => item.id === threadId))
      workspace.bindThread(threadId, dot.id, 'Morning news');
    const task = store.createTask(prompt);
    workspace.bindTask(task.id, threadId);
    return task;
  };
  const inbox = async () =>
    (await (await app.request('/api/inbox')).json()) as InboxResponse;
  const post = (path: string, body: unknown = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    store,
    workspace,
    platform,
    app,
    runner,
    dot,
    schedule,
    inbox,
    post,
    prompts,
    systems,
  };
}

const askCall = (question: string) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'ask-1',
          type: 'function',
          function: {
            name: 'ask_owner',
            arguments: JSON.stringify({ question }),
          },
        },
      ],
    },
    'tool_calls',
  );
const say = (content: string) => () =>
  completion({ role: 'assistant', content });

describe('the inbox through the real wiring', () => {
  it('writes one result per finished background turn and none for an owner chat turn', async () => {
    const r = platformRig();
    r.schedule('news');
    await r.runner.tick();
    let listed = await r.inbox();
    expect(listed.results).toHaveLength(1);
    expect(listed.results[0]).toMatchObject({
      threadId: 'news',
      dotId: r.dot.id,
      title: `${r.dot.name} finished a scheduled task`,
      text: 'Deliverable.',
      readAt: null,
    });
    expect(listed.counts).toMatchObject({ results: 1, unread: 1, needsYou: 0 });

    // An owner chat turn in the same thread writes nothing.
    await r.platform.turn('news', 'Thanks!', new AbortController().signal);
    listed = await r.inbox();
    expect(listed.results).toHaveLength(1);
    // The background prompt line appears only on background turns.
    expect(r.systems[0]).toContain('ask_owner');
    expect(r.systems[1]).not.toContain('ask_owner');
  });

  it('asks the owner from a background turn, waits, and resumes once with the answer', async () => {
    const r = platformRig([
      () => askCall('Which venue should I book?'),
      say('I asked which venue to book and will continue once you answer.'),
      say('Booked the river venue.'),
    ]);
    const changes = vi.fn();
    r.platform.events.subscribe('inbox.changed', changes);
    r.schedule('venue', 'Book a venue for the party.');
    await r.runner.tick();
    let listed = await r.inbox();
    expect(listed.questions).toHaveLength(1);
    const [question] = listed.questions;
    expect(question).toMatchObject({
      title: `${r.dot.name} has a question`,
      text: 'Which venue should I book?',
    });
    // The turn ended waiting: no result yet, no approval, and the thread is held from the scheduler.
    expect(listed.results).toEqual([]);
    expect(listed.approvals).toEqual([]);
    expect(listed.counts.needsYou).toBe(1);
    expect(r.workspace.approvals.list()).toEqual([]);
    expect(r.platform.turns.exclusions().threadIds).toContain('venue');
    expect(changes).toHaveBeenCalled();

    const response = await r.post(`/api/inbox/${question.id}/answer`, {
      text: 'The river one.',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: 'The river one.' });
    await vi.waitFor(() => expect(r.workspace.resumes.all()).toEqual([]));
    await vi.waitFor(async () =>
      expect((await r.inbox()).results).toHaveLength(1),
    );
    expect(r.prompts).toHaveLength(3);
    expect(r.prompts[2]).toContain('The river one.');
    listed = await r.inbox();
    expect(listed.questions).toEqual([]);
    expect(listed.results[0]).toMatchObject({
      title: `${r.dot.name} continued after your answer`,
      text: 'Booked the river venue.',
    });
    expect(r.platform.turns.exclusions().threadIds).not.toContain('venue');
    // The stored resume message carries the new source.
    const resumed = r.platform.runner
      .getThreadMessages('venue')
      .find(
        (message) =>
          message.role === 'user' &&
          String(message.content).includes('The river one.'),
      );
    expect(resumed).toMatchObject({
      metadata: { source: 'question', ref: question.id },
    });

    // A second answer is refused.
    const again = await r.post(`/api/inbox/${question.id}/answer`, {
      text: 'Other one.',
    });
    expect(again.status).toBe(409);
  });

  it('archiving an open question resumes once with "no answer"', async () => {
    const r = platformRig([
      () => askCall('Morning or evening?'),
      say('Waiting for your answer.'),
      say('Going with the morning.'),
    ]);
    r.schedule('slot');
    await r.runner.tick();
    const [question] = (await r.inbox()).questions;
    const response = await r.post(`/api/inbox/${question.id}/archive`);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(r.prompts).toHaveLength(3));
    expect(r.prompts[2]).toContain('no answer');
    await vi.waitFor(() => expect(r.workspace.resumes.all()).toEqual([]));
    await r.post(`/api/inbox/${question.id}/archive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.prompts).toHaveLength(3);
  });

  it('counts, reads and archives through the routes', async () => {
    const r = platformRig();
    r.workspace.bindThread('t1', r.dot.id, 'One');
    r.workspace.approvals.create({
      threadId: 't1',
      dotId: r.dot.id,
      toolCallId: 'c1',
      tool: 'computer_exec',
      argsHash: 'h',
      summary: 'Run a command',
      argsRedacted: 'ls',
      ttlMs: 60_000,
    });
    r.workspace.handoffs.create({
      dotId: r.dot.id,
      threadId: 't1',
      kind: 'credential',
      reason: 'Sign in',
    });
    r.platform.inbox.ask({ dotId: r.dot.id, threadId: 't1', question: 'Q?' });
    const result = r.platform.inbox.finished({
      dotId: r.dot.id,
      threadId: 't2',
      work: 'trigger',
      text: 'Handled.',
    }) as InboxItem;
    expect(result).toBeTruthy();
    let listed = await r.inbox();
    expect(listed.counts).toEqual({
      approvals: 1,
      handoffs: 1,
      questions: 1,
      results: 1,
      unread: 1,
      needsYou: 3,
    });

    expect((await r.post(`/api/inbox/${result.id}/read`)).status).toBe(200);
    expect((await r.inbox()).counts.unread).toBe(0);
    expect((await r.post(`/api/inbox/${result.id}/archive`)).status).toBe(200);
    listed = await r.inbox();
    expect(listed.results).toEqual([]);
    expect(listed.counts.results).toBe(0);

    expect((await r.post('/api/inbox/missing/read')).status).toBe(404);
    expect(
      (await r.post(`/api/inbox/${result.id}/answer`, { text: 'Hi' })).status,
    ).toBe(409);
    const [question] = listed.questions;
    expect(
      (await r.post(`/api/inbox/${question.id}/answer`, { text: '  ' })).status,
    ).toBe(400);
    expect(
      (
        await r.post(`/api/inbox/${question.id}/answer`, {
          text: 'x'.repeat(4001),
        })
      ).status,
    ).toBe(400);
  });

  it('gives the lead one result for its teammates and none for the teammates', async () => {
    const r = platformRig();
    const space = r.workspace.spaces()[0].id;
    const scout = r.workspace.createDot(
      space,
      'Scout',
      'Research.',
      true,
      true,
    );
    r.workspace.team.setDelegates(r.dot.id, [scout.id]);
    r.workspace.bindThread('lead-thread', r.dot.id, 'Launch');
    await r.platform.start();
    r.platform.team.delegate({
      fromDotId: r.dot.id,
      threadId: 'lead-thread',
      to: 'Scout',
      brief: 'Find three venues.',
      deliverable: 'A list.',
      runId: 'lead-run',
    });
    await r.runner.tick();
    await vi.waitFor(() => expect(r.workspace.resumes.all()).toEqual([]));
    await vi.waitFor(async () =>
      expect((await r.inbox()).results).toHaveLength(1),
    );
    const [result] = (await r.inbox()).results;
    expect(result).toMatchObject({
      threadId: 'lead-thread',
      dotId: r.dot.id,
      title: `${r.dot.name} finished with its teammates’ results`,
    });
  });
});
