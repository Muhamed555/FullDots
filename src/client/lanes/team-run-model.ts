// Pure helpers behind a team run's work band: which run a call started, the run's phase, its
// reviewer badge and what each step's lane shows.
import type { ToolCall } from '@ag-ui/core';
import type { LaneProgress } from '../../shared/lanes';
import type { TeamRunBand } from '../../shared/teams';
import { latestAttempt } from './lane-model';

/** What a start_team_run (or a direct chat's team_dispatch) call says about its run. */
export interface RunCall {
  runId?: string;
  /** No result yet: the call is still running. */
  pending: boolean;
  /** Why the run did not start. */
  error?: string;
  members: string[];
}

function parse(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function runCall(call: ToolCall, raw: string | undefined): RunCall {
  const result = parse(raw);
  const args = parse(call.function.arguments);
  const runId =
    (typeof result?.runId === 'string' && result.runId) ||
    (typeof args?.runId === 'string' && args.runId) ||
    undefined;
  const members = Array.isArray(result?.members)
    ? result.members.filter((item): item is string => typeof item === 'string')
    : [];
  if (raw === undefined) return { pending: true, members };
  if (result?.started !== true)
    return {
      pending: false,
      members,
      error:
        typeof result?.error === 'string'
          ? result.error
          : 'The team run did not start.',
    };
  return { pending: false, members, ...(runId ? { runId } : {}) };
}

/**
 * Where a run is: members at work, the reviewer checking (their results folded under it), members
 * revising after a send-back, or finished.
 */
export type RunPhase = 'working' | 'reviewing' | 'revising' | 'settled';

export function runPhase(run: TeamRunBand): RunPhase {
  if (run.status !== 'running') return 'settled';
  const reviewer = run.steps.find((step) => step.role === 'reviewer');
  if (!reviewer) return 'working';
  if (reviewer.status === 'running') return 'reviewing';
  if (reviewer.status === 'queued' && run.sentBack) return 'revising';
  return 'working';
}

/** The reviewer's badge: "Sent back" while members revise, "Checked by ..." after its check. */
export function reviewBadge(
  run: TeamRunBand,
  reviewerName: string,
): { text: string; tone: 'sent-back' | 'checked' | 'unchecked' } | undefined {
  const reviewer = run.steps.find((step) => step.role === 'reviewer');
  if (!reviewer) return undefined;
  if (runPhase(run) === 'revising')
    return { text: 'Sent back', tone: 'sent-back' };
  if (reviewer.status === 'done')
    return {
      text:
        run.verdict === 'changes'
          ? `Checked by ${reviewerName} · changes still asked`
          : `Checked by ${reviewerName}`,
      tone: 'checked',
    };
  if (run.status !== 'running')
    return { text: 'Not reviewed', tone: 'unchecked' };
  return undefined;
}

export interface StepEntry {
  step: TeamRunBand['steps'][number];
  /** The lane of its newest delegation (after a send-back or a Try again). */
  lane?: LaneProgress;
}

/** The members' steps in member order, each with its lane once started. */
export function workerEntries(
  run: TeamRunBand,
  lanes: readonly LaneProgress[],
): StepEntry[] {
  return run.steps
    .filter((step) => step.role === 'worker')
    .sort((a, b) => a.position - b.position)
    .map((step) => {
      const lane = step.delegationId
        ? latestAttempt(step.delegationId, lanes)
        : undefined;
      return { step, ...(lane ? { lane } : {}) };
    });
}

export function reviewerEntry(
  run: TeamRunBand,
  lanes: readonly LaneProgress[],
): StepEntry | undefined {
  const step = run.steps.find((item) => item.role === 'reviewer');
  if (!step) return undefined;
  const lane = step.delegationId
    ? latestAttempt(step.delegationId, lanes)
    : undefined;
  return { step, ...(lane ? { lane } : {}) };
}

/** What a step without a lane says: it waits its turn, was skipped, or was stopped. */
export function waitingLine(
  entry: StepEntry,
  previous: string | undefined,
  sequential: boolean,
): string {
  switch (entry.step.status) {
    case 'skipped':
      return 'Skipped: an earlier step did not finish';
    case 'cancelled':
      return 'Stopped by you';
    case 'failed':
      return 'Could not start';
    default:
      return sequential && previous ? `Waits for ${previous}` : 'Queued';
  }
}

/**
 * The lanes a team run's result turn delivered (its `ref` is the run id): each member's newest,
 * then the reviewer's. Undefined when `ref` names no team run of this chat.
 */
export function runResultLanes(
  ref: string,
  runs: readonly TeamRunBand[] | undefined,
  lanes: readonly LaneProgress[],
): LaneProgress[] | undefined {
  const run = runs?.find((item) => item.id === ref);
  if (!run) return undefined;
  const reviewer = reviewerEntry(run, lanes);
  return [...workerEntries(run, lanes), ...(reviewer ? [reviewer] : [])]
    .map((entry) => entry.lane)
    .filter((lane): lane is LaneProgress => !!lane);
}
