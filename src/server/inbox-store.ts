// The owner's inbox: questions a Dot asked with `ask_owner` and the results of finished background
// turns. Approvals and handoffs keep their own tables. Rows belong to a thread and go with it
// (WorkspaceStore.deleteThread).
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { InboxItem, InboxKind } from '../shared/inbox.js';

const toItem = (row: Record<string, unknown>): InboxItem => ({
  id: String(row.id),
  kind: row.kind === 'question' ? 'question' : 'result',
  dotId: String(row.dotId),
  threadId: String(row.threadId),
  teamRunId: row.teamRunId === null ? null : String(row.teamRunId),
  title: String(row.title),
  text: String(row.text),
  createdAt: Number(row.createdAt),
  readAt: row.readAt === null ? null : Number(row.readAt),
  archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
  answer: row.answer === null ? null : String(row.answer),
  answeredAt: row.answeredAt === null ? null : Number(row.answeredAt),
});

/** A question still waiting for the owner: not answered and not archived. */
const OPEN = "kind='question' AND answeredAt IS NULL AND archivedAt IS NULL";
// rowid breaks ties between items created in the same millisecond.
const NEWEST = 'ORDER BY createdAt DESC, rowid DESC';

export class InboxStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_items(id TEXT PRIMARY KEY, kind TEXT NOT NULL, dotId TEXT NOT NULL, threadId TEXT NOT NULL,
      teamRunId TEXT, title TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL, readAt INTEGER, archivedAt INTEGER,
      answer TEXT, answeredAt INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_items_thread ON inbox_items(threadId, kind);
      CREATE INDEX IF NOT EXISTS inbox_items_open ON inbox_items(kind, archivedAt, createdAt);`);
  }

  create(input: {
    kind: InboxKind;
    dotId: string;
    threadId: string;
    title: string;
    text: string;
    teamRunId?: string | null;
  }): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      kind: input.kind,
      dotId: input.dotId,
      threadId: input.threadId,
      teamRunId: input.teamRunId ?? null,
      title: input.title,
      text: input.text,
      createdAt: this.now(),
      readAt: null,
      archivedAt: null,
      answer: null,
      answeredAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO inbox_items(id,kind,dotId,threadId,teamRunId,title,text,createdAt,readAt,archivedAt,answer,answeredAt)
         VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)`,
      )
      .run(
        item.id,
        item.kind,
        item.dotId,
        item.threadId,
        item.teamRunId,
        item.title,
        item.text,
        item.createdAt,
      );
    return item;
  }

  get(id: string): InboxItem | undefined {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE id=?').get(id);
    return row ? toItem(row) : undefined;
  }

  /** Items not archived, newest first. Questions are the open ones only. */
  list(kind: InboxKind, limit = 100): InboxItem[] {
    return this.db
      .prepare(
        kind === 'question'
          ? `SELECT * FROM inbox_items WHERE ${OPEN} ${NEWEST} LIMIT ?`
          : `SELECT * FROM inbox_items WHERE kind='result' AND archivedAt IS NULL ${NEWEST} LIMIT ?`,
      )
      .all(limit)
      .map(toItem);
  }

  counts(): { questions: number; results: number; unread: number } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) AS questions,
          SUM(CASE WHEN kind='result' AND archivedAt IS NULL THEN 1 ELSE 0 END) AS results,
          SUM(CASE WHEN kind='result' AND archivedAt IS NULL AND readAt IS NULL THEN 1 ELSE 0 END) AS unread
         FROM inbox_items`,
      )
      .get();
    return {
      questions: Number(row?.questions ?? 0),
      results: Number(row?.results ?? 0),
      unread: Number(row?.unread ?? 0),
    };
  }

  /** The open question of a thread, if any (there is at most one: ask_owner reuses it). */
  openQuestion(threadId: string): InboxItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM inbox_items WHERE threadId=? AND ${OPEN} ${NEWEST} LIMIT 1`,
      )
      .get(threadId);
    return row ? toItem(row) : undefined;
  }

  /** Threads with an open question: the scheduler skips them, like threads with a pending approval. */
  openQuestionThreadIds(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT threadId FROM inbox_items WHERE ${OPEN}`)
      .all()
      .map((row) => String(row.threadId));
  }

  /** Open questions per Dot. */
  openQuestionsByDot(): Map<string, number> {
    return new Map(
      this.db
        .prepare(
          `SELECT dotId, COUNT(*) AS n FROM inbox_items WHERE ${OPEN} GROUP BY dotId`,
        )
        .all()
        .map((row) => [String(row.dotId), Number(row.n)]),
    );
  }

  /** True when the item was unread. */
  markRead(id: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE inbox_items SET readAt=? WHERE id=? AND readAt IS NULL',
        )
        .run(this.now(), id).changes > 0
    );
  }

  /**
   * Stores the answer to an open question, once: false when the item is not an open question
   * (answered, archived, a result, or gone). The check and the write are one statement.
   */
  answer(id: string, text: string): boolean {
    const now = this.now();
    return (
      this.db
        .prepare(
          `UPDATE inbox_items SET answer=?, answeredAt=?, readAt=COALESCE(readAt, ?) WHERE id=? AND ${OPEN}`,
        )
        .run(text, now, now, id).changes > 0
    );
  }

  /**
   * Archives an item, once. Returns the item as it was before, or undefined when it was already
   * archived or does not exist.
   */
  archive(id: string): InboxItem | undefined {
    const before = this.get(id);
    if (!before || before.archivedAt !== null) return undefined;
    const now = this.now();
    const changed =
      this.db
        .prepare(
          'UPDATE inbox_items SET archivedAt=?, readAt=COALESCE(readAt, ?) WHERE id=? AND archivedAt IS NULL',
        )
        .run(now, now, id).changes > 0;
    return changed ? before : undefined;
  }
}
