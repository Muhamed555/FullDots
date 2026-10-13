// Deleting a conversation leaves no per-thread rows behind. Every phase that adds a per-thread table
// adds it to TABLES here (workspace tables are removed by WorkspaceStore.deleteThread, chat tables by
// SqliteAgentRunner.deleteThread).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Observable } from 'rxjs';
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { runThreadTurn } from '../src/server/headless.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

/** Per-thread tables and their thread column. */
const TABLES: [table: string, column: string][] = [
  ['chat_runs', 'threadId'],
  ['chat_threads', 'threadId'],
  ['thread_authors', 'threadId'],
  ['computer_frames', 'threadId'],
];

class ReplyAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `reply-${input.runId}`;
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Done.' },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('DELETE /api/conversations/:id leaves no rows of that thread in any per-thread table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-delete-'));
  const path = join(dir, 'fulldots.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const platform = new Platform(
    store,
    workspace,
    { baseUrl: 'https://unused.invalid/v1', voiceName: 'marin' },
    path,
  );
  const reader = new DatabaseSync(path);
  cleanups.push(async () => {
    reader.close();
    await platform.stop();
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const research = { mode: 'sample' as const, baseUrl: '' };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  const dot = workspace.dots()[0];
  for (const id of ['drop', 'keep']) {
    workspace.bindThread(id, dot.id, id);
    await runThreadTurn(
      platform.runner,
      new ReplyAgent({ agentId: dot.id }),
      id,
      'Go.',
      new AbortController().signal,
    );
  }
  // Tables no plain chat turn writes to get a row of their own for each thread.
  for (const id of ['drop', 'keep'])
    reader
      .prepare(
        'INSERT INTO computer_frames(id,dotId,threadId,toolCallId,createdAt) VALUES (?,?,?,?,?)',
      )
      .run(`frame-${id}`, dot.id, id, 'call-1', Date.now());
  const count = (table: string, column: string, id: string) =>
    Number(
      reader
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
        .get(id)?.n,
    );
  for (const [table, column] of TABLES)
    expect(count(table, column, 'drop'), table).toBeGreaterThan(0);

  const response = await app.request('/api/conversations/drop', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status).toBe(200);
  for (const [table, column] of TABLES) {
    expect(count(table, column, 'drop'), table).toBe(0);
    expect(count(table, column, 'keep'), table).toBeGreaterThan(0);
  }
});
