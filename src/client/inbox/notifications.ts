// Desktop notifications for what needs the owner: a new approval, a handoff or a question. Off until
// the owner clicks "Enable desktop notifications". A notification carries a title made of the Dot's
// name and the kind of request only: never the prompt, the action's arguments, the question or a
// result. Nothing is shown while the owner is looking at that very chat.
import { useEffect, useRef } from 'react';
import type { InboxResponse } from '../../shared/inbox';

export type NeedsYouKind = 'approval' | 'handoff' | 'question';

/** A new thing that needs the owner, reduced to ids: the text never reaches this module. */
export interface NeedsYouEvent {
  kind: NeedsYouKind;
  id: string;
  dotId: string;
  threadId: string;
}

export type NotifyPermission = NotificationPermission | 'unsupported';

export interface NotificationState {
  permission: NotifyPermission;
  /** The tab is visible and has focus. */
  focused: boolean;
  /** The chat on screen, when the chat view is open. */
  openThreadId?: string;
  dotName: (dotId: string) => string | undefined;
}

export interface DesktopNotification {
  title: string;
  /** Replaces an older notification of the same item instead of stacking. */
  tag: string;
  /** Where a click goes. */
  hash: string;
}

/** The needs-you items of an inbox snapshot, ids only. */
export function needsYouEvents(inbox: InboxResponse): NeedsYouEvent[] {
  return [
    ...inbox.approvals.map(({ id, dotId, threadId }) => ({
      kind: 'approval' as const,
      id,
      dotId,
      threadId,
    })),
    ...inbox.handoffs.map(({ id, dotId, threadId }) => ({
      kind: 'handoff' as const,
      id,
      dotId,
      threadId,
    })),
    ...inbox.questions.map(({ id, dotId, threadId }) => ({
      kind: 'question' as const,
      id,
      dotId,
      threadId,
    })),
  ];
}

const keyOf = (event: NeedsYouEvent) => `${event.kind}:${event.id}`;

/** The notification for one new needs-you item, or null when none should be shown. */
export function notificationFor(
  event: NeedsYouEvent,
  state: NotificationState,
): DesktopNotification | null {
  if (state.permission !== 'granted') return null;
  if (state.focused && state.openThreadId === event.threadId) return null;
  const name = state.dotName(event.dotId)?.trim() || 'A Dot';
  const title =
    event.kind === 'approval'
      ? `${name} needs your approval`
      : event.kind === 'handoff'
        ? `Your turn on the computer: ${name}`
        : `${name} has a question`;
  return {
    title,
    tag: `fulldots-${keyOf(event)}`,
    hash: event.kind === 'approval' ? '#/approvals' : '#/inbox',
  };
}

/** The items of `next` that were not in `seen`. Without `seen` (the first load) nothing is new. */
export function newSince(
  seen: ReadonlySet<string> | undefined,
  next: NeedsYouEvent[],
): NeedsYouEvent[] {
  return seen ? next.filter((event) => !seen.has(keyOf(event))) : [];
}

export function notificationPermission(): NotifyPermission {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission;
}

function show(notification: DesktopNotification) {
  try {
    const shown = new Notification(notification.title, {
      tag: notification.tag,
    });
    shown.onclick = () => {
      window.focus();
      location.hash = notification.hash;
      shown.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the badge still counts.
  }
}

/**
 * Shows a desktop notification for each needs-you item that appears after the first load, when the
 * owner allowed them. Items already waiting when the page opened are not announced.
 */
export function useDesktopNotifications(
  inbox: InboxResponse | undefined,
  context: {
    openThreadId?: string;
    dotName: (dotId: string) => string | undefined;
  },
) {
  const seen = useRef<Set<string> | undefined>(undefined);
  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  });
  useEffect(() => {
    if (!inbox) return;
    const events = needsYouEvents(inbox);
    const state: NotificationState = {
      permission: notificationPermission(),
      focused:
        document.visibilityState === 'visible' &&
        (typeof document.hasFocus !== 'function' || document.hasFocus()),
      openThreadId: latest.current.openThreadId,
      dotName: latest.current.dotName,
    };
    for (const event of newSince(seen.current, events)) {
      const notification = notificationFor(event, state);
      if (notification) show(notification);
    }
    seen.current = new Set(events.map(keyOf));
  }, [inbox]);
}
