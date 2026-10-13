// The inbox snapshot (GET /api/inbox), refetched on the live events that can change it, with the
// slow fallback poll; plus the needs-you count in the tab title.
import { useCallback, useEffect, useState } from 'react';
import type { LiveEventType } from '../../shared/live-events';
import type { InboxResponse } from '../../shared/inbox';
import { api } from '../api';
import { useLiveRefresh } from '../live-refresh';

export const INBOX_EVENTS = [
  'approval.changed',
  'handoff.changed',
  'inbox.changed',
  'workspace.changed',
] as const satisfies readonly LiveEventType[];

export function useInbox() {
  const [inbox, setInbox] = useState<InboxResponse>();
  const refresh = useCallback(async () => {
    try {
      setInbox(await api<InboxResponse>('/inbox'));
    } catch {
      // The app's own refresh reports the connection; an older server has no inbox route.
    }
  }, []);
  useLiveRefresh(refresh, INBOX_EVENTS);
  return { inbox, refresh };
}

/** "(3) FullDots" while three things wait for the owner; the plain name otherwise. */
export function needsYouTitle(count: number, base = 'FullDots'): string {
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

export function useNeedsYouTitle(count: number) {
  useEffect(() => {
    document.title = needsYouTitle(count);
  }, [count]);
}
