// Teammates' chats (made by a hand-off) nest under the chat that handed the work over, at any
// depth, instead of standing in the list as rows of their own.

interface Nestable {
  id: string;
  handedBy?: { threadId: string };
  running?: boolean;
}

export interface ChatTree<T> {
  /** Chats with no listed parent, in the order given. */
  roots: T[];
  /** The listed children of each chat, in the order given. */
  children: Map<string, T[]>;
}

/** Splits a chat list into top-level chats and the children nested under them. */
export function nestChats<T extends Nestable>(
  chats: readonly T[],
): ChatTree<T> {
  const listed = new Set(chats.map((chat) => chat.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const chat of chats) {
    const parent = chat.handedBy?.threadId;
    // A child whose parent is not listed (deleted, or filtered out) stays at the top level.
    if (parent && parent !== chat.id && listed.has(parent))
      children.set(parent, [...(children.get(parent) ?? []), chat]);
    else roots.push(chat);
  }
  return { roots, children };
}

/** The chat and every chat nested under it (cycle-safe). */
export function descendants<T extends Nestable>(
  id: string,
  tree: ChatTree<T>,
): T[] {
  const found: T[] = [];
  const seen = new Set([id]);
  const walk = (parent: string) => {
    for (const child of tree.children.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return found;
}

/** True when the chat or anything nested under it has a turn running: its row pulses. */
export function workRunning<T extends Nestable>(
  chat: T,
  tree: ChatTree<T>,
): boolean {
  return !!chat.running || descendants(chat.id, tree).some((c) => c.running);
}
