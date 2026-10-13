// Mission control grouped by team (the `groups` hook of src/server/mission.ts). A Dot in several
// teams appears under each of them; Dots in no team share one last group. Without teams the grid
// keeps its single "Your Dots" group.
import type { MissionGroup } from '../../shared/inbox.js';
import type { Team } from '../../shared/teams.js';

export function teamGroups(teams: Team[], dotIds: string[]): MissionGroup[] {
  if (!teams.length) return [{ id: 'all', label: 'Your Dots', dotIds }];
  const known = new Set(dotIds);
  const placed = new Set<string>();
  const groups: MissionGroup[] = [];
  for (const team of teams) {
    const ids = [
      team.leadDotId,
      ...team.members.map((member) => member.dotId),
    ].filter((id) => known.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => placed.add(id));
    groups.push({
      id: `team:${team.id}`,
      label: `${team.emoji} ${team.name}`,
      dotIds: ids,
    });
  }
  const rest = dotIds.filter((id) => !placed.has(id));
  if (rest.length)
    groups.push({
      id: 'other',
      label: groups.length ? 'Not in a team' : 'Your Dots',
      dotIds: rest,
    });
  return groups;
}
