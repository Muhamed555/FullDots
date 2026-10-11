// Standing goals: a repeating task with an objective. Each run is a turn in the goal's conversation,
// and the Dot closes the goal with `mark_goal_done` once it is achieved (only on that goal's turn).
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Task } from '../shared/types.js';

export interface GoalService {
  /** True when the task is a goal that is still open. */
  isOpenGoal: (taskId: string) => boolean;
  /** Records the outcome; false when the task is not an open goal. */
  complete: (taskId: string, summary: string) => boolean;
}

export const markGoalDoneInput = z
  .object({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe('Two or three sentences for the owner: what was achieved.'),
  })
  .strict();

export function goalTools(goals: GoalService, taskId: string) {
  return [
    defineTool({
      name: 'mark_goal_done',
      description:
        'Close the standing goal this turn is working on, once its objective is fully achieved. No more runs are scheduled afterwards. Do not call it for partial progress.',
      parameters: markGoalDoneInput,
      execute: async ({ summary }) =>
        goals.complete(taskId, summary)
          ? {
              done: true,
              note: 'The goal is closed. No more runs are scheduled.',
            }
          : { done: false, error: 'This turn is not working on an open goal.' },
    }),
  ];
}

/** What the Dot is told on a goal's turn, next to its usual instructions. */
export const goalSystemPrompt =
  'This turn works on a standing goal that runs again on a schedule until it is achieved. Earlier runs are in this conversation. When the objective is fully achieved, call mark_goal_done with a short summary. Otherwise do the next useful step and end with what you did and what remains.';

/** The message that starts one run of a goal. */
export function goalRunPrompt(
  goal: Pick<Task, 'prompt' | 'runCount' | 'maxRuns'>,
) {
  const run = goal.runCount + 1;
  const limit = goal.maxRuns ? ` of at most ${goal.maxRuns}` : '';
  return `Standing goal, run ${run}${limit}: ${goal.prompt}\n\nCheck what has been done so far in this conversation, then take the next step toward the goal. If it is fully achieved, call mark_goal_done.`;
}
