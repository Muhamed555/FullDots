// Everything the open chat needs for group chats, kept out of Chat.tsx: the participants, who wrote
// which reply, which turn runs in the thread, the @mention trigger, the owner's confirm before a Dot
// joins, and the queue that gives each mentioned Dot its turn in mention order.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dot } from '../../shared/types';
import { api } from '../api';
import { pollInterval } from '../live-refresh';
import { useLiveEvent, useLiveReset, useLiveStatus } from '../useLiveEvents';
import { AddDotDialog } from './AddDotDialog';
import { useMentionTrigger } from './MentionPopover';
import { ParticipantStrip } from './ParticipantStrip';
import { mentionPlan } from './mentions';
import {
  ThreadRuns,
  participantsPath,
  waitForTurnEnd,
  type ParticipantsView,
} from './turn-queue';

interface Pending {
  text: string;
  targets: string[];
}

export function useGroupChat({
  threadId,
  host,
  dots,
}: {
  threadId: string;
  host: Dot;
  /** Every Dot of the workspace. */
  dots: readonly Dot[];
}) {
  const live = useLiveStatus();
  const [view, setView] = useState<ParticipantsView>();
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const runs = useRef(new ThreadRuns(threadId));
  const [runningDotId, setRunningDotId] = useState<string>();
  const [threadBusy, setThreadBusy] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [asking, setAsking] = useState<{
    dot: Dot;
    answer(added: boolean): void;
  }>();
  const [adding, setAdding] = useState(false);
  const stopQueue = useRef<AbortController>(undefined);

  const byId = useMemo(
    () => new Map([host, ...dots].map((dot) => [dot.id, dot])),
    [host, dots],
  );
  const participantIds = useMemo(
    () => view?.participants.map((row) => row.dotId) ?? [],
    [view],
  );
  const participants = participantIds
    .map((id) => byId.get(id))
    .filter((dot): dot is Dot => !!dot);

  const syncRuns = () => {
    setThreadBusy(runs.current.busy);
    setRunningDotId(runs.current.dotId);
  };
  const refreshView = useCallback(async () => {
    try {
      const next = await api<ParticipantsView>(participantsPath(threadId));
      setView(next);
      // Nothing runs on the server: a turn whose finish this page missed is over.
      if (!next.running && runs.current.settle()) syncRuns();
    } catch {
      // The strip keeps its last state; the next event or poll retries.
    }
  }, [threadId]);
  const refreshAuthors = useCallback(async () => {
    try {
      const data = await api<{ authors: Record<string, string> }>(
        `/conversations/${encodeURIComponent(threadId)}/authors`,
      );
      setAuthors(data.authors);
    } catch {
      // Replies keep their last known authors.
    }
  }, [threadId]);

  useEffect(() => {
    runs.current = new ThreadRuns(threadId);
    syncRuns();
    void refreshView();
    void refreshAuthors();
    return () => stopQueue.current?.abort();
  }, [threadId, refreshView, refreshAuthors]);
  // Without the live feed, the strip and the busy state follow a slow poll.
  useEffect(() => {
    if (live === 'open') return;
    const timer = setInterval(() => void refreshView(), pollInterval(live));
    return () => clearInterval(timer);
  }, [live, refreshView]);
  useLiveEvent('workspace.changed', () => void refreshView());
  useLiveReset(() => {
    if (runs.current.clear()) syncRuns();
    void refreshView();
    void refreshAuthors();
  });
  useLiveEvent('turn.started', (event) => {
    if (runs.current.started(event)) syncRuns();
  });
  useLiveEvent('turn.finished', (event) => {
    if (event.threadId !== threadId) return;
    if (runs.current.finished(event)) syncRuns();
    void refreshAuthors();
  });

  /** A group chat: someone besides the host is in it, or wrote in it. */
  const isGroup =
    participantIds.length > 0 ||
    Object.values(authors).some((id) => id !== host.id);
  const group = useMemo(
    () =>
      isGroup
        ? {
            authorOf: (messageId: string) => {
              const id = authors[messageId];
              return id ? byId.get(id) : undefined;
            },
            dot: (id: string) => byId.get(id),
          }
        : undefined,
    [isGroup, authors, byId],
  );

  /** Asks the owner once; on Add the Dot joins (the server's confirm action). */
  const askToAdd = (dotId: string) =>
    new Promise<boolean>((resolve) => {
      const dot = byId.get(dotId);
      if (!dot) return resolve(false);
      setAsking({ dot, answer: resolve });
    });
  const answer = async (added: boolean) => {
    const current = asking;
    if (!current) return;
    if (!added) {
      setAsking(undefined);
      current.answer(false);
      return;
    }
    setAdding(true);
    try {
      setView(
        await api<ParticipantsView>(participantsPath(threadId), 'POST', {
          dotId: current.dot.id,
        }),
      );
      current.answer(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the Dot.');
      current.answer(false);
    } finally {
      setAdding(false);
      setAsking(undefined);
    }
  };

  /** Each target takes its turn in this thread, one after another. */
  const runQueue = async (text: string, targets: string[]) => {
    const controller = new AbortController();
    stopQueue.current = controller;
    setDispatching(true);
    setError('');
    setPending(undefined);
    try {
      for (const [index, dotId] of targets.entries()) {
        const last = index === targets.length - 1;
        // Listen before posting so a very fast turn's finish is not missed.
        const ended = last
          ? undefined
          : waitForTurnEnd(threadId, dotId, controller.signal);
        ended?.catch(() => {});
        try {
          await api(
            `/conversations/${encodeURIComponent(threadId)}/turns`,
            'POST',
            { text, dotId },
          );
        } catch (e) {
          controller.abort();
          setPending({ text, targets: targets.slice(index) });
          setError(
            e instanceof Error ? e.message : 'The message was not sent.',
          );
          return 'failed' as const;
        }
        if (ended) await ended;
      }
      return 'sent' as const;
    } catch {
      return 'failed' as const; // stopped (the chat closed)
    } finally {
      if (stopQueue.current === controller) stopQueue.current = undefined;
      setDispatching(false);
    }
  };

  /**
   * Sends an owner message that mentions Dots: confirms the ones not in the chat yet, then runs the
   * turns. Returns 'host' when the message mentions no other Dot (the chat sends it as before).
   */
  const send = async (
    typed: string,
    text: string,
  ): Promise<'host' | 'sent' | 'cancelled' | 'failed'> => {
    const plan = mentionPlan(
      typed,
      [...byId.values()],
      host.id,
      participantIds,
    );
    if (!plan.targets.length) return 'host';
    for (const dotId of plan.toConfirm)
      if (!(await askToAdd(dotId))) return 'cancelled';
    return runQueue(text, plan.targets);
  };

  const remove = async (dotId: string) => {
    try {
      setView(
        await api<ParticipantsView>(
          `${participantsPath(threadId)}/${encodeURIComponent(dotId)}`,
          'DELETE',
          {},
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the Dot.');
    }
  };

  /** Stops the turn running in this thread, whoever's it is. */
  const stopThread = async () => {
    await api(
      `/conversations/${encodeURIComponent(threadId)}/stop`,
      'POST',
      {},
    );
  };

  const retry = () => {
    if (pending) void runQueue(pending.text, pending.targets);
  };
  const stopAndRetry = async () => {
    try {
      await stopThread();
      setError('');
      setTimeout(retry, 800);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not stop the other work.',
      );
    }
  };

  const mentionTrigger = useMentionTrigger({
    dots: [...byId.values()],
    hostId: host.id,
    participantIds,
  });

  const strip = (
    <ParticipantStrip
      host={host}
      participants={participants}
      dots={[...byId.values()]}
      runningDotId={runningDotId ?? view?.running?.dotId}
      disabled={dispatching}
      onAdd={(dotId) => void askToAdd(dotId)}
      onRemove={(dotId) => void remove(dotId)}
    />
  );
  const dialog = asking ? (
    <AddDotDialog
      dot={asking.dot}
      busy={adding}
      onAdd={() => void answer(true)}
      onCancel={() => void answer(false)}
    />
  ) : null;

  return {
    group,
    strip,
    dialog,
    mentionTrigger,
    /** A turn runs in this thread (any Dot's), as the live feed reports it. */
    threadBusy,
    dispatching,
    runningDotId,
    runningName: runningDotId ? byId.get(runningDotId)?.name : undefined,
    error,
    clearError: () => setError(''),
    hasPending: !!pending,
    send,
    retry,
    stopAndRetry,
    stopThread,
  };
}
