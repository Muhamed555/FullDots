import type { DatabaseSync } from 'node:sqlite';

/** Escapes `\`, `%` and `_` so a LIKE pattern matches the typed text literally. */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const contains = (query: string) => `%${escapeLike(query)}%`;
// SQLite LIKE ignores case for ASCII letters only; other scripts match with their exact case.
const LIKE = `LIKE ? ESCAPE '\\'`;

export interface ChatRow {
  id: string;
  dotId: string;
  title: string;
}
export interface PageRow {
  id: string;
  spaceId: string;
  title: string;
  content: string;
  updatedAt: number;
  titleHit: boolean;
}
export interface DotRow {
  id: string;
  name: string;
  instructions: string;
  createdAt: number;
  nameHit: boolean;
}
export interface PromptRow {
  id: string;
  title: string;
  body: string;
  dotId: string | null;
  updatedAt: number;
  titleHit: boolean;
}

/** LIKE queries over the workspace tables. Chat messages are searched separately (see search.ts). */
export class SearchStore {
  constructor(
    private db: DatabaseSync,
    private ownerId: string,
  ) {}

  /** Conversations whose title contains the text. Recency comes from the chat store, not here. */
  chats(query: string): ChatRow[] {
    return this.db
      .prepare(
        `SELECT id, dotId, title FROM thread_bindings WHERE ownerId=? AND title ${LIKE} LIMIT 500`,
      )
      .all(this.ownerId, contains(query))
      .map((row) => ({
        id: String(row.id),
        dotId: String(row.dotId),
        title: String(row.title),
      }));
  }

  pages(query: string, limit: number): PageRow[] {
    const pattern = contains(query);
    return this.db
      .prepare(
        `SELECT id, spaceId, title, content, updatedAt, (title ${LIKE}) AS titleHit FROM pages
         WHERE title ${LIKE} OR content ${LIKE} ORDER BY updatedAt DESC, id LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit)
      .map((row) => ({
        id: String(row.id),
        spaceId: String(row.spaceId),
        title: String(row.title),
        content: String(row.content),
        updatedAt: Number(row.updatedAt),
        titleHit: !!row.titleHit,
      }));
  }

  dots(query: string, limit: number): DotRow[] {
    const pattern = contains(query);
    return this.db
      .prepare(
        `SELECT id, name, instructions, createdAt, (name ${LIKE}) AS nameHit FROM dots
         WHERE name ${LIKE} OR instructions ${LIKE} ORDER BY createdAt DESC, id LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        instructions: String(row.instructions),
        createdAt: Number(row.createdAt),
        nameHit: !!row.nameHit,
      }));
  }

  /** Active prompts only; archived ones never show up. */
  prompts(query: string, limit: number): PromptRow[] {
    const pattern = contains(query);
    return this.db
      .prepare(
        `SELECT id, title, body, dotId, updatedAt, (title ${LIKE}) AS titleHit FROM prompts
         WHERE archivedAt IS NULL AND (title ${LIKE} OR body ${LIKE})
         ORDER BY updatedAt DESC, id LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit)
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        body: String(row.body),
        dotId: row.dotId === null ? null : String(row.dotId),
        updatedAt: Number(row.updatedAt),
        titleHit: !!row.titleHit,
      }));
  }
}
