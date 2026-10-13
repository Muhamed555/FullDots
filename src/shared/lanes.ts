// Work lanes: the live view of the work a Dot handed to teammates, drawn as one lane per hand-off in
// the chat that handed it over. GET /api/conversations/:id/delegations/progress serves these (owner
// only); the live event feed only says when to fetch them again.
import type { TeamRunBand } from './teams.js';
import type { Approval, Handoff } from './types.js';

/** What a lane shows: waiting to start, working, waiting for something, or finished. */
export type LaneStatus =
  'queued' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';

/** Why a lane waits. */
export type LaneWait =
  /** The teammate is busy in another chat; it starts when that turn ends. */
  | { kind: 'busy' }
  /** The teammate reached its daily token budget. */
  | { kind: 'budget' }
  /** The teammate (or every Dot) is paused. */
  | { kind: 'paused' }
  /** The teammate asked for an approval in its chat. */
  | { kind: 'approval'; approval: Approval }
  /** The teammate asked the owner to take over its computer. */
  | {
      kind: 'handoff';
      handoff: Pick<Handoff, 'id' | 'kind' | 'reason' | 'dotId'>;
    }
  /** The teammate asked the owner a question (answered in the inbox). */
  | { kind: 'question' }
  /** Nothing will move it on by itself (its run ended without a result): try again or stop. */
  | { kind: 'stalled' };

export interface LaneProgress {
  /** The delegation id. */
  id: string;
  parentThreadId: string;
  parentDotId: string;
  childThreadId: string;
  childDotId: string;
  batchKey: string | null;
  /** The hand-off this one tries again. */
  retryOf: string | null;
  /** 1 for the first try, 2 after one Try again, ... */
  attempt: number;
  brief: string;
  deliverable: string;
  status: LaneStatus;
  wait: LaneWait | null;
  /** What it is doing now ("Opening website", "Thinking"); null once finished. */
  step: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deliveredAt: number | null;
  /** From its start (or hand-off, while queued) to its end or now. */
  elapsedMs: number;
  /** Tokens its runs used so far; null when the model reported none. */
  tokens: number | null;
  /** The last lines of its newest reply (at most two). */
  preview: string[];
  /** The start of its result or error (see `resultLength` for the whole length). */
  result: string | null;
  resultLength: number;
  /** The run streaming in its chat right now. */
  runId: string | null;
}

export interface LaneProgressResponse {
  lanes: LaneProgress[];
  /** The conversation's team runs (their steps; the lanes above carry each started step). */
  runs?: TeamRunBand[];
  /** Server time, so the client's timers line up. */
  now: number;
}

/**
 * The tools whose calls are drawn as a work band: hand-offs, a lead's team run, and the line a
 * direct team chat stores when it sends the owner's message to every member.
 */
export const LANE_TOOLS = [
  'delegate_to_dot',
  'check_delegation',
  'start_team_run',
  'team_dispatch',
] as const;

/** The team run tools among the lane tools: each call draws its run's band. */
export const isTeamRunTool = (name: string) =>
  name === 'start_team_run' || name === 'team_dispatch';

export const isLaneTool = (name: string) =>
  (LANE_TOOLS as readonly string[]).includes(name);

/** Up to `count` short last lines of a reply, without Markdown markers. */
export function previewLines(text: string, count = 2, max = 140): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    .filter((line) => line && !/^\|?[\s:|-]+\|?$/.test(line))
    .slice(-count)
    .map((line) => (line.length > max ? `${line.slice(0, max - 1)}…` : line));
}
