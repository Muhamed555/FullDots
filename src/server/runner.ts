import { Store } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
import { isDotBusy } from './turn-registry.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<Result>,
    private timeoutMs = 90_000,
    private options: {
      /** Task ids to skip; gets the Dots of the runs this runner has in flight. */
      excluded?: (activeDotIds: string[]) => string[];
      /** Background tasks at once; each runs on a different Dot. Default 1. */
      concurrency?: number;
      /** The Dot a task runs on, so two of its tasks are never claimed together. */
      dotOf?: (taskId: string) => string | undefined;
    } = {},
  ) {}
  private activeDots = new Map<string, string>();
  private exclusionsFailed = false;
  private wakeQueued = false;
  // Set while this runner puts a claim back because the Dot was busy: that requeue must not wake
  // it again, or a Dot the exclusions miss would be claimed and refused in a tight loop.
  private requeueing = false;
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      void this.tick();
    }
  }
  /**
   * Runs a tick soon (in a microtask), for work that became due now: a task created or requeued,
   * a Dot lock released. Calls in the same synchronous stretch share one tick, and the caller's
   * synchronous writes (binding the task to its conversation) are done by the time it claims.
   * Overlapping ticks are safe, see runTick. The interval stays as the safety net. Not while stopped.
   */
  wake() {
    if (!this.timer || this.wakeQueued || this.requeueing) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      if (this.timer) void this.tick();
    });
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const task of this.store.tasks()) {
      if (this.active.has(task.id) && task.lease)
        this.store.interrupt(
          { ...task, lease: task.lease },
          'Server stopped during this run. Review completed effects before retrying.',
        );
    }
    this.abortAll();
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  private excludedTaskIds(): string[] {
    try {
      return (
        this.options.excluded?.([...new Set(this.activeDots.values())]) ?? []
      );
    } catch (error) {
      if (!this.exclusionsFailed) {
        this.exclusionsFailed = true;
        console.error(
          'Runner exclusions failed: ' +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }
      return [];
    }
  }
  async tick() {
    try {
      await this.runTick();
    } catch {
      // Store errors must not become unhandled interval promise rejections.
      // Do not log task content, provider responses, or database details.
      console.error(
        'Background runner tick failed; will retry on the next tick.',
      );
    }
  }
  private async runTick() {
    const concurrency = Math.max(1, this.options.concurrency ?? 1);
    const started: Promise<void>[] = [];
    let failure: unknown;
    // Ticks overlap (the interval and wake() do not wait for an earlier tick, which awaits its runs
    // to the end). The claim loop below is what keeps them within `concurrency`: it is synchronous,
    // from the size check through claim() to active.set() with no await, so no other tick can claim
    // in between. Keep it that way; serialising whole ticks instead would stall scheduling while any
    // task runs.
    try {
      while (this.active.size < concurrency) {
        // The lease must outlive the run so a slow task is never claimed twice.
        const claim = this.store.claim(
          Date.now(),
          this.timeoutMs + 90_000,
          this.excludedTaskIds(),
        );
        if (!claim) break;
        const controller = new AbortController();
        this.active.set(claim.id, controller);
        const dotId = this.options.dotOf?.(claim.id);
        if (dotId) this.activeDots.set(claim.id, dotId);
        started.push(this.run(claim, controller));
      }
    } catch (error) {
      failure = error;
    }
    // Every started run is awaited, so none can end as an unhandled rejection.
    const settled = await Promise.allSettled(started);
    if (failure) throw failure;
    const rejected = settled.find((outcome) => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  private async run(claim: Claim, controller: AbortController) {
    let busy = false;
    const ownershipCheck = setInterval(() => {
      try {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
      } catch {
        controller.abort(new Error('Run ownership check failed.'));
      }
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Research exceeded the ${Math.round(this.timeoutMs / 1000)} second time limit.`,
          ),
        ),
      this.timeoutMs,
    );
    try {
      const settings = this.store.settings();
      const memories = settings.memoryAllowed ? this.store.memories() : [];
      const progress = (text: string) => {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
        controller.signal.throwIfAborted();
        this.store.event(claim.id, claim.lease, text);
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      controller.signal.throwIfAborted();
      this.store.finish(claim, result);
    } catch (error) {
      // A chat turn took the Dot between the claim and the turn: try again later, not a failure.
      if (isDotBusy(error)) {
        busy = true;
        this.requeueing = true;
        try {
          this.store.release(
            claim,
            'Waiting: the Dot was busy with another turn.',
          );
        } finally {
          this.requeueing = false;
        }
      } else
        this.store.fail(
          claim,
          error instanceof Error
            ? error.message
            : 'Unexpected research failure.',
        );
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
      this.activeDots.delete(claim.id);
      // A slot is free: claim the next due task now. Not after a busy requeue, which the release
      // of the Dot's lock wakes instead.
      if (!busy) this.wake();
    }
  }
}
