import type { RecentEntry } from './palette-model';

const KEY = 'fulldots.palette.recents';
export const RECENTS_MAX = 8;

const sameThing = (a: RecentEntry, b: RecentEntry) =>
  a.kind === b.kind && a.id === b.id;

/** Puts an entry first, drops its older copy and keeps the list short. */
export function addRecent(
  list: RecentEntry[],
  entry: RecentEntry,
  max = RECENTS_MAX,
): RecentEntry[] {
  return [entry, ...list.filter((item) => !sameThing(item, entry))].slice(
    0,
    max,
  );
}

function isEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string') return false;
  if (entry.kind === 'chat') return true;
  return entry.kind === 'page' && typeof entry.spaceId === 'string';
}

/** Recently opened chats and pages. Storage can be blocked, so every access is guarded. */
export function readRecents(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isEntry).slice(0, RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Remembers an opened chat or page and returns the new list. */
export function recordRecent(entry: RecentEntry): RecentEntry[] {
  const next = addRecent(readRecents(), entry);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows or blocked storage: the list simply is not kept.
  }
  return next;
}
