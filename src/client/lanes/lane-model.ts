// Pure helpers behind the work band: which hand-offs a turn made, what each lane says, timers,
// the cap on live child transcripts and the throttle of the screen reader announcements.
import type { ToolCall } from '@ag-ui/core';
import type { LaneProgress } from '../../shared/lanes';

/** One `delegate_to_dot` call of a turn, with what its result said. */
export interface HandOffCall {
  callId: string;
  /** The teammate the Dot named (its name or id), from the call's arguments. */
  to: string;
  brief: string;
  /** The delegation it started. */
  id?: string;
  /** Why the hand-off was refused. */
  error?: string;
  /** No result yet: the call is still streaming or running. */
  pending: boolean;
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

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The hand-offs among a band's tool calls, in call order (check_delegation calls are skipped). */
export function handOffCalls(
  calls: readonly ToolCall[],
  results: ReadonlyMap<string, string>,
): HandOffCall[] {
  return calls
    .filter((call) => call.function.name === 'delegate_to_dot')
    .map((call) => {
      const args = parse(call.function.arguments) ?? {};
      const raw = results.get(call.id);
      const result = parse(raw);
      const id = text(result?.id);
      const error =
        result && result.started !== true
          ? text(result.error) || 'Could not hand over.'
          : undefined;
      return {
        callId: call.id,
        to: text(args.dot),
        brief: text(args.brief),
        ...(id && result?.started === true ? { id } : {}),
        ...(error ? { error } : {}),
        pending: raw === undefined,
      };
    });
}

/** The newest attempt of a hand-off: the owner's Try again makes a new one pointing back. */
export function latestAttempt(
  id: string,
  lanes: readonly LaneProgress[],
): LaneProgress | undefined {
  let current = lanes.find((lane) => lane.id === id);
  for (let guard = 0; current && guard < 50; guard++) {
    const next = lanes.find((lane) => lane.retryOf === current!.id);
    if (!next) break;
    current = next;
  }
  return current;
}

export type LaneTone = 'neutral' | 'active' | 'attention' | 'done' | 'failed';

export interface LaneView {
  /** DotCharacter state of the teammate. */
  mascot: string;
  /** The short chip on the lane. */
  chip: string;
  tone: LaneTone;
  /** The state in words, always shown (never only as colour or motion). */
  line: string;
  /** No longer working or waiting. */
  finished: boolean;
  /** The owner can stop it. */
  stoppable: boolean;
}

/** What a lane says and shows for its progress. `name` is the teammate's name. */
export function laneView(lane: LaneProgress, name: string): LaneView {
  const base = { finished: false, stoppable: true };
  switch (lane.status) {
    case 'queued':
      return {
        ...base,
        mascot: 'receiving',
        chip: 'Queued',
        tone: 'neutral',
        line: 'Queued',
      };
    case 'working':
      return {
        ...base,
        mascot: 'working',
        chip: 'Working',
        tone: 'active',
        line: lane.step ?? 'Working',
      };
    case 'done':
      return {
        mascot: 'complete',
        chip: 'Done',
        tone: 'done',
        line: 'Done',
        finished: true,
        stoppable: false,
      };
    case 'failed':
      return {
        mascot: 'needs-input',
        chip: 'Failed',
        tone: 'failed',
        line: 'Failed',
        finished: true,
        stoppable: false,
      };
    case 'stopped':
      return {
        mascot: 'stopped',
        chip: 'Stopped',
        tone: 'neutral',
        line: 'Stopped by you',
        finished: true,
        stoppable: false,
      };
    case 'waiting': {
      const wait = lane.wait;
      switch (wait?.kind) {
        case 'approval':
          return {
            ...base,
            mascot: 'needs-input',
            chip: 'Needs you',
            tone: 'attention',
            line: 'Waiting for your approval',
          };
        case 'handoff':
          return {
            ...base,
            mascot: 'needs-input',
            chip: 'Your turn',
            tone: 'attention',
            line: 'Your turn on the computer',
          };
        case 'question':
          return {
            ...base,
            mascot: 'needs-input',
            chip: 'Needs you',
            tone: 'attention',
            line: 'Waiting for your answer in the inbox',
          };
        case 'busy':
          return {
            ...base,
            mascot: 'idle',
            chip: 'Waiting',
            tone: 'neutral',
            line: `Waiting: ${name} is busy in another chat`,
          };
        case 'budget':
          return {
            ...base,
            mascot: 'paused',
            chip: 'Waiting',
            tone: 'neutral',
            line: 'Waiting: daily budget reached',
          };
        case 'paused':
          return {
            ...base,
            mascot: 'paused',
            chip: 'Paused',
            tone: 'neutral',
            line: `Waiting: ${name} is paused`,
          };
        default:
          return {
            ...base,
            mascot: 'idle',
            chip: 'Stuck',
            tone: 'attention',
            line: 'Waiting: nothing is moving. Try again or stop it.',
          };
      }
    }
  }
}

/** 0:42, 3:05, 1:02:03. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** 820 tokens, 1.5k tokens, 12k tokens. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k tokens`;
}

/** The elapsed time of a lane now, counted on from when the progress arrived while it is active. */
export function laneElapsed(
  lane: LaneProgress,
  receivedAt: number,
  now: number,
): number {
  return lane.finishedAt === null
    ? lane.elapsedMs + Math.max(0, now - receivedAt)
    : lane.elapsedMs;
}

/** Live child transcripts open at once: each holds a streaming connection (see the P0 spike). */
export const MAX_LIVE_LANES = 2;

/**
 * Opens or closes a lane's inline transcript. Opening one more than `max` closes the one opened
 * longest ago, so at most `max` live connections are held.
 */
export function toggleExpanded(
  expanded: readonly string[],
  id: string,
  max = MAX_LIVE_LANES,
): string[] {
  if (expanded.includes(id)) return expanded.filter((item) => item !== id);
  return [...expanded, id].slice(-Math.max(1, max));
}

/**
 * The polite live region speaks a lane's change at most once per `gapMs`; a change that comes
 * sooner waits, and only the newest waiting text of a lane is spoken.
 */
export class LaneAnnouncer {
  private last = new Map<string, number>();
  private waiting = new Map<string, string>();
  private spoken = new Map<string, string>();

  constructor(private gapMs = 2000) {}

  /** The text to speak now, or undefined when it has to wait (or says nothing new). */
  offer(laneId: string, text: string, now: number): string | undefined {
    if (this.spoken.get(laneId) === text && !this.waiting.has(laneId))
      return undefined;
    const last = this.last.get(laneId);
    if (last !== undefined && now - last < this.gapMs) {
      this.waiting.set(laneId, text);
      return undefined;
    }
    this.waiting.delete(laneId);
    this.last.set(laneId, now);
    this.spoken.set(laneId, text);
    return text;
  }

  /** Waiting texts whose gap has passed; speaking them counts as their lane's last. */
  due(now: number): string[] {
    const ready: string[] = [];
    for (const [laneId, text] of this.waiting) {
      if (now - (this.last.get(laneId) ?? 0) < this.gapMs) continue;
      this.waiting.delete(laneId);
      if (this.spoken.get(laneId) === text) continue;
      this.last.set(laneId, now);
      this.spoken.set(laneId, text);
      ready.push(text);
    }
    return ready;
  }

  /** When the next waiting text is due, or undefined when nothing waits. */
  nextAt(): number | undefined {
    let next: number | undefined;
    for (const laneId of this.waiting.keys()) {
      const at = (this.last.get(laneId) ?? 0) + this.gapMs;
      next = next === undefined ? at : Math.min(next, at);
    }
    return next;
  }
}

/**
 * True when an error reported by CopilotKit's global subscriber belongs to this agent. Every agent
 * reports there (a lane's live connection too), so the main chat shows only its own and those that
 * name no agent.
 */
export function isOwnAgentError(
  event: { context?: Record<string, unknown> },
  agentId: string | undefined,
): boolean {
  const reported = event.context?.agentId;
  return typeof reported !== 'string' || reported === agentId;
}

/**
 * The results one "Delegated work" turn delivered: the hand-off it names (`ref`) and the others of
 * its batch delivered in the same turn.
 */
export function deliveredWith(
  ref: string,
  lanes: readonly LaneProgress[],
): LaneProgress[] {
  const lead = lanes.find((lane) => lane.id === ref);
  if (!lead) return [];
  if (!lead.batchKey) return [lead];
  // While the turn that delivers them runs, the results are finished but not marked delivered.
  const finished = (lane: LaneProgress) =>
    lane.status === 'done' ||
    lane.status === 'failed' ||
    lane.status === 'stopped';
  return lanes.filter(
    (lane) =>
      lane.batchKey === lead.batchKey &&
      (lead.deliveredAt === null
        ? lane.deliveredAt === null && finished(lane)
        : lane.deliveredAt === lead.deliveredAt),
  );
}

/** The hand-offs a band shows, newest attempt of each, in call order. */
export function bandLanes(
  calls: readonly HandOffCall[],
  lanes: readonly LaneProgress[],
): { call: HandOffCall; lane?: LaneProgress }[] {
  return calls.map((call) => ({
    call,
    ...(call.id ? { lane: latestAttempt(call.id, lanes) } : {}),
  }));
}

/** A band is settled when every lane finished (failed ones only once skipped or retried). */
export function bandSettled(
  entries: readonly { call: HandOffCall; lane?: LaneProgress }[],
  skipped: ReadonlySet<string>,
): boolean {
  return entries.every(({ call, lane }) => {
    if (call.error) return true;
    if (!lane) return false;
    if (lane.status === 'failed') return skipped.has(lane.id);
    return lane.status === 'done' || lane.status === 'stopped';
  });
}
