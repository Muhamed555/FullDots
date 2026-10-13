// Work lanes (P3): the progress of every hand-off a conversation made, for the lanes drawn in that
// chat, and the owner's Stop and Try again on them. Progress is read from what already exists: the
// delegation row, its task, the turn registry, approvals, handoffs, questions, budgets, and the
// teammate's runs (stored ones incrementally, the running one from memory).
import { EventType, type BaseEvent } from '@ag-ui/client';
import {
  previewLines,
  type LaneProgress,
  type LaneWait,
} from '../shared/lanes.js';
import { toolStepLabel } from '../shared/step-label.js';
import type { Delegation } from '../shared/types.js';
import { runUsage } from './dot-agent.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';
import type { Store } from './store.js';
import type { TeamService } from './team-service.js';
import type { TurnRegistry } from './turn-registry.js';
import type { WorkspaceStore } from './workspace.js';

/** How many times one hand-off may be tried in all (the first try and its retries). */
export const MAX_ATTEMPTS = 5;
/** How much of a result the progress carries; the whole one is one request away. */
export const RESULT_EXCERPT = 600;

export class LaneError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

export interface LaneDeps {
  workspace: WorkspaceStore;
  store: Store;
  turns: Pick<TurnRegistry, 'running' | 'stop'>;
  runner: Pick<SqliteAgentRunner, 'liveRun' | 'runsAfter'>;
  team: Pick<TeamService, 'delegate'>;
  /** Aborts the background run of a task at once (the runner would notice the cancel in 100 ms). */
  abortTask?: (taskId: string) => void;
}

interface RunDigest {
  /** Tokens reported by the runs read so far; null while none reported any. */
  tokens: number | null;
  /** The newest assistant text of those runs. */
  text: string;
}

/** Text written per message, the newest message last, and the tokens of a finished run. */
function digest(events: readonly BaseEvent[]) {
  const texts = new Map<string, string>();
  let tokens: number | null = null;
  let tool: { id: string; name: string; done: boolean } | undefined;
  let last: 'text' | 'tool' | undefined;
  let current = '';
  for (const event of events) {
    const data = event as BaseEvent & {
      messageId?: string;
      delta?: string;
      toolCallId?: string;
      toolCallName?: string;
    };
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        current = data.messageId ?? current;
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK: {
        const id = data.messageId ?? current;
        current = id;
        if (data.delta) {
          // Re-insert so the message written to last is the newest one.
          const text = (texts.get(id) ?? '') + data.delta;
          texts.delete(id);
          texts.set(id, text);
          last = 'text';
        }
        break;
      }
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK:
        if (data.toolCallName && data.toolCallId) {
          tool = { id: data.toolCallId, name: data.toolCallName, done: false };
          last = 'tool';
        }
        break;
      case EventType.TOOL_CALL_RESULT:
        if (tool && data.toolCallId === tool.id) tool.done = true;
        break;
      case EventType.RUN_FINISHED: {
        const usage = runUsage(event);
        if (usage) tokens = (tokens ?? 0) + usage.input + usage.output;
        break;
      }
    }
  }
  const text = [...texts.values()].filter((value) => value.trim()).at(-1);
  return { text: text ?? '', tokens, tool, last };
}

export class LaneService {
  private runs = new Map<string, RunDigest & { lastId: number }>();

  constructor(private deps: LaneDeps) {}

  /** Every hand-off this conversation made, oldest first, as its lane shows it. */
  progress(parentThreadId: string, now = Date.now()): LaneProgress[] {
    return this.deps.workspace.team
      .forParent(parentThreadId)
      .map((delegation) => this.lane(delegation, now));
  }

  /** The stored runs of a teammate's chat, read once each. */
  private stored(threadId: string): RunDigest {
    const known = this.runs.get(threadId) ?? {
      lastId: 0,
      tokens: null,
      text: '',
    };
    for (const run of this.deps.runner.runsAfter(threadId, known.lastId)) {
      const read = digest(run.events);
      known.lastId = run.id;
      if (read.tokens !== null)
        known.tokens = (known.tokens ?? 0) + read.tokens;
      if (read.text.trim()) known.text = read.text;
    }
    this.runs.set(threadId, known);
    return known;
  }

  private attempt(delegation: Delegation): number {
    let count = 1;
    let current = delegation;
    for (; current.retryOf && count < 50; count++) {
      const previous = this.deps.workspace.team.get(current.retryOf);
      if (!previous) break;
      current = previous;
    }
    return count;
  }

  private lane(delegation: Delegation, now: number): LaneProgress {
    const { workspace, store, turns, runner } = this.deps;
    const child = delegation.childThreadId;
    const live = runner.liveRun(child);
    const stored = this.stored(child);
    const liveRead = live ? digest(live.events) : undefined;
    const running = turns.running().find((turn) => turn.threadId === child);
    let status: LaneProgress['status'] =
      delegation.status === 'running' ? 'queued' : delegation.status;
    let wait: LaneWait | null = null;
    let step: string | null = null;
    if (delegation.status === 'running') {
      const dotId = delegation.childDotId;
      const dot = workspace.dot(dotId);
      const task = store.task(delegation.taskId);
      // The reasons a teammate that has not (re)started yet is held back, most specific first.
      const heldBack = (): LaneWait | null =>
        store.settings().paused || dot?.paused || task?.status === 'paused'
          ? { kind: 'paused' }
          : workspace.usage.overBudgetDots(now).includes(dotId)
            ? { kind: 'budget' }
            : turns
                  .running()
                  .some(
                    (turn) => turn.dotId === dotId && turn.threadId !== child,
                  )
              ? { kind: 'busy' }
              : null;
      const approval = workspace.approvals.list({
        status: 'pending',
        threadId: child,
        limit: 1,
      })[0];
      const handoff = workspace.handoffs
        .list({ status: 'waiting', dotId, limit: 20 })
        .find((row) => row.threadId === child);
      if (running || live) {
        status = 'working';
        step =
          liveRead?.tool && !liveRead.tool.done
            ? toolStepLabel(liveRead.tool.name)
            : liveRead?.last === 'text'
              ? 'Writing'
              : 'Thinking';
      } else if (approval) {
        status = 'waiting';
        wait = { kind: 'approval', approval };
      } else if (handoff) {
        status = 'waiting';
        wait = {
          kind: 'handoff',
          handoff: {
            id: handoff.id,
            kind: handoff.kind,
            reason: handoff.reason,
            dotId: handoff.dotId,
          },
        };
      } else if (workspace.inbox.openQuestion(child)) {
        status = 'waiting';
        wait = { kind: 'question' };
      } else if (
        task &&
        ['queued', 'paused', 'interrupted', 'running'].includes(task.status)
      ) {
        wait = heldBack();
        status = wait
          ? 'waiting'
          : task.status === 'running'
            ? 'working'
            : 'queued';
        if (status === 'working') step = 'Starting';
      } else if (
        workspace.resumes.all().some((marker) => marker.threadId === child)
      ) {
        // The owner answered; its resume turn is about to run.
        wait = heldBack();
        status = wait ? 'waiting' : 'working';
        if (!wait) step = 'Picking up again';
      } else {
        status = 'waiting';
        wait = { kind: 'stalled' };
      }
    }
    const finished = delegation.status !== 'running';
    const text = liveRead?.text.trim() ? liveRead.text : stored.text;
    const start = delegation.startedAt ?? delegation.createdAt;
    return {
      id: delegation.id,
      parentThreadId: delegation.parentThreadId,
      parentDotId: delegation.parentDotId,
      childThreadId: child,
      childDotId: delegation.childDotId,
      batchKey: delegation.batchKey,
      retryOf: delegation.retryOf,
      attempt: this.attempt(delegation),
      brief: delegation.brief,
      deliverable: delegation.deliverable,
      status,
      wait,
      step,
      createdAt: delegation.createdAt,
      startedAt: delegation.startedAt,
      finishedAt: delegation.finishedAt,
      deliveredAt: delegation.deliveredAt,
      elapsedMs: Math.max(0, (delegation.finishedAt ?? now) - start),
      tokens: stored.tokens,
      preview: previewLines(
        finished && delegation.status !== 'stopped'
          ? (delegation.result ?? text)
          : text,
      ),
      result: finished
        ? (delegation.result ?? '').slice(0, RESULT_EXCERPT)
        : null,
      resultLength: finished ? (delegation.result ?? '').length : 0,
      runId: live?.runId ?? null,
    };
  }

  /**
   * Stops one hand-off and everything it handed on: cancels the tasks, and stops the teammate's
   * turn only when that turn runs in the hand-off's own chat. A Dot busy in another chat is never
   * stopped. Returns how many hand-offs were stopped.
   */
  stop(id: string, why = 'Stopped by you.'): number {
    const { workspace, store, turns } = this.deps;
    const delegation = workspace.team.get(id);
    if (!delegation || delegation.status !== 'running') return 0;
    // Marked first, so the run that ends because of the cancel cannot report a result or a failure.
    workspace.team.finish(delegation.id, 'stopped', why);
    let stopped = 1;
    for (const below of workspace.team.forParent(delegation.childThreadId))
      stopped += this.stop(below.id, why);
    const task = store.task(delegation.taskId);
    if (
      task &&
      ['queued', 'running', 'paused', 'interrupted'].includes(task.status)
    )
      store.action(delegation.taskId, 'cancel');
    this.deps.abortTask?.(delegation.taskId);
    // Nothing waiting to resume the teammate's chat may start it again.
    for (const marker of workspace.resumes.all())
      if (marker.threadId === delegation.childThreadId)
        workspace.resumes.remove(marker.id);
    if (
      turns
        .running()
        .some(
          (turn) =>
            turn.dotId === delegation.childDotId &&
            turn.threadId === delegation.childThreadId,
        )
    )
      turns.stop(delegation.childDotId);
    return stopped;
  }

  /** Stop everything: every hand-off of this conversation still running. */
  stopAll(parentThreadId: string): number {
    let stopped = 0;
    for (const delegation of this.deps.workspace.team.forParent(parentThreadId))
      stopped += this.stop(delegation.id);
    return stopped;
  }

  /**
   * Try again: the same brief to the same teammate, as a new hand-off of the Dot that made the first
   * one. The usual checks apply (still a teammate, depth, loops), and the owner's rules and pauses.
   */
  retry(id: string): Delegation {
    const { workspace, store } = this.deps;
    const delegation = workspace.team.get(id);
    if (!delegation) throw new LaneError('Hand-off not found.', 404);
    if (delegation.status === 'running' || delegation.status === 'done')
      throw new LaneError('Only failed or stopped work can be tried again.');
    if (workspace.team.retryOfThis(id))
      throw new LaneError('This work was already tried again.');
    if (this.attempt(delegation) >= MAX_ATTEMPTS)
      throw new LaneError(
        `This work was tried ${MAX_ATTEMPTS} times. Hand it over again in the chat instead.`,
      );
    const member = workspace.dot(delegation.childDotId);
    const lead = workspace.dot(delegation.parentDotId);
    if (!member || !lead)
      throw new LaneError('That Dot no longer exists.', 404);
    if (store.settings().paused || member.paused || lead.paused)
      throw new LaneError(
        `${member.paused ? member.name : lead.paused ? lead.name : 'Every Dot'} is paused. Resume it first.`,
      );
    if (workspace.rules.get(lead.id).hand_off_work === 'never')
      throw new LaneError(
        `${lead.name}'s rules say it never hands work over. Change the rule first.`,
      );
    // Joins its batch while the others still work, so the results go back together.
    const batchKey =
      delegation.batchKey &&
      workspace.team
        .inBatch(delegation.batchKey)
        .some((other) => other.status === 'running')
        ? delegation.batchKey
        : null;
    try {
      return this.deps.team.delegate({
        fromDotId: lead.id,
        threadId: delegation.parentThreadId,
        to: member.id,
        brief: delegation.brief,
        deliverable: delegation.deliverable,
        batchKey,
        retryOf: delegation.id,
      });
    } catch (error) {
      throw new LaneError(
        error instanceof Error ? error.message : 'Could not hand over.',
      );
    }
  }
}
