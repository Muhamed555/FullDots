// The named teams and which Dots hold a turn right now, kept fresh by the live event feed (with
// the shared slow poll as a fallback).
import { useCallback, useState } from 'react';
import type { Team } from '../../shared/teams';
import { api } from '../api';
import { useLiveRefresh } from '../live-refresh';

export const TEAM_REFRESH_EVENTS = [
  'workspace.changed',
  'turn.started',
  'turn.finished',
  'delegation.changed',
] as const;

export interface TeamsState {
  teams: Team[];
  /** Dots running a turn: a team row pulses while any of its Dots works. */
  working: ReadonlySet<string>;
  refresh: () => Promise<void>;
}

export function useTeams(): TeamsState {
  const [teams, setTeams] = useState<Team[]>([]);
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const data = await api<{ teams: Team[]; workingDotIds?: string[] }>(
        '/teams',
      );
      setTeams(data.teams ?? []);
      setWorking(new Set(data.workingDotIds ?? []));
    } catch {
      // An older server without teams, or a blip: keep what is shown; the next event retries.
    }
  }, []);
  useLiveRefresh(refresh, TEAM_REFRESH_EVENTS);
  return { teams, working, refresh };
}
