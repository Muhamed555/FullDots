// Refetching on live events, with polling kept as a fallback: slow while the feed is open, the old
// 3 s cadence while it is not.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { LiveEventType } from '../shared/live-events';
import {
  liveEvents,
  useLiveEvent,
  useLiveReset,
  useLiveStatus,
  type LiveEventStore,
  type LiveStatus,
} from './useLiveEvents';

/** Events after which App refetches /state, /workspace, /approvals and /handoffs. */
export const APP_REFRESH_EVENTS = [
  'workspace.changed',
  'task.changed',
  'delegation.changed',
  'approval.changed',
  'handoff.changed',
  'usage.updated',
  'inbox.changed',
  'turn.started',
  'turn.finished',
] as const satisfies readonly LiveEventType[];

export const REFRESH_DEBOUNCE_MS = 100;
/** A burst that never pauses (usage while a turn streams) still refetches this often. */
export const REFRESH_MAX_WAIT_MS = 1000;
export const FALLBACK_POLL_MS = 15_000;
export const OFFLINE_POLL_MS = 3000;

export function pollInterval(status: LiveStatus) {
  return status === 'open' ? FALLBACK_POLL_MS : OFFLINE_POLL_MS;
}

interface Timers {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: never) => void;
  now: () => number;
}

const realTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => Date.now(),
};

/**
 * Trailing debounce: `run` fires `wait` ms after the last `schedule()`, but no later than `maxWait`
 * ms after the first one of a burst.
 */
export function debounce(
  run: () => void,
  wait = REFRESH_DEBOUNCE_MS,
  maxWait = REFRESH_MAX_WAIT_MS,
  timers: Timers = realTimers,
) {
  let timer: unknown;
  let first: number | undefined;
  const fire = () => {
    timer = undefined;
    first = undefined;
    run();
  };
  return {
    schedule() {
      const now = timers.now();
      first ??= now;
      if (timer !== undefined) timers.clearTimeout(timer as never);
      timer = timers.setTimeout(
        fire,
        Math.max(0, Math.min(wait, first + maxWait - now)),
      );
    },
    cancel() {
      if (timer !== undefined) timers.clearTimeout(timer as never);
      timer = undefined;
      first = undefined;
    },
    pending: () => timer !== undefined,
  };
}

/**
 * Calls `refresh` on mount, soon after any of `types`, after a feed reset, and on the fallback poll.
 * Returns the feed status.
 */
export function useLiveRefresh(
  refresh: () => unknown,
  types: readonly LiveEventType[] = APP_REFRESH_EVENTS,
  store: LiveEventStore = liveEvents,
) {
  const latest = useRef(refresh);
  useLayoutEffect(() => {
    latest.current = refresh;
  });
  const status = useLiveStatus(store);
  const debounced = useMemo(
    () => debounce(() => void latest.current()),
    [latest],
  );
  useEffect(() => () => debounced.cancel(), [debounced]);
  useLiveEvent(types, () => debounced.schedule(), store);
  useLiveReset(() => debounced.schedule(), store);
  useEffect(() => {
    void latest.current();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(
      () => void latest.current(),
      pollInterval(status),
    );
    return () => clearInterval(timer);
  }, [status]);
  return status;
}
