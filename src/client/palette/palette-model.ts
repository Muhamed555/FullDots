import type { SearchResult } from '../../shared/search';
import type { ConversationSummary, Dot, Space } from '../../shared/types';
import { filterChats } from '../sidebar/chat-groups';

/** The groups in the order the palette shows them. `recent` only appears for an empty query. */
export type PaletteGroupId =
  'recent' | 'chat' | 'message' | 'page' | 'dot' | 'prompt' | 'action';
export const GROUP_ORDER: readonly PaletteGroupId[] = [
  'recent',
  'chat',
  'message',
  'page',
  'dot',
  'prompt',
  'action',
];
export const GROUP_LABELS: Record<PaletteGroupId, string> = {
  recent: 'Recent',
  chat: 'Chats',
  message: 'Messages',
  page: 'Pages',
  dot: 'Dots',
  prompt: 'Prompts',
  action: 'Actions',
};

export type PaletteAction =
  | { type: 'new-chat'; dotId: string }
  | { type: 'create-dot' }
  | { type: 'create-space' }
  | { type: 'settings' }
  | { type: 'prompts' }
  | { type: 'approvals' }
  | { type: 'scheduled' }
  | { type: 'pause-dot'; dotId: string }
  | { type: 'resume-dot'; dotId: string };

/** What choosing an item does, as data so the same item can be tested without a browser. */
export type PaletteTarget =
  | { kind: 'chat'; threadId: string; dotId?: string }
  | { kind: 'page'; spaceId: string; pageId: string }
  | { kind: 'dot'; dotId: string }
  | { kind: 'prompt'; promptId: string; dotId?: string }
  | { kind: 'action'; action: PaletteAction };

export type PaletteIcon =
  | 'chat'
  | 'page'
  | 'prompt'
  | 'dot'
  | 'new-chat'
  | 'create-dot'
  | 'create-space'
  | 'settings'
  | 'approvals'
  | 'scheduled'
  | 'pause'
  | 'resume';

export interface PaletteItem {
  /** Unique across groups: `<group>:<id>`. */
  id: string;
  group: PaletteGroupId;
  title: string;
  /** A short second line such as the Dot or Space a result lives in. */
  subtitle?: string;
  /** Text around the match, shown under the title. */
  snippet?: string;
  /** Shown as that Dot's character instead of an icon. */
  dotId?: string;
  icon: PaletteIcon;
  target: PaletteTarget;
}

export interface PaletteGroup {
  id: PaletteGroupId;
  label: string;
  items: PaletteItem[];
}

export interface PaletteHandlers {
  openThread: (threadId: string, dotId?: string) => void;
  openPage: (spaceId: string, pageId: string) => void;
  openDot: (dotId: string) => void;
  usePrompt: (promptId: string, dotId?: string) => void;
  runAction: (action: PaletteAction) => void;
}

/** Sends a chosen target to the matching handler. */
export function dispatchTarget(
  target: PaletteTarget,
  handlers: PaletteHandlers,
) {
  switch (target.kind) {
    case 'chat':
      return handlers.openThread(target.threadId, target.dotId);
    case 'page':
      return handlers.openPage(target.spaceId, target.pageId);
    case 'dot':
      return handlers.openDot(target.dotId);
    case 'prompt':
      return handlers.usePrompt(target.promptId, target.dotId);
    case 'action':
      return handlers.runAction(target.action);
  }
}

export interface PaletteWorkspace {
  dots: Dot[];
  spaces: Space[];
  conversations: ConversationSummary[];
}

/** A search hit as a palette row, or undefined when the thing it points at is gone. */
export function resultToItem(
  result: SearchResult,
  workspace: PaletteWorkspace,
): PaletteItem | undefined {
  const dotName = (id?: string) =>
    workspace.dots.find((dot) => dot.id === id)?.name;
  const id = `${result.type}:${result.id}`;
  switch (result.type) {
    case 'chat':
    case 'message': {
      const threadId = result.threadId ?? result.id;
      return {
        id,
        group: result.type,
        title: result.title,
        subtitle: dotName(result.dotId),
        snippet: result.snippet || undefined,
        dotId: result.dotId,
        icon: 'chat',
        target: { kind: 'chat', threadId, dotId: result.dotId },
      };
    }
    case 'page': {
      if (!result.spaceId) return undefined;
      return {
        id,
        group: 'page',
        title: result.title,
        subtitle: workspace.spaces.find((space) => space.id === result.spaceId)
          ?.name,
        snippet: result.snippet || undefined,
        icon: 'page',
        target: { kind: 'page', spaceId: result.spaceId, pageId: result.id },
      };
    }
    case 'dot':
      return {
        id,
        group: 'dot',
        title: result.title,
        snippet: result.snippet || undefined,
        dotId: result.id,
        icon: 'dot',
        target: { kind: 'dot', dotId: result.id },
      };
    case 'prompt':
      return {
        id,
        group: 'prompt',
        title: result.title,
        subtitle: dotName(result.dotId),
        snippet: result.snippet || undefined,
        icon: 'prompt',
        target: { kind: 'prompt', promptId: result.id, dotId: result.dotId },
      };
    default:
      // A result type this client does not know yet (for example 'team').
      return undefined;
  }
}

export interface ActionContext {
  dots: Dot[];
  /** The Dot the owner is working with; its actions come first. */
  currentDotId?: string;
  /** A chat cannot start before setup is done. */
  configured: boolean;
}

const action = (
  key: string,
  title: string,
  icon: PaletteIcon,
  act: PaletteAction,
  extra: Partial<PaletteItem> = {},
): PaletteItem => ({
  id: `action:${key}`,
  group: 'action',
  title,
  icon,
  target: { kind: 'action', action: act },
  ...extra,
});

/** Everything the palette can do, the current Dot's actions first. */
export function buildActions(context: ActionContext): PaletteItem[] {
  const dots = [...context.dots].sort(
    (a, b) =>
      Number(b.id === context.currentDotId) -
      Number(a.id === context.currentDotId),
  );
  const newChats = context.configured
    ? dots.map((dot) =>
        action(
          `new-chat:${dot.id}`,
          `New chat with ${dot.name}`,
          'new-chat',
          { type: 'new-chat', dotId: dot.id },
          { dotId: dot.id },
        ),
      )
    : [];
  const pauses = dots.map((dot) =>
    dot.paused
      ? action(
          `resume:${dot.id}`,
          `Resume ${dot.name}`,
          'resume',
          { type: 'resume-dot', dotId: dot.id },
          { dotId: dot.id },
        )
      : action(
          `pause:${dot.id}`,
          `Pause ${dot.name}`,
          'pause',
          { type: 'pause-dot', dotId: dot.id },
          { dotId: dot.id },
        ),
  );
  return [
    ...newChats.slice(0, 1),
    action('create-dot', 'Create Dot', 'create-dot', { type: 'create-dot' }),
    action('create-space', 'Create Space', 'create-space', {
      type: 'create-space',
    }),
    action('settings', 'Open Settings', 'settings', { type: 'settings' }),
    action('prompts', 'Open saved prompts', 'prompt', { type: 'prompts' }),
    action('approvals', 'Open Approvals', 'approvals', { type: 'approvals' }),
    action('scheduled', 'Scheduled and activity', 'scheduled', {
      type: 'scheduled',
    }),
    ...pauses.slice(0, 1),
    ...newChats.slice(1),
    ...pauses.slice(1),
  ];
}

/** How many actions an empty or a typed query shows. */
export const ACTIONS_EMPTY = 6;
export const ACTIONS_MATCHED = 8;

/** A chat or page the owner opened lately, kept in local storage. */
export type RecentEntry =
  | { kind: 'chat'; id: string }
  | { kind: 'page'; id: string; spaceId: string; title?: string };

export function recentItems(
  recents: RecentEntry[],
  workspace: PaletteWorkspace,
  pageTitles: Record<string, string> = {},
  max = 6,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const entry of recents) {
    if (entry.kind === 'chat') {
      const chat = workspace.conversations.find((item) => item.id === entry.id);
      if (!chat) continue;
      items.push({
        id: `recent:chat:${chat.id}`,
        group: 'recent',
        title: chat.title,
        subtitle: workspace.dots.find((dot) => dot.id === chat.dotId)?.name,
        dotId: chat.dotId,
        icon: 'chat',
        target: { kind: 'chat', threadId: chat.id, dotId: chat.dotId },
      });
    } else {
      const space = workspace.spaces.find((item) => item.id === entry.spaceId);
      const title = pageTitles[entry.id] ?? entry.title;
      if (!space || !title) continue;
      items.push({
        id: `recent:page:${entry.id}`,
        group: 'recent',
        title,
        subtitle: space.name,
        icon: 'page',
        target: { kind: 'page', spaceId: space.id, pageId: entry.id },
      });
    }
    if (items.length >= max) break;
  }
  return items;
}

export interface BuildInput {
  query: string;
  results: SearchResult[];
  workspace: PaletteWorkspace;
  actions: PaletteItem[];
  recents: PaletteItem[];
}

/** The groups to show: recents and a few actions when empty, results and matching actions when not. */
export function buildGroups(input: BuildInput): PaletteGroup[] {
  const query = input.query.trim();
  const items: PaletteItem[] = query
    ? [
        ...input.results.flatMap((result) => {
          const item = resultToItem(result, input.workspace);
          return item ? [item] : [];
        }),
        ...filterChats(input.actions, query).slice(0, ACTIONS_MATCHED),
      ]
    : [...input.recents, ...input.actions.slice(0, ACTIONS_EMPTY)];
  return GROUP_ORDER.flatMap((id) => {
    const group = items.filter((item) => item.group === id);
    return group.length ? [{ id, label: GROUP_LABELS[id], items: group }] : [];
  });
}

/** What to highlight in a row: the whole typed text for search hits, each word for actions. */
export function highlightTerms(query: string, item: PaletteItem): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return item.group === 'action' ? trimmed.split(/\s+/) : [trimmed];
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Splits text into plain and matching runs (case-insensitive). */
export function highlightParts(text: string, terms: string[]): TextPart[] {
  const usable = [...new Set(terms.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!usable.length || !text) return [{ text, match: false }];
  const pattern = new RegExp(
    usable.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'gi',
  );
  const parts: TextPart[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    if (found[0] === '') continue;
    if (found.index > last)
      parts.push({ text: text.slice(last, found.index), match: false });
    parts.push({ text: found[0], match: true });
    last = found.index + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/** A DOM id for an option: letters, digits and dashes stay, anything else becomes `_<hex>_`. */
export function optionDomId(itemId: string): string {
  return `pal-opt-${Array.from(itemId, (character) =>
    /[A-Za-z0-9-]/.test(character)
      ? character
      : `_${character.codePointAt(0)!.toString(16)}_`,
  ).join('')}`;
}

// ---- Keyboard navigation (pure, so it is tested without a browser) -------------------------

export const flatItems = (groups: PaletteGroup[]): PaletteItem[] =>
  groups.flatMap((group) => group.items);

/** The active id if it is still listed, else the first item. */
export function resolveActive(
  groups: PaletteGroup[],
  activeId: string | undefined,
): string | undefined {
  const items = flatItems(groups);
  return items.some((item) => item.id === activeId) ? activeId : items[0]?.id;
}

/** One step through every item, wrapping around at both ends. */
export function moveActive(
  groups: PaletteGroup[],
  activeId: string | undefined,
  step: 1 | -1,
): string | undefined {
  const items = flatItems(groups);
  if (!items.length) return undefined;
  const current = items.findIndex((item) => item.id === activeId);
  if (current < 0) return items[step === 1 ? 0 : items.length - 1]!.id;
  return items[(current + step + items.length) % items.length]!.id;
}

/** The first item of the next (or previous) group, wrapping around. */
export function jumpGroup(
  groups: PaletteGroup[],
  activeId: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (!groups.length) return undefined;
  const current = groups.findIndex((group) =>
    group.items.some((item) => item.id === activeId),
  );
  if (current < 0)
    return groups[step === 1 ? 0 : groups.length - 1]!.items[0]!.id;
  return groups[(current + step + groups.length) % groups.length]!.items[0]!.id;
}

export interface PaletteKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** An IME is composing text; Enter then belongs to the IME. */
  isComposing?: boolean;
}

export interface PaletteKeyResult {
  /** The key was used here; the caller should preventDefault. */
  handled: boolean;
  activeId?: string;
  choose?: PaletteItem;
  close?: boolean;
}

/** What a key press in the palette input does. */
export function handlePaletteKey(
  groups: PaletteGroup[],
  activeId: string | undefined,
  key: PaletteKey,
): PaletteKeyResult {
  const active = resolveActive(groups, activeId);
  if (key.isComposing) return { handled: false };
  if (key.key === 'Escape')
    return { handled: true, close: true, activeId: active };
  if (key.ctrlKey || key.metaKey || key.altKey) return { handled: false };
  if (key.key === 'ArrowDown')
    return { handled: true, activeId: moveActive(groups, active, 1) };
  if (key.key === 'ArrowUp')
    return { handled: true, activeId: moveActive(groups, active, -1) };
  // Tab never leaves the palette: it hops between groups.
  if (key.key === 'Tab')
    return {
      handled: true,
      activeId: jumpGroup(groups, active, key.shiftKey ? -1 : 1) ?? active,
    };
  if (key.key === 'Enter') {
    const choose = flatItems(groups).find((item) => item.id === active);
    return choose
      ? { handled: true, activeId: active, choose }
      : { handled: true, activeId: active };
  }
  return { handled: false, activeId: active };
}

/** Ctrl+K or Cmd+K, unless something in the page already used the key. */
export function isPaletteShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
}): boolean {
  return (
    event.key.toLowerCase() === 'k' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.defaultPrevented
  );
}

/** How the shortcut is written for this computer. */
export function shortcutLabel(platform?: string): string {
  const name =
    platform ??
    (typeof navigator === 'undefined' ? '' : navigator.platform || '');
  return /mac|iphone|ipad/i.test(name) ? '⌘K' : 'Ctrl K';
}
