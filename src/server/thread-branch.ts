// Branching a conversation: a new conversation for the same Dot that starts with another one's
// history up to a chosen message. The source never changes ("nothing is deleted": a branch copies).
//
// Chat runs live in the runner's database handle and the conversation binding in the workspace's,
// so the runs are written first, the binding last, and the copied runs are removed again when the
// binding fails. Every copied run gets a fresh runId (chat_runs.runId is UNIQUE) and the runId and
// threadId inside its stored events are rewritten; message ids are kept.
//
// A branch never inherits approvals, hand-offs or resume markers: their rows stay keyed to the
// source, and the tool results that asked the owner for one are replaced in the copy, so the branch
// shows no card that would answer (and resume) the source's request.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import type { Conversation } from '../shared/types.js';
import { branchTitle } from '../shared/message-actions.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';
import type { WorkspaceStore } from './workspace.js';

export class BranchPointError extends Error {
  constructor() {
    super(
      'That message is not in the saved history of this chat yet. Wait for the reply to finish and try again.',
    );
  }
}

/** What a branch holds in place of a tool result that asked the source's owner for something. */
export const LEFT_IN_SOURCE = JSON.stringify({
  status: 'left_in_source',
  note: 'This request belongs to the chat this branch was made from. It is not answered here.',
});

/** An approval request or hand-off tool result becomes LEFT_IN_SOURCE; anything else is kept. */
export function withoutOwnerRequest(content: unknown): unknown {
  if (typeof content !== 'string' || !content.includes('"status"'))
    return content;
  try {
    const data: unknown = JSON.parse(content);
    if (
      data &&
      typeof data === 'object' &&
      'status' in data &&
      (data.status === 'pending_approval' || data.status === 'handoff')
    )
      return LEFT_IN_SOURCE;
  } catch {
    // Not JSON: an ordinary tool result.
  }
  return content;
}

type StoredEvent = BaseEvent & Record<string, unknown>;

interface StoredRun {
  runId: string;
  agentId: string;
  events: StoredEvent[];
  createdAt: number;
}

function inputMessages(event: StoredEvent): Message[] | undefined {
  const input = event.input;
  if (!input || typeof input !== 'object') return undefined;
  const messages = (input as { messages?: unknown }).messages;
  return Array.isArray(messages) ? (messages as Message[]) : undefined;
}

/** Message ids an event names: its own, its parent's, and the input messages of a run start. */
function namedIds(event: StoredEvent): string[] {
  const ids: string[] = [];
  if (typeof event.messageId === 'string') ids.push(event.messageId);
  if (typeof event.parentMessageId === 'string')
    ids.push(event.parentMessageId);
  if (event.type === EventType.RUN_STARTED)
    for (const message of inputMessages(event) ?? []) ids.push(message.id);
  return ids;
}

function copyMessage(message: Message): Message {
  return message.role === 'tool'
    ? { ...message, content: withoutOwnerRequest(message.content) as string }
    : message;
}

/**
 * The runs a branch at `atMessageId` keeps: every run before the first one that names the message,
 * and that run. When the message is one of that run's inputs (the owner message that started it),
 * the run is cut right after its start, so the reply to the message is not copied.
 */
export function historyPrefix(
  runs: StoredRun[],
  atMessageId: string | null,
): StoredRun[] {
  if (atMessageId === null) return [];
  for (const [index, run] of runs.entries()) {
    const at = run.events.findIndex((event) =>
      namedIds(event).includes(atMessageId),
    );
    if (at < 0) continue;
    const event = run.events[at];
    if (event.type !== EventType.RUN_STARTED) return runs.slice(0, index + 1);
    const messages = inputMessages(event) ?? [];
    const started: StoredEvent = {
      ...event,
      input: {
        ...(event.input as Record<string, unknown>),
        messages: messages.slice(
          0,
          messages.findIndex((message) => message.id === atMessageId) + 1,
        ),
      },
    };
    const finished = {
      type: EventType.RUN_FINISHED,
      threadId: event.threadId,
      runId: run.runId,
    } as StoredEvent;
    return [
      ...runs.slice(0, index),
      { ...run, events: [...run.events.slice(0, at), started, finished] },
    ];
  }
  throw new BranchPointError();
}

function retarget(
  record: Record<string, unknown>,
  from: string,
  to: string,
  runIds: ReadonlyMap<string, string>,
) {
  if (record.threadId === from) record.threadId = to;
  for (const key of ['runId', 'parentRunId']) {
    const id = record[key];
    if (typeof id === 'string' && runIds.has(id)) record[key] = runIds.get(id);
  }
}

function copyEvent(
  event: StoredEvent,
  from: string,
  to: string,
  runIds: ReadonlyMap<string, string>,
): StoredEvent {
  const copy: StoredEvent = { ...event };
  retarget(copy, from, to, runIds);
  const messages = inputMessages(event);
  if (event.input && typeof event.input === 'object') {
    const input = { ...(event.input as Record<string, unknown>) };
    retarget(input, from, to, runIds);
    if (messages) input.messages = messages.map(copyMessage);
    copy.input = input;
  }
  if (Array.isArray(copy.messages))
    copy.messages = (copy.messages as Message[]).map(copyMessage);
  if (copy.type === EventType.TOOL_CALL_RESULT)
    copy.content = withoutOwnerRequest(copy.content);
  return copy;
}

/**
 * Copies thread `from`'s stored history up to `atMessageId` (null: none of it) into thread `to`:
 * its runs, its message list cut to match, and the authors of the kept messages. One transaction
 * on the runner's handle. Returns how many runs were copied.
 */
export function copyHistoryPrefix(
  db: DatabaseSync,
  from: string,
  to: string,
  atMessageId: string | null,
): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const runs: StoredRun[] = db
      .prepare(
        'SELECT runId, agentId, events, createdAt FROM chat_runs WHERE threadId=? ORDER BY id',
      )
      .all(from)
      .map((row) => ({
        runId: String(row.runId),
        agentId: String(row.agentId),
        events: JSON.parse(String(row.events)) as StoredEvent[],
        createdAt: Number(row.createdAt),
      }));
    const kept = historyPrefix(runs, atMessageId);
    const runIds = new Map(kept.map((run) => [run.runId, randomUUID()]));
    const keptIds = new Set(
      kept.flatMap((run) => run.events.flatMap(namedIds)),
    );
    const thread = db
      .prepare('SELECT agentId, messages FROM chat_threads WHERE threadId=?')
      .get(from);
    const messages: Message[] = thread
      ? (JSON.parse(String(thread.messages)) as Message[])
      : [];
    const keptMessages = messages
      .slice(
        0,
        messages.findLastIndex((message) => keptIds.has(message.id)) + 1,
      )
      .map(copyMessage);
    const now = Date.now();
    for (const run of kept)
      db.prepare(
        'INSERT INTO chat_runs(threadId, runId, agentId, events, createdAt) VALUES (?, ?, ?, ?, ?)',
      ).run(
        to,
        runIds.get(run.runId)!,
        run.agentId,
        JSON.stringify(
          run.events.map((event) => copyEvent(event, from, to, runIds)),
        ),
        run.createdAt,
      );
    if (thread && keptMessages.length) {
      db.prepare(
        'INSERT INTO chat_threads(threadId, agentId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ).run(to, String(thread.agentId), JSON.stringify(keptMessages), now, now);
      const ids = new Set(keptMessages.map((message) => message.id));
      for (const row of db
        .prepare(
          'SELECT messageId, agentId FROM thread_authors WHERE threadId=?',
        )
        .all(from))
        if (ids.has(String(row.messageId)))
          db.prepare(
            'INSERT OR IGNORE INTO thread_authors(threadId, messageId, agentId) VALUES (?, ?, ?)',
          ).run(to, String(row.messageId), String(row.agentId));
    }
    db.exec('COMMIT');
    return kept.length;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Copies the rows of a per-thread table another phase may add (the group chat's
 * `thread_participants`) from one thread to another. Does nothing while the table does not exist:
 * PRAGMA table_info lists no columns for a missing table.
 */
export function copyThreadRows(
  db: DatabaseSync,
  table: string,
  from: string,
  to: string,
) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => String(column.name));
  if (!columns.includes('threadId')) return;
  const names = columns.map((column) => `"${column}"`).join(', ');
  const values = columns
    .map((column) => (column === 'threadId' ? '?' : `"${column}"`))
    .join(', ');
  db.prepare(
    `INSERT OR IGNORE INTO ${table}(${names}) SELECT ${values} FROM ${table} WHERE threadId=?`,
  ).run(to, from);
}

/**
 * Branches conversation `sourceId` at `atMessageId` (null: an empty branch) for the same Dot and
 * returns the new conversation.
 */
export function branchConversation(
  deps: { workspace: WorkspaceStore; runner: SqliteAgentRunner },
  sourceId: string,
  atMessageId: string | null,
): Conversation {
  const source = deps.workspace.requireThread(sourceId);
  const id = randomUUID();
  deps.runner.branchRuns(sourceId, id, atMessageId);
  try {
    return deps.workspace.bindBranch(
      id,
      source,
      atMessageId,
      branchTitle(source.title),
    );
  } catch (error) {
    try {
      deps.runner.deleteThread(id);
    } catch (cleanup) {
      console.error(
        'Could not remove the copied history of a failed branch:',
        cleanup instanceof Error ? cleanup.message : 'unknown error',
      );
    }
    throw error;
  }
}
