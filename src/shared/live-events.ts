// The live event feed (GET /api/events). Payloads carry ids and small enums only, never prompt,
// page or message text: a client that sees an event refetches what it shows through the normal API.
import type { DelegationStatus, Status, TurnSource } from './types.js';

/** How a turn ended: stopped by the owner, ended in an error, or completed. */
export type TurnFinishStatus = 'completed' | 'stopped' | 'failed';

export interface LiveEventMap {
  'turn.started': {
    threadId: string;
    dotId: string;
    runId: string;
    source: TurnSource | 'chat';
  };
  /** Sent after the run is stored and the conversation is no longer running. */
  'turn.finished': {
    threadId: string;
    dotId: string;
    runId: string;
    status: TurnFinishStatus;
  };
  'task.changed': { taskId: string; status: Status };
  'delegation.changed': {
    id: string;
    parentThreadId: string;
    childThreadId: string;
    status: DelegationStatus;
  };
  'approval.changed': { id: string; threadId: string };
  'handoff.changed': { id: string; threadId: string };
  /** Spaces, Dots or conversations changed. */
  'workspace.changed': Record<string, never>;
  'usage.updated': { dotId: string };
  /** Something that needs the owner changed without a more specific event (e.g. approvals expired). */
  'inbox.changed': Record<string, never>;
}

export type LiveEventType = keyof LiveEventMap;

export const LIVE_EVENT_TYPES: readonly LiveEventType[] = [
  'turn.started',
  'turn.finished',
  'task.changed',
  'delegation.changed',
  'approval.changed',
  'handoff.changed',
  'workspace.changed',
  'usage.updated',
  'inbox.changed',
];

/** One event as the feed sends it: `id:` is the sequence number, `event:` the type, `data:` the payload. */
export type LiveEvent = {
  [K in LiveEventType]: { id: number; type: K; data: LiveEventMap[K] };
}[LiveEventType];

/**
 * The first event on every connection. `reset` means the `Last-Event-ID` the client sent is no
 * longer replayable (too old, or from before a restart): refetch everything.
 */
export interface LiveHello {
  reset?: boolean;
}

/** Control events that are not part of LiveEventMap: `hello` opens the feed, `bye` ends it on shutdown. */
export type LiveControlEvent = 'hello' | 'bye';
