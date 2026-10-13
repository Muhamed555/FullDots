// Pure helpers for @mentions in the composer: which Dots the owner addressed, which of them must be
// confirmed first, and the keyboard of the mention popover. Only text the owner typed is ever parsed
// here; nothing the model, a tool or a web page wrote reaches these functions.
import type { Dot } from '../../shared/types';

type Named = Pick<Dot, 'id' | 'name'>;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Dots mentioned as `@Name` in the owner's text, in the order they first appear. Names match
 * case-insensitively and the longest name wins ("@Scout Pro" is not "@Scout"); a mention must start
 * the text or follow whitespace or an opening bracket, and end at a non-word character.
 */
export function findMentions(text: string, dots: readonly Named[]): string[] {
  const named = dots
    .filter((dot) => dot.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return [];
  const pattern = new RegExp(
    `(^|[\\s(\\[])@(${named.map((dot) => escape(dot.name.trim())).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match[2].toLowerCase();
    const dot = named.find((item) => item.name.trim().toLowerCase() === name);
    if (dot && !found.includes(dot.id)) found.push(dot.id);
  }
  return found;
}

export interface MentionPlan {
  /** The Dots that take a turn, one after another, in mention order. Empty: the host answers as usual. */
  targets: string[];
  /** Mentioned Dots that are not in the chat yet: the owner confirms each before anything runs. */
  toConfirm: string[];
}

/** What sending this text does in a chat with this host and these participants. */
export function mentionPlan(
  text: string,
  dots: readonly Named[],
  hostId: string,
  participantIds: readonly string[],
): MentionPlan {
  const mentioned = findMentions(text, dots);
  // Mentioning only the host changes nothing: it answers as it always does.
  if (!mentioned.some((id) => id !== hostId))
    return { targets: [], toConfirm: [] };
  return {
    targets: mentioned,
    toConfirm: mentioned.filter(
      (id) => id !== hostId && !participantIds.includes(id),
    ),
  };
}

/** The Dots the popover lists for what follows `@`: name prefix matches first, then the rest. */
export function filterMentionDots<T extends Named>(
  dots: readonly T[],
  query: string,
): T[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...dots];
  const starts = dots.filter((dot) =>
    dot.name.toLowerCase().startsWith(wanted),
  );
  const contains = dots.filter(
    (dot) => !starts.includes(dot) && dot.name.toLowerCase().includes(wanted),
  );
  return [...starts, ...contains];
}

/** What the composer inserts for a picked Dot. */
export const mentionText = (dot: Pick<Dot, 'name'>) => `@${dot.name} `;

export type MentionKeyResult =
  | { handled: false }
  | { handled: true; active: number }
  | { handled: true; choose: number }
  | { handled: true; close: true };

/** The popover's keyboard: Up/Down move (wrapping), Enter/Tab pick, Escape closes. */
export function mentionKey(
  key: string,
  state: { count: number; active: number },
): MentionKeyResult {
  const { count, active } = state;
  if (key === 'Escape') return { handled: true, close: true };
  if (!count) return { handled: false };
  switch (key) {
    case 'ArrowDown':
      return { handled: true, active: (active + 1) % count };
    case 'ArrowUp':
      return { handled: true, active: (active - 1 + count) % count };
    case 'Enter':
    case 'Tab':
      return {
        handled: true,
        choose: Math.min(Math.max(active, 0), count - 1),
      };
    default:
      return { handled: false };
  }
}

/** The first non-empty line of a Dot's instructions: its role line in lists. */
export function roleLine(instructions: string, max = 70): string {
  const line =
    instructions
      .split('\n')
      .find((item) => item.trim())
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The option id the textarea's aria-activedescendant points at. */
export const mentionOptionId = (listId: string, dotId: string) =>
  `${listId}-${dotId}`;
