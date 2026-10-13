// A team's home Space: the team gives its lead, members and reviewer access to it, and takes back
// only the access it gave. `team_space_grants` records each grant the team made; access a Dot had
// before (the owner ticked it by hand) is never recorded, so the team never removes it.
import type { DatabaseSync } from 'node:sqlite';

export class TeamSpaceGrants {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS team_space_grants(teamId TEXT NOT NULL, dotId TEXT NOT NULL,
      spaceId TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(teamId, dotId, spaceId));`);
  }

  canUse(dotId: string, spaceId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }

  /** The (Dot, Space) pairs this team granted. */
  granted(teamId: string): { dotId: string; spaceId: string }[] {
    return this.db
      .prepare(
        'SELECT dotId, spaceId FROM team_space_grants WHERE teamId=? ORDER BY dotId',
      )
      .all(teamId)
      .map((row) => ({
        dotId: String(row.dotId),
        spaceId: String(row.spaceId),
      }));
  }

  /**
   * Gives every Dot in `dotIds` access to `spaceId` and takes back what the team gave Dots that
   * left (or to an earlier Space). A Dot that already had access gets no grant row. A grant whose
   * access the owner removed by hand stays removed: only a Dot without a grant row is given access.
   * Access is kept when it is the Dot's default page destination, or when another team granted it.
   */
  sync(
    teamId: string,
    spaceId: string | null,
    dotIds: string[],
    now = Date.now(),
  ) {
    const space =
      spaceId && this.db.prepare('SELECT 1 FROM spaces WHERE id=?').get(spaceId)
        ? spaceId
        : null;
    const wanted = new Set(
      space
        ? dotIds.filter(
            (id) => !!this.db.prepare('SELECT 1 FROM dots WHERE id=?').get(id),
          )
        : [],
    );
    const grants = this.granted(teamId);
    for (const grant of grants) {
      if (grant.spaceId === space && wanted.has(grant.dotId)) continue;
      this.db
        .prepare(
          'DELETE FROM team_space_grants WHERE teamId=? AND dotId=? AND spaceId=?',
        )
        .run(teamId, grant.dotId, grant.spaceId);
      const shared = this.db
        .prepare(
          'SELECT 1 FROM team_space_grants WHERE dotId=? AND spaceId=? LIMIT 1',
        )
        .get(grant.dotId, grant.spaceId);
      const home = this.db
        .prepare('SELECT 1 FROM dots WHERE id=? AND spaceId=?')
        .get(grant.dotId, grant.spaceId);
      if (!shared && !home)
        this.db
          .prepare('DELETE FROM dot_spaces WHERE dotId=? AND spaceId=?')
          .run(grant.dotId, grant.spaceId);
    }
    if (!space) return;
    for (const dotId of wanted) {
      if (
        grants.some(
          (grant) => grant.dotId === dotId && grant.spaceId === space,
        ) ||
        this.canUse(dotId, space)
      )
        continue;
      this.db
        .prepare('INSERT INTO dot_spaces(dotId, spaceId) VALUES (?, ?)')
        .run(dotId, space);
      this.db
        .prepare(
          'INSERT INTO team_space_grants(teamId, dotId, spaceId, createdAt) VALUES (?, ?, ?, ?)',
        )
        .run(teamId, dotId, space, now);
    }
  }
}
