// The lanes of one chat: the progress of every hand-off it made, kept fresh by the live feed (and a
// short poll while a teammate works, for its streaming preview), plus the owner's actions on them.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LaneProgress, LaneProgressResponse } from '../../shared/lanes';
import type { TeamRunBand } from '../../shared/teams';
import type { Dot } from '../../shared/types';
import { api } from '../api';
import type { Delegation } from '../../shared/types';
import { requestControl } from '../computer-panel/take-over';
import { debounce, pollInterval } from '../live-refresh';
import { useLiveEvent, useLiveReset, useLiveStatus } from '../useLiveEvents';
import { LaneAnnouncer, laneView, toggleExpanded } from './lane-model';
import { LanesContext, type LanesValue } from './lanes-context';

export { LanesContext, type LanesValue };

/** How often lanes refetch while a teammate works, for its streaming preview and step. */
export const WORKING_POLL_MS = 1500;
/** A lane created this recently plays the hand-off animation when it first shows. */
export const FRESH_MS = 15_000;

const ACTIVE = new Set(['queued', 'working', 'waiting']);

export function useLanes({
  threadId,
  hostDot,
  dots,
  onOpenThread,
  onComputer,
}: {
  threadId: string;
  hostDot: Dot;
  dots: Dot[];
  onOpenThread?: (id: string) => void;
  onComputer?: () => void;
}) {
  const [data, setData] = useState<{
    lanes: LaneProgress[];
    runs: TeamRunBand[];
    receivedAt: number;
    loaded: boolean;
  }>({ lanes: [], runs: [], receivedAt: 0, loaded: false });
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [handingOff, setHandingOff] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef<Map<string, string> | undefined>(undefined);
  const announcer = useRef(new LaneAnnouncer());
  const live = useLiveStatus();

  const refresh = useCallback(async () => {
    try {
      const response = await api<LaneProgressResponse>(
        `/conversations/${encodeURIComponent(threadId)}/delegations/progress`,
      );
      setData({
        lanes: response.lanes,
        runs: response.runs ?? [],
        receivedAt: Date.now(),
        loaded: true,
      });
    } catch {
      // The lanes keep their last known state; the next event or poll retries.
    }
  }, [threadId]);
  const latest = useRef(refresh);
  latest.current = refresh;
  const soon = useMemo(() => debounce(() => void latest.current(), 150), []);
  useEffect(() => () => soon.cancel(), [soon]);
  useEffect(() => {
    setData({ lanes: [], runs: [], receivedAt: 0, loaded: false });
    seen.current = undefined;
    void refresh();
  }, [refresh]);

  const lanes = data.lanes;
  const childThreads = useMemo(
    () => new Set(lanes.map((lane) => lane.childThreadId)),
    [lanes],
  );
  const active = lanes.filter((lane) => ACTIVE.has(lane.status));
  const childDots = new Set(active.map((lane) => lane.childDotId));
  const working = active.some((lane) => lane.status === 'working');

  useLiveEvent('delegation.changed', (event) => {
    if (
      event.parentThreadId === threadId ||
      childThreads.has(event.childThreadId)
    )
      soon.schedule();
  });
  useLiveEvent(['turn.started', 'turn.finished'], (event) => {
    if (childThreads.has(event.threadId)) soon.schedule();
  });
  useLiveEvent(['approval.changed', 'handoff.changed'], (event) => {
    if (childThreads.has(event.threadId)) soon.schedule();
  });
  useLiveEvent('usage.updated', (event) => {
    if (childDots.has(event.dotId)) soon.schedule();
  });
  useLiveEvent('task.changed', () => {
    if (active.length) soon.schedule();
  });
  useLiveReset(() => soon.schedule());
  // Text streams without events: poll briskly while a teammate works, slowly while one waits.
  const every = working
    ? WORKING_POLL_MS
    : active.length
      ? pollInterval(live)
      : undefined;
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden)
        void latest.current();
    }, every);
    return () => clearInterval(timer);
  }, [every]);

  const dotById = useMemo(
    () => new Map(dots.map((dot) => [dot.id, dot])),
    [dots],
  );
  const name = useCallback(
    (id: string) => dotById.get(id)?.name ?? 'A teammate',
    [dotById],
  );

  // New hand-offs play the animation; every change of a lane's state is announced (politely,
  // at most once per 2 s per lane). Nothing is announced for what was already there on load.
  useEffect(() => {
    if (!data.loaded) return;
    const now = Date.now();
    const states = new Map(
      lanes.map((lane) => [
        lane.id,
        `${name(lane.childDotId)}: ${laneView(lane, name(lane.childDotId)).line}`,
      ]),
    );
    const before = seen.current;
    seen.current = states;
    if (!before) {
      for (const [id, text] of states) announcer.current.offer(id, text, 0);
      return;
    }
    const added = lanes.filter(
      (lane) => !before.has(lane.id) && now - lane.createdAt < FRESH_MS,
    );
    if (added.length) {
      setFresh((current) => new Set([...current, ...added.map((l) => l.id)]));
      setHandingOff(true);
    }
    const spoken: string[] = [];
    for (const [id, text] of states) {
      if (before.get(id) === text) continue;
      const said = announcer.current.offer(id, text, now);
      if (said) spoken.push(said);
    }
    if (spoken.length) setAnnouncement(spoken.join('. '));
  }, [data, lanes, name]);
  // Changes that had to wait for their lane's gap.
  useEffect(() => {
    const at = announcer.current.nextAt();
    if (at === undefined) return;
    const timer = setTimeout(
      () => {
        const ready = announcer.current.due(Date.now());
        if (ready.length) setAnnouncement(ready.join('. '));
      },
      Math.max(0, at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [data, announcement]);
  useEffect(() => {
    if (!handingOff) return;
    const timer = setTimeout(() => setHandingOff(false), 1400);
    return () => clearTimeout(timer);
  }, [handingOff]);

  const act = useCallback(async (id: string, run: () => Promise<unknown>) => {
    setPending((current) => new Set([...current, id]));
    setError('');
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      await latest.current();
    }
  }, []);

  const value: LanesValue = {
    threadId,
    hostDot,
    lanes,
    runs: data.runs,
    receivedAt: data.receivedAt,
    loaded: data.loaded,
    dot: (id) => dotById.get(id),
    skipped,
    skip: (id) => setSkipped((current) => new Set([...current, id])),
    stop: (id) =>
      act(id, () =>
        api(`/delegations/${encodeURIComponent(id)}/stop`, 'POST', {}),
      ),
    stopAll: () =>
      act('*', () =>
        api(
          `/conversations/${encodeURIComponent(threadId)}/delegations/stop`,
          'POST',
          {},
        ),
      ),
    retry: (id) =>
      act(id, () =>
        api(`/delegations/${encodeURIComponent(id)}/retry`, 'POST', {}),
      ),
    expanded,
    toggle: (id) => setExpanded((current) => toggleExpanded(current, id)),
    decide: (id, decision, note) =>
      act(id, () =>
        api(`/approvals/${encodeURIComponent(id)}`, 'POST', {
          decision,
          ...(note ? { note } : {}),
        }),
      ),
    onOpenThread,
    takeOver: (lane) =>
      act(lane.id, async () => {
        await requestControl(lane.childDotId);
        onComputer?.();
        onOpenThread?.(lane.childThreadId);
      }),
    fresh,
    played: (ids) =>
      setFresh((current) => {
        if (!ids.some((id) => current.has(id))) return current;
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      }),
    pending,
    error,
    clearError: () => setError(''),
    loadResult: async (id) =>
      (
        await api<{ delegation: Delegation }>(
          `/delegations/${encodeURIComponent(id)}`,
        )
      ).delegation.result ?? '',
  };
  const running = active.length > 0;
  // The polite announcements, and what went wrong with the owner's last lane action.
  const announcerNode: ReactNode = (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {error && (
        <div className="chat-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
  return { value, running, handingOff, announcer: announcerNode };
}
