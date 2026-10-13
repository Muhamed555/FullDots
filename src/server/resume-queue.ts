// Delivers resume markers: starts a new turn in the same thread once the thread and the Dot are
// free. Markers are persisted first (ResumeStore), delivered second, and removed only after the
// turn ran. Retries happen when a turn finishes (its thread or its Dot), when a Dot's lock is
// released, and on a periodic sweep.
//
// Rules:
// - A busy thread or Dot defers the marker without counting as a failure (attempts unchanged).
// - Any other error bumps `attempts` and schedules `nextAt` with backoff.
// - A marker that failed MAX_ATTEMPTS times, or is older than `maxAgeMs`, is given up: it is
//   removed, logged once (never its prompt) and reported to `onGiveUp`. A resume that keeps
//   failing would otherwise append its prompt to the thread forever.
// - Markers of one thread are delivered oldest first: while an older marker of the thread is
//   stored, a newer one waits. A failing marker blocks later ones of its thread until it is
//   delivered or given up; that keeps the conversation in order.
// - Markers with a batch key (the results of the hand-offs one turn made) go out together: once
//   every member of the batch has a result, or `batches.windowMs` after the first one arrived,
//   one turn carries all stored markers of the batch and they are removed in one transaction.
//   A result that arrives after that gets a turn of its own.
// - Attempts never overlap for one marker, and only one attempt per Dot runs at a time.
import type { TurnMetadata } from '../shared/types.js';
import { NO_TIME_LIMIT_MS } from './limits.js';
import { isDotBusy, type TurnRegistry } from './turn-registry.js';
import type {
  NewResumeMarker,
  ResumeMarker,
  ResumeStore,
} from './resume-store.js';

export const MAX_ATTEMPTS = 10;
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Quick retries while the runner finishes the turn that just released the Dot (about 5 s). Only
 * used without `onTurnFinished`: with it, the end of that turn kicks the marker instead.
 */
const RUNNING_RETRY_MS = 250;
const RUNNING_RETRIES = 20;
export const DEFAULT_SWEEP_MS = 30_000;
export const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 60_000];

export interface ResumeBatches {
  /** How long a batch waits for missing results after its first marker arrived. */
  windowMs: number;
  /** True when no member of the batch is still working. */
  settled: (batchKey: string) => boolean;
  /** The prompt of the one turn that delivers these markers (oldest first, two or more). */
  prompt: (markers: ResumeMarker[]) => string;
  /** Runs inside the transaction that removes delivered markers (every delivery, batched or not). */
  delivered?: (markers: ResumeMarker[], now: number) => void;
}

export interface ResumeQueueDeps {
  store: ResumeStore;
  registry: TurnRegistry;
  /** = platform.turn */
  turn: (
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata: TurnMetadata,
  ) => Promise<string>;
  /**
   * Subscribes to finished turns (the `turn.finished` event, sent once the runner stored the run
   * and the thread is free). Returns the unsubscribe function.
   */
  onTurnFinished?: (
    listener: (turn: { threadId: string; dotId: string }) => void,
  ) => () => void;
  /** Delivers markers with a batch key together; without it every marker goes alone. */
  batches?: ResumeBatches;
  sweepMs?: number;
  /** Delay after the n-th failed attempt; the last entry repeats. */
  backoffMs?: number[];
  /** A marker older than this is given up on (default 7 days). */
  maxAgeMs?: number;
  /** A paused Dot gets no resume turns until it is resumed. */
  isPaused?: (dotId: string) => boolean;
  /** Called once when a marker is removed without delivery (too many failures, or too old). */
  onGiveUp?: (marker: ResumeMarker, lastError: string) => void;
  /** Called after a marker's turn ran, with the text the turn returned (once per batch). */
  onDelivered?: (marker: ResumeMarker, text: string) => void;
  log?: (line: string) => void;
}

export type AttemptResult = 'delivered' | 'deferred' | 'failed' | 'gave_up';

export class ResumeQueue {
  private inFlight = new Map<string, string>(); // marker id -> dotId
  // Markers kicked while their attempt was in flight: tried again if that attempt is deferred.
  private kickedInFlight = new Set<string>();
  private batchTimers = new Map<
    string,
    { at: number; timer: ReturnType<typeof setTimeout> }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private unfinished: (() => void) | undefined;
  private readonly sweepMs: number;
  private readonly backoffMs: number[];
  private readonly maxAgeMs: number;
  private readonly log: (line: string) => void;

  constructor(private deps: ResumeQueueDeps) {
    this.sweepMs = deps.sweepMs ?? DEFAULT_SWEEP_MS;
    this.backoffMs =
      deps.backoffMs && deps.backoffMs.length > 0
        ? deps.backoffMs
        : DEFAULT_BACKOFF_MS;
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.log = deps.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.timer || this.unsubscribe) return;
    for (const marker of this.deps.store.all()) this.kick(marker.id);
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref();
    this.unsubscribe = this.deps.registry.onRelease((dotId) =>
      this.kickWhere((marker) => marker.dotId === dotId),
    );
    // The thread is free only once the runner stored the run, a moment after the Dot's lock was
    // released. A relay marker belongs to the receiving Dot but waits on the sender's thread, so
    // both the thread and the Dot of the finished turn count.
    this.unfinished = this.deps.onTurnFinished?.(({ threadId, dotId }) =>
      this.kickWhere(
        (marker) => marker.threadId === threadId || marker.dotId === dotId,
      ),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unfinished?.();
    this.unfinished = undefined;
    for (const { timer } of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
  }

  enqueue(input: NewResumeMarker): ResumeMarker {
    const marker = this.deps.store.add(input);
    this.kick(marker.id);
    return marker;
  }

  async attempt(id: string): Promise<AttemptResult> {
    const { store, registry, batches } = this.deps;
    const marker = store.get(id);
    if (!marker) return 'delivered';
    if (this.inFlight.has(id)) {
      this.kickedInFlight.add(id);
      return 'deferred';
    }
    if (Date.now() - marker.createdAt > this.maxAgeMs)
      return this.giveUp([marker], marker.lastError ?? 'expired', 'too old');
    for (const dotId of this.inFlight.values())
      if (dotId === marker.dotId) return 'deferred';
    if (registry.isThreadRunning(marker.threadId)) return 'deferred';
    if (registry.isDotBusy(marker.dotId)) return 'deferred';
    if (this.deps.isPaused?.(marker.dotId)) return 'deferred';
    const stored = store.all();
    const batchKey = batches ? marker.batchKey : null;
    const oldest = stored.find((m) => m.threadId === marker.threadId);
    // A marker of the same batch ahead of this one goes out in the same turn.
    if (
      oldest &&
      oldest.id !== marker.id &&
      !(batchKey && oldest.batchKey === batchKey)
    )
      return 'deferred';
    const group = batchKey
      ? stored.filter(
          (m) => m.batchKey === batchKey && m.threadId === marker.threadId,
        )
      : [marker];
    if (batchKey && batches && !batches.settled(batchKey)) {
      const first = Math.min(
        ...group.map((m) => m.firstResultAt ?? m.createdAt),
      );
      const due = first + batches.windowMs;
      if (Date.now() < due) {
        this.kickAt(batchKey, marker.id, due);
        return 'deferred';
      }
    }
    const lead = group[0];

    for (const m of group) this.inFlight.set(m.id, m.dotId);
    let text = '';
    let outcome: AttemptResult | undefined;
    let lastError: string | undefined;
    try {
      text = await this.deps.turn(
        lead.threadId,
        group.length > 1 && batches ? batches.prompt(group) : lead.prompt,
        AbortSignal.timeout(NO_TIME_LIMIT_MS), // the turn has its own limits
        { source: lead.source, ref: lead.refId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Another turn took the Dot first; the end of that turn kicks this marker again.
      if (isDotBusy(error)) outcome = 'deferred';
      else if (/Thread already running/.test(message)) {
        // The Dot's lock is released a moment before the runner marks the thread free, so a
        // release-triggered attempt can land in that gap. The turn.finished of that run kicks the
        // marker again; without that event, try again shortly instead of waiting for the sweep.
        if (!this.deps.onTurnFinished) this.retrySoon(id);
        outcome = 'deferred';
      } else {
        const delay =
          this.backoffMs[Math.min(lead.attempts, this.backoffMs.length - 1)];
        for (const m of group) store.bump(m.id, message, Date.now() + delay);
        // Never log marker.prompt: it can hold the owner's note.
        this.log(
          `Resume ${lead.kind} ${lead.refId} failed (attempt ${lead.attempts + 1}): ${message.slice(0, 200)}`,
        );
        if (lead.attempts + 1 < MAX_ATTEMPTS) outcome = 'failed';
        else lastError = message;
      }
    } finally {
      for (const m of group) this.inFlight.delete(m.id);
    }
    // After `finally`: the next marker of this Dot must not see this one as still running.
    const kickedMeanwhile = group.some((m) => this.kickedInFlight.delete(m.id));
    if (outcome === 'deferred') {
      // A turn ended while this attempt was in flight: its kick was swallowed above, so retry now.
      if (kickedMeanwhile) this.kick(lead.id);
      return outcome;
    }
    if (outcome) return outcome;
    if (lastError !== undefined)
      return this.giveUp(group, lastError, 'too many failures');
    try {
      store.removeAll(
        group.map((m) => m.id),
        batches?.delivered
          ? () => batches.delivered!(group, Date.now())
          : undefined,
      );
    } catch (error) {
      // The turn ran; a marker left behind would repeat it. Remove them one by one instead.
      this.log(
        `Resume ${lead.kind} ${lead.refId}: could not record the delivery: ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const m of group) store.remove(m.id);
    }
    for (const m of group) this.retries.delete(m.id);
    try {
      this.deps.onDelivered?.(lead, text);
    } catch (error) {
      this.log(
        `Resume ${lead.kind} ${lead.refId}: onDelivered failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.kickNext(lead.threadId);
    return 'delivered';
  }

  /** Removes markers that will not be delivered, tells the platform, and lets the thread go on. */
  private giveUp(
    markers: ResumeMarker[],
    lastError: string,
    why: string,
  ): AttemptResult {
    for (const marker of markers) {
      this.deps.store.remove(marker.id);
      this.retries.delete(marker.id);
      this.log(
        `Resume ${marker.kind} ${marker.refId}: giving up (${why}): ${lastError.slice(0, 200)}`,
      );
      try {
        this.deps.onGiveUp?.(marker, lastError);
      } catch (error) {
        this.log(
          `Resume ${marker.kind} ${marker.refId}: onGiveUp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.kickNext(markers[0].threadId);
    return 'gave_up';
  }

  /** The next marker of a thread was waiting for the one before it. */
  private kickNext(threadId: string): void {
    const next = this.deps.store.all().find((m) => m.threadId === threadId);
    if (next) this.kick(next.id);
  }

  private kickWhere(match: (marker: ResumeMarker) => boolean): void {
    let markers: ResumeMarker[];
    try {
      markers = this.deps.store.all();
    } catch {
      return; // The store was closed (shutdown).
    }
    for (const marker of markers) if (match(marker)) this.kick(marker.id);
  }

  /** Kicks a waiting batch when its window closes (one timer per batch, the earliest wins). */
  private kickAt(batchKey: string, id: string, at: number): void {
    const current = this.batchTimers.get(batchKey);
    if (current && current.at <= at) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(
      () => {
        this.batchTimers.delete(batchKey);
        try {
          if (this.deps.store.get(id)) this.kick(id);
          else this.kickWhere((marker) => marker.batchKey === batchKey); // delivered or replaced
        } catch {
          // The store was closed (shutdown).
        }
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref?.();
    this.batchTimers.set(batchKey, { at, timer });
  }

  private retries = new Map<string, number>();
  private retrySoon(id: string): void {
    const count = (this.retries.get(id) ?? 0) + 1;
    if (count > RUNNING_RETRIES) {
      this.retries.delete(id);
      return; // The sweep takes over.
    }
    this.retries.set(id, count);
    setTimeout(() => {
      try {
        if (!this.deps.store.get(id)) this.retries.delete(id);
        else this.kick(id);
      } catch {
        this.retries.delete(id); // The store was closed (shutdown).
      }
    }, RUNNING_RETRY_MS).unref();
  }

  private sweep(): void {
    for (const marker of this.deps.store.due()) this.kick(marker.id);
  }

  /** Fire-and-forget attempt that can never reject. */
  private kick(id: string): void {
    this.attempt(id).catch((error: unknown) => {
      this.log(
        `Resume attempt crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
