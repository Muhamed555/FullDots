// Computer replay: one row per browser step a Dot took in a conversation, with a small JPEG of the
// screen after it when one could be taken. Rows belong to a Dot and a thread; they go when the thread
// is deleted, when the Dot is, and oldest first once a Dot has more than its cap.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ReplayStep } from '../shared/computer-types.js';

export interface NewReplayStep {
  dotId: string;
  threadId: string;
  toolCallId: string;
  action: string;
  url: string;
  title: string;
  outcome: ReplayStep['outcome'];
  jpeg?: Uint8Array;
}

export class ComputerFrameStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_frames(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, createdAt INTEGER NOT NULL, jpeg BLOB,
        action TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'succeeded');
      CREATE INDEX IF NOT EXISTS computer_frames_thread ON computer_frames(dotId,threadId,createdAt);
      CREATE INDEX IF NOT EXISTS computer_frames_dot ON computer_frames(dotId,createdAt);`);
  }
  /** Records a step and drops the Dot's oldest beyond `cap`. Returns the step's id. */
  add(step: NewReplayStep, cap: number, now = Date.now()): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO computer_frames(id,dotId,threadId,toolCallId,createdAt,jpeg,action,url,title,outcome) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        step.dotId,
        step.threadId,
        step.toolCallId,
        now,
        step.jpeg ?? null,
        step.action,
        step.url.slice(0, 2048),
        step.title.slice(0, 300),
        step.outcome,
      );
    this.db
      .prepare(
        `DELETE FROM computer_frames WHERE dotId=? AND id NOT IN
          (SELECT id FROM computer_frames WHERE dotId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?)`,
      )
      .run(step.dotId, step.dotId, Math.max(0, cap));
    return id;
  }
  /** Adds the picture to a step recorded earlier, unless the step has been removed since. */
  attach(id: string, jpeg: Uint8Array) {
    this.db
      .prepare('UPDATE computer_frames SET jpeg=? WHERE id=?')
      .run(jpeg, id);
  }
  /** A thread's steps for one Dot, oldest first. Never includes the pictures themselves. */
  steps(dotId: string, threadId: string): ReplayStep[] {
    return this.db
      .prepare(
        `SELECT id,toolCallId,createdAt,action,url,title,outcome,jpeg IS NOT NULL AS hasFrame FROM computer_frames
          WHERE dotId=? AND threadId=? ORDER BY createdAt, rowid`,
      )
      .all(dotId, threadId)
      .map((row) => ({
        id: String(row.id),
        toolCallId: String(row.toolCallId),
        createdAt: Number(row.createdAt),
        action: String(row.action),
        url: String(row.url),
        title: String(row.title),
        outcome: row.outcome === 'failed' ? 'failed' : 'succeeded',
        hasFrame: Number(row.hasFrame) === 1,
      }));
  }
  /** The picture of one step, only when it belongs to this Dot. */
  frame(dotId: string, id: string): Uint8Array | undefined {
    const row = this.db
      .prepare('SELECT jpeg FROM computer_frames WHERE id=? AND dotId=?')
      .get(id, dotId);
    return row?.jpeg instanceof Uint8Array ? row.jpeg : undefined;
  }
  count(dotId: string): number {
    return Number(
      this.db
        .prepare('SELECT COUNT(*) AS n FROM computer_frames WHERE dotId=?')
        .get(dotId)?.n ?? 0,
    );
  }
  deleteThread(threadId: string) {
    this.db
      .prepare('DELETE FROM computer_frames WHERE threadId=?')
      .run(threadId);
  }
  deleteDot(dotId: string) {
    this.db.prepare('DELETE FROM computer_frames WHERE dotId=?').run(dotId);
  }
}

/**
 * The newest screencast frame the live-screen relay passed on for each Dot. When the owner is
 * watching, a replay step reuses it instead of asking the computer for a screenshot.
 */
export class LiveFrames {
  private latest = new Map<string, { body: string; at: number }>();
  /** Keeps the frame message as it arrived; it is parsed only if a step needs it. */
  note(dotId: string, body: string, now = Date.now()) {
    this.latest.set(dotId, { body, at: now });
  }
  forget(dotId: string) {
    this.latest.delete(dotId);
  }
  /**
   * The JPEG of a frame no older than `maxAgeMs`. `redact` runs over the raw message first, the same
   * way every other computer response is cleaned.
   */
  recent(
    dotId: string,
    maxAgeMs: number,
    redact: (text: string) => string = (text) => text,
    now = Date.now(),
  ): Buffer | undefined {
    const entry = this.latest.get(dotId);
    if (!entry || now - entry.at > maxAgeMs) return undefined;
    try {
      const message = JSON.parse(redact(entry.body)) as { data?: unknown };
      if (typeof message.data !== 'string') return undefined;
      const jpeg = Buffer.from(message.data, 'base64');
      return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Shared by the live-screen relay and every ComputerService in this process. */
export const liveFrames = new LiveFrames();
