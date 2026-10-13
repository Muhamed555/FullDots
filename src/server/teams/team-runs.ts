// Team runs: one piece of work a named team does for one of its chats. The lead starts one with
// start_team_run ("Lead plans"), or the owner's message starts one directly ("Direct"). Each member
// that takes part is a step, run as an ordinary delegation (its own conversation, task, approvals,
// budget and time limit) whose batch key is the run's. The lead hears back once, when the run ends.
//
// Rules:
// - parallel (and, until P5, review): every step starts at once; the runner's concurrency applies.
// - sequential: steps run strictly in member order, whatever order the briefs came in; each step's
//   prompt carries the previous step's result. A step that fails ends the chain: the steps after it
//   are skipped, and the lead hears what was done.
// - A Dot appears at most once per run; the lead is never a step.
// - start_team_run may be called once per lead turn, and only in turns the owner started (a chat
//   message, or the approval of one), so a team run's own results cannot start another run.
// - Cancelling a run cancels its steps' tasks. A member's turn is stopped only when it runs on that
//   step's own conversation; the same member working in another chat is left alone.
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Delegation, Dot, TurnSource } from '../../shared/types.js';
import {
  TEAM_STYLE_LABELS,
  type Team,
  type TeamRun,
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
   * without a model call. Rejects with "Thread already running" while a turn runs there.
   */
  post?: (input: {
    threadId: string;
    dotId: string;
    text: string;
    reply: string;
    metadata?: { source: TurnSource; ref?: string };
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

  /** What the lead is told about its team in a team chat. */
  prompt(team: Team): string {
    const members = team.members
      .map(
        (member, index) =>
          `${index + 1}. ${this.name(member.dotId)}${member.role ? ` (${member.role})` : ''}`,
      )
      .join('; ');
    const style =
      team.style === 'sequential'
        ? 'Step by step: the members work one after another in the order above, each building on the previous result; members without a brief are skipped.'
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
          const names = this.deps.workspace.teams
            .steps(run.id)
            .map((step) => this.name(step.dotId));
          return {
            started: true,
            runId: run.id,
            members: names,
            note:
              team.style === 'sequential'
                ? `Started step by step: ${names.join(' → ')}. The results come back here together.`
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

  /**
   * Starts a run with these briefs (member Dot id → brief). Steps follow member order; the lead
   * and Dots that are not members are never steps.
   */
  start(team: Team, threadId: string, briefs: Map<string, string>): TeamRun {
    const { workspace, team: service } = this.deps;
    const lead = this.dot(team.leadDotId);
    if (!lead) throw new Error('The team lead no longer exists.');
    if (service.depthOf(threadId) + 1 > service.maxDepth)
      throw new Error(
        `Hand-offs can only go ${service.maxDepth} levels deep. Do this part yourself.`,
      );
    const steps = team.members
      .filter((member) => briefs.has(member.dotId) && this.dot(member.dotId))
      .map((member) => ({
        dotId: member.dotId,
        position: member.position,
        brief: briefs.get(member.dotId)!,
      }));
    if (!steps.length) throw new Error('No member of the team got a brief.');
    const run = workspace.teams.createRun(
      { teamId: team.id, threadId, style: team.style, mode: team.mode },
      steps,
    );
    const stored = workspace.teams.steps(run.id);
    // TODO(P5): the 'review' style hands the combined results to the reviewer Dot afterwards; until
    // then it runs like 'parallel'.
    if (run.style === 'sequential') this.startStep(run, team, stored[0]!);
    else for (const step of stored) this.startStep(run, team, step);
    // A step that could not start may have ended the run already.
    this.settle(run.id);
    return workspace.teams.run(run.id) ?? run;
  }

  /** Starts one step as a delegation; a step that cannot start is marked failed. */
  private startStep(
    run: TeamRun,
    team: Team,
    step: StoredStep,
    previous?: Delegation,
  ) {
    const { workspace } = this.deps;
    const lead = this.dot(team.leadDotId);
    const target = this.dot(step.dotId);
    const role = team.members.find(
      (member) => member.dotId === step.dotId,
    )?.role;
    try {
      if (!lead || !target) throw new Error('This Dot no longer exists.');
      const context = [
        role ? `Your role on the team: ${role}.` : '',
        previous
          ? `${this.name(previous.childDotId)} worked on the step before yours and delivered:\n\n${clip(previous.result ?? '', CARRY_CHARS)}\n\nBuild on it.`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const delegation = this.deps.team.handOff({
        from: lead,
        target,
        threadId: run.threadId,
        brief: step.brief,
        deliverable:
          run.mode === 'direct'
            ? "Your answer to the owner's message, from your role on the team."
            : 'Your part of the work, ready for the lead to combine with the others.',
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
      });
    } catch (error) {
      this.log(
        `Team run ${run.id}: a step could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      workspace.teams.setStep(run.id, step.dotId, { status: 'failed' });
      if (run.style === 'sequential') this.skipQueued(run.id);
    }
  }

  private skipQueued(runId: string) {
    for (const step of this.deps.workspace.teams.steps(runId))
      if (step.status === 'queued')
        this.deps.workspace.teams.setStep(runId, step.dotId, {
          status: 'skipped',
        });
  }

  /**
   * A step's delegation finished (TeamService calls this before it would report to the lead).
   * Returns true when the delegation is a team step, which then never reports on its own.
   */
  stepFinished(delegation: Delegation): boolean {
    const { teams } = this.deps.workspace;
    const step = teams.stepOf(delegation.id);
    if (!step) return false;
    const run = teams.run(step.runId);
    if (!run) return true;
    const status = delegation.status === 'done' ? 'done' : 'failed';
    if (run.status !== 'running') {
      if (step.status === 'running')
        teams.setStep(run.id, step.dotId, { status });
      return true;
    }
    teams.setStep(run.id, step.dotId, { status });
    if (run.style === 'sequential') {
      const next = teams.steps(run.id).find((item) => item.status === 'queued');
      const team = this.deps.workspace.teams.get(run.teamId);
      if (next && status === 'done' && team)
        this.startStep(run, team, next, delegation);
      else if (next) this.skipQueued(run.id);
    }
    this.settle(run.id);
    return true;
  }

  /** Ends the run once no step is queued or running, and delivers its results once. */
  private settle(runId: string) {
    const { teams } = this.deps.workspace;
    const steps = teams.steps(runId);
    if (steps.some((step) => ['queued', 'running'].includes(step.status)))
      return;
    const ok = steps.some((step) => step.status === 'done');
    if (!teams.finishRun(runId, ok ? 'done' : 'failed')) return;
    const run = teams.run(runId)!;
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

  /** The one message that gives the lead every result of a run, a section per step. */
  resultsPrompt(runId: string): string {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId)!;
    const team = teams.get(run.teamId);
    const steps = teams.steps(runId);
    const sections = steps.map((step, index) => {
      const delegation = step.delegationId
        ? this.deps.team.get(step.delegationId)
        : undefined;
      const head = `## ${index + 1}. ${this.name(step.dotId)}`;
      if (step.status === 'done')
        return `${head}: done\n\nBrief: ${step.brief}\n\nResult:\n${delegation?.result ?? ''}`;
      if (step.status === 'skipped' || step.status === 'cancelled')
        return `${head}: skipped\n\nBrief: ${step.brief}\n\n(An earlier step did not finish, so this one did not start.)`;
      return `${head}: could not finish\n\nBrief: ${step.brief}\n\nWhat went wrong: ${clip(delegation?.result ?? 'unknown error', 300)}`;
    });
    const done = steps.filter((step) => step.status === 'done').length;
    const label = team ? `${team.emoji} ${team.name}` : 'Your team';
    return `Your team ${label} finished the run you started (${TEAM_STYLE_LABELS[run.style].toLowerCase()}, ${done} of ${steps.length} done).\n\n${sections.join('\n\n')}\n\nContinue from here: combine the results and tell the owner what they mean for their request. Do not start another team run for the same request.${done < steps.length ? ' For the parts that did not finish, do them yourself or tell the owner.' : ''}`;
  }

  /** The Results message a direct run posts into its chat. */
  resultsMessage(runId: string): string {
    const { teams } = this.deps.workspace;
    const run = teams.run(runId)!;
    const team = teams.get(run.teamId);
    const steps = teams.steps(runId);
    const done = steps.filter((step) => step.status === 'done').length;
    const sections = steps.map((step) => {
      const delegation = step.delegationId
        ? this.deps.team.get(step.delegationId)
        : undefined;
      const body =
        step.status === 'done'
          ? (delegation?.result ?? '')
          : step.status === 'skipped' || step.status === 'cancelled'
            ? '_Skipped: an earlier step did not finish._'
            : `_Could not finish: ${clip(delegation?.result ?? 'unknown error', 300)}_`;
      return `### ${this.name(step.dotId)}\n\n${body}`;
    });
    return `**Results from ${team ? `${team.emoji} ${team.name}` : 'your team'}** (${done} of ${steps.length} done)\n\n${sections.join('\n\n')}`;
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
   * and a short "Sent to ..." line are stored in the chat first (refused while a turn runs there).
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
    const names = members.map((member) => this.name(member.dotId));
    try {
      await post({
        threadId,
        dotId: thread.dotId,
        text,
        reply: `Sent to ${names.join(', ')}. Their answers will appear here when they finish.`,
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
        dotName: this.name(step.dotId),
        brief: step.brief,
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
