// P1 "fast hand-offs": batched results, the release gap, the delegation time limit and the
// bookkeeping (titles, startedAt, deliveredAt) the lanes view relies on.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { EventBus } from '../src/server/events.js';
import { defaultLimits } from '../src/server/limits.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import {
  createBackgroundRunner,
  DELEGATION_RUN_MARGIN_MS,
  runTimeouts,
} from '../src/server/task-executor.js';
import { TeamService } from '../src/server/team-service.js';
import { TeamStore } from '../src/server/team-store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A lead with two teammates, a team service and a resume queue over one workspace database. */
function rig(options: { windowMs?: number; path?: string } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(options.path ?? ':memory:', 'owner');
  const space = workspace.spaces()[0].id;
  const lead =
    workspace.dots().find((dot) => dot.name === 'Dot') ?? workspace.dots()[0];
  const dot = (name: string) =>
    workspace.dots().find((item) => item.name === name) ??
    workspace.createDot(space, name, `${name} role.`, true, true);
  const scout = dot('Scout');
  const writer = dot('Writer');
  workspace.team.setDelegates(lead.id, [scout.id, writer.id]);
  if (!workspace.conversations().some((thread) => thread.id === 'lead-thread'))
    workspace.bindThread('lead-thread', lead.id, 'Launch');
  const registry = new TurnRegistry();
  const bus = new EventBus();
  const turn = vi.fn<
    (
      threadId: string,
      prompt: string,
      signal: AbortSignal,
      metadata: { source: string; ref?: string },
    ) => Promise<string>
  >(async () => 'Thanks, noted.');
  const holder: { queue?: ResumeQueue } = {};
  const team = new TeamService({
    workspace,
    store,
    resume: (marker) => void holder.queue!.enqueue(marker),
  });
  const queue = new ResumeQueue({
    store: workspace.resumes,
    registry,
    turn,
    onTurnFinished: (listener) => bus.subscribe('turn.finished', listener),
    batches: team.batches(options.windowMs ?? 60_000),
    sweepMs: 3_600_000, // the sweep never runs in these tests
    log: () => {},
  });
  holder.queue = queue;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queue.stop();
    store.close();
    workspace.close();
  };
  cleanups.push(close);
  const handOff = (to: string, brief: string, runId = 'run-1') =>
    team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to,
      brief,
      deliverable: 'Notes.',
      runId,
    });
  return {
    store,
    workspace,
    team,
    queue,
    registry,
    bus,
    turn,
    lead,
    handOff,
    close,
  };
}

describe('batched hand-off results', () => {
  it('gives the results of one turn back in one resume turn, with a section per teammate', async () => {
    const f = rig();
    f.queue.start();
    const a = f.handOff('Scout', 'Research the market.');
    const b = f.handOff('Writer', 'Draft the launch post.');
    expect(a.batchKey).toBe('lead-thread:run-1');
    expect(b.batchKey).toBe(a.batchKey);
    f.team.completed(a.taskId, 'Three competitors.');
    await flush();
    // The batch waits for Writer.
    expect(f.turn).not.toHaveBeenCalled();
    expect(f.workspace.resumes.all()).toHaveLength(1);
    f.team.completed(b.taskId, 'A short post.');
    await flush();
    await flush();
    expect(f.turn).toHaveBeenCalledTimes(1);
    const [threadId, prompt, , metadata] = f.turn.mock.calls[0];
    expect(threadId).toBe('lead-thread');
    expect(metadata).toEqual({ source: 'delegation', ref: a.id });
    expect(prompt).toContain('(2 results)');
    expect(prompt).toContain('## Scout: done');
    expect(prompt).toContain('Three competitors.');
    expect(prompt).toContain('## Writer: done');
    expect(prompt).toContain('A short post.');
    expect(f.workspace.resumes.all()).toEqual([]);
    for (const id of [a.id, b.id])
      expect(f.workspace.team.get(id)!.deliveredAt).toEqual(expect.any(Number));
  });

  it('reports a failed hand-off in the same turn as the others', async () => {
    const f = rig();
    const a = f.handOff('Scout', 'Research the market.');
    const b = f.handOff('Writer', 'Draft the launch post.');
    f.team.failed(b.taskId, 'Model offline.');
    f.team.completed(a.taskId, 'Three competitors.');
    await flush();
    await flush();
    expect(f.turn).toHaveBeenCalledTimes(1);
    const prompt = f.turn.mock.calls[0][1];
    expect(prompt).toContain('## Writer: could not finish');
    expect(prompt).toContain('Model offline.');
    expect(prompt).toContain('do it yourself or tell the owner');
  });

  it('sends what arrived when the window closes, and a straggler gets its own turn', async () => {
    vi.useFakeTimers();
    const f = rig({ windowMs: 1500 });
    const a = f.handOff('Scout', 'Research the market.');
    const b = f.handOff('Writer', 'Draft the launch post.');
    const c = f.handOff('Scout', 'Check the pricing pages.');
    f.team.completed(a.taskId, 'Three competitors.');
    await vi.advanceTimersByTimeAsync(500);
    f.team.completed(b.taskId, 'A short post.');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.turn).not.toHaveBeenCalled();
    // 1500 ms after the first result: the two that arrived go out together.
    await vi.advanceTimersByTimeAsync(600);
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.turn.mock.calls[0][1]).toContain('(2 results)');
    expect(f.workspace.team.get(c.id)!.deliveredAt).toBeNull();
    f.team.completed(c.taskId, 'Prices listed.');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.turn).toHaveBeenCalledTimes(2);
    const straggler = f.turn.mock.calls[1][1];
    expect(straggler).toContain('Prices listed.');
    expect(straggler).not.toContain('Three competitors.');
    expect(f.workspace.team.get(c.id)!.deliveredAt).toEqual(expect.any(Number));
  });

  it('delivers a batch exactly once after a restart between its two results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-batch-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'fulldots.sqlite');
    const first = rig({ path });
    first.queue.start();
    const a = first.handOff('Scout', 'Research the market.');
    const b = first.handOff('Writer', 'Draft the launch post.');
    first.team.completed(a.taskId, 'Three competitors.');
    await flush();
    expect(first.turn).not.toHaveBeenCalled();
    first.close();

    const second = rig({ path });
    second.queue.start();
    await flush();
    const stored = second.workspace.resumes.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      batchKey: 'lead-thread:run-1',
      firstResultAt: expect.any(Number),
    });
    expect(second.turn).not.toHaveBeenCalled();
    second.team.completed(b.taskId, 'A short post.');
    for (let i = 0; i < 5; i++) await flush();
    expect(second.turn).toHaveBeenCalledTimes(1);
    expect(second.turn.mock.calls[0][1]).toContain('Three competitors.');
    expect(second.turn.mock.calls[0][1]).toContain('A short post.');
    expect(second.workspace.resumes.all()).toEqual([]);
    expect(
      second.workspace.team.inBatch('lead-thread:run-1').map((d) => d.status),
    ).toEqual(['done', 'done']);
  });

  it('keeps a hand-off made outside a run on its own', async () => {
    const f = rig();
    const lone = f.team.delegate({
      fromDotId: f.lead.id,
      threadId: 'lead-thread',
      to: 'Scout',
      brief: 'Research the market.',
      deliverable: 'Notes.',
    });
    expect(lone.batchKey).toBeNull();
    f.team.completed(lone.taskId, 'Three competitors.');
    await flush();
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.turn.mock.calls[0][1]).toContain(
      'Scout finished the work you handed over.',
    );
    expect(f.workspace.team.get(lone.id)!.deliveredAt).toEqual(
      expect.any(Number),
    );
  });
});

describe('the release gap', () => {
  it('resumes when the thread finishes, without the sweep or quick retries', async () => {
    vi.useFakeTimers();
    const f = rig();
    f.queue.start();
    // The lock was released but the runner still holds the thread.
    f.turn.mockRejectedValueOnce(new Error('Thread already running'));
    const marker = f.queue.enqueue({
      kind: 'approval',
      refId: 'ap-1',
      threadId: 'lead-thread',
      dotId: f.lead.id,
      prompt: 'Approved.',
      source: 'approval',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.workspace.resumes.get(marker.id)).toMatchObject({ attempts: 0 });
    f.bus.emit('turn.finished', {
      threadId: 'lead-thread',
      dotId: f.lead.id,
      runId: 'r',
      status: 'completed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.turn).toHaveBeenCalledTimes(2);
    expect(f.workspace.resumes.all()).toEqual([]);
  });

  it("delivers a relay marker for Dot B within one tick of Dot A's turn ending in that thread", async () => {
    const f = rig();
    f.queue.start();
    const release = f.registry.acquire(
      'dot-a',
      'shared-thread',
      'chat',
      () => {},
    );
    f.queue.enqueue({
      kind: 'handoff',
      refId: 'relay-1',
      threadId: 'shared-thread',
      dotId: 'dot-b',
      prompt: 'Your turn.',
      source: 'handoff',
    });
    await flush();
    expect(f.turn).not.toHaveBeenCalled();
    // Dot A's lock release does not concern Dot B's marker; the end of its turn in the thread does.
    release();
    await flush();
    expect(f.turn).not.toHaveBeenCalled();
    f.bus.emit('turn.finished', {
      threadId: 'shared-thread',
      dotId: 'dot-a',
      runId: 'r',
      status: 'completed',
    });
    await flush();
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.turn.mock.calls[0][0]).toBe('shared-thread');
  });

  it('retries a deferral whose turn.finished arrived while the attempt was in flight', async () => {
    const f = rig();
    f.queue.start();
    let fail!: (error: Error) => void;
    f.turn.mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => (fail = reject)),
    );
    f.queue.enqueue({
      kind: 'approval',
      refId: 'ap-1',
      threadId: 'lead-thread',
      dotId: f.lead.id,
      prompt: 'Approved.',
      source: 'approval',
    });
    await flush();
    f.bus.emit('turn.finished', {
      threadId: 'lead-thread',
      dotId: f.lead.id,
      runId: 'r',
      status: 'completed',
    });
    fail(new Error('Thread already running'));
    await flush();
    await flush();
    expect(f.turn).toHaveBeenCalledTimes(2);
    expect(f.workspace.resumes.all()).toEqual([]);
  });
});

describe('hand-off bookkeeping', () => {
  it('names the child conversation "Lead → Member: brief" within the title limit', () => {
    expect(
      TeamService.title('Lead', 'Marketer', 'Write the launch email.\nMore.'),
    ).toBe('Lead → Marketer: Write the launch email.');
    const long = TeamService.title(
      'A'.repeat(50),
      'B'.repeat(50),
      'word '.repeat(80),
    );
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.startsWith(`${'A'.repeat(50)} → ${'B'.repeat(50)}: `)).toBe(
      true,
    );
  });

  it('asks the teammate for the deliverable only', () => {
    const f = rig();
    const delegation = f.handOff('Scout', 'Research the market.');
    const prompt = f.store.task(delegation.taskId)!.prompt;
    expect(prompt).toContain('reply with the deliverable only');
    expect(prompt).toContain('no preamble, no plan, no "I am ready"');
    expect(f.workspace.requireThread(delegation.childThreadId).title).toBe(
      `${f.lead.name} → Scout: Research the market.`,
    );
  });
});

describe('delegation time limit', () => {
  it('gives delegation runs their own timeout and lease', async () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    const delegation = store.createTask('Hand-off.', { kind: 'delegation' });
    const once = store.createTask('Once.');
    const signals = new Map<string, AbortSignal>();
    const timeouts = runTimeouts({
      taskTimeoutMs: 90_000,
      delegationTimeoutMs: 300_000,
    });
    expect(timeouts('delegation')).toBe(300_000 + DELEGATION_RUN_MARGIN_MS);
    expect(timeouts('once')).toBe(90_000);
    vi.useFakeTimers();
    const runner = new Runner(
      store,
      { mode: 'sample', baseUrl: '' },
      (claim, _memories, signal) => {
        signals.set(claim.id, signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      },
      timeouts,
      { concurrency: 2 },
    );
    const now = Date.now();
    const tick = runner.tick();
    expect(store.task(delegation.id)!.leaseUntil).toBe(
      now + 300_000 + DELEGATION_RUN_MARGIN_MS + 90_000,
    );
    expect(store.task(once.id)!.leaseUntil).toBe(now + 90_000 + 90_000);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(signals.get(once.id)!.aborted).toBe(true);
    expect(signals.get(delegation.id)!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(205_001);
    expect(signals.get(delegation.id)!.aborted).toBe(true);
    await tick;
  });

  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    limits: defaultLimits,
  };

  async function hangingTurn(metadata?: Record<string, unknown>) {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    cleanups.push(() => {
      store.close();
      workspace.close();
    });
    const dot = workspace.dots()[0];
    workspace.bindThread('child', dot.id, 'Child');
    let abortedAt: number | undefined;
    const started = Date.now();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => {
              abortedAt ??= Date.now() - started;
              reject(init.signal?.reason);
            },
            { once: true },
          ),
        ),
    );
    const agent = new DotAgent(store, workspace, config, dot.id);
    const input: RunAgentInput = {
      threadId: 'child',
      runId: 'run',
      state: {},
      context: [],
      messages: [
        {
          id: 'u',
          role: 'user',
          content: 'Do the handed-over work.',
          ...(metadata ? { metadata } : {}),
        } as Message,
      ],
      tools: [],
      forwardedProps: {},
    };
    const events = lastValueFrom(agent.run(input).pipe(toArray()));
    return { events, abortedAt: () => abortedAt };
  }

  it('does not cut a delegation turn at 110 s; it stops at DELEGATION_TIMEOUT', async () => {
    vi.useFakeTimers();
    const turn = await hangingTurn({
      source: 'delegation',
      ref: 'd-1',
      turnLimitMs: 300_000,
    });
    await vi.advanceTimersByTimeAsync(111_000);
    expect(turn.abortedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(190_000);
    expect(turn.abortedAt()).toBeGreaterThanOrEqual(300_000);
    const events = await turn.events;
    expect(JSON.stringify(events)).toContain('time limit (300 seconds)');
  });

  it('still cuts an ordinary turn at the chat limit plus grace', async () => {
    vi.useFakeTimers();
    const turn = await hangingTurn({ source: 'task', turnLimitMs: 300_000 });
    await vi.advanceTimersByTimeAsync(111_000);
    expect(turn.abortedAt()).toBe(110_000);
    await turn.events;
  });
});

describe('a hand-off through the real wiring', () => {
  it('runs two teammates at once, records startedAt and deliveredAt, and resumes the lead once', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const platform = new Platform(store, workspace, {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      backgroundConcurrency: 4,
      teamResultBatchMs: 60_000,
    });
    cleanups.push(async () => {
      await platform.stop();
      store.close();
      workspace.close();
    });
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: unknown }[];
      };
      const last = body.messages.findLast((m) => m.role === 'user');
      requests.push(String(last?.content));
      return completion({ role: 'assistant', content: 'Deliverable.' });
    });
    await platform.start();
    const space = workspace.spaces()[0].id;
    const lead = workspace.dots()[0];
    const scout = workspace.createDot(space, 'Scout', 'Research.', true, true);
    const writer = workspace.createDot(space, 'Writer', 'Write.', true, true);
    workspace.team.setDelegates(lead.id, [scout.id, writer.id]);
    workspace.bindThread('lead-thread', lead.id, 'Launch');
    const handOff = (to: string) =>
      platform.team.delegate({
        fromDotId: lead.id,
        threadId: 'lead-thread',
        to,
        brief: `Work for ${to}.`,
        deliverable: 'Notes.',
        runId: 'lead-run',
      });
    const a = handOff('Scout');
    const b = handOff('Writer');
    const runner = createBackgroundRunner(platform, {
      mode: 'sample',
      baseUrl: '',
    });
    await runner.tick();
    for (const id of [a.id, b.id])
      expect(workspace.team.get(id)).toMatchObject({
        status: 'done',
        startedAt: expect.any(Number),
      });
    await vi.waitFor(() => expect(workspace.resumes.all()).toEqual([]));
    // Two teammate turns and one lead turn carrying both results.
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('(2 results)');
    for (const id of [a.id, b.id])
      expect(workspace.team.get(id)!.deliveredAt).toEqual(expect.any(Number));
    const listed = workspace.team.forParent('lead-thread');
    expect(listed[0]).toHaveProperty('startedAt');
    expect(listed[0]).toHaveProperty('deliveredAt');
  });
});

describe('migrating an older database', () => {
  it('adds the new columns and keeps every existing hand-off and marker', () => {
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    db.exec(`CREATE TABLE delegations(id TEXT PRIMARY KEY, parentThreadId TEXT NOT NULL,
      parentDotId TEXT NOT NULL, childThreadId TEXT NOT NULL, childDotId TEXT NOT NULL, taskId TEXT NOT NULL,
      depth INTEGER NOT NULL, status TEXT NOT NULL, brief TEXT NOT NULL, deliverable TEXT NOT NULL,
      result TEXT, createdAt INTEGER NOT NULL, finishedAt INTEGER);
      INSERT INTO delegations VALUES ('d1', 'p', 'lead', 'c', 'scout', 't', 1, 'done', 'b', 'd', 'r', 1, 2);
      CREATE TABLE resume_markers(id TEXT PRIMARY KEY, kind TEXT NOT NULL, refId TEXT NOT NULL, threadId TEXT NOT NULL,
      dotId TEXT NOT NULL, prompt TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, lastError TEXT);
      INSERT INTO resume_markers VALUES ('m1', 'delegation', 'd1', 'p', 'lead', 'Result.', 'delegation', 0, 1, 1, NULL);`);
    const team = new TeamStore(db);
    const resumes = new ResumeStore(db);
    expect(team.get('d1')).toMatchObject({
      result: 'r',
      batchKey: null,
      startedAt: null,
      deliveredAt: null,
    });
    expect(resumes.all()).toEqual([
      expect.objectContaining({
        id: 'm1',
        prompt: 'Result.',
        batchKey: null,
        firstResultAt: null,
      }),
    ]);
    // Opening it again changes nothing.
    new TeamStore(db);
    new ResumeStore(db);
    expect(team.forParent('p')).toHaveLength(1);
  });
});
