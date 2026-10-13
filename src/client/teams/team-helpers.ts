// Small pure helpers about a team's Dots, shared by the sidebar rows and the team views.
import type { Team } from '../../shared/teams';

/** Lead first, then the members in order. */
export const teamDotIds = (team: Pick<Team, 'leadDotId' | 'members'>) => [
  team.leadDotId,
  ...team.members.map((member) => member.dotId),
];

/** True while any Dot of the team holds a turn. */
export const teamIsWorking = (
  team: Pick<Team, 'leadDotId' | 'members'>,
  working: ReadonlySet<string>,
) => teamDotIds(team).some((id) => working.has(id));
