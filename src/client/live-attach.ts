// Shows a turn this page did not start (a Lead's resume, a scheduled task, another tab) in the open
// chat as soon as it starts, by reconnecting the chat's agent to the thread's live run.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { LiveEventMap } from '../shared/live-events';
import { useLiveEvent } from './useLiveEvents';

/** How long after this page's own run ended a `turn.started` without a run id is still assumed ours. */
export const OWN_RUN_GRACE_MS = 1500;

export interface LocalRunState {
  /** The thread open in this chat. */
  threadId: string;
  /** This chat's own runAgent is streaming, or the chat has not finished its first connect. */
  busy: boolean;
  /** Every run id this chat started (its own turns and their tool continuations). */
  ownRunIds: ReadonlySet<string>;
  lastLocalRunEndedAt?: number;
  now: number;
}

/** attach: reconnect now; defer: reconnect once this chat's own run ends; ignore: nothing to do. */
export type AttachDecision = 'attach' | 'defer' | 'ignore';

export function attachDecision(
  event: Pick<LiveEventMap['turn.started'], 'threadId' | 'runId'>,
  local: LocalRunState,
): AttachDecision {
  if (event.threadId !== local.threadId) return 'ignore';
  if (event.runId && local.ownRunIds.has(event.runId)) return 'ignore';
  // Reconnecting would cut this chat's own stream; catch up once it ends instead.
  if (local.busy) return 'defer';
  if (
    !event.runId &&
    local.lastLocalRunEndedAt !== undefined &&
    local.now - local.lastLocalRunEndedAt < OWN_RUN_GRACE_MS
  )
    return 'ignore';
  return 'attach';
}

/** True when a `turn.started` should clear and reconnect the open chat right now. */
export function shouldReconnect(
  event: Pick<LiveEventMap['turn.started'], 'threadId' | 'runId'>,
  local: LocalRunState,
) {
  return attachDecision(event, local) === 'attach';
}

/**
 * True when a finished turn in the open thread is not on screen yet: it was not this chat's, the
 * chat did not attach to it while it ran, and the chat is free to reconnect.
 */
export function shouldRefreshOnFinish(
  event: Pick<LiveEventMap['turn.finished'], 'threadId' | 'runId'>,
  local: LocalRunState & { attachedRunIds: ReadonlySet<string> },
) {
  return (
    event.threadId === local.threadId &&
    !local.ownRunIds.has(event.runId) &&
    !local.attachedRunIds.has(event.runId) &&
    !local.busy
  );
}

interface RunInitializedAgent {
  subscribe(subscriber: {
    onRunInitialized?: (params: { input: { runId: string } }) => void;
  }): { unsubscribe(): void };
}

/**
 * Wires a chat to `turn.started` / `turn.finished`. The chat calls `beginLocalRun` before its own
 * runAgent and `endLocalRun` after it, so the run ids it starts are known before the server
 * announces them. Returns the id of a foreign run currently streaming into the chat.
 */
export function useAutoAttach({
  threadId,
  agent,
  ready,
  running,
  reconnect,
}: {
  threadId: string;
  agent: RunInitializedAgent;
  /** The first connect finished. */
  ready: boolean;
  /** This chat's own turn is in flight (state, so the deferred catch-up runs when it flips). */
  running: boolean;
  reconnect: () => Promise<unknown>;
}) {
  const own = useRef(new Set<string>());
  const attached = useRef(new Set<string>());
  const finished = useRef(new Set<string>());
  const localActive = useRef(false);
  const endedAt = useRef<number>(undefined);
  const deferred = useRef<string>(undefined);
  const [remoteRunId, setRemoteRunId] = useState<string>();
  const remote = useRef<string>(undefined);
  const latestReconnect = useRef(reconnect);
  useLayoutEffect(() => {
    latestReconnect.current = reconnect;
  });

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: ({ input }) => {
        if (localActive.current && input.runId) own.current.add(input.runId);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const local = (): LocalRunState => ({
    threadId,
    busy: localActive.current || running || !ready,
    ownRunIds: own.current,
    lastLocalRunEndedAt: endedAt.current,
    now: Date.now(),
  });
  const setRemote = (runId: string | undefined) => {
    remote.current = runId;
    setRemoteRunId(runId);
  };
  const attach = (runId: string) => {
    if (runId) attached.current.add(runId);
    // A run that ended while this chat was busy only needs its stored result shown.
    const live = runId && !finished.current.has(runId) ? runId : undefined;
    setRemote(live);
    // The connect stream ends with the run, so a missed turn.finished cannot leave it "working".
    void latestReconnect
      .current()
      .catch(() => {})
      .finally(() => {
        if (live && remote.current === live) setRemote(undefined);
      });
  };

  useLiveEvent('turn.started', (event) => {
    const decision = attachDecision(event, local());
    if (decision === 'attach') attach(event.runId);
    else if (decision === 'defer') deferred.current = event.runId;
  });
  useLiveEvent('turn.finished', (event) => {
    if (event.threadId !== threadId) return;
    if (event.runId) {
      finished.current.add(event.runId);
      if (finished.current.size > 50)
        finished.current.delete(finished.current.values().next().value!);
    }
    if (remote.current && remote.current === event.runId) setRemote(undefined);
    if (deferred.current !== undefined) return;
    if (
      shouldRefreshOnFinish(event, {
        ...local(),
        attachedRunIds: attached.current,
      })
    ) {
      attached.current.add(event.runId);
      void latestReconnect.current().catch(() => {});
    }
  });

  // Catch up on a turn that started while this chat was busy.
  useEffect(() => {
    if (running || !ready || localActive.current) return;
    const runId = deferred.current;
    if (runId === undefined) return;
    deferred.current = undefined;
    // attach reads refs only, so it is left out of the dependencies on purpose.
    if (!own.current.has(runId)) attach(runId);
  }, [running, ready]);

  const beginLocalRun = useCallback(() => {
    localActive.current = true;
  }, []);
  const endLocalRun = useCallback(() => {
    localActive.current = false;
    endedAt.current = Date.now();
  }, []);
  return { beginLocalRun, endLocalRun, remoteRunId };
}
