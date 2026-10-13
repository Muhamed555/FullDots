// The lanes of the open chat, shared with the transcript's work bands and result cards. Kept apart
// from useLanes so the transcript (and its server-side render in tests) needs no API or feed.
import { createContext, useContext } from 'react';
import type { LaneProgress } from '../../shared/lanes';
import type { TeamRunBand } from '../../shared/teams';
import type { Dot } from '../../shared/types';
import type { DecideApproval } from '../ApprovalCard';

export interface LanesValue {
  threadId: string;
  /** The Dot of this chat: the one that hands work over. */
  hostDot: Dot;
  lanes: LaneProgress[];
  /** The chat's team runs: each start_team_run (or direct dispatch) draws its run's band. */
  runs?: TeamRunBand[];
  /** When the progress arrived (client clock), so timers count on from it. */
  receivedAt: number;
  loaded: boolean;
  dot(id: string): Dot | undefined;
  /** Failed lanes the owner chose to skip (kept in this tab only). */
  skipped: ReadonlySet<string>;
  skip(id: string): void;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  retry(id: string): Promise<void>;
  /** Lanes whose live transcript is open, oldest first. */
  expanded: readonly string[];
  toggle(id: string): void;
  decide: DecideApproval;
  onOpenThread?: (id: string) => void;
  takeOver(lane: LaneProgress): Promise<void>;
  /** Lane ids whose hand-off animation should play once. */
  fresh: ReadonlySet<string>;
  /** Marks the animation of these lanes as played. */
  played(ids: string[]): void;
  /** Lane ids with an action in flight. */
  pending: ReadonlySet<string>;
  error: string;
  clearError(): void;
  /** The whole result of a hand-off (the progress carries its start only). */
  loadResult(id: string): Promise<string>;
}

export const LanesContext = createContext<LanesValue | null>(null);

export const useLanesContext = () => useContext(LanesContext);
