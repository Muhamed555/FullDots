// Connects the stores' write paths to the live event bus. Most hooks wrap a store method on the
// instance this Platform owns rather than editing the store: the stores stay as upstream has them,
// and the approval store in particular is owned by separate work. Each wrapper runs after the
// original returned (after its transaction committed) and never changes its result.
import type { ApprovalStore } from './approval-store.js';
import type { EventBus } from './events.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';
import type { Store } from './store.js';
import type { TurnRegistry } from './turn-registry.js';
import type { WorkspaceStore } from './workspace.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Method = (...args: any[]) => any;
type MethodKey<T> = {
  [K in keyof T]: T[K] extends Method ? K : never;
}[keyof T];

/** Calls `after` with the result and arguments of every call of `target[key]`. */
export function tap<T extends object, K extends MethodKey<T>>(
  target: T,
  key: K,
  after: (
    result: ReturnType<Extract<T[K], Method>>,
    ...args: Parameters<Extract<T[K], Method>>
  ) => void,
) {
  const original = (target[key] as Method).bind(target);
  (target as Record<K, Method>)[key] = (...args: unknown[]) => {
    const result = original(...args);
    try {
      after(result, ...(args as Parameters<Extract<T[K], Method>>));
    } catch (error) {
      console.error(
        'Live event hook failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    return result;
  };
}

export function wireLiveEvents(
  bus: EventBus,
  deps: {
    store: Store;
    workspace: WorkspaceStore;
    turns: TurnRegistry;
    runner: SqliteAgentRunner;
  },
) {
  const { store, workspace, turns, runner } = deps;

  turns.onAcquire((turn) =>
    bus.emit('turn.started', {
      threadId: turn.threadId,
      dotId: turn.dotId,
      runId: turn.runId ?? '',
      source: turn.source,
    }),
  );
  // After the run is stored and the thread is no longer running, so a listener may start the next one.
  runner.onRunFinished((run) =>
    bus.emit('turn.finished', {
      threadId: run.threadId,
      dotId: run.agentId,
      runId: run.runId,
      status: run.status,
    }),
  );

  const task = (taskId: string | undefined) => {
    const status = taskId ? store.task(taskId)?.status : undefined;
    if (taskId && status) bus.emit('task.changed', { taskId, status });
  };
  tap(store, 'createTask', (created) => task(created.id));
  tap(store, 'action', (changed) => task(changed?.id));
  tap(store, 'schedule', (changed) => task(changed?.id));
  tap(store, 'claim', (claim) => task(claim?.id));
  tap(store, 'finish', (_, claim) => task(claim.id));
  tap(store, 'completeGoal', (changed) => task(changed?.id));
  tap(store, 'interrupt', (_, claim) => task(claim.id));
  tap(store, 'release', (_, claim) => task(claim.id));
  tap(store, 'fail', (_, claim) => task(claim.id));

  const delegation = (id: string) => {
    const row = workspace.team.get(id);
    if (row)
      bus.emit('delegation.changed', {
        id: row.id,
        parentThreadId: row.parentThreadId,
        childThreadId: row.childThreadId,
        status: row.status,
      });
  };
  tap(workspace.team, 'create', (created) => delegation(created.id));
  tap(workspace.team, 'finish', (_, id) => delegation(id));
  // The teammate started: its lane turns from queued to working.
  tap(workspace.team, 'markStarted', (_, id) => delegation(id));
  // The results reached the Dot that asked: the lanes fold them into its reply.
  tap(workspace.team, 'markDelivered', (_, ids) => ids.forEach(delegation));

  const handoff = (row: { id: string; threadId: string }) =>
    bus.emit('handoff.changed', { id: row.id, threadId: row.threadId });
  tap(workspace.handoffs, 'create', handoff);
  tap(workspace.handoffs, 'finish', handoff);

  tap(workspace.usage, 'record', (_, dotId) =>
    bus.emit('usage.updated', { dotId }),
  );
  tap(workspace.usage, 'setBudget', (_, dotId) =>
    bus.emit('usage.updated', { dotId }),
  );

  tapApprovals(workspace.approvals, bus);
}

/**
 * Starts new and requeued work, and work that waited on a Dot, now instead of on the scheduler's
 * next interval. Returns the function that undoes the wiring.
 */
export function wakeOnWork(
  bus: EventBus,
  turns: TurnRegistry,
  runner: { wake(): void },
) {
  const unsubscribe = bus.subscribe('task.changed', ({ status }) => {
    if (status === 'queued') runner.wake();
  });
  const unrelease = turns.onRelease(() => runner.wake());
  return () => {
    unsubscribe();
    unrelease();
  };
}

function tapApprovals(approvals: ApprovalStore, bus: EventBus) {
  const changed = (row: { id: string; threadId: string } | undefined) => {
    if (row)
      bus.emit('approval.changed', { id: row.id, threadId: row.threadId });
  };
  tap(approvals, 'create', changed);
  tap(approvals, 'decide', changed);
  tap(approvals, 'consume', changed);
  tap(approvals, 'lapse', (lapsed, id) => {
    if (lapsed) changed(approvals.get(id));
  });
  // The sweep reports a count, not ids: the owner's needs-you view refetches.
  tap(approvals, 'expire', (count) => {
    if (count) bus.emit('inbox.changed', {});
  });
}
