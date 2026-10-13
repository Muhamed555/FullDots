// Group chat dispatch on the client: which turns run in the open thread (from the live feed), and
// the queue that gives each mentioned Dot its turn one after another. The queue lives in the page:
// one Dot's turn is posted, the next waits for that turn's `turn.finished` (or, without the live
// feed, for the server to report the thread free). Closing the page drops the Dots still waiting.
import type { LiveEventMap } from '../../shared/live-events';
import { api } from '../api';
import { liveEvents, type LiveEventStore } from '../useLiveEvents';

/** Turns started in one thread that have not finished yet, by run id. */
export class ThreadRuns {
  private runs = new Map<string, { dotId: string; at: number }>();
  constructor(readonly threadId: string) {}

  /** True when the event changed what is running here. */
  started(event: LiveEventMap['turn.started'], now = Date.now()): boolean {
    if (event.threadId !== this.threadId) return false;
    this.runs.set(event.runId, { dotId: event.dotId, at: now });
    return true;
  }

  finished(event: LiveEventMap['turn.finished']): boolean {
    if (event.threadId !== this.threadId) return false;
    // A finished run without a known start (this page opened mid-turn) changes nothing.
    return this.runs.delete(event.runId);
  }

  /** The server says nothing runs here: forget starts older than `graceMs` (a missed finish). */
  settle(now = Date.now(), graceMs = 5000): boolean {
    let changed = false;
    for (const [runId, run] of this.runs)
      if (now - run.at > graceMs) changed = this.runs.delete(runId) || changed;
    return changed;
  }

  clear(): boolean {
    const had = this.runs.size > 0;
    this.runs.clear();
    return had;
  }

  get busy(): boolean {
    return this.runs.size > 0;
  }

  /** The Dot of the most recent unfinished turn. */
  get dotId(): string | undefined {
    return [...this.runs.values()].at(-1)?.dotId;
  }
}

export interface ParticipantsView {
  hostId: string;
  participants: { dotId: string; addedAt: number }[];
  running: { dotId: string | null } | null;
}

export const participantsPath = (threadId: string) =>
  `/conversations/${encodeURIComponent(threadId)}/participants`;

/**
 * Resolves once `dotId`'s turn in `threadId` has finished: on its `turn.finished`, or when a poll of
 * the participants route finds the thread free. Call it before posting the turn so a fast turn's
 * event is not missed. Rejects with an AbortError when `signal` aborts.
 */
export function waitForTurnEnd(
  threadId: string,
  dotId: string,
  signal: AbortSignal,
  options: {
    store?: LiveEventStore;
    pollMs?: number;
    fetchView?: () => Promise<ParticipantsView>;
  } = {},
): Promise<void> {
  const store = options.store ?? liveEvents;
  const fetchView =
    options.fetchView ??
    (() => api<ParticipantsView>(participantsPath(threadId), 'GET'));
  const stopped = () =>
    new DOMException('The queue was stopped.', 'AbortError');
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<void>((resolve, reject) => {
    const done = (error?: unknown) => {
      unsubscribe();
      clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => done(stopped());
    const unsubscribe = store.subscribe('turn.finished', (data) => {
      const event = data as LiveEventMap['turn.finished'];
      if (event.threadId === threadId && event.dotId === dotId) done();
    });
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      void fetchView()
        .then((view) => {
          if (!view.running) done();
        })
        .catch(() => {});
    }, options.pollMs ?? 3000);
  });
}
