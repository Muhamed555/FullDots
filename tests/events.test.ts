// The in-process event bus behind GET /api/events, and the store hooks that feed it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/server/events.js';
import { tap } from '../src/server/live-wiring.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { LiveEvent } from '../src/shared/live-events.js';

afterEach(() => vi.restoreAllMocks());

describe('EventBus', () => {
  it('delivers events to subscribers of their type, with increasing ids', () => {
    const bus = new EventBus(1000);
    const usage = vi.fn();
    const everything: LiveEvent[] = [];
    bus.subscribe('usage.updated', usage);
    bus.subscribeAll((event) => everything.push(event));
    const first = bus.emit('usage.updated', { dotId: 'a' });
    const second = bus.emit('inbox.changed', {});
    expect(first.id).toBe(1001);
    expect(second.id).toBe(1002);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ dotId: 'a' });
    expect(everything.map((event) => [event.id, event.type])).toEqual([
      [1001, 'usage.updated'],
      [1002, 'inbox.changed'],
    ]);
    expect(bus.lastId()).toBe(1002);
  });

  it('stops delivering after unsubscribe, either way', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const off = bus.subscribe('workspace.changed', a);
    bus.subscribe('workspace.changed', b);
    off();
    bus.unsubscribe('workspace.changed', b);
    bus.emit('workspace.changed', {});
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('keeps a failing listener from affecting the others or the emitter', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new EventBus();
    const after = vi.fn();
    bus.subscribe('inbox.changed', () => {
      throw new Error('listener broke');
    });
    bus.subscribe('inbox.changed', after);
    expect(() => bus.emit('inbox.changed', {})).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('replays recent events after an id and refuses ids it cannot replay', () => {
    const bus = new EventBus(0);
    expect(bus.since(0)).toEqual([]);
    for (let i = 0; i < 250; i++) bus.emit('usage.updated', { dotId: `${i}` });
    // 200 are kept: ids 51..250.
    expect(bus.since(250)).toEqual([]);
    expect(bus.since(248)?.map((event) => event.id)).toEqual([249, 250]);
    expect(bus.since(50)).toHaveLength(200);
    expect(bus.since(49)).toBeUndefined();
    expect(bus.since(251)).toBeUndefined();
    expect(bus.since(Number.NaN)).toBeUndefined();
  });

  it('starts ids at the boot time, so an id from an earlier process is never replayed', () => {
    const earlier = new EventBus(5_000);
    const old = earlier.emit('inbox.changed', {});
    const later = new EventBus(9_000);
    expect(later.since(old.id)).toBeUndefined();
  });
});

describe('tap', () => {
  it('reports results and arguments without changing them', () => {
    const target = {
      factor: 2,
      times(value: number) {
        return value * this.factor;
      },
    };
    const seen: [number, number][] = [];
    tap(target, 'times', (result, value) => seen.push([result, value]));
    expect(target.times(4)).toBe(8);
    expect(seen).toEqual([[8, 4]]);
  });

  it('keeps a failing hook from failing the write', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = { write: () => 'stored' };
    tap(target, 'write', () => {
      throw new Error('hook broke');
    });
    expect(target.write()).toBe('stored');
  });
});

describe('store hooks', () => {
  function rig() {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const platform = new Platform(store, workspace, {
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
    });
    const events: LiveEvent[] = [];
    platform.events.subscribeAll((event) => events.push(event));
    const close = async () => {
      await platform.stop();
      store.close();
      workspace.close();
    };
    return { store, workspace, platform, events, close };
  }

  it('emits task, delegation, handoff, approval and usage changes with ids only', async () => {
    const { store, workspace, platform, events, close } = rig();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Hooks');

    const task = store.createTask('A secret task prompt');
    const claim = store.claim()!;
    store.finish(claim, { text: 'secret result', sources: [], sample: false });
    store.action(task.id, 'run');

    const delegation = workspace.team.create({
      parentThreadId: 'thread',
      parentDotId: dot.id,
      childThreadId: 'child',
      childDotId: dot.id,
      taskId: task.id,
      depth: 1,
      brief: 'secret brief',
      deliverable: 'secret deliverable',
    });
    workspace.team.finish(delegation.id, 'done', 'secret result');

    const handoff = workspace.handoffs.create({
      dotId: dot.id,
      threadId: 'thread',
      kind: 'credential',
      reason: 'secret reason',
    });
    workspace.handoffs.finish(handoff.id, 'done');

    const approval = workspace.approvals.create({
      threadId: 'thread',
      dotId: dot.id,
      toolCallId: 'call-1',
      tool: 'shell',
      argsHash: 'hash',
      summary: 'secret summary',
      argsRedacted: '{}',
      ttlMs: 60_000,
    });
    workspace.approvals.decide(approval.id, 'approve');
    platform.recordUsage(dot.id, { input: 1, output: 2 });
    workspace.usage.setBudget(dot.id, 1000);

    expect(events.map((event) => [event.type, event.data])).toEqual([
      ['task.changed', { taskId: task.id, status: 'queued' }],
      ['task.changed', { taskId: task.id, status: 'running' }],
      ['task.changed', { taskId: task.id, status: 'completed' }],
      ['task.changed', { taskId: task.id, status: 'queued' }],
      [
        'delegation.changed',
        {
          id: delegation.id,
          parentThreadId: 'thread',
          childThreadId: 'child',
          status: 'running',
        },
      ],
      [
        'delegation.changed',
        {
          id: delegation.id,
          parentThreadId: 'thread',
          childThreadId: 'child',
          status: 'done',
        },
      ],
      ['handoff.changed', { id: handoff.id, threadId: 'thread' }],
      ['handoff.changed', { id: handoff.id, threadId: 'thread' }],
      ['approval.changed', { id: approval.id, threadId: 'thread' }],
      ['approval.changed', { id: approval.id, threadId: 'thread' }],
      ['usage.updated', { dotId: dot.id }],
      ['usage.updated', { dotId: dot.id }],
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
    await close();
  });

  it('turns an approval expiry sweep into inbox.changed', async () => {
    const { workspace, events, close } = rig();
    const dot = workspace.dots()[0];
    workspace.approvals.create({
      threadId: 'thread',
      dotId: dot.id,
      toolCallId: 'call-1',
      tool: 'shell',
      argsHash: 'hash',
      summary: 'summary',
      argsRedacted: '{}',
      ttlMs: 1,
    });
    events.splice(0);
    expect(workspace.approvals.expire(Date.now() + 10)).toBe(1);
    expect(workspace.approvals.expire(Date.now() + 10)).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['inbox.changed']);
    await close();
  });

  it('emits turn.started when a Dot lock is taken, with the run id', async () => {
    const { platform, events, close } = rig();
    const release = platform.turns.acquire(
      'dot-1',
      'thread',
      'task',
      () => {},
      'run-1',
    );
    release();
    expect(events.map((event) => [event.type, event.data])).toEqual([
      [
        'turn.started',
        { threadId: 'thread', dotId: 'dot-1', runId: 'run-1', source: 'task' },
      ],
    ]);
    await close();
  });
});
