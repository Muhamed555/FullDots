// Runner.wake(): new and requeued tasks, and tasks that waited on a Dot, start at once instead of on
// the 1000 ms interval, without overlapping ticks ever running more than `concurrency` tasks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wakeOnWork } from '../src/server/live-wiring.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { DotBusyError } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Result } from '../src/shared/types.js';

const research = { mode: 'sample' as const, baseUrl: '' };
const done: Result = { text: 'done', sources: [], sample: false };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

/** Runs that stay open until released, recording the most that overlapped. */
function gated() {
  const open = new Map<string, () => void>();
  let peak = 0;
  const execute = vi.fn(
    (claim: { id: string }) =>
      new Promise<Result>((resolve) => {
        open.set(claim.id, () => {
          open.delete(claim.id);
          resolve(done);
        });
        peak = Math.max(peak, open.size);
      }),
  );
  return {
    execute,
    open,
    peak: () => peak,
    releaseAll: () => [...open.values()].forEach((release) => release()),
  };
}

/** A platform for its event bus and turn registry, a runner on its store, wired like index.ts. */
function rig(
  options: {
    concurrency?: number;
    execute?: ConstructorParameters<typeof Runner>[2];
    wire?: boolean;
  } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
  });
  const work = gated();
  const dots = new Map<string, string>();
  const runner = new Runner(
    store,
    research,
    options.execute ?? work.execute,
    90_000,
    {
      concurrency: options.concurrency ?? 1,
      dotOf: (id) => dots.get(id),
      // Like index.ts: tasks of Dots that are busy (registry or this runner) are skipped.
      excluded: (activeDots) => {
        const busy = new Set([
          ...platform.turns.exclusions().dotIds,
          ...activeDots,
        ]);
        return [...dots].filter(([, dot]) => busy.has(dot)).map(([id]) => id);
      },
    },
  );
  const unwire =
    options.wire === false
      ? () => {}
      : wakeOnWork(platform.events, platform.turns, runner);
  cleanups.push(async () => {
    unwire();
    work.releaseAll();
    runner.stop();
    await platform.stop();
    store.close();
    workspace.close();
  });
  // The wake runs in a microtask, so the task is bound to its Dot by the time it claims.
  const task = (dot: string) => {
    const created = store.createTask(`Work for ${dot}`);
    dots.set(created.id, dot);
    return created;
  };
  return { store, platform, runner, work, task };
}

describe('Runner.wake', () => {
  it('claims a task created at t+100 ms before the 1000 ms interval', async () => {
    vi.useFakeTimers();
    const { runner, work, task } = rig();
    runner.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(work.execute).not.toHaveBeenCalled();
    task('dot-a');
    await vi.advanceTimersByTimeAsync(1);
    expect(work.execute).toHaveBeenCalledTimes(1);
  });

  it('without the wake wiring the same task waits for the interval', async () => {
    vi.useFakeTimers();
    const { runner, work, task } = rig({ wire: false });
    runner.start();
    await vi.advanceTimersByTimeAsync(100);
    task('dot-a');
    await vi.advanceTimersByTimeAsync(500);
    expect(work.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(work.execute).toHaveBeenCalledTimes(1);
  });

  it('with one run in flight, a wake still claims a second task immediately', async () => {
    vi.useFakeTimers();
    const { runner, work, task } = rig({ concurrency: 2 });
    runner.start();
    task('dot-a');
    await vi.advanceTimersByTimeAsync(1);
    expect(work.open.size).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    task('dot-b');
    await vi.advanceTimersByTimeAsync(1);
    expect(work.open.size).toBe(2);
    expect(work.execute).toHaveBeenCalledTimes(2);
  });

  it('never runs more than the concurrency limit across overlapping wakes and ticks', async () => {
    vi.useFakeTimers();
    const { runner, work, task } = rig({ concurrency: 2 });
    runner.start();
    for (const dot of ['a', 'b', 'c', 'd', 'e']) task(dot);
    for (let i = 0; i < 10; i++) {
      runner.wake();
      void runner.tick();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(work.open.size).toBe(2);
    expect(work.execute).toHaveBeenCalledTimes(2);
    // As runs finish, freed slots are refilled at once, still two at a time.
    for (let round = 0; round < 3; round++) {
      work.releaseAll();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(work.execute).toHaveBeenCalledTimes(5);
    expect(work.peak()).toBe(2);
  });

  it('claims a task that waited on a busy Dot as soon as its lock is released', async () => {
    vi.useFakeTimers();
    const { runner, work, task, platform } = rig();
    runner.start();
    const release = platform.turns.acquire(
      'dot-a',
      'chat-thread',
      'chat',
      () => {},
    );
    await vi.advanceTimersByTimeAsync(100);
    task('dot-a');
    await vi.advanceTimersByTimeAsync(1);
    expect(work.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(work.execute).toHaveBeenCalledTimes(1);
  });

  it('does not wake itself on its own busy requeue (no tight loop when exclusions miss a busy Dot)', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => {
      throw new DotBusyError('dot-a', 'chat', 'elsewhere');
    });
    const { runner, task, store } = rig({ execute });
    runner.start();
    const created = task('dot-x');
    await vi.advanceTimersByTimeAsync(50);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.task(created.id)?.status).toBe('queued');
    // The interval is still the safety net.
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does nothing while stopped', async () => {
    vi.useFakeTimers();
    const { runner, work, task } = rig();
    task('dot-a');
    runner.wake();
    await vi.advanceTimersByTimeAsync(2000);
    expect(work.execute).not.toHaveBeenCalled();
  });
});
