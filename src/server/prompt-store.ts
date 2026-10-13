import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Prompt, PromptScope } from '../shared/prompts.js';

const toPrompt = (row: Record<string, unknown>): Prompt => ({
  id: String(row.id),
  title: String(row.title),
  body: String(row.body),
  scope: String(row.scope) as PromptScope,
  dotId: row.dotId === null ? null : String(row.dotId),
  teamId: row.teamId === null ? null : String(row.teamId),
  createdAt: Number(row.createdAt),
  updatedAt: Number(row.updatedAt),
  archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
});

export interface PromptInput {
  title: string;
  body: string;
  scope: PromptScope;
  dotId: string | null;
  teamId: string | null;
}

/** Saved prompts. Archiving hides a prompt; no row is ever deleted. */
export class PromptStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      scope TEXT NOT NULL, dotId TEXT, teamId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      archivedAt INTEGER);
      CREATE INDEX IF NOT EXISTS prompts_dot ON prompts(dotId);`);
  }

  /** Active prompts, newest change first. With a Dot: the global ones plus that Dot's own. */
  list(dotId?: string): Prompt[] {
    const rows = dotId
      ? this.db
          .prepare(
            `SELECT * FROM prompts WHERE archivedAt IS NULL AND (scope='global' OR dotId=?)
             ORDER BY updatedAt DESC, id`,
          )
          .all(dotId)
      : this.db
          .prepare(
            'SELECT * FROM prompts WHERE archivedAt IS NULL ORDER BY updatedAt DESC, id',
          )
          .all();
    return rows.map(toPrompt);
  }

  /** An active prompt; an archived one reads as missing. */
  get(id: string): Prompt | undefined {
    const row = this.db
      .prepare('SELECT * FROM prompts WHERE id=? AND archivedAt IS NULL')
      .get(id);
    return row ? toPrompt(row) : undefined;
  }

  create(input: PromptInput, now = Date.now()): Prompt {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO prompts(id, title, body, scope, dotId, teamId, createdAt, updatedAt, archivedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.title,
        input.body,
        input.scope,
        input.dotId,
        input.teamId,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, input: PromptInput, now = Date.now()): Prompt | undefined {
    const changed = this.db
      .prepare(
        `UPDATE prompts SET title=?, body=?, scope=?, dotId=?, teamId=?, updatedAt=?
         WHERE id=? AND archivedAt IS NULL`,
      )
      .run(
        input.title,
        input.body,
        input.scope,
        input.dotId,
        input.teamId,
        now,
        id,
      ).changes;
    return changed ? this.get(id) : undefined;
  }

  /** Hides a prompt. False when it is missing or already archived. */
  archive(id: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          'UPDATE prompts SET archivedAt=? WHERE id=? AND archivedAt IS NULL',
        )
        .run(now, id).changes > 0
    );
  }

  /** Hides every prompt that belongs to a Dot; call it when the Dot is deleted. */
  archiveForDot(dotId: string, now = Date.now()): number {
    return Number(
      this.db
        .prepare(
          'UPDATE prompts SET archivedAt=? WHERE dotId=? AND archivedAt IS NULL',
        )
        .run(now, dotId).changes,
    );
  }
}
