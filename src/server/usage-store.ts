import type { DatabaseSync } from 'node:sqlite';
import type { DotUsage, UsageDay } from '../shared/types.js';

/** The UTC day a moment belongs to, as `YYYY-MM-DD`. */
export const usageDay = (now = Date.now()) =>
  new Date(now).toISOString().slice(0, 10);

const toDay = (row: Record<string, unknown>): UsageDay => ({
  day: String(row.day),
  inputTokens: Number(row.inputTokens),
  outputTokens: Number(row.outputTokens),
  turns: Number(row.turns),
  unreportedTurns: Number(row.unreportedTurns),
});

/**
 * Tokens each Dot used per UTC day, from the usage providers report at the end of every turn, and the
 * optional daily budget that pauses a Dot's background work. A turn whose provider reports nothing
 * counts as an unreported turn instead of an estimate.
 */
export class UsageStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS dot_usage(dotId TEXT NOT NULL, day TEXT NOT NULL,
      inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0, unreportedTurns INTEGER NOT NULL DEFAULT 0,
      warnedAt INTEGER, PRIMARY KEY(dotId, day));
      CREATE TABLE IF NOT EXISTS dot_budgets(dotId TEXT PRIMARY KEY, dailyTokens INTEGER NOT NULL);`);
  }

  /** Adds one turn. Returns the Dot's total tokens for that day afterwards. */
  record(
    dotId: string,
    tokens: { input: number; output: number } | null,
    now = Date.now(),
  ): number {
    const input = Math.max(0, Math.round(tokens?.input ?? 0));
    const output = Math.max(0, Math.round(tokens?.output ?? 0));
    this.db
      .prepare(
        `INSERT INTO dot_usage(dotId, day, inputTokens, outputTokens, turns, unreportedTurns)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(dotId, day) DO UPDATE SET inputTokens=inputTokens+excluded.inputTokens,
           outputTokens=outputTokens+excluded.outputTokens, turns=turns+1,
           unreportedTurns=unreportedTurns+excluded.unreportedTurns`,
      )
      .run(dotId, usageDay(now), input, output, tokens ? 0 : 1);
    return this.tokensOn(dotId, usageDay(now));
  }

  tokensOn(dotId: string, day: string): number {
    const row = this.db
      .prepare(
        'SELECT inputTokens + outputTokens AS total FROM dot_usage WHERE dotId=? AND day=?',
      )
      .get(dotId, day);
    return Number(row?.total ?? 0);
  }

  /** True the first time it is called for this Dot and day: the caller sends the warning. */
  claimWarning(dotId: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          'UPDATE dot_usage SET warnedAt=? WHERE dotId=? AND day=? AND warnedAt IS NULL',
        )
        .run(now, dotId, usageDay(now)).changes > 0
    );
  }

  budget(dotId: string): number | null {
    const row = this.db
      .prepare('SELECT dailyTokens FROM dot_budgets WHERE dotId=?')
      .get(dotId);
    return row ? Number(row.dailyTokens) : null;
  }

  setBudget(dotId: string, dailyTokens: number | null) {
    if (dailyTokens === null)
      this.db.prepare('DELETE FROM dot_budgets WHERE dotId=?').run(dotId);
    else
      this.db
        .prepare(
          'INSERT INTO dot_budgets VALUES (?, ?) ON CONFLICT(dotId) DO UPDATE SET dailyTokens=excluded.dailyTokens',
        )
        .run(dotId, Math.round(dailyTokens));
  }

  /** Dots that used their whole daily budget today; their background work waits for tomorrow. */
  overBudgetDots(now = Date.now()): string[] {
    return this.db
      .prepare(
        `SELECT b.dotId FROM dot_budgets b JOIN dot_usage u ON u.dotId=b.dotId AND u.day=?
         WHERE u.inputTokens + u.outputTokens >= b.dailyTokens`,
      )
      .all(usageDay(now))
      .map((row) => String(row.dotId));
  }

  /** Usage of one Dot: today, the current month, and the last `days` days (newest first). */
  summary(dotId: string, now = Date.now(), days = 30): DotUsage {
    const today = usageDay(now);
    const since = usageDay(now - (days - 1) * 86_400_000);
    const rows = this.db
      .prepare(
        'SELECT * FROM dot_usage WHERE dotId=? AND day>=? ORDER BY day DESC',
      )
      .all(dotId, since)
      .map(toDay);
    const month = today.slice(0, 7);
    const sum = (list: UsageDay[]) =>
      list.reduce(
        (total, day) => total + day.inputTokens + day.outputTokens,
        0,
      );
    return {
      dotId,
      today: sum(rows.filter((row) => row.day === today)),
      month: sum(
        this.db
          .prepare('SELECT * FROM dot_usage WHERE dotId=? AND day LIKE ?')
          .all(dotId, `${month}-%`)
          .map(toDay),
      ),
      budget: this.budget(dotId),
      days: rows,
    };
  }

  /** Forgets a deleted Dot. */
  forget(dotId: string) {
    this.db.prepare('DELETE FROM dot_usage WHERE dotId=?').run(dotId);
    this.db.prepare('DELETE FROM dot_budgets WHERE dotId=?').run(dotId);
  }
}
