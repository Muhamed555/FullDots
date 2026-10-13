// What each Dot is doing right now, for its sidebar row: working (it holds a turn) or needs-input
// (an approval, a takeover or a question waits for the owner). Read from GET /api/mission, again
// whenever the live feed says a turn or something waiting for the owner changed.
import { useCallback, useState } from 'react';
import type { MissionResponse } from '../../shared/inbox';
import { api } from '../api';
import { useLiveRefresh } from '../live-refresh';

export type DotLiveState = 'working' | 'needs-input';

const EVENTS = [
  'turn.started',
  'turn.finished',
  'approval.changed',
  'handoff.changed',
  'inbox.changed',
  'workspace.changed',
] as const;

/** Dot id to its live state; Dots that are idle or paused are left out. */
export function liveStates(
  mission: Pick<MissionResponse, 'dots'>,
): Map<string, DotLiveState> {
  const states = new Map<string, DotLiveState>();
  for (const dot of mission.dots)
    if (dot.state === 'working' || dot.state === 'needs-input')
      states.set(dot.id, dot.state);
  return states;
}

export function useDotLive(): ReadonlyMap<string, DotLiveState> {
  const [states, setStates] = useState<ReadonlyMap<string, DotLiveState>>(
    () => new Map(),
  );
  const refresh = useCallback(async () => {
    try {
      setStates(liveStates(await api<MissionResponse>('/mission')));
    } catch {
      // The rows keep their last known state; the next event or poll retries.
    }
  }, []);
  useLiveRefresh(refresh, EVENTS);
  return states;
}
