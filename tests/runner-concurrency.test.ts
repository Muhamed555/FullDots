import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Result } from '../src/shared/types.js';

const config = { mode: 'sample' as const, baseUrl: '' };
const done: Result = { text: 'done', sources: [], sample: false };

/** An execute function whose runs stay open until released, recording what overlapped. */
function gated() {
  const open = new Map<string, () => void>();
  let peak = 0;
  // Once released, later runs finish at once.
  let released = false;
  const execute = vi.fn(
    (claim: { id: string }) =>
      new Promise<Result>((resolve) => {
        if (released) return resolve(done);
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
    releaseAll: () => {
      released = true;
      [...open.values()].forEach((release) => release());
    },
  };
}

describe('parallel background work', () => {
  it('runs up to the concurrency limit at once', async () => {
    const store = new Store(':memory:');
    const dots = new Map<string, string>();
    for (const [i, dot] of ['a', 'b', 'c'].entries())
      dots.set(store.createTask(`Task ${i}`).id, dot);
    const work = gated();
    const runner = new Runner(store, config, work.execute, 90_000, {
      concurrency: 2,
      dotOf: (id) => dots.get(id),
      excluded: () => [],
    });
    const tick = runner.tick();
    await vi.waitFor(() => expect(work.open.size).toBe(2));
    work.releaseAll();
    await tick;
    expect(work.peak()).toBe(2);
    await runner.tick();
    expect(work.execute).toHaveBeenCalledTimes(3);
    store.close();
  });

  it('never claims two tasks of the same Dot together', async () => {
    const store = new Store(':memory:');
    const first = store.createTask('First on Scout').id;
    const second = store.createTask('Second on Scout').id;
    const other = store.createTask('On Builder').id;
    const dots = new Map([
      [first, 'scout'],
      [second, 'scout'],
      [other, 'builder'],
    ]);
    const work = gated();
    const runner = new Runner(store, config, work.execute, 90_000, {
      concurrency: 3,
      dotOf: (id) => dots.get(id),
      // Mirrors index.ts: tasks of the Dots in flight are skipped.
      excluded: (activeDots) =>
        [...dots]
          .filter(([, dot]) => activeDots.includes(dot))
          .map(([id]) => id),
    });
    const tick = runner.tick();
    await vi.waitFor(() => expect(work.open.size).toBe(2));
    expect([...work.open.keys()].sort()).toEqual([first, other].sort());
    expect(store.task(second)!.status).toBe('queued');
    work.releaseAll();
    await tick;
    await runner.tick();
    expect(store.task(second)!.status).toBe('completed');
    store.close();
  });

  it('keeps one run at a time by default', async () => {
    const store = new Store(':memory:');
    store.createTask('One');
    store.createTask('Two');
    const work = gated();
    const runner = new Runner(store, config, work.execute, 90_000);
    const tick = runner.tick();
    await vi.waitFor(() => expect(work.open.size).toBe(1));
    work.releaseAll();
    await tick;
    expect(work.peak()).toBe(1);
    store.close();
  });

  it('awaits the runs it started when a later claim fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new Store(':memory:');
    store.createTask('Runs');
    const claim = store.claim.bind(store);
    vi.spyOn(store, 'claim')
      .mockImplementationOnce(claim)
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      });
    const execute = vi.fn().mockResolvedValue(done);
    const runner = new Runner(store, config, execute, 90_000, {
      concurrency: 2,
    });
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
    store.close();
  });
});
