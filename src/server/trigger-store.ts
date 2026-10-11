import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { open, seal } from './connector-crypto.js';
import type { Trigger, TriggerAuth, TriggerKind } from '../shared/types.js';

export const hashSecret = (secret: string) =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export interface NewTrigger {
  dotId: string;
  threadId: string;
  kind: TriggerKind;
  name: string;
  prompt: string;
  auth?: TriggerAuth;
  hmacHeader?: string;
  hmacPrefix?: string;
  connectorId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  intervalSeconds?: number;
  dedupePath?: string;
}

/** The stored row: the view plus what verifies a webhook. Never sent to the browser. */
export interface TriggerRecord extends Trigger {
  secretHash: string | null;
  secretSealed: string | null;
  lastKey: string | null;
}

const toRecord = (row: Record<string, unknown>): TriggerRecord => ({
  id: String(row.id),
  dotId: String(row.dotId),
  threadId: String(row.threadId),
  kind: String(row.kind) as TriggerKind,
  name: String(row.name),
  prompt: String(row.prompt),
  auth: row.auth === null ? null : (String(row.auth) as TriggerAuth),
  hmacHeader: row.hmacHeader === null ? null : String(row.hmacHeader),
  hmacPrefix: row.hmacPrefix === null ? null : String(row.hmacPrefix),
  connectorId: row.connectorId === null ? null : String(row.connectorId),
  tool: row.tool === null ? null : String(row.tool),
  args:
    row.args === null
      ? {}
      : (JSON.parse(String(row.args)) as Record<string, unknown>),
  intervalSeconds:
    row.intervalSeconds === null ? null : Number(row.intervalSeconds),
  dedupePath: row.dedupePath === null ? null : String(row.dedupePath),
  enabled: Number(row.enabled) === 1,
  createdAt: Number(row.createdAt),
  lastFiredAt: row.lastFiredAt === null ? null : Number(row.lastFiredAt),
  lastPolledAt: row.lastPolledAt === null ? null : Number(row.lastPolledAt),
  lastError: row.lastError === null ? null : String(row.lastError),
  eventCount: Number(row.eventCount ?? 0),
  secretHash: row.secretHash === null ? null : String(row.secretHash),
  secretSealed: row.secretSealed === null ? null : String(row.secretSealed),
  lastKey: row.lastKey === null ? null : String(row.lastKey),
});

/** What the API may show: everything except the secret material and the poll state. */
export const toView = (record: TriggerRecord): Trigger => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secretHash, secretSealed, lastKey, ...view } = record;
  return view;
};

/**
 * Webhook and poll triggers. Bearer and query secrets are kept as SHA-256 hashes; an HMAC secret is
 * needed in plain text to verify a signature, so it is sealed with the connector key (AES-256-GCM).
 */
export class TriggerStore {
  constructor(
    private db: DatabaseSync,
    private key: Buffer,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS triggers(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, threadId TEXT NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, auth TEXT, secretHash TEXT, secretSealed TEXT,
      hmacHeader TEXT, hmacPrefix TEXT, connectorId TEXT, tool TEXT, args TEXT, intervalSeconds INTEGER,
      dedupePath TEXT, lastKey TEXT, lastPolledAt INTEGER, lastFiredAt INTEGER, lastError TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_events(id TEXT PRIMARY KEY, triggerId TEXT NOT NULL, dedupeKey TEXT NOT NULL,
      receivedAt INTEGER NOT NULL, taskId TEXT, UNIQUE(triggerId, dedupeKey));
      CREATE INDEX IF NOT EXISTS triggers_thread ON triggers(threadId);`);
  }

  private select = `SELECT t.*, (SELECT COUNT(*) FROM trigger_events e WHERE e.triggerId=t.id) AS eventCount FROM triggers t`;

  list(): TriggerRecord[] {
    return this.db
      .prepare(`${this.select} ORDER BY t.createdAt DESC`)
      .all()
      .map(toRecord);
  }

  get(id: string): TriggerRecord | undefined {
    const row = this.db.prepare(`${this.select} WHERE t.id=?`).get(id);
    return row ? toRecord(row) : undefined;
  }

  create(input: NewTrigger, secret: string | null, now = Date.now()) {
    const id = randomUUID();
    const auth = input.kind === 'webhook' ? (input.auth ?? 'bearer') : null;
    this.db
      .prepare(
        `INSERT INTO triggers(id, dotId, threadId, kind, name, prompt, auth, secretHash, secretSealed, hmacHeader,
          hmacPrefix, connectorId, tool, args, intervalSeconds, dedupePath, enabled, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.dotId,
        input.threadId,
        input.kind,
        input.name,
        input.prompt,
        auth,
        ...this.secretColumns(id, auth, secret),
        auth === 'hmac' ? (input.hmacHeader ?? 'x-hub-signature-256') : null,
        auth === 'hmac' ? (input.hmacPrefix ?? 'sha256=') : null,
        input.connectorId ?? null,
        input.tool ?? null,
        input.kind === 'poll' ? JSON.stringify(input.args ?? {}) : null,
        input.kind === 'poll' ? (input.intervalSeconds ?? 300) : null,
        input.dedupePath ?? null,
        now,
      );
    return this.get(id)!;
  }

  private secretColumns(
    id: string,
    auth: TriggerAuth | null,
    secret: string | null,
  ): [string | null, string | null] {
    if (!auth || !secret) return [null, null];
    return auth === 'hmac'
      ? [null, seal(this.key, secret, `trigger:${id}`)]
      : [hashSecret(secret), null];
  }

  setSecret(id: string, secret: string) {
    const record = this.get(id);
    if (!record?.auth) return;
    const [hash, sealed] = this.secretColumns(id, record.auth, secret);
    this.db
      .prepare('UPDATE triggers SET secretHash=?, secretSealed=? WHERE id=?')
      .run(hash, sealed, id);
  }

  /** The HMAC secret in plain text, for verifying a signature; undefined if it cannot be opened. */
  hmacSecret(record: TriggerRecord): string | undefined {
    return record.secretSealed
      ? open(this.key, record.secretSealed, `trigger:${record.id}`)
      : undefined;
  }

  update(
    id: string,
    patch: Partial<
      Pick<Trigger, 'name' | 'prompt' | 'enabled' | 'intervalSeconds'>
    >,
  ) {
    const current = this.get(id);
    if (!current) return undefined;
    this.db
      .prepare(
        'UPDATE triggers SET name=?, prompt=?, enabled=?, intervalSeconds=? WHERE id=?',
      )
      .run(
        patch.name ?? current.name,
        patch.prompt ?? current.prompt,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        current.kind === 'poll'
          ? (patch.intervalSeconds ?? current.intervalSeconds)
          : null,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM trigger_events WHERE triggerId=?').run(id);
    return (
      this.db.prepare('DELETE FROM triggers WHERE id=?').run(id).changes > 0
    );
  }

  /** Records an event once per dedupe key. False when the key was already seen. */
  recordEvent(triggerId: string, dedupeKey: string, now = Date.now()) {
    const inserted =
      this.db
        .prepare(
          'INSERT OR IGNORE INTO trigger_events(id, triggerId, dedupeKey, receivedAt) VALUES (?, ?, ?, ?)',
        )
        .run(randomUUID(), triggerId, dedupeKey, now).changes > 0;
    if (inserted)
      this.db
        .prepare('UPDATE triggers SET lastFiredAt=?, lastError=NULL WHERE id=?')
        .run(now, triggerId);
    return inserted;
  }

  linkTask(triggerId: string, dedupeKey: string, taskId: string) {
    this.db
      .prepare(
        'UPDATE trigger_events SET taskId=? WHERE triggerId=? AND dedupeKey=?',
      )
      .run(taskId, triggerId, dedupeKey);
  }

  polled(
    id: string,
    key: string | null,
    error: string | null,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        'UPDATE triggers SET lastPolledAt=?, lastKey=COALESCE(?, lastKey), lastError=? WHERE id=?',
      )
      .run(now, key, error, id);
  }

  /** Poll triggers whose interval has passed. */
  duePolls(now = Date.now()): TriggerRecord[] {
    return this.list().filter(
      (trigger) =>
        trigger.kind === 'poll' &&
        trigger.enabled &&
        (trigger.lastPolledAt === null ||
          trigger.lastPolledAt + (trigger.intervalSeconds ?? 300) * 1000 <=
            now),
    );
  }

  deleteForThread(threadId: string) {
    for (const trigger of this.list().filter((t) => t.threadId === threadId))
      this.delete(trigger.id);
  }
}
