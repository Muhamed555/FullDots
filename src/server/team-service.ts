// Teams of Dots: a Dot hands a brief to a teammate, the teammate works on it in a new conversation of
// its own (a background task, with its own model, permissions, approvals and budget), and the result
// comes back to the original conversation as a resume turn.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Delegation, Dot } from '../shared/types.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import type { NewResumeMarker } from './resume-store.js';

/** Hand-offs per turn, so one turn cannot fan out without bound. */
export const DELEGATIONS_PER_TURN = 3;

export interface TeamServiceDeps {
  workspace: WorkspaceStore;
  store: Store;
  /** = resumes.enqueue */
  resume: (marker: NewResumeMarker) => void;
  /** How many hand-offs may chain (A to B to C is 2). Default 2. */
  maxDepth?: number;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 120) ?? '';

export class TeamService {
  readonly maxDepth: number;
  constructor(private deps: TeamServiceDeps) {
    this.maxDepth = deps.maxDepth ?? 2;
  }

  get(id: string): Delegation | undefined {
    return this.deps.workspace.team.get(id);
  }

  /** The Dots this Dot may hand work to. */
  teammates(dotId: string): Dot[] {
    const { workspace } = this.deps;
    return workspace.team
      .delegates(dotId)
      .map((id) => workspace.dot(id))
      .filter((dot): dot is Dot => !!dot);
  }

  /** 0 for an ordinary conversation, 1 for one created by a hand-off, and so on. */
  depthOf(threadId: string): number {
    return this.deps.workspace.team.byChildThread(threadId)?.depth ?? 0;
  }

  /** The Dots above this conversation in its chain of hand-offs. */
  private ancestors(threadId: string): string[] {
    const dots: string[] = [];
    let current = this.deps.workspace.team.byChildThread(threadId);
    for (let guard = 0; current && guard < 20; guard++) {
      dots.push(current.parentDotId);
      current = this.deps.workspace.team.byChildThread(current.parentThreadId);
    }
    return dots;
  }

  /** Whether a turn in this conversation may hand work on at all. */
  canDelegate(dotId: string, threadId: string): boolean {
    return (
      this.teammates(dotId).length > 0 && this.depthOf(threadId) < this.maxDepth
    );
  }

  delegate(input: {
    fromDotId: string;
    threadId: string;
    to: string;
    brief: string;
    deliverable: string;
  }): Delegation {
    const { workspace, store } = this.deps;
    const from = workspace.dot(input.fromDotId);
    if (!from) throw new Error('Dot not found.');
    const team = this.teammates(from.id);
    const wanted = input.to.trim().toLowerCase();
    const target = team.find(
      (dot) => dot.id === input.to || dot.name.toLowerCase() === wanted,
    );
    if (!target)
      throw new Error(
        team.length
          ? `${input.to} is not on your team. You can hand work to: ${team.map((dot) => dot.name).join(', ')}.`
          : 'You have no teammates to hand work to.',
      );
    const depth = this.depthOf(input.threadId) + 1;
    if (depth > this.maxDepth)
      throw new Error(
        `Hand-offs can only go ${this.maxDepth} levels deep. Do this part yourself.`,
      );
    if (
      target.id === from.id ||
      this.ancestors(input.threadId).includes(target.id)
    )
      throw new Error(
        `${target.name} already handed this work down; handing it back would loop. Do it yourself or report back.`,
      );
    const child = workspace.bindThread(
      randomUUID(),
      target.id,
      `From ${from.name}: ${firstLine(input.brief).slice(0, 60)}`,
    );
    const prompt = `${from.name} handed you this work.\n\nBrief: ${input.brief}\n\nWhat to deliver: ${input.deliverable}\n\nDo the work, then end with the deliverable. Your final answer is sent back to ${from.name}.`;
    const task = store.createTask(prompt, { kind: 'delegation' });
    workspace.bindTask(task.id, child.id);
    return workspace.team.create({
      parentThreadId: input.threadId,
      parentDotId: from.id,
      childThreadId: child.id,
      childDotId: target.id,
      taskId: task.id,
      depth,
      brief: input.brief,
      deliverable: input.deliverable,
    });
  }

  private report(delegation: Delegation, prompt: string) {
    this.deps.resume({
      kind: 'delegation',
      refId: delegation.id,
      threadId: delegation.parentThreadId,
      dotId: delegation.parentDotId,
      prompt,
      source: 'delegation',
    });
  }

  /** The teammate finished: record the result and give it to the Dot that asked. */
  completed(taskId: string, text: string) {
    const delegation = this.deps.workspace.team.byTask(taskId);
    if (!delegation || delegation.status !== 'running') return;
    this.deps.workspace.team.finish(delegation.id, 'done', text);
    const name =
      this.deps.workspace.dot(delegation.childDotId)?.name ?? 'Your teammate';
    this.report(
      delegation,
      `${name} finished the work you handed over.\n\nBrief: ${delegation.brief}\n\nResult:\n${text}\n\nContinue from here: use the result and tell the owner what it means for their request.`,
    );
  }

  /** The teammate's run failed: tell the Dot that asked, so it can decide what to do. */
  failed(taskId: string, error: string) {
    const delegation = this.deps.workspace.team.byTask(taskId);
    if (!delegation || delegation.status !== 'running') return;
    this.deps.workspace.team.finish(delegation.id, 'failed', error);
    const name =
      this.deps.workspace.dot(delegation.childDotId)?.name ?? 'Your teammate';
    this.report(
      delegation,
      `${name} could not finish the work you handed over (${error.slice(0, 300)}).\n\nBrief: ${delegation.brief}\n\nDecide what to do next: do it yourself, or tell the owner.`,
    );
  }

  /** Cancels the hand-offs still running from a conversation (when it is deleted). */
  cancelFrom(threadId: string) {
    for (const delegation of this.deps.workspace.team.forParent(threadId))
      if (delegation.status === 'running') {
        this.deps.store.action(delegation.taskId, 'cancel');
        this.deps.workspace.team.finish(
          delegation.id,
          'failed',
          'Cancelled: the conversation that asked for it was deleted.',
        );
      }
  }
}

export const delegateInput = z
  .object({
    dot: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('The teammate: its name (or id).'),
    brief: z
      .string()
      .trim()
      .min(10)
      .max(4000)
      .describe(
        'What the teammate should do, with the context it needs. It does not see this conversation.',
      ),
    deliverable: z
      .string()
      .trim()
      .min(3)
      .max(1000)
      .describe(
        'What it should hand back, for example "a 5-bullet summary with sources".',
      ),
  })
  .strict();

/** The tools a Dot gets when it has teammates: hand work over, and check on it. */
export function teamTools(
  team: TeamService,
  context: { dotId: string; threadId: string },
) {
  let handed = 0;
  return [
    defineTool({
      name: 'delegate_to_dot',
      description:
        'Hand a piece of work to a teammate Dot. It works in its own conversation with its own tools, and its result comes back to this conversation as a new message. After handing work over, tell the owner and end your turn instead of waiting.',
      parameters: delegateInput,
      execute: async ({ dot, brief, deliverable }) => {
        if (handed >= DELEGATIONS_PER_TURN)
          return {
            started: false,
            error: `You can hand over at most ${DELEGATIONS_PER_TURN} pieces of work per turn.`,
          };
        try {
          const delegation = team.delegate({
            fromDotId: context.dotId,
            threadId: context.threadId,
            to: dot,
            brief,
            deliverable,
          });
          handed++;
          return {
            started: true,
            id: delegation.id,
            note: 'Handed over. The result will arrive in this conversation as a new message.',
          };
        } catch (error) {
          return {
            started: false,
            error:
              error instanceof Error ? error.message : 'Could not hand over.',
          };
        }
      },
    }),
    defineTool({
      name: 'check_delegation',
      description:
        'Check on work handed to a teammate: running, done (with its result) or failed.',
      parameters: z.object({ id: z.string().min(1).max(100) }).strict(),
      execute: async ({ id }) => {
        const delegation = team.get(id);
        if (!delegation || delegation.parentThreadId !== context.threadId)
          return { error: 'No hand-off with that id in this conversation.' };
        return {
          status: delegation.status,
          ...(delegation.result ? { result: delegation.result } : {}),
        };
      },
    }),
  ];
}

/** What a Dot with teammates is told. */
export function teamPrompt(teammates: Dot[]): string {
  const list = teammates
    .map((dot) => `${dot.name} (${firstLine(dot.instructions).slice(0, 80)})`)
    .join('; ');
  return `You can hand work to teammate Dots: ${list}. Use delegate_to_dot with a clear, self-contained brief and the deliverable you need when a teammate's role fits part of the task better. Their result comes back here as a new message.`;
}
