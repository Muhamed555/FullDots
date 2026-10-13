import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Delegation, DelegationStatus } from '../shared/types.js';

const toDelegation = (row: Record<string, unknown>): Delegation => ({
  id: String(row.id),
  parentThreadId: String(row.parentThreadId),
  parentDotId: String(row.parentDotId),
  childThreadId: String(row.childThreadId),
  childDotId: String(row.childDotId),
  taskId: String(row.taskId),
  depth: Number(row.depth),
  status: String(row.status) as DelegationStatus,
  brief: String(row.brief),
  deliverable: String(row.deliverable),
  result: row.result === null ? null : String(row.result),
  createdAt: Number(row.createdAt),
  finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
  batchKey: row.batchKey == null ? null : String(row.batchKey),
  startedAt: row.startedAt == null ? null : Number(row.startedAt),
  deliveredAt: row.deliveredAt == null ? null : Number(row.deliveredAt),
  retryOf: row.retryOf == null ? null : String(row.retryOf),
});

// Columns added after the first release; ALTER TABLE keeps existing rows (they read as null).
const DELEGATION_COLUMNS: [string, string][] = [
  ['batchKey', 'TEXT'],
  ['startedAt', 'INTEGER'],
  ['deliveredAt', 'INTEGER'],
  ['retryOf', 'TEXT'],
];

/** Teams of Dots: who may hand work to whom, and every hand-off with its result. */
export class TeamStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS dot_teams(dotId TEXT NOT NULL, delegateId TEXT NOT NULL,
      PRIMARY KEY(dotId, delegateId));
      CREATE TABLE IF NOT EXISTS delegations(id TEXT PRIMARY KEY, parentThreadId TEXT NOT NULL,
      parentDotId TEXT NOT NULL, childThreadId TEXT NOT NULL, childDotId TEXT NOT NULL, taskId TEXT NOT NULL,
      depth INTEGER NOT NULL, status TEXT NOT NULL, brief TEXT NOT NULL, deliverable TEXT NOT NULL,
      result TEXT, createdAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX IF NOT EXISTS delegations_child ON delegations(childThreadId);
      CREATE INDEX IF NOT EXISTS delegations_task ON delegations(taskId);
      CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parentThreadId);`);
    const present = new Set(
      db
        .prepare('PRAGMA table_info(delegations)')
        .all()
        .map((column) => String(column.name)),
    );
    for (const [name, type] of DELEGATION_COLUMNS)
      if (!present.has(name))
        db.exec(`ALTER TABLE delegations ADD COLUMN ${name} ${type}`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS delegations_batch ON delegations(batchKey)',
    );
  }

  delegates(dotId: string): string[] {
    return this.db
      .prepare(
        'SELECT delegateId FROM dot_teams WHERE dotId=? ORDER BY delegateId',
      )
      .all(dotId)
      .map((row) => String(row.delegateId));
  }

  setDelegates(dotId: string, delegateIds: string[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM dot_teams WHERE dotId=?').run(dotId);
      for (const id of new Set(delegateIds))
        if (id !== dotId)
          this.db.prepare('INSERT INTO dot_teams VALUES (?, ?)').run(dotId, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(
    input: Omit<
      Delegation,
      | 'id'
      | 'status'
      | 'result'
      | 'createdAt'
      | 'finishedAt'
      | 'batchKey'
      | 'startedAt'
      | 'deliveredAt'
      | 'retryOf'
    > & { batchKey?: string | null; retryOf?: string | null },
    now = Date.now(),
  ): Delegation {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegations(id, parentThreadId, parentDotId, childThreadId, childDotId, taskId, depth, status,
          brief, deliverable, result, createdAt, finishedAt, batchKey, retryOf) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.parentThreadId,
        input.parentDotId,
        input.childThreadId,
        input.childDotId,
        input.taskId,
        input.depth,
        input.brief,
        input.deliverable,
        now,
        input.batchKey ?? null,
        input.retryOf ?? null,
      );
    return this.get(id)!;
  }

  get(id: string): Delegation | undefined {
    const row = this.db.prepare('SELECT * FROM delegations WHERE id=?').get(id);
    return row ? toDelegation(row) : undefined;
  }

  byTask(taskId: string): Delegation | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE taskId=?')
      .get(taskId);
    return row ? toDelegation(row) : undefined;
  }

  /** The hand-off that created this conversation, if it was created by one. */
  byChildThread(threadId: string): Delegation | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE childThreadId=?')
      .get(threadId);
    return row ? toDelegation(row) : undefined;
  }

  forParent(threadId: string): Delegation[] {
    return this.db
      .prepare(
        'SELECT * FROM delegations WHERE parentThreadId=? ORDER BY createdAt',
      )
      .all(threadId)
      .map(toDelegation);
  }

  finish(
    id: string,
    status: Exclude<DelegationStatus, 'running'>,
    result: string,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        'UPDATE delegations SET status=?, result=?, finishedAt=? WHERE id=?',
      )
      .run(status, result.slice(0, 20_000), now, id);
  }

  /** The hand-off that tried this one again, if any. */
  retryOfThis(id: string): Delegation | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM delegations WHERE retryOf=? ORDER BY createdAt LIMIT 1',
      )
      .get(id);
    return row ? toDelegation(row) : undefined;
  }

  /** Every conversation a hand-off created, with the conversation and Dot that handed it over. */
  parents(): Map<string, { threadId: string; dotId: string }> {
    return new Map(
      this.db
        .prepare(
          'SELECT childThreadId, parentThreadId, parentDotId FROM delegations',
        )
        .all()
        .map((row) => [
          String(row.childThreadId),
          {
            threadId: String(row.parentThreadId),
            dotId: String(row.parentDotId),
          },
        ]),
    );
  }

  /** The hand-offs made in one turn (see Delegation.batchKey), oldest first. */
  inBatch(batchKey: string): Delegation[] {
    return this.db
      .prepare(
        'SELECT * FROM delegations WHERE batchKey=? ORDER BY createdAt, rowid',
      )
      .all(batchKey)
      .map(toDelegation);
  }

  /** Records when the teammate's turn started; the first start counts. */
  markStarted(id: string, now = Date.now()) {
    this.db
      .prepare(
        'UPDATE delegations SET startedAt=? WHERE id=? AND startedAt IS NULL',
      )
      .run(now, id);
  }

  /** Records that these results reached the Dot that asked. */
  markDelivered(ids: string[], now = Date.now()) {
    const update = this.db.prepare(
      'UPDATE delegations SET deliveredAt=? WHERE id=? AND deliveredAt IS NULL',
    );
    for (const id of ids) update.run(now, id);
  }

  /** Forgets a Dot's team when its grants change hands (not used for history). */
  forgetDot(dotId: string) {
    this.db
      .prepare('DELETE FROM dot_teams WHERE dotId=? OR delegateId=?')
      .run(dotId, dotId);
  }
}
