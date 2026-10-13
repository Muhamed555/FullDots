// `ask_owner`: a Dot working in the background asks the owner a question. Like `request_approval`
// it is answered by the approval gate (src/server/approval-gate.ts), which stores the question and
// wraps up the turn; the placeholder executor below never runs while the gate is installed. A
// question unlocks nothing: the answer only starts a new turn in the same thread.
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

export const askOwnerInput = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'The question, in one or two sentences the owner can answer without opening the conversation. Never ask for a password or a code.',
      ),
  })
  .strict();
export type AskOwnerInput = z.infer<typeof askOwnerInput>;

/** What the gate returns to the model once the question is stored. */
export interface QuestionResult {
  status: 'question';
  questionId: string;
  note: string;
}

export function askOwnerTool() {
  return defineTool({
    name: 'ask_owner',
    description:
      "Ask the owner a question you genuinely cannot decide yourself while you work in the background (a choice between options, a missing detail only they know). The question goes to the owner's inbox. After calling it, stop using tools and summarize: you will be resumed in this conversation with the answer, or told that there is none.",
    parameters: askOwnerInput,
    execute: async () => ({
      error: 'This tool is handled by the approval system.',
    }),
  });
}

/** The line a background turn adds to the Dot's system prompt. */
export const askOwnerPrompt =
  'You are working in the background and the owner is not watching this conversation. When you need a decision or a detail only the owner can give, call `ask_owner({ question })` once and stop; do not ask in your reply text. Do not ask about things you can reasonably decide yourself.';
