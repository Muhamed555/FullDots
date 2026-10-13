import type { DatabaseSync } from 'node:sqlite';
import type { PinnedMessage } from '../shared/message-actions.js';

/** Messages pinned to the top of a conversation. Rows go with their conversation (deleteThread). */
export class PinStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS pinned_messages(threadId TEXT NOT NULL, messageId TEXT NOT NULL,
      createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, messageId));`);
  }

  /** Oldest pin first, the order they were pinned in. */
  list(threadId: string): PinnedMessage[] {
    return this.db
      .prepare(
        'SELECT messageId, createdAt FROM pinned_messages WHERE threadId=? ORDER BY createdAt, messageId',
      )
      .all(threadId)
      .map((row) => ({
        messageId: String(row.messageId),
        createdAt: Number(row.createdAt),
      }));
  }

  /** Pinning twice keeps the first pin. */
  pin(threadId: string, messageId: string, now = Date.now()): PinnedMessage[] {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pinned_messages(threadId, messageId, createdAt) VALUES (?, ?, ?)',
      )
      .run(threadId, messageId, now);
    return this.list(threadId);
  }

  unpin(threadId: string, messageId: string): PinnedMessage[] {
    this.db
      .prepare('DELETE FROM pinned_messages WHERE threadId=? AND messageId=?')
      .run(threadId, messageId);
    return this.list(threadId);
  }
}
