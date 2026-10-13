// Group chats: the Dots the owner added to a conversation besides its host Dot. The host stays in
// thread_bindings.dotId (and chat_threads.agentId); a participant may take turns in the thread, so
// every entry path checks membership through WorkspaceStore.requireThread.
import type { DatabaseSync } from 'node:sqlite';

export interface ThreadParticipant {
  threadId: string;
  dotId: string;
  addedAt: number;
}

export class ParticipantStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_participants(threadId TEXT NOT NULL, dotId TEXT NOT NULL,
      addedAt INTEGER NOT NULL, PRIMARY KEY(threadId, dotId));`);
  }

  /** The participants of a thread, in the order they were added. */
  list(threadId: string): ThreadParticipant[] {
    return this.db
      .prepare(
        'SELECT threadId, dotId, addedAt FROM thread_participants WHERE threadId=? ORDER BY addedAt, rowid',
      )
      .all(threadId)
      .map((row) => ({
        threadId: String(row.threadId),
        dotId: String(row.dotId),
        addedAt: Number(row.addedAt),
      }));
  }

  /** Participant ids of every thread that has any, for the conversation list. */
  byThread(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of this.db
      .prepare(
        'SELECT threadId, dotId FROM thread_participants ORDER BY addedAt, rowid',
      )
      .all()) {
      const ids = map.get(String(row.threadId)) ?? [];
      ids.push(String(row.dotId));
      map.set(String(row.threadId), ids);
    }
    return map;
  }

  has(threadId: string, dotId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM thread_participants WHERE threadId=? AND dotId=?')
      .get(threadId, dotId);
  }

  /** Adds a participant; adding one twice keeps the first time it joined. */
  add(threadId: string, dotId: string, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO thread_participants(threadId, dotId, addedAt) VALUES (?, ?, ?)',
      )
      .run(threadId, dotId, now);
  }

  /** Removes a participant and the baton passes still waiting for it in that thread. */
  remove(threadId: string, dotId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.db
        .prepare('DELETE FROM thread_participants WHERE threadId=? AND dotId=?')
        .run(threadId, dotId).changes;
      this.db
        .prepare(
          "DELETE FROM resume_markers WHERE threadId=? AND dotId=? AND kind='relay'",
        )
        .run(threadId, dotId);
      this.db.exec('COMMIT');
      return removed > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
