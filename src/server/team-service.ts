// Teams of Dots: a Dot hands a brief to a teammate, the teammate works on it in a new conversation of
// its own (a background task, with its own model, permissions, approvals and budget), and the result
// comes back to the original conversation as a resume turn.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Delegation, Dot, TurnSource } from '../shared/types.js';
import {
  deriveTitle,
  MAX_CONVERSATION_TITLE_LENGTH,
} from '../shared/conversation-title.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import type { NewResumeMarker, ResumeMarker } from './resume-store.js';
import type { ResumeBatches } from './resume-queue.js';

/** Hand-offs per turn, so one turn cannot fan out without bound. */
export const DELEGATIONS_PER_TURN = 3;

/** Hand-offs one turn made so far: delegate_to_dot and hand_to_dot share it. */
export interface HandOffCounter {
  handed: number;
}

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

  /** The child conversation's title: "Lead → Member: first line of the brief". */
  static title(lead: string, member: string, brief: string): string {
    const head = `${lead} → ${member}: `;
    const room = Math.max(
      20,
      Math.min(60, MAX_CONVERSATION_TITLE_LENGTH - head.length),
    );
    return `${head}${deriveTitle(brief, 'Handed-over work', room)}`.slice(
      0,
      MAX_CONVERSATION_TITLE_LENGTH,
    );
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
    /** The run of the turn that hands the work over; its hand-offs report back together. */
    runId?: string;
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
      TeamService.title(from.name, target.name, input.brief),
    );
    const prompt = `${from.name} handed you this work.\n\nBrief: ${input.brief}\n\nWhat to deliver: ${input.deliverable}\n\nDo the work, then reply with the deliverable only: no preamble, no plan, no "I am ready", no notes about what you are about to do. Your final reply goes to ${from.name} exactly as you write it.`;
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
      batchKey: input.runId ? `${input.threadId}:${input.runId}` : null,
    });
  }

  /** A turn started: a delegation turn in a hand-off's conversation is the teammate starting. */
  started(threadId: string, source: TurnSource | 'chat') {
    if (source !== 'delegation') return;
    const delegation = this.deps.workspace.team.byChildThread(threadId);
    if (delegation?.status === 'running' && delegation.startedAt === null)
      this.deps.workspace.team.markStarted(delegation.id);
  }

  /** How the resume queue delivers the results of one turn's hand-offs together. */
  batches(windowMs: number): ResumeBatches {
    const { team } = this.deps.workspace;
    const of = (markers: ResumeMarker[]) =>
      markers
        .filter((marker) => marker.kind === 'delegation')
        .map((marker) => team.get(marker.refId))
        .filter((delegation): delegation is Delegation => !!delegation);
    return {
      windowMs,
      settled: (batchKey) =>
        team
          .inBatch(batchKey)
          .every((delegation) => delegation.status !== 'running'),
      prompt: (markers) => this.batchPrompt(of(markers)),
      delivered: (markers, now) =>
        team.markDelivered(
          of(markers).map((delegation) => delegation.id),
          now,
        ),
    };
  }

  /** One message with every result of a batch, a section per teammate. */
  batchPrompt(delegations: Delegation[]): string {
    const name = (delegation: Delegation) =>
      this.deps.workspace.dot(delegation.childDotId)?.name ?? 'Your teammate';
    const sections = delegations.map((delegation) =>
      delegation.status === 'done'
        ? `## ${name(delegation)}: done\n\nBrief: ${delegation.brief}\n\nResult:\n${delegation.result ?? ''}`
        : `## ${name(delegation)}: could not finish\n\nBrief: ${delegation.brief}\n\nWhat went wrong: ${(delegation.result ?? 'unknown error').slice(0, 300)}`,
    );
    const failed = delegations.some(
      (delegation) => delegation.status !== 'done',
    );
    return `Your teammates finished the work you handed over (${delegations.length} results).\n\n${sections.join('\n\n')}\n\nContinue from here: use the results together and tell the owner what they mean for their request.${failed ? ' For the work that could not be finished, do it yourself or tell the owner.' : ''}`;
  }

  private report(delegation: Delegation, prompt: string) {
    this.deps.resume({
      kind: 'delegation',
      refId: delegation.id,
      threadId: delegation.parentThreadId,
      dotId: delegation.parentDotId,
      prompt,
      source: 'delegation',
      // Null (a hand-off made outside a run) goes back on its own.
      batchKey: delegation.batchKey,
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
  context: {
    dotId: string;
    threadId: string;
    runId?: string;
    counter?: HandOffCounter;
  },
) {
  const counter = context.counter ?? { handed: 0 };
  return [
    defineTool({
      name: 'delegate_to_dot',
      description:
        'Hand a piece of work to a teammate Dot. It works in its own conversation with its own tools, and its result comes back to this conversation as a new message. After handing work over, tell the owner and end your turn instead of waiting.',
      parameters: delegateInput,
      execute: async ({ dot, brief, deliverable }) => {
        if (counter.handed >= DELEGATIONS_PER_TURN)
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
            ...(context.runId ? { runId: context.runId } : {}),
          });
          counter.handed++;
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
