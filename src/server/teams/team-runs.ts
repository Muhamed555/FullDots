// Team runs: one piece of work a named team does for one of its chats. The lead starts one with
// start_team_run ("Lead plans"), or the owner's message starts one directly ("Direct"). Each member
// that takes part is a step, run as an ordinary delegation (its own conversation, task, approvals,
// budget and time limit) whose batch key is the run's. The lead hears back once, when the run ends.
//
// Rules:
// - parallel: every step starts at once; the runner's concurrency applies.
// - sequential: steps run strictly in member order, whatever order the briefs came in; each step's
//   prompt carries the previous step's result. A step that fails ends the chain: the steps after it
//   are skipped, and the lead hears what was done.
// - review: the members work at once; when every one of them has finished, the server hands their
//   combined results to the team's reviewer ("check and improve"). If its verdict is CHANGES, the
//   members it names (all of them when it names none) revise once with its notes, and the reviewer
//   checks once more. At most one send-back per run. Then the lead hears the reviewed result plus
//   the raw results. A team without a reviewer runs like parallel.
// - A Dot appears at most once per run; the lead is never a step, the reviewer never a member.
// - start_team_run may be called once per lead turn, and only in turns the owner started (a chat
//   message, or the approval of one), so a team run's own results cannot start another run.
// - Cancelling a run cancels its steps' tasks. A member's turn is stopped only when it runs on that
//   step's own conversation; the same member working in another chat is left alone.
// - A finished run writes its log page into the team's own Space when the team keeps a run log.
import { randomUUID } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import type { Message } from '@ag-ui/core';
import { z } from 'zod';
import type { Delegation, Dot, TurnSource } from '../../shared/types.js';
import {
  TEAM_DISPATCH_TOOL,
  TEAM_STYLE_LABELS,
  type Team,
  type TeamRun,
  type TeamRunBand,
  type TeamRunDetail,
} from '../../shared/teams.js';
import {
  deriveTitle,
  hasDefaultTitle,
} from '../../shared/conversation-title.js';
import type { NewResumeMarker } from '../resume-store.js';
import { teamBatchKey, type TeamService } from '../team-service.js';
import type { RunningTurn } from '../turn-registry.js';
import type { WorkspaceStore } from '../workspace.js';
import type { StoredStep } from './named-team-store.js';
import {
  readVerdict,
  REVIEW_DELIVERABLE,
  reviewBrief,
  reviewMaterial,
  REVIEWER_POSITION,
  revisionContext,
  sentBackTo,
} from './review.js';
import { requestFor, runLogContent, runLogTitle } from './run-log.js';

/** How much of the previous step's result a step-by-step member gets. */
const CARRY_CHARS = 8000;
/** A post that found its chat busy tries again after this long if no turn.finished came first. */
const POST_RETRY_MS = 10_000;

export interface TeamRunDeps {
  workspace: WorkspaceStore;
  team: TeamService;
  /** = resumes.enqueue */
  resume: (marker: NewResumeMarker) => void;
  /** Cancels a background task (store.action(id, 'cancel')). */
  cancelTask: (taskId: string) => void;
  /**
   * Writes the owner's text (or an event line) and a fixed reply of `dotId` into a conversation,
   * without a model call. Rejects with "Thread already running" while a turn runs there. A
   * `toolCall` is stored with the reply (the direct dispatch names its run so the band is drawn).
   */
  post?: (input: {
    threadId: string;
    dotId: string;
    text: string;
    reply: string;
    metadata?: { source: TurnSource; ref?: string };
    toolCall?: { name: string; args: unknown; result: unknown };
  }) => Promise<void>;
  /** Subscribes to finished turns; returns the unsubscribe function. */
  onTurnFinished?: (
    listener: (turn: { threadId: string }) => void,
  ) => () => void;
  turns?: {
    running: () => RunningTurn[];
    stop: (dotId: string) => boolean;
  };
  /** A direct run's results reached its chat: the owner's inbox gets them. */
  finished?: (threadId: string, text: string) => void;
  /** The stored messages of a conversation (to find the owner's request for the run log). */
  messages?: (threadId: string) => Message[];
  /** A run log page was written (the live feed tells open pages). */
  logged?: (spaceId: string) => void;
  log?: (line: string) => void;
}

const startTeamRunInput = z
  .object({
    briefs: z
      .record(
        z.string().trim().min(1).max(100),
        z.string().trim().min(3).max(4000),
      )
      .optional()
      .describe(
        'One brief per member who should help, keyed by the member name. Each member sees only its own brief (and the shared one), not this conversation.',
      ),
    shared: z
      .string()
      .trim()
      .min(3)
      .max(4000)
      .optional()
      .describe(
        'Context every member gets. Given alone, every member gets it as their brief.',
      ),
  })
  .strict();
export type StartTeamRunInput = z.infer<typeof startTeamRunInput>;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export class TeamRunService {
  private posting = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private deps: TeamRunDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
  }

  private dot(id: string): Dot | undefined {
    return this.deps.workspace.dot(id);
  }

  private name(id: string): string {
    return this.dot(id)?.name ?? 'A teammate';
  }

  /** The active team a conversation belongs to. */
  teamOf(threadId: string): Team | undefined {
    const team = this.deps.workspace.teams.threadTeam(threadId);
    return team && !team.archivedAt ? team : undefined;
  }

  /** The reviewer a run of this team gets: only for the review style, never the lead or a member. */
  private reviewerOf(team: Team): Dot | undefined {
    const id = team.reviewerDotId;
    if (team.style !== 'review' || !id || id === team.leadDotId) return;
    if (team.members.some((member) => member.dotId === id)) return;
    return this.dot(id);
  }

  /** What the lead is told about its team in a team chat. */
  prompt(team: Team): string {
    const members = team.members
      .map(
        (member, index) =>
          `${index + 1}. ${this.name(member.dotId)}${member.role ? ` (${member.role})` : ''}`,
      )
      .join('; ');
    const reviewer = this.reviewerOf(team);
    const style =
      team.style === 'sequential'
        ? 'Step by step: the members work one after another in the order above, each building on the previous result; members without a brief are skipped.'
        : reviewer
          ? `With a reviewer: every member with a brief works at the same time, then ${reviewer.name} checks and improves their combined work (sending it back once at most). You get the reviewed result and the raw results.`
          : 'All at once: every member with a brief works at the same time.';
    const how =
      team.mode === 'lead'
        ? ` To put the team to work, call start_team_run once with a brief per member who should help (briefs keyed by member name), or one shared brief for everyone. You can start one team run per turn. The results come back to you in one message; then combine them for the owner.`
        : ` In this chat the owner's messages go straight to every member, and their results are posted here.`;
    return `This is a team chat. You lead the team ${team.emoji} ${team.name}${team.description ? ` (${team.description})` : ''}. Members, in order: ${members || 'none yet'}. ${style}${how}`;
  }

  /**
   * The team context and tool for one turn of `dotId` in `threadId`: only the lead of the team the
   * chat belongs to gets them, and the tool only in a "Lead plans" team and in a turn the owner
   * started.
   */
  forTurn(input: {
    dotId: string;
    threadId: string;
    source: TurnSource | 'chat';
  }): { prompt: string; tools: ToolDefinition[] } | undefined {
    const team = this.teamOf(input.threadId);
    if (!team || team.leadDotId !== input.dotId) return undefined;
    const tools =
      team.mode === 'lead' &&
      team.members.length > 0 &&
      (input.source === 'chat' || input.source === 'approval')
        ? [this.tool(team.id, input.threadId)]
        : [];
    return { prompt: this.prompt(team), tools };
  }

  /** start_team_run for one turn: a fresh "already used" flag per turn. */
  private tool(teamId: string, threadId: string) {
    let used = false;
    return defineTool({
      name: 'start_team_run',
      description:
        "Put your team to work on the owner's request: give each member who should help a brief (keyed by member name), and optionally shared context. The server runs them in the team's work style and gives you every result together in one message. After starting, tell the owner who is on it and end your turn.",
      parameters: startTeamRunInput,
      // Synchronous up to the start, so two calls in one step cannot both pass the check.
      execute: async (args) => {
        if (used)
          return {
            started: false,
            error:
              'You already started a team run in this turn. Wait for its results.',
          };
        used = true;
        try {
          const team = this.teamOf(threadId);
          if (!team || team.id !== teamId)
            throw new Error('This chat no longer belongs to an active team.');
          const run = this.startFromBriefs(team, threadId, args);
          const steps = this.deps.workspace.teams.steps(run.id);
          const names = steps
            .filter((step) => step.role === 'worker')
            .map((step) => this.name(step.dotId));
          const reviewer = steps.find((step) => step.role === 'reviewer');
          return {
            started: true,
            runId: run.id,
            members: names,
            note:
              team.style === 'sequential'
                ? `Started step by step: ${names.join(' → ')}. The results come back here together.`
                : reviewer
                  ? `Started: ${names.join(', ')}, then ${this.name(reviewer.dotId)} reviews their work. The reviewed result comes back here.`
                  : `Started: ${names.join(', ')}. The results come back here together.`,
          };
        } catch (error) {
          used = false;
          return {
            started: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not start the team run.',
          };
        }
      },
    });
  }

  /** Resolves the lead's briefs to members (by name or id) and starts the run. */
  startFromBriefs(team: Team, threadId: string, input: StartTeamRunInput) {
    const shared = input.shared?.trim() ?? '';
    const entries = Object.entries(input.briefs ?? {});
    if (!entries.length && !shared)
      throw new Error(
        'Give at least one member a brief, or a shared brief for everyone.',
      );
    const members = team.members.map((member) => ({
      ...member,
      dot: this.dot(member.dotId),
    }));
    const briefs = new Map<string, string>();
    for (const [key, brief] of entries) {
      const wanted = key.trim().toLowerCase();
      const member = members.find(
        (item) =>
          item.dotId === key.trim() || item.dot?.name.toLowerCase() === wanted,
      );
      if (!member)
        throw new Error(
          `${key} is not on ${team.name}. Members: ${members.map((item) => item.dot?.name ?? 'a removed Dot').join(', ')}.`,
        );
      if (briefs.has(member.dotId))
        throw new Error(
          `${member.dot?.name ?? key} got two briefs. Each member takes part once per run.`,
        );
      briefs.set(member.dotId, brief.trim());
    }
    const combined = new Map<string, string>();
    for (const member of members) {
      const own = briefs.get(member.dotId);
      if (entries.length && own === undefined) continue;
      combined.set(
        member.dotId,
        own && shared ? `${shared}\n\nYour part: ${own}` : (own ?? shared),
      );
    }
    return this.start(team, threadId, combined);
  }

  /** Why a run of this team cannot start from this chat now, or undefined. */
  private problem(team: Team, threadId: string): string | undefined {
    const service = this.deps.team;
    if (!this.dot(team.leadDotId)) return 'The team lead no longer exists.';
    if (service.depthOf(threadId) + 1 > service.maxDepth)
      return `Hand-offs can only go ${service.maxDepth} levels deep. Do this part yourself.`;
    return undefined;
  }

  /**
   * Starts a run with these briefs (member Dot id → brief). Steps follow member order; the lead
   * and Dots that are not members are never steps. A review run adds the reviewer's step last.
   */
  start(
    team: Team,
    threadId: string,
    briefs: Map<string, string>,
    options: { id?: string; request?: string } = {},
  ): TeamRun {
    const { workspace } = this.deps;
    const problem = this.problem(team, threadId);
    if (problem) throw new Error(problem);
    const steps = team.members
      .filter((member) => briefs.has(member.dotId) && this.dot(member.dotId))
      .map((member) => ({
        dotId: member.dotId,
        position: member.position,
        brief: briefs.get(member.dotId)!,
      }));
    if (!steps.length) throw new Error('No member of the team got a brief.');
    const reviewer = this.reviewerOf(team);
    const run = workspace.teams.createRun(
      {
        teamId: team.id,
        threadId,
        style: team.style,
        mode: team.mode,
        reviewerDotId: reviewer?.id ?? null,
        ...(options.id ? { id: options.id } : {}),
        ...(options.request ? { request: options.request } : {}),
      },
      [
        ...steps,
        ...(reviewer
          ? [
              {
                dotId: reviewer.id,
                position: REVIEWER_POSITION,
                brief: 'Check and improve the team’s combined work.',
                role: 'reviewer' as const,
              },
            ]
          : []),
      ],
    );
    const stored = workspace.teams
      .steps(run.id)
      .filter((step) => step.role === 'worker');
    if (run.style === 'sequential') this.startStep(run, team, stored[0]!);
    else for (const step of stored) this.startStep(run, team, step);
    // A step that could not start may have ended the run (or started the review) already.
    this.afterWorkers(run.id);
    this.settle(run.id);
    return workspace.teams.run(run.id) ?? run;
  }

  /**
   * Starts one step as a delegation; a step that cannot start is marked failed (a revision that
   * cannot start keeps the first version).
   */
  private startStep(
    run: TeamRun,
    team: Team,
    step: StoredStep,
    options: {
      previous?: Delegation;
      /** In place of the step's stored brief (the reviewer's). */
      brief?: string;
      context?: string;
      deliverable?: string;
      /** The delegation of the round before: this one goes round again. */
      firstDelegationId?: string;
    } = {},
  ) {
    const { workspace } = this.deps;
    const lead = this.dot(team.leadDotId);
    const target = this.dot(step.dotId);
    const role =
      step.role === 'reviewer'
        ? 'reviewer: you check and improve the members’ work'
        : team.members.find((member) => member.dotId === step.dotId)?.role;
    try {
      if (!lead || !target) throw new Error('This Dot no longer exists.');
      const context = [
        role ? `Your role on the team: ${role}.` : '',
        options.previous
          ? `${this.name(options.previous.childDotId)} worked on the step before yours and delivered:\n\n${clip(options.previous.result ?? '', CARRY_CHARS)}\n\nBuild on it.`
          : '',
        options.context ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const delegation = this.deps.team.handOff({
        from: lead,
        target,
        threadId: run.threadId,
        brief: options.brief ?? step.brief,
        deliverable:
          options.deliverable ??
          (run.mode === 'direct'
            ? "Your answer to the owner's message, from your role on the team."
            : 'Your part of the work, ready for the lead to combine with the others.'),
        batchKey: teamBatchKey(run.id),
        origin: run.mode === 'direct' ? 'owner' : 'team',
        intro:
          run.mode === 'direct'
            ? `The owner sent this to the ${team.emoji} ${team.name} team.`
            : `${lead.name} (lead of the ${team.emoji} ${team.name} team) handed you your part of the team's work.`,
        ...(context ? { context } : {}),
      });
      workspace.teams.setStep(run.id, step.dotId, {
        status: 'running',
        delegationId: delegation.id,
        ...(options.firstDelegationId
          ? { firstDelegationId: options.firstDelegationId }
          : {}),
      });
    } catch (error) {
      this.log(
        `Team run ${run.id}: a step could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      if (options.firstDelegationId && step.role === 'worker') {
        workspace.teams.setStep(run.id, step.dotId, { status: 'done' });
        return;
      }
      workspace.teams.setStep(run.id, step.dotId, { status: 'failed' });
      if (run.style === 'sequential') this.skipQueued(run.id);
    }
  }

  private skipQueued(runId: string) {
    for (const step of this.deps.workspace.teams.steps(runId))
      if (step.status === 'queued' && step.role === 'worker')
        this.deps.workspace.teams.setStep(runId, step.dotId, {
          status: 'skipped',
        });
  }

  /**
   * A step's delegation finished (TeamService calls this before it would report to the lead, and
   * when the owner stops a lane). Returns true when the delegation is a team step, which then
   * never reports on its own.
   */
  stepFinished(delegation: Delegation): boolean {
    const { teams } = this.deps.workspace;
    const step = teams.stepOf(delegation.id);
    if (!step) return false;
    const run = teams.run(step.runId);
    if (!run) return true;
    // The round before of a step that went round again: its newer delegation reports.
    if (step.delegationId !== delegation.id) return true;
    const status =
      delegation.status === 'done'
        ? 'done'
        : delegation.status === 'stopped'
          ? 'cancelled'
          : 'failed';
    if (run.status !== 'running') {
      if (step.status === 'running')
        teams.setStep(run.id, step.dotId, { status });
      return true;
    }
    if (step.status !== 'running') return true;
    teams.setStep(run.id, step.dotId, { status });
    const team = teams.get(run.teamId);
    if (step.role === 'reviewer') {
      if (team && status === 'done') this.reviewed(run, team, delegation);
    } else if (run.style === 'sequential') {
      const next = teams.steps(run.id).find((item) => item.status === 'queued');
      if (next && status === 'done' && team)
        this.startStep(run, team, next, { previous: delegation });
      else if (next) this.skipQueued(run.id);
    }
    this.afterWorkers(run.id);
    this.settle(run.id);
    return true;
  }

  /** Once every member of a review run has finished, the reviewer starts (or is skipped). */
  private afterWorkers(runId: string) {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId);
    if (!run || run.status !== 'running' || !run.reviewerDotId) return;
    const steps = teams.steps(runId);
    const reviewer = steps.find((step) => step.role === 'reviewer');
    const workers = steps.filter((step) => step.role === 'worker');
    if (!reviewer || reviewer.status !== 'queued') return;
    if (workers.some((step) => ['queued', 'running'].includes(step.status)))
      return;
    const done = workers.filter((step) => step.status === 'done');
    const team = teams.get(run.teamId);
    if (!done.length || !team) {
      teams.setStep(runId, reviewer.dotId, { status: 'skipped' });
      return;
    }
    const second = !!reviewer.firstDelegationId;
    const material = reviewMaterial(
      done.map((step) => ({
        name: this.name(step.dotId),
        role:
          team.members.find((member) => member.dotId === step.dotId)?.role ??
          '',
        result:
          (step.delegationId &&
            this.deps.team.get(step.delegationId)?.result) ||
          '',
      })),
    );
    const brief = reviewBrief({
      names: done.map((step) => this.name(step.dotId)),
      request: this.request(run),
      second,
    });
    this.startStep(run, team, reviewer, {
      brief,
      context: `The members' results:\n\n${material}`,
      deliverable: REVIEW_DELIVERABLE,
      ...(second && reviewer.delegationId
        ? { firstDelegationId: reviewer.delegationId }
        : {}),
    });
  }

  /**
   * The reviewer finished a check. CHANGES on the first check sends the work back once: the members
   * it names (every member when it names none) revise with its notes, and it checks once more.
   */
  private reviewed(run: TeamRun, team: Team, delegation: Delegation) {
    const { teams } = this.deps.workspace;
    const { verdict, notes } = readVerdict(delegation.result ?? '');
    teams.setVerdict(run.id, verdict);
    if (verdict !== 'changes' || run.sentBack) return;
    const steps = teams.steps(run.id);
    const reviewer = steps.find((step) => step.role === 'reviewer');
    const done = steps.filter(
      (step) => step.role === 'worker' && step.status === 'done',
    );
    if (!reviewer || !done.length || !teams.markSentBack(run.id)) return;
    const targets = sentBackTo(
      notes || delegation.result || '',
      done.map((step) => ({ ...step, name: this.name(step.dotId) })),
    );
    // The reviewer goes round again once the members it sent back are done.
    teams.setStep(run.id, reviewer.dotId, {
      status: 'queued',
      firstDelegationId: delegation.id,
    });
    const reviewerName = this.name(reviewer.dotId);
    for (const step of targets) {
      const first = step.delegationId
        ? this.deps.team.get(step.delegationId)
        : undefined;
      this.startStep(run, team, step, {
        context: revisionContext({
          reviewer: reviewerName,
          first: first?.result ?? '',
          notes: notes || delegation.result || '',
        }),
        ...(step.delegationId ? { firstDelegationId: step.delegationId } : {}),
      });
    }
  }

  /** Ends the run once no step is queued or running, and delivers its results once. */
  private settle(runId: string) {
    const { teams } = this.deps.workspace;
    const steps = teams.steps(runId);
    if (steps.some((step) => ['queued', 'running'].includes(step.status)))
      return;
    const ok = steps.some(
      (step) => step.role === 'worker' && step.status === 'done',
    );
    if (!teams.finishRun(runId, ok ? 'done' : 'failed')) return;
    const run = teams.run(runId)!;
    this.writeLog(run);
    if (run.mode === 'direct') void this.postResults(run);
    else this.resumeLead(run);
  }

  /** The conversation's host (the lead when the chat was made) hears back. */
  private host(threadId: string): string | undefined {
    try {
      return this.deps.workspace.requireThread(threadId).dotId;
    } catch {
      return undefined;
    }
  }

  /** The owner's message the run answers: stored for direct runs, found in the chat otherwise. */
  private request(run: TeamRun): string | null {
    const { teams } = this.deps.workspace;
    const stored = teams.request(run.id);
    if (stored) return stored;
    try {
      const found = this.deps.messages
        ? requestFor(this.deps.messages(run.threadId), run.id)
        : undefined;
      if (found) teams.setRequest(run.id, found);
      return found ?? null;
    } catch {
      return null;
    }
  }

  private resumeLead(run: TeamRun) {
    const dotId = this.host(run.threadId);
    if (!dotId) return;
    this.deps.resume({
      kind: 'delegation',
      refId: run.id,
      threadId: run.threadId,
      dotId,
      prompt: this.resultsPrompt(run.id),
      source: 'delegation',
      batchKey: teamBatchKey(run.id),
    });
  }

  private result(step: StoredStep): string {
    return (
      (step.delegationId && this.deps.team.get(step.delegationId)?.result) || ''
    );
  }

  /** The reviewer's step of a run and what it said, when the run had one. */
  private review(runId: string) {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId)!;
    const step = teams.steps(runId).find((item) => item.role === 'reviewer');
    if (!step) return undefined;
    const name = this.name(step.dotId);
    const checked = step.status === 'done';
    const headline = !checked
      ? `${name} could not finish the check, so these results are unreviewed`
      : run.verdict === 'changes'
        ? `${name} still asks for changes${run.sentBack ? ' after one send-back' : ''}`
        : `Checked by ${name}${run.sentBack ? ' after one send-back' : ''}`;
    return { step, name, checked, headline, result: this.result(step) };
  }

  /** The one message that gives the lead every result of a run, a section per step. */
  resultsPrompt(runId: string): string {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId)!;
    const team = teams.get(run.teamId);
    const steps = teams.steps(runId).filter((step) => step.role === 'worker');
    const sections = steps.map((step, index) => {
      const delegation = step.delegationId
        ? this.deps.team.get(step.delegationId)
        : undefined;
      const head = `## ${index + 1}. ${this.name(step.dotId)}`;
      if (step.status === 'done')
        return `${head}: done${step.firstDelegationId ? ' (revised after the review)' : ''}\n\nBrief: ${step.brief}\n\nResult:\n${delegation?.result ?? ''}`;
      if (step.status === 'cancelled' && delegation?.status === 'stopped')
        return `${head}: stopped by the owner\n\nBrief: ${step.brief}`;
      if (step.status === 'skipped' || step.status === 'cancelled')
        return `${head}: skipped\n\nBrief: ${step.brief}\n\n(An earlier step did not finish, so this one did not start.)`;
      return `${head}: could not finish\n\nBrief: ${step.brief}\n\nWhat went wrong: ${clip(delegation?.result ?? 'unknown error', 300)}`;
    });
    const done = steps.filter((step) => step.status === 'done').length;
    const label = team ? `${team.emoji} ${team.name}` : 'Your team';
    const review = this.review(runId);
    const reviewed = review
      ? review.checked
        ? `\n\n# Reviewed result (${review.headline})\n\n${review.result}\n\n# Raw results from the members`
        : `\n\n${review.headline}.`
      : '';
    const use = review?.checked
      ? 'Continue from here: start from the reviewed result, use the raw results for detail, and tell the owner what it means for their request.'
      : 'Continue from here: combine the results and tell the owner what they mean for their request.';
    return `Your team ${label} finished the run you started (${TEAM_STYLE_LABELS[run.style].toLowerCase()}, ${done} of ${steps.length} done).${reviewed}\n\n${sections.join('\n\n')}\n\n${use} Do not start another team run for the same request.${done < steps.length ? ' For the parts that did not finish, do them yourself or tell the owner.' : ''}`;
  }

  /** The Results message a direct run posts into its chat. */
  resultsMessage(runId: string): string {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId)!;
    const team = teams.get(run.teamId);
    const steps = teams.steps(runId).filter((step) => step.role === 'worker');
    const done = steps.filter((step) => step.status === 'done').length;
    const sections = steps.map((step) => {
      const delegation = step.delegationId
        ? this.deps.team.get(step.delegationId)
        : undefined;
      const body =
        step.status === 'done'
          ? (delegation?.result ?? '')
          : step.status === 'cancelled' && delegation?.status === 'stopped'
            ? '_Stopped by you._'
            : step.status === 'skipped' || step.status === 'cancelled'
              ? '_Skipped: an earlier step did not finish._'
              : `_Could not finish: ${clip(delegation?.result ?? 'unknown error', 300)}_`;
      return `### ${this.name(step.dotId)}${step.firstDelegationId ? ' (revised)' : ''}\n\n${body}`;
    });
    const review = this.review(runId);
    const reviewed = review
      ? review.checked
        ? `### ${review.headline}\n\n${review.result}\n\n---\n\n`
        : `_${review.headline}._\n\n`
      : '';
    return `**Results from ${team ? `${team.emoji} ${team.name}` : 'your team'}** (${done} of ${steps.length} done)\n\n${reviewed}${sections.join('\n\n')}`;
  }

  /**
   * Writes the run log page into the team's own Space (never anywhere else), once, when the team
   * keeps a run log. Never throws: a log that cannot be written leaves the run as it is.
   */
  private writeLog(run: TeamRun) {
    const { workspace } = this.deps;
    try {
      const team = workspace.teams.get(run.teamId);
      const spaceId = team?.spaceId;
      if (!team || !spaceId || !team.runLog || run.log) return;
      if (!workspace.spaces().some((space) => space.id === spaceId)) return;
      const steps = workspace.teams.steps(run.id);
      const describe = (step: StoredStep) => {
        const delegation = step.delegationId
          ? workspace.team.get(step.delegationId)
          : undefined;
        const first = step.firstDelegationId
          ? workspace.team.get(step.firstDelegationId)
          : undefined;
        return {
          name: this.name(step.dotId),
          dotId: step.dotId,
          role:
            team.members.find((member) => member.dotId === step.dotId)?.role ??
            '',
          status: step.status,
          result: delegation?.result ?? null,
          childThreadId: delegation?.childThreadId ?? null,
          firstChildThreadId:
            first && first.id !== delegation?.id ? first.childThreadId : null,
        };
      };
      const reviewer = steps.find((step) => step.role === 'reviewer');
      const page = workspace.pages.create(
        spaceId,
        {
          title: runLogTitle(team, run.createdAt),
          content: runLogContent({
            team,
            run,
            hostDotId: this.host(run.threadId) ?? team.leadDotId,
            request: this.request(run),
            workers: steps
              .filter((step) => step.role === 'worker')
              .map(describe),
            ...(reviewer ? { reviewer: describe(reviewer) } : {}),
          }),
          parentId: null,
        },
        run.threadId,
      );
      workspace.teams.setLog(run.id, spaceId, page.id);
      this.deps.logged?.(spaceId);
    } catch (error) {
      this.log(
        `Team run ${run.id}: run log not written: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** Posts a direct run's results once; a busy chat is tried again when its turn ends. */
  private async postResults(run: TeamRun): Promise<void> {
    const { post } = this.deps;
    const host = this.host(run.threadId);
    if (!post || !host || this.posting.has(run.id)) return;
    this.posting.add(run.id);
    const team = this.deps.workspace.teams.get(run.teamId);
    const reply = this.resultsMessage(run.id);
    const attempt = async (): Promise<void> => {
      try {
        await post({
          threadId: run.threadId,
          dotId: host,
          text: `Team results: ${team ? `${team.emoji} ${team.name}` : 'your team'}`,
          reply,
          metadata: { source: 'delegation', ref: run.id },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Thread already running/.test(message))
          return this.later(run, attempt);
        this.posting.delete(run.id);
        this.log(
          `Team run ${run.id}: results not posted: ${message.slice(0, 200)}`,
        );
        return;
      }
      this.deps.workspace.teams.markPosted(run.id);
      this.posting.delete(run.id);
      this.deps.finished?.(run.threadId, reply);
      if (team?.summarize)
        this.deps.resume({
          kind: 'delegation',
          refId: run.id,
          threadId: run.threadId,
          dotId: host,
          prompt:
            "Your team's results are in the message above. Write the owner a short summary: what they found, where they agree or differ, and what to do next. Do not repeat the results in full.",
          source: 'delegation',
          batchKey: null,
        });
    };
    await attempt();
  }

  /** Runs `attempt` again once the chat's current turn ends (or after a while). */
  private later(run: TeamRun, attempt: () => Promise<void>) {
    let done = false;
    let unsubscribe = () => {};
    const go = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      void attempt();
    };
    const timer = setTimeout(go, POST_RETRY_MS);
    timer.unref?.();
    unsubscribe =
      this.deps.onTurnFinished?.(({ threadId }) => {
        if (threadId === run.threadId) go();
      }) ?? (() => {});
  }

  /**
   * Direct mode: the owner's message goes to every member with no lead model call. The message
   * and a short "Sent to ..." line are stored in the chat first (refused while a turn runs there);
   * the line carries the run's id, so the chat draws the run's work band right below it.
   */
  async dispatch(
    teamId: string,
    threadId: string,
    text: string,
  ): Promise<TeamRun> {
    const { workspace, post } = this.deps;
    const team = workspace.teams.get(teamId);
    if (!team || team.archivedAt)
      throw new TeamRunError(404, 'Team not found.');
    let thread;
    try {
      thread = workspace.requireThread(threadId);
    } catch {
      throw new TeamRunError(404, 'Conversation not found.');
    }
    if (thread.teamId !== team.id)
      throw new TeamRunError(
        400,
        'This conversation is not a chat of this team.',
      );
    if (team.mode !== 'direct')
      throw new TeamRunError(
        400,
        `${team.name}'s lead plans the work: send the message in the chat instead.`,
      );
    const members = team.members.filter((member) => this.dot(member.dotId));
    if (!members.length)
      throw new TeamRunError(400, 'Add a member to the team first.');
    if (!post)
      throw new TeamRunError(503, 'Direct team chats are not available.');
    const problem = this.problem(team, threadId);
    if (problem) throw new TeamRunError(400, problem);
    const names = members.map((member) => this.name(member.dotId));
    const runId = randomUUID();
    const reviewer = this.reviewerOf(team);
    try {
      await post({
        threadId,
        dotId: thread.dotId,
        text,
        reply: `Sent to ${names.join(', ')}.${reviewer ? ` ${reviewer.name} reviews their work.` : ''} Their answers will appear here when they finish.`,
        toolCall: {
          name: TEAM_DISPATCH_TOOL,
          args: { runId },
          result: { started: true, runId, members: names },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Thread already running/.test(message))
        throw new TeamRunError(
          409,
          'Something is still running in this chat. Wait for it to finish, then send again.',
        );
      throw error;
    }
    if (hasDefaultTitle(thread.title)) {
      const title = deriveTitle(text, '');
      if (title) workspace.renameThread(threadId, title);
    }
    return this.start(
      team,
      threadId,
      new Map(members.map((member) => [member.dotId, text])),
      { id: runId, request: text },
    );
  }

  /** Stops a run: its steps' tasks are cancelled and the lead is not resumed. */
  cancel(runId: string): TeamRun | undefined {
    const { workspace, cancelTask, turns } = this.deps;
    const run = workspace.teams.run(runId);
    if (!run) return undefined;
    if (!workspace.teams.cancelRun(runId)) return run;
    for (const step of workspace.teams.steps(runId)) {
      if (step.status === 'queued') {
        workspace.teams.setStep(runId, step.dotId, { status: 'cancelled' });
        continue;
      }
      if (step.status !== 'running' || !step.delegationId) continue;
      const delegation = workspace.team.get(step.delegationId);
      workspace.teams.setStep(runId, step.dotId, { status: 'cancelled' });
      if (!delegation || delegation.status !== 'running') continue;
      cancelTask(delegation.taskId);
      workspace.team.finish(delegation.id, 'failed', 'Cancelled by you.');
      // The task cancel stops the run within 100 ms; stopping the turn makes it immediate. Only a
      // turn on this step's own conversation: the member may be busy in another chat.
      if (
        turns
          ?.running()
          .some(
            (turn) =>
              turn.dotId === delegation.childDotId &&
              turn.threadId === delegation.childThreadId,
          )
      )
        turns.stop(delegation.childDotId);
    }
    return workspace.teams.run(runId);
  }

  /** Cancels every running team run of a conversation; returns how many steps were working. */
  cancelThread(threadId: string): number {
    let stopped = 0;
    for (const run of this.deps.workspace.teams.runsForThread(threadId)) {
      if (run.status !== 'running') continue;
      stopped += this.deps.workspace.teams
        .steps(run.id)
        .filter((step) => step.status === 'running').length;
      this.cancel(run.id);
    }
    return stopped;
  }

  /** The run with each step's brief, conversation and timings. */
  detail(runId: string): TeamRunDetail | undefined {
    const { workspace } = this.deps;
    const run = workspace.teams.run(runId);
    if (!run) return undefined;
    const steps = workspace.teams.steps(runId).map((step) => {
      const delegation = step.delegationId
        ? workspace.team.get(step.delegationId)
        : undefined;
      return {
        runId: step.runId,
        delegationId: step.delegationId,
        dotId: step.dotId,
        position: step.position,
        status: step.status,
        role: step.role,
        firstDelegationId: step.firstDelegationId,
        dotName: this.name(step.dotId),
        brief: delegation?.brief ?? step.brief,
        childThreadId: delegation?.childThreadId ?? null,
        createdAt: delegation?.createdAt ?? null,
        startedAt: delegation?.startedAt ?? null,
        finishedAt: delegation?.finishedAt ?? null,
        deliveredAt: delegation?.deliveredAt ?? null,
      };
    });
    // postedAt is bookkeeping for direct runs; the API shows the run as the shared type has it.
    const { postedAt, ...shown } = run;
    void postedAt;
    return {
      ...shown,
      steps,
      durationMs:
        run.finishedAt === null ? null : run.finishedAt - run.createdAt,
    };
  }

  /** A conversation's team runs as its work bands draw them, oldest first. */
  bands(threadId: string): TeamRunBand[] {
    const { teams } = this.deps.workspace;
    return teams.runsForThread(threadId).map((run) => {
      const team = teams.get(run.teamId);
      // postedAt is bookkeeping; the band gets the shared shape.
      const { postedAt, ...shown } = run as TeamRun & { postedAt?: unknown };
      void postedAt;
      return {
        ...shown,
        teamName: team?.name ?? 'Team',
        teamEmoji: team?.emoji ?? '✨',
        leadDotId: team?.leadDotId ?? '',
        steps: teams.steps(run.id).map((step) => ({
          runId: step.runId,
          delegationId: step.delegationId,
          dotId: step.dotId,
          position: step.position,
          status: step.status,
          role: step.role,
          firstDelegationId: step.firstDelegationId,
          brief: step.brief,
        })),
      };
    });
  }

  /** After a restart: posts the results of direct runs that finished but were never posted. */
  recover() {
    for (const run of this.deps.workspace.teams.unposted())
      void this.postResults(run);
  }
}

export class TeamRunError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
