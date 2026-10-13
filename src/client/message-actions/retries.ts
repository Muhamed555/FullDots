// Pure helpers behind the message actions: retry metadata, folding earlier attempts, and where an
// edit branches. Nothing here removes a message; folding only decides what is shown where.
import type { Message } from '@ag-ui/core';
import { turnSource } from '../chat-turns';

/** The owner message a retry sends again, from its `retryOf` metadata. */
export function retryOf(message: Message): string | undefined {
  if (message.role !== 'user') return undefined;
  const metadata: unknown = message.metadata;
  return metadata &&
    typeof metadata === 'object' &&
    'retryOf' in metadata &&
    typeof metadata.retryOf === 'string'
    ? metadata.retryOf
    : undefined;
}

/** A new owner message that sends `original` again. A retry of a retry points at the first one. */
export function retryMessage(original: Message, id: string): Message {
  return {
    id,
    role: 'user',
    content: typeof original.content === 'string' ? original.content : '',
    metadata: { retryOf: retryOf(original) ?? original.id },
  };
}

export interface FoldedTranscript {
  /** What the transcript shows, in order: retry messages and earlier attempts left out. */
  messages: Message[];
  /** Earlier attempts (each the messages that answered it), oldest first, by owner message id. */
  earlier: Map<string, Message[][]>;
}

/**
 * Folds retries: for a retry of owner message X, everything shown between X (or X's previous
 * retry) and the retry becomes an earlier attempt of X, and the retry message itself is not shown
 * again (it repeats X). A retry whose original is not in the list is shown as an ordinary message.
 */
export function foldRetries(messages: Message[]): FoldedTranscript {
  const shown: Message[] = [];
  const earlier = new Map<string, Message[][]>();
  // Where the current attempt of each owner message starts in `shown`.
  const starts = new Map<string, number>();
  for (const message of messages) {
    const original = retryOf(message);
    const start = original === undefined ? undefined : starts.get(original);
    if (original === undefined || start === undefined) {
      shown.push(message);
      if (message.role === 'user') starts.set(message.id, shown.length);
      continue;
    }
    const attempt = shown.splice(start);
    if (attempt.length)
      earlier.set(original, [...(earlier.get(original) ?? []), attempt]);
    // Owner messages that were inside the folded attempt can no longer be retried into it.
    for (const [id, at] of starts) if (at > start) starts.delete(id);
  }
  return { messages: shown, earlier };
}

/**
 * The owner message the Retry action belongs to: the last message the owner typed. When that is
 * already a retry, its original (the bubble the transcript shows).
 */
export function lastOwnerMessageId(messages: Message[]): string | undefined {
  const last = messages.findLast(
    (message) => message.role === 'user' && !turnSource(message),
  );
  return last && (retryOf(last) ?? last.id);
}

/**
 * Where editing a message branches: the message just before it, so the branch never holds the
 * version being replaced. Null when it is the first message (the branch starts empty).
 */
export function branchPointBefore(
  messages: Message[],
  messageId: string,
): string | null {
  const index = messages.findIndex((message) => message.id === messageId);
  return index > 0 ? messages[index - 1].id : null;
}

/** The text the owner typed: the "From [page](...)" line a page chat adds is left out. */
export function ownerText(content: string): string {
  return content.replace(/^From \[[^\]\n]*\]\(\/#\/spaces\/[^)\s]*\):\n\n/, '');
}
