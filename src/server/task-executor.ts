// The background runner the server starts: each claimed task runs as a turn in its conversation,
// skipping busy, waiting, paused and over-budget Dots. Kept out of index.ts so tests and the team
// bench (scripts/team-bench.ts) run exactly what the server runs.
import type { TaskKind } from '../shared/types.js';
import { goalRunPrompt } from './goal-tools.js';
import {
  defaultLimits,
  hasTimeLimit,
  NO_TIME_LIMIT_MS,
  type Limits,
} from './limits.js';
import type { Platform } from './platform.js';
import type { Config } from './research.js';
import { Runner } from './runner.js';
import { isDotBusy } from './turn-registry.js';

/**
 * How much longer the runner waits than a delegation turn's own limit: the Dot stops itself first,
 * with a notice the Dot that asked receives as the result, instead of a bare failure.
 */
export const DELEGATION_RUN_MARGIN_MS = 15_000;

/** The run time limit (and so the lease) of each kind of background task. */
export function runTimeouts(
  limits: Pick<Limits, 'taskTimeoutMs' | 'delegationTimeoutMs'>,
): (kind: TaskKind) => number {
  return (kind) =>
    kind === 'delegation'
      ? hasTimeLimit(limits.delegationTimeoutMs)
        ? limits.delegationTimeoutMs + DELEGATION_RUN_MARGIN_MS
        : NO_TIME_LIMIT_MS
      : limits.taskTimeoutMs;
}

export function createBackgroundRunner(platform: Platform, research: Config) {
  const { store, workspace, turns, config } = platform;
  const limits = config.limits ?? defaultLimits;
  return new Runner(
    store,
    research,
    async (claim, _memories, signal, progress) => {
      const threadId = workspace.taskThread(claim.id);
      if (!threadId)
        throw new Error(
          'This legacy task has no conversation. Create a new scheduled task from a conversation.',
        );
      progress(
        claim.kind === 'goal'
          ? `Working on the goal (run ${claim.runCount + 1}).`
          : 'Running this task in its conversation.',
      );
      const delegation =
        claim.kind === 'delegation'
          ? workspace.team.byTask(claim.id)
          : undefined;
      let text: string;
      try {
        text = await platform.turn(
          threadId,
          claim.kind === 'goal' ? goalRunPrompt(claim) : claim.prompt,
          signal,
          delegation
            ? {
                source: 'delegation',
                ref: delegation.id,
                // The teammate's turn gets DELEGATION_TIMEOUT in place of the chat turn limit.
                turnLimitMs: limits.delegationTimeoutMs,
              }
            : {
                source: claim.kind === 'event' ? 'trigger' : 'task',
                ref: claim.id,
              },
        );
      } catch (error) {
        // A busy Dot only postpones the hand-off; anything else is reported to the Dot that asked.
        if (delegation && !isDotBusy(error))
          platform.team.failed(
            claim.id,
            error instanceof Error ? error.message : 'The run failed.',
          );
        throw error;
      }
      if (delegation) platform.team.completed(claim.id, text);
      // The owner's inbox gets the result of their own background work; a teammate's goes to its lead.
      else
        platform.finishedWork(
          threadId,
          claim.kind === 'goal'
            ? 'goal'
            : claim.kind === 'event'
              ? 'trigger'
              : 'task',
          text,
        );
      return { text, sources: [], sample: false };
    },
    runTimeouts(limits),
    {
      concurrency: config.backgroundConcurrency,
      dotOf: (taskId) => workspace.taskDot(taskId),
      excluded: (activeDotIds) => {
        const { threadIds, dotIds } = turns.exclusions();
        return workspace.taskIdsFor({
          threadIds,
          // Dots over today's token budget wait for tomorrow.
          dotIds: [
            ...dotIds,
            ...activeDotIds,
            ...workspace.usage.overBudgetDots(),
            ...workspace.pausedDotIds(),
          ],
        });
      },
    },
  );
}
