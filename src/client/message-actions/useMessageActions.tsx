// Wires the message actions of one open chat: pins (loaded per conversation), branch, edit and
// resend (a branch at the message before, with the text waiting in the branch's composer), retry
// (handed back to the chat, which owns the running turn) and copy.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@ag-ui/core';
import type { Conversation } from '../../shared/types';
import type { PinnedMessage } from '../../shared/message-actions';
import { api } from '../api';
import { MessageActions } from './MessageActions';
import { PinnedBar, type PinnedItem } from './PinnedBar';
import { branchPointBefore, lastOwnerMessageId, ownerText } from './retries';
import { branchDraft, clearBranchDraft, setBranchDraft } from './branch-drafts';

/** What a transcript bubble tells its actions. */
export interface BubbleInfo {
  messageId: string;
  role: string;
  content: string;
}

const SNIPPET = 90;

function snippet(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line;
}

/** Scrolls the transcript to a message, opening a folded earlier attempt if it sits in one. */
export function jumpToMessage(messageId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (!element) return;
  const folded = element.closest('details');
  if (folded) folded.open = true;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    block: 'center',
    behavior: still ? 'auto' : 'smooth',
  });
  element.classList.remove('is-flash');
  // Restart the highlight when the same message is chosen twice.
  void element.offsetWidth;
  element.classList.add('is-flash');
  setTimeout(() => element.classList.remove('is-flash'), 1600);
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: true });
}

export function useMessageActions({
  threadId,
  messages,
  visible,
  dotName,
  retryBlocked,
  onRetry,
  onOpenThread,
  onError,
}: {
  threadId: string;
  /** Every message of the conversation (branch points are found here). */
  messages: Message[];
  /** The messages the transcript shows (the Retry action goes on the owner's last one). */
  visible: Message[];
  dotName: string;
  /** Why Retry cannot run now; undefined when it can. */
  retryBlocked?: string;
  onRetry(message: Message): void;
  /** Opens another conversation (the new branch). */
  onOpenThread?(id: string): void;
  onError(text: string): void;
}) {
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // An edit opened this chat with its text in the composer (the chat read it): forget it, focus it.
  useEffect(() => {
    if (branchDraft(threadId) === undefined) return;
    clearBranchDraft(threadId);
    composerRef.current?.focus();
  }, [threadId]);
  useEffect(() => {
    let active = true;
    setPins([]);
    api<{ pins: PinnedMessage[] }>(`/conversations/${threadId}/pins`)
      .then((data) => {
        if (active) setPins(data.pins);
      })
      .catch(() => {
        // The bar is a convenience: without it the chat still works.
      });
    return () => {
      active = false;
    };
  }, [threadId]);
  const pinned = new Set(pins.map((pin) => pin.messageId));
  const togglePin = async (messageId: string) => {
    try {
      const data = await api<{ pins: PinnedMessage[] }>(
        `/conversations/${threadId}/pins/${encodeURIComponent(messageId)}`,
        pinned.has(messageId) ? 'DELETE' : 'POST',
      );
      setPins(data.pins);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not change the pin.');
    }
  };
  const branch = async (atMessageId: string | null, draft?: string) => {
    try {
      const next = await api<Conversation>(
        `/conversations/${threadId}/branch`,
        'POST',
        { atMessageId },
      );
      if (draft !== undefined) setBranchDraft(next.id, draft);
      onOpenThread?.(next.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not branch the chat.');
    }
  };
  const byId = new Map(messages.map((message) => [message.id, message]));
  const lastOwner = lastOwnerMessageId(visible);
  const textOf = (bubble: BubbleInfo) =>
    bubble.role === 'user' ? ownerText(bubble.content) : bubble.content;
  const bubbleActions = (bubble: BubbleInfo): ReactNode => (
    <MessageActions
      role={bubble.role}
      pinned={pinned.has(bubble.messageId)}
      canRetry={bubble.messageId === lastOwner}
      retryBlocked={retryBlocked}
      onEdit={() =>
        void branch(
          branchPointBefore(messages, bubble.messageId),
          textOf(bubble),
        )
      }
      onRetry={() => {
        const message = byId.get(bubble.messageId);
        if (message) onRetry(message);
      }}
      onBranch={() => void branch(bubble.messageId)}
      onPin={() => void togglePin(bubble.messageId)}
      onCopy={() => navigator.clipboard.writeText(textOf(bubble))}
    />
  );
  const items: PinnedItem[] = pins.flatMap((pin) => {
    const message = byId.get(pin.messageId);
    if (!message || typeof message.content !== 'string') return [];
    return [
      {
        messageId: pin.messageId,
        role: message.role,
        text: snippet(
          message.role === 'user'
            ? ownerText(message.content)
            : message.content,
        ),
      },
    ];
  });
  const pinnedBar = (
    <PinnedBar
      pins={items}
      dotName={dotName}
      onJump={jumpToMessage}
      onUnpin={(messageId) => void togglePin(messageId)}
    />
  );
  return { bubbleActions, pinnedBar, composerRef };
}
