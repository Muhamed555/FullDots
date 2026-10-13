// The team builder's state and rules as plain functions, so adding, reordering and validating a
// team is tested without a browser. The first Dot added becomes the lead; the rest orbit it.
import {
  isSingleEmoji,
  MAX_TEAM_MEMBERS,
  TEAM_NAME_MAX,
  TEAM_ROLE_MAX,
  type Team,
  type TeamMode,
  type TeamStyle,
} from '../../shared/teams';
import type { DotColor } from '../../shared/types';

export interface DraftMember {
  dotId: string;
  role: string;
}

export interface TeamDraft {
  /** Set when editing an existing team. */
  id?: string;
  name: string;
  emoji: string;
  color: DotColor;
  description: string;
  leadDotId: string | null;
  members: DraftMember[];
  style: TeamStyle;
  mode: TeamMode;
  summarize: boolean;
}

/** A new team: "Lead plans" by default (the owner's decision), everyone at once. */
export function emptyDraft(seed: Partial<TeamDraft> = {}): TeamDraft {
  return {
    name: '',
    emoji: '🚀',
    color: 'coral',
    description: '',
    leadDotId: null,
    members: [],
    style: 'parallel',
    mode: 'lead',
    summarize: false,
    ...seed,
  };
}

export function draftFromTeam(team: Team): TeamDraft {
  return {
    id: team.id,
    name: team.name,
    emoji: team.emoji,
    color: team.color,
    description: team.description,
    leadDotId: team.leadDotId,
    members: team.members.map(({ dotId, role }) => ({ dotId, role })),
    style: team.style,
    mode: team.mode,
    summarize: team.summarize,
  };
}

export const onTeam = (draft: TeamDraft, dotId: string) =>
  draft.leadDotId === dotId ||
  draft.members.some((member) => member.dotId === dotId);

export const teamIsFull = (draft: TeamDraft) =>
  draft.leadDotId !== null && draft.members.length >= MAX_TEAM_MEMBERS;

/** Adds a Dot: the lead when there is none yet, else the last member. Unchanged when full. */
export function addToTeam(draft: TeamDraft, dotId: string): TeamDraft {
  if (onTeam(draft, dotId)) return draft;
  if (draft.leadDotId === null) return { ...draft, leadDotId: dotId };
  if (draft.members.length >= MAX_TEAM_MEMBERS) return draft;
  return { ...draft, members: [...draft.members, { dotId, role: '' }] };
}

/** Takes a Dot off the team; when it was the lead, the first member steps up. */
export function removeFromTeam(draft: TeamDraft, dotId: string): TeamDraft {
  if (draft.leadDotId === dotId) {
    const [next, ...rest] = draft.members;
    return { ...draft, leadDotId: next?.dotId ?? null, members: rest };
  }
  return {
    ...draft,
    members: draft.members.filter((member) => member.dotId !== dotId),
  };
}

/** Moves a member to another place in the order (clamped to the list). */
export function moveMember(
  draft: TeamDraft,
  from: number,
  to: number,
): TeamDraft {
  const target = Math.max(0, Math.min(draft.members.length - 1, to));
  if (from === target || !draft.members[from]) return draft;
  const members = [...draft.members];
  const [moved] = members.splice(from, 1);
  members.splice(target, 0, moved!);
  return { ...draft, members };
}

/** A member becomes the lead; the old lead takes its place in the order. */
export function makeLead(draft: TeamDraft, dotId: string): TeamDraft {
  const index = draft.members.findIndex((member) => member.dotId === dotId);
  if (index < 0) return draft;
  const members = [...draft.members];
  if (draft.leadDotId) members[index] = { dotId: draft.leadDotId, role: '' };
  else members.splice(index, 1);
  return { ...draft, leadDotId: dotId, members };
}

export function setRole(
  draft: TeamDraft,
  dotId: string,
  role: string,
): TeamDraft {
  return {
    ...draft,
    members: draft.members.map((member) =>
      member.dotId === dotId
        ? { ...member, role: role.slice(0, TEAM_ROLE_MAX) }
        : member,
    ),
  };
}

/**
 * What a key on a member's order handle does: ArrowUp and ArrowDown move it one place, Home and
 * End to the front or the back. Undefined for any other key.
 */
export function orderKey(
  key: string,
  index: number,
  count: number,
): number | undefined {
  switch (key) {
    case 'ArrowUp':
      return index > 0 ? index - 1 : undefined;
    case 'ArrowDown':
      return index < count - 1 ? index + 1 : undefined;
    case 'Home':
      return index > 0 ? 0 : undefined;
    case 'End':
      return index < count - 1 ? count - 1 : undefined;
    default:
      return undefined;
  }
}

/** The polite announcement after a member moved. */
export const movedMessage = (name: string, index: number, count: number) =>
  `${name} moved to place ${index + 1} of ${count}.`;

export interface DraftErrors {
  name?: string;
  emoji?: string;
  lead?: string;
  members?: string;
}

/** Inline validation, matching what the server checks. */
export function validateDraft(
  draft: TeamDraft,
  others: Pick<Team, 'id' | 'name' | 'archivedAt'>[] = [],
): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Give the team a name.';
  else if (name.length > TEAM_NAME_MAX)
    errors.name = `Team names are at most ${TEAM_NAME_MAX} characters.`;
  else if (
    others.some(
      (team) =>
        !team.archivedAt &&
        team.id !== draft.id &&
        team.name.trim().toLowerCase() === name.toLowerCase(),
    )
  )
    errors.name = `A team named ${name} already exists.`;
  if (!isSingleEmoji(draft.emoji))
    errors.emoji = 'Choose one emoji for the team.';
  if (!draft.leadDotId) errors.lead = 'Add a Dot to lead the team.';
  if (!draft.members.length)
    errors.members = 'Add at least one member besides the lead.';
  else if (draft.members.length > MAX_TEAM_MEMBERS)
    errors.members = `A team has at most ${MAX_TEAM_MEMBERS} members besides its lead.`;
  return errors;
}

export const hasErrors = (errors: DraftErrors) =>
  Object.values(errors).some(Boolean);

/** The body for POST /api/teams (or PATCH /api/teams/:id). */
export function draftPayload(draft: TeamDraft) {
  return {
    name: draft.name.trim(),
    emoji: draft.emoji.trim(),
    color: draft.color,
    description: draft.description.trim(),
    leadDotId: draft.leadDotId ?? '',
    style: draft.style,
    mode: draft.mode,
    summarize: draft.summarize,
    members: draft.members.map((member) => ({
      dotId: member.dotId,
      role: member.role.trim(),
    })),
  };
}

/**
 * Where each member sits around the lead: evenly spaced angles in degrees, the first at the top
 * and the rest clockwise in member order.
 */
export function orbitAngles(count: number): number[] {
  return Array.from({ length: count }, (_, index) =>
    Math.round(-90 + (360 / Math.max(1, count)) * index),
  );
}
