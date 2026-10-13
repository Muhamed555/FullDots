// Named teams and their runs. A team is a lead Dot plus up to eight members (the lead is NOT a
// member row: `teams.leadDotId` names it, and `team_members.position` orders the members from 0).
// A team run is one piece of work a team did for one team chat; each member that took part is a
// step, backed by a delegation (the existing hand-off machinery) once it starts.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DOT_COLORS, type DotColor } from '../../shared/types.js';
import type {
  ReviewVerdict,
  Team,
  TeamMember,
  TeamMode,
  TeamRun,
  TeamRunStatus,
  TeamRunStep,
  TeamStepRole,
  TeamStepStatus,
  TeamStyle,
} from '../../shared/teams.js';
import { TeamSpaceGrants } from './team-space.js';

export interface NewTeam {
  name: string;
  emoji: string;
  color: DotColor;
  description?: string;
  leadDotId: string;
  style?: TeamStyle;
  mode?: TeamMode;
  summarize?: boolean;
  reviewerDotId?: string | null;
  runLog?: boolean;
  members?: { dotId: string; role?: string }[];
}

export type TeamPatch = Partial<
  Pick<
    Team,
    | 'name'
    | 'emoji'
    | 'color'
    | 'description'
    | 'leadDotId'
    | 'style'
    | 'mode'
    | 'summarize'
    | 'reviewerDotId'
    | 'runLog'
  >
>;

/** A step as stored, with the brief it starts with (kept for steps that have not started yet). */
export interface StoredStep extends TeamRunStep {
  brief: string;
}

const VERDICTS: readonly ReviewVerdict[] = ['approved', 'changes', 'unclear'];

const toRun = (
  row: Record<string, unknown>,
): TeamRun & { postedAt: number | null } => ({
  id: String(row.id),
  teamId: String(row.teamId),
  threadId: String(row.threadId),
  style: String(row.style) as TeamStyle,
  mode: String(row.mode) as TeamMode,
  status: String(row.status) as TeamRunStatus,
  createdAt: Number(row.createdAt),
  finishedAt: row.finishedAt == null ? null : Number(row.finishedAt),
  cancelledAt: row.cancelledAt == null ? null : Number(row.cancelledAt),
  reviewerDotId: row.reviewerDotId == null ? null : String(row.reviewerDotId),
  verdict: VERDICTS.find((verdict) => verdict === row.verdict) ?? null,
  sentBack: !!row.sentBack,
  log:
    row.logPageId == null || row.logSpaceId == null
      ? null
      : { spaceId: String(row.logSpaceId), pageId: String(row.logPageId) },
  postedAt: row.postedAt == null ? null : Number(row.postedAt),
});

const toStep = (row: Record<string, unknown>): StoredStep => ({
  runId: String(row.runId),
  delegationId: row.delegationId == null ? null : String(row.delegationId),
  dotId: String(row.dotId),
  position: Number(row.position),
  status: String(row.status) as TeamStepStatus,
  role: row.role === 'reviewer' ? 'reviewer' : 'worker',
  firstDelegationId:
    row.firstDelegationId == null ? null : String(row.firstDelegationId),
  brief: String(row.brief ?? ''),
});

export class NamedTeamStore {
  /** Space access a team gave its Dots (only that is ever taken back by the team). */
  readonly spaces: TeamSpaceGrants;
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL,
      color TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', leadDotId TEXT NOT NULL, style TEXT NOT NULL,
      mode TEXT NOT NULL, summarize INTEGER NOT NULL DEFAULT 0, reviewerDotId TEXT, spaceId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER);
      CREATE TABLE IF NOT EXISTS team_members(teamId TEXT NOT NULL, dotId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, PRIMARY KEY(teamId, dotId));
      CREATE TABLE IF NOT EXISTS team_runs(id TEXT PRIMARY KEY, teamId TEXT NOT NULL, threadId TEXT NOT NULL,
      style TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
      finishedAt INTEGER, cancelledAt INTEGER, postedAt INTEGER);
      CREATE INDEX IF NOT EXISTS team_runs_thread ON team_runs(threadId);
      CREATE INDEX IF NOT EXISTS team_runs_team ON team_runs(teamId, createdAt);
      CREATE TABLE IF NOT EXISTS team_run_steps(runId TEXT NOT NULL, delegationId TEXT, dotId TEXT NOT NULL,
      position INTEGER NOT NULL, status TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(runId, dotId));
      CREATE INDEX IF NOT EXISTS team_run_steps_delegation ON team_run_steps(delegationId);`);
    for (const [table, column, definition] of [
      // P5: the run log switch, the reviewer of review runs, the run log page and the owner's request.
      ['teams', 'runLog', 'INTEGER NOT NULL DEFAULT 1'],
      ['team_runs', 'reviewerDotId', 'TEXT'],
      ['team_runs', 'verdict', 'TEXT'],
      ['team_runs', 'sentBack', 'INTEGER NOT NULL DEFAULT 0'],
      ['team_runs', 'logSpaceId', 'TEXT'],
      ['team_runs', 'logPageId', 'TEXT'],
      ['team_runs', 'request', 'TEXT'],
      ['team_run_steps', 'role', "TEXT NOT NULL DEFAULT 'worker'"],
      ['team_run_steps', 'firstDelegationId', 'TEXT'],
    ] as const)
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    this.spaces = new TeamSpaceGrants(db);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private members(teamId: string): TeamMember[] {
    return this.db
      .prepare(
        'SELECT dotId, role, position FROM team_members WHERE teamId=? ORDER BY position, dotId',
      )
      .all(teamId)
      .map((row) => ({
        dotId: String(row.dotId),
        role: String(row.role),
        position: Number(row.position),
      }));
  }

  private toTeam(row: Record<string, unknown>): Team {
    const color = String(row.color);
    return {
      id: String(row.id),
      name: String(row.name),
      emoji: String(row.emoji),
      color: (DOT_COLORS.includes(color as DotColor)
        ? color
        : 'indigo') as DotColor,
      description: String(row.description ?? ''),
      leadDotId: String(row.leadDotId),
      style: String(row.style) as TeamStyle,
      mode: String(row.mode) as TeamMode,
      summarize: !!row.summarize,
      reviewerDotId:
        row.reviewerDotId == null ? null : String(row.reviewerDotId),
      spaceId: row.spaceId == null ? null : String(row.spaceId),
      runLog: row.runLog == null ? true : !!row.runLog,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      archivedAt: row.archivedAt == null ? null : Number(row.archivedAt),
      members: this.members(String(row.id)),
    };
  }

  /** Active teams by name; with `archived`, archived ones too (after the active ones). */
  list(options: { archived?: boolean } = {}): Team[] {
    return this.db
      .prepare(
        `SELECT * FROM teams ${options.archived ? '' : 'WHERE archivedAt IS NULL'}
         ORDER BY archivedAt IS NOT NULL, name COLLATE NOCASE, createdAt`,
      )
      .all()
      .map((row) => this.toTeam(row));
  }

  get(id: string): Team | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE id=?').get(id);
    return row ? this.toTeam(row) : undefined;
  }

  /** An active team with this name, ignoring case and surrounding spaces. */
  activeNamed(name: string): Team | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM teams WHERE archivedAt IS NULL AND lower(trim(name))=lower(trim(?))',
      )
      .get(name);
    return row ? this.toTeam(row) : undefined;
  }

  create(input: NewTeam, now = Date.now()): Team {
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO teams(id, name, emoji, color, description, leadDotId, style, mode, summarize,
            reviewerDotId, spaceId, createdAt, updatedAt, archivedAt, runLog)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          input.name.trim(),
          input.emoji.trim(),
          input.color,
          input.description?.trim() ?? '',
          input.leadDotId,
          input.style ?? 'parallel',
          input.mode ?? 'lead',
          +(input.summarize ?? false),
          input.reviewerDotId ?? null,
          now,
          now,
          +(input.runLog ?? true),
        );
      this.writeMembers(id, input.members ?? []);
    });
    this.syncSpace(id);
    return this.get(id)!;
  }

  update(id: string, patch: TeamPatch, now = Date.now()): Team | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    // A key given as undefined keeps the current value (the routes pass optional fields through).
    const next: Team = {
      ...current,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    };
    this.db
      .prepare(
        `UPDATE teams SET name=?, emoji=?, color=?, description=?, leadDotId=?, style=?, mode=?,
          summarize=?, reviewerDotId=?, runLog=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name.trim(),
        next.emoji.trim(),
        next.color,
        next.description.trim(),
        next.leadDotId,
        next.style,
        next.mode,
        +next.summarize,
        next.reviewerDotId,
        +next.runLog,
        now,
        id,
      );
    this.syncSpace(id);
    return this.get(id);
  }

  /** Gives the team its home Space and its Dots access to it. */
  setSpace(id: string, spaceId: string, now = Date.now()): Team | undefined {
    this.db
      .prepare('UPDATE teams SET spaceId=?, updatedAt=? WHERE id=?')
      .run(spaceId, now, id);
    this.syncSpace(id);
    return this.get(id);
  }

  /** Brings the team's Space access in line with its lead, members and reviewer. */
  syncSpace(id: string) {
    const team = this.get(id);
    if (!team) return;
    this.spaces.sync(team.id, team.spaceId, [
      team.leadDotId,
      ...team.members.map((member) => member.dotId),
      ...(team.reviewerDotId ? [team.reviewerDotId] : []),
    ]);
  }

  /**
   * The team Space a page made in this conversation goes to by default: the Space of the team the
   * chat belongs to (or whose run made it, for a member's step chat), when this Dot may use it.
   */
  spaceFor(threadId: string, dotId: string): string | undefined {
    const row =
      this.db
        .prepare(
          'SELECT teamId FROM thread_bindings WHERE id=? AND teamId IS NOT NULL',
        )
        .get(threadId) ??
      this.db
        .prepare(
          `SELECT r.teamId FROM team_run_steps s JOIN team_runs r ON r.id=s.runId
           JOIN delegations d ON d.id=s.delegationId OR d.id=s.firstDelegationId
           WHERE d.childThreadId=? LIMIT 1`,
        )
        .get(threadId);
    if (typeof row?.teamId !== 'string') return undefined;
    const spaceId = this.get(row.teamId)?.spaceId;
    return spaceId && this.spaces.canUse(dotId, spaceId) ? spaceId : undefined;
  }

  private writeMembers(
    teamId: string,
    members: { dotId: string; role?: string }[],
  ) {
    this.db.prepare('DELETE FROM team_members WHERE teamId=?').run(teamId);
    const insert = this.db.prepare(
      'INSERT INTO team_members(teamId, dotId, role, position) VALUES (?, ?, ?, ?)',
    );
    members.forEach((member, position) =>
      insert.run(teamId, member.dotId, member.role?.trim() ?? '', position),
    );
  }

  /** Replaces the members; their order in the list is their position. */
  setMembers(
    teamId: string,
    members: { dotId: string; role?: string }[],
    now = Date.now(),
  ): Team | undefined {
    if (!this.get(teamId)) return undefined;
    this.transaction(() => {
      this.writeMembers(teamId, members);
      this.db
        .prepare('UPDATE teams SET updatedAt=? WHERE id=?')
        .run(now, teamId);
    });
    this.syncSpace(teamId);
    return this.get(teamId);
  }

  /** Archives a team. Its Dots, chats and runs stay; it no longer grants its lead anything. */
  archive(id: string, now = Date.now()): Team | undefined {
    this.db
      .prepare(
        'UPDATE teams SET archivedAt=?, updatedAt=? WHERE id=? AND archivedAt IS NULL',
      )
      .run(now, now, id);
    return this.get(id);
  }

  /** Active teams this Dot leads. */
  ledBy(dotId: string): Team[] {
    return this.db
      .prepare(
        'SELECT * FROM teams WHERE archivedAt IS NULL AND leadDotId=? ORDER BY name COLLATE NOCASE',
      )
      .all(dotId)
      .map((row) => this.toTeam(row));
  }

  /** Active teams this Dot is in, as lead or member. */
  teamsOf(dotId: string): Team[] {
    return this.list().filter(
      (team) =>
        team.leadDotId === dotId ||
        team.reviewerDotId === dotId ||
        team.members.some((member) => member.dotId === dotId),
    );
  }

  /**
   * The Dots this Dot may hand work to because it leads an active team they are in, with the teams
   * that imply each. Members get nothing from a team: only the lead does.
   */
  impliedDelegates(dotId: string): Map<string, Team[]> {
    const implied = new Map<string, Team[]>();
    for (const team of this.ledBy(dotId))
      for (const member of team.members)
        if (member.dotId !== dotId)
          implied.set(member.dotId, [
            ...(implied.get(member.dotId) ?? []),
            team,
          ]);
    return implied;
  }

  /**
   * A Dot leaves every team (for when Dots can be deleted): its member rows go, and a team it led
   * is archived rather than deleted, so its chats and runs stay readable.
   */
  dotRemoved(dotId: string, now = Date.now()): { archived: string[] } {
    return this.transaction(() => {
      const touched = this.db
        .prepare('SELECT DISTINCT teamId FROM team_members WHERE dotId=?')
        .all(dotId)
        .map((row) => String(row.teamId));
      this.db.prepare('DELETE FROM team_members WHERE dotId=?').run(dotId);
      for (const teamId of touched)
        this.writeMembers(
          teamId,
          this.members(teamId).map(({ dotId: id, role }) => ({
            dotId: id,
            role,
          })),
        );
      const archived = this.db
        .prepare(
          'SELECT id FROM teams WHERE leadDotId=? AND archivedAt IS NULL',
        )
        .all(dotId)
        .map((row) => String(row.id));
      this.db
        .prepare(
          'UPDATE teams SET archivedAt=?, updatedAt=? WHERE leadDotId=? AND archivedAt IS NULL',
        )
        .run(now, now, dotId);
      // A team whose reviewer goes keeps its style; until a new reviewer is chosen it runs like
      // "All at once".
      const reviewed = this.db
        .prepare('SELECT id FROM teams WHERE reviewerDotId=?')
        .all(dotId)
        .map((row) => String(row.id));
      this.db
        .prepare(
          'UPDATE teams SET reviewerDotId=NULL, updatedAt=? WHERE reviewerDotId=?',
        )
        .run(now, dotId);
      for (const teamId of new Set([...touched, ...reviewed]))
        this.syncSpace(teamId);
      return { archived };
    });
  }

  // ---- Team chats -------------------------------------------------------------------------

  /** Marks a conversation as a chat of this team (thread_bindings.teamId). */
  bindThread(threadId: string, teamId: string) {
    this.db
      .prepare('UPDATE thread_bindings SET teamId=? WHERE id=?')
      .run(teamId, threadId);
  }

  threadTeam(threadId: string): Team | undefined {
    const row = this.db
      .prepare('SELECT teamId FROM thread_bindings WHERE id=?')
      .get(threadId);
    return typeof row?.teamId === 'string' ? this.get(row.teamId) : undefined;
  }

  /** The team's chats, newest first. */
  conversations(
    teamId: string,
    limit = 20,
  ): { id: string; title: string; createdAt: number }[] {
    return this.db
      .prepare(
        'SELECT id, title, createdAt FROM thread_bindings WHERE teamId=? ORDER BY createdAt DESC LIMIT ?',
      )
      .all(teamId, limit)
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        createdAt: Number(row.createdAt),
      }));
  }

  // ---- Runs -------------------------------------------------------------------------------

  createRun(
    input: Pick<TeamRun, 'teamId' | 'threadId' | 'style' | 'mode'> & {
      /** A direct run's id is chosen before its "Sent to ..." line names it. */
      id?: string;
      reviewerDotId?: string | null;
      /** The owner's message the run answers (a direct run knows it at once). */
      request?: string | null;
    },
    steps: {
      dotId: string;
      position: number;
      brief: string;
      role?: TeamStepRole;
    }[],
    now = Date.now(),
  ): TeamRun {
    const id = input.id ?? randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO team_runs(id, teamId, threadId, style, mode, status, createdAt, finishedAt, cancelledAt,
            postedAt, reviewerDotId, request)
           VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.teamId,
          input.threadId,
          input.style,
          input.mode,
          now,
          input.reviewerDotId ?? null,
          input.request ?? null,
        );
      const insert = this.db.prepare(
        `INSERT INTO team_run_steps(runId, delegationId, dotId, position, status, brief, role)
         VALUES (?, NULL, ?, ?, 'queued', ?, ?)`,
      );
      for (const step of steps)
        insert.run(
          id,
          step.dotId,
          step.position,
          step.brief,
          step.role ?? 'worker',
        );
    });
    return this.run(id)!;
  }

  /** The owner's message a run answers, when it was recorded. */
  request(runId: string): string | null {
    const row = this.db
      .prepare('SELECT request FROM team_runs WHERE id=?')
      .get(runId);
    return typeof row?.request === 'string' ? row.request : null;
  }

  setRequest(runId: string, request: string) {
    this.db
      .prepare('UPDATE team_runs SET request=? WHERE id=? AND request IS NULL')
      .run(request, runId);
  }

  setVerdict(runId: string, verdict: ReviewVerdict) {
    this.db
      .prepare('UPDATE team_runs SET verdict=? WHERE id=?')
      .run(verdict, runId);
  }

  /** Records the one send-back round of a review run. True only for the first call. */
  markSentBack(runId: string): boolean {
    return (
      this.db
        .prepare('UPDATE team_runs SET sentBack=1 WHERE id=? AND sentBack=0')
        .run(runId).changes > 0
    );
  }

  /** Records the run log page. True only the first time, so a run is logged once. */
  setLog(runId: string, spaceId: string, pageId: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE team_runs SET logSpaceId=?, logPageId=? WHERE id=? AND logPageId IS NULL',
        )
        .run(spaceId, pageId, runId).changes > 0
    );
  }

  run(id: string): (TeamRun & { postedAt: number | null }) | undefined {
    const row = this.db.prepare('SELECT * FROM team_runs WHERE id=?').get(id);
    return row ? toRun(row) : undefined;
  }

  runs(teamId: string, limit = 10): TeamRun[] {
    return this.db
      .prepare(
        'SELECT * FROM team_runs WHERE teamId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?',
      )
      .all(teamId, limit)
      .map(toRun);
  }

  runsForThread(threadId: string): TeamRun[] {
    return this.db
      .prepare(
        'SELECT * FROM team_runs WHERE threadId=? ORDER BY createdAt, rowid',
      )
      .all(threadId)
      .map(toRun);
  }

  steps(runId: string): StoredStep[] {
    return this.db
      .prepare(
        'SELECT * FROM team_run_steps WHERE runId=? ORDER BY position, dotId',
      )
      .all(runId)
      .map(toStep);
  }

  /** The step of a delegation: its current one, or the first of a step that went round again. */
  stepOf(delegationId: string): StoredStep | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM team_run_steps WHERE delegationId=? OR firstDelegationId=?',
      )
      .get(delegationId, delegationId);
    return row ? toStep(row) : undefined;
  }

  setStep(
    runId: string,
    dotId: string,
    patch: {
      status: TeamStepStatus;
      delegationId?: string;
      /** The delegation of the round before (a step that goes round again). */
      firstDelegationId?: string;
    },
  ) {
    if (patch.firstDelegationId)
      this.db
        .prepare(
          'UPDATE team_run_steps SET firstDelegationId=? WHERE runId=? AND dotId=?',
        )
        .run(patch.firstDelegationId, runId, dotId);
    if (patch.delegationId)
      this.db
        .prepare(
          'UPDATE team_run_steps SET status=?, delegationId=? WHERE runId=? AND dotId=?',
        )
        .run(patch.status, patch.delegationId, runId, dotId);
    else
      this.db
        .prepare('UPDATE team_run_steps SET status=? WHERE runId=? AND dotId=?')
        .run(patch.status, runId, dotId);
  }

  /** Ends a running run. True only for the call that ended it, so its results go out once. */
  finishRun(
    id: string,
    status: Exclude<TeamRunStatus, 'running' | 'cancelled'>,
    now = Date.now(),
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE team_runs SET status=?, finishedAt=? WHERE id=? AND status='running'",
        )
        .run(status, now, id).changes > 0
    );
  }

  /** Cancels a running run. True only for the call that cancelled it. */
  cancelRun(id: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE team_runs SET status='cancelled', cancelledAt=?, finishedAt=? WHERE id=? AND status='running'",
        )
        .run(now, now, id).changes > 0
    );
  }

  /** Records that a direct run's results were posted into its chat. True only the first time. */
  markPosted(id: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          'UPDATE team_runs SET postedAt=? WHERE id=? AND postedAt IS NULL',
        )
        .run(now, id).changes > 0
    );
  }

  /** Direct runs that finished but whose results are not in their chat yet (a restart came between). */
  unposted(): TeamRun[] {
    return this.db
      .prepare(
        "SELECT * FROM team_runs WHERE mode='direct' AND status IN ('done','failed') AND postedAt IS NULL",
      )
      .all()
      .map(toRun);
  }
}
