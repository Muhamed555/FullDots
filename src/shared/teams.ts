// Named teams: a lead Dot plus up to eight members, a work style and a mode. Shared by the server
// (storage, routes, team runs) and the client (sidebar, builder, team page).
import type { DotColor } from './types.js';

/** parallel: every member at once; sequential: in member order, each building on the last. */
export type TeamStyle = 'parallel' | 'sequential' | 'review';
export const TEAM_STYLES: readonly TeamStyle[] = [
  'parallel',
  'sequential',
  'review',
];
/** lead: the lead Dot plans and starts the work; direct: the owner's message goes to every member. */
export type TeamMode = 'lead' | 'direct';
export const TEAM_MODES: readonly TeamMode[] = ['lead', 'direct'];

export const TEAM_STYLE_LABELS: Record<TeamStyle, string> = {
  parallel: 'All at once',
  sequential: 'Step by step',
  review: 'With a reviewer',
};
export const TEAM_MODE_LABELS: Record<TeamMode, string> = {
  lead: 'Lead plans',
  direct: 'Direct',
};

/** Members besides the lead. */
export const MAX_TEAM_MEMBERS = 8;
export const TEAM_NAME_MAX = 40;
export const TEAM_ROLE_MAX = 80;
export const TEAM_DESCRIPTION_MAX = 500;

/** The builder's curated emoji grid; any single emoji can be typed instead. */
export const TEAM_EMOJI = [
  '🚀',
  '✨',
  '🧭',
  '🔬',
  '🎨',
  '📣',
  '🛠️',
  '📚',
  '🌱',
  '🦊',
  '🐝',
  '🎯',
  '💡',
  '🧩',
  '🌊',
  '🍀',
] as const;

/**
 * True for exactly one user-perceived character that is an emoji (a flag, a keycap, a skin tone or
 * a ZWJ family all count as one). Plain letters, digits and punctuation do not.
 */
export function isSingleEmoji(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 32) return false;
  const segments =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
            text,
          ),
        ].length
      : Array.from(text).length;
  if (segments !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text);
}

export interface TeamMember {
  dotId: string;
  /** What this member does on the team, shown to the lead and in the member's brief. */
  role: string;
  /** 0-based order; step by step runs in this order. The lead is not a member row. */
  position: number;
}

export interface Team {
  id: string;
  name: string;
  emoji: string;
  color: DotColor;
  description: string;
  leadDotId: string;
  style: TeamStyle;
  mode: TeamMode;
  /** Direct mode: the lead writes one short summary after the results are posted. */
  summarize: boolean;
  /**
   * The reviewer of the 'review' style: checks the members' combined work before the lead hears
   * back. Never the lead and never a member (each Dot takes part in a run once).
   */
  reviewerDotId: string | null;
  /** The team's home Space: members get access, team chats save pages there. */
  spaceId: string | null;
  /** Each finished run writes a page into the team's Space (only when it has one). */
  runLog: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** In member order. */
  members: TeamMember[];
}

export type TeamRunStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type TeamStepStatus =
  'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

/** What the reviewer said: APPROVED, CHANGES, or neither (treated like approved). */
export type ReviewVerdict = 'approved' | 'changes' | 'unclear';

export interface TeamRun {
  id: string;
  teamId: string;
  threadId: string;
  style: TeamStyle;
  mode: TeamMode;
  status: TeamRunStatus;
  createdAt: number;
  finishedAt: number | null;
  cancelledAt: number | null;
  /** The reviewer of a review run (taken from the team when the run started). */
  reviewerDotId: string | null;
  /** The reviewer's latest verdict; null until it gave one. */
  verdict: ReviewVerdict | null;
  /** The reviewer sent the work back (at most once per run). */
  sentBack: boolean;
  /** The run log page in the team's Space, once written. */
  log: { spaceId: string; pageId: string } | null;
}

export type TeamStepRole = 'worker' | 'reviewer';

export interface TeamRunStep {
  runId: string;
  /** Null until a step of a step-by-step run starts (or when it was skipped before starting). */
  delegationId: string | null;
  dotId: string;
  position: number;
  status: TeamStepStatus;
  /** Members are workers; the review style adds one reviewer step after them. */
  role: TeamStepRole;
  /**
   * The step's first delegation when it went round again: a worker the reviewer sent back, or the
   * reviewer checking a second time. `delegationId` is then the newer one.
   */
  firstDelegationId: string | null;
}

/** A run as the work band draws it (in GET /api/conversations/:id/delegations/progress). */
export interface TeamRunBand extends TeamRun {
  teamName: string;
  teamEmoji: string;
  leadDotId: string;
  steps: (TeamRunStep & { brief: string })[];
}

/** The pseudo tool a direct team chat's "Sent to ..." reply carries, so its band is drawn there. */
export const TEAM_DISPATCH_TOOL = 'team_dispatch';

/** GET /api/teams/runs/:id: the run and each step with its timings (ms epoch, null when not yet). */
export interface TeamRunDetail extends TeamRun {
  steps: (TeamRunStep & {
    dotName: string;
    brief: string;
    childThreadId: string | null;
    createdAt: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    deliveredAt: number | null;
  })[];
  durationMs: number | null;
}

/** GET /api/teams/:id: the team with its recent chats and runs. */
export interface TeamDetail extends Team {
  conversations: { id: string; title: string; createdAt: number }[];
  runs: TeamRun[];
}
