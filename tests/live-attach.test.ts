import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ authHeaders: () => ({}) }));
import {
  OWN_RUN_GRACE_MS,
  attachDecision,
  shouldReconnect,
  shouldRefreshOnFinish,
  useAutoAttach,
  type LocalRunState,
} from '../src/client/live-attach';
import { liveEvents } from '../src/client/useLiveEvents';

const base: LocalRunState = {
  threadId: 'open',
  busy: false,
  ownRunIds: new Set(['mine']),
  now: 10_000,
};

describe('attachDecision / shouldReconnect', () => {
  const cases: [
    string,
    { threadId: string; runId: string },
    Partial<LocalRunState>,
    string,
  ][] = [
    ['another thread', { threadId: 'other', runId: 'x' }, {}, 'ignore'],
    [
      'another thread while streaming',
      { threadId: 'other', runId: 'x' },
      { busy: true },
      'ignore',
    ],
    [
      'this client started the run',
      { threadId: 'open', runId: 'mine' },
      {},
      'ignore',
    ],
    [
      'own run while it streams',
      { threadId: 'open', runId: 'mine' },
      { busy: true },
      'ignore',
    ],
    [
      'a foreign run while the own run streams',
      { threadId: 'open', runId: 'x' },
      { busy: true },
      'defer',
    ],
    [
      'a background turn (resume, schedule, other tab)',
      { threadId: 'open', runId: 'x' },
      {},
      'attach',
    ],
    [
      "another Dot's turn in the same thread",
      { threadId: 'open', runId: 'dot-b-run' },
      {},
      'attach',
    ],
    [
      'no run id just after the own run ended',
      { threadId: 'open', runId: '' },
      { lastLocalRunEndedAt: 10_000 - OWN_RUN_GRACE_MS + 1 },
      'ignore',
    ],
    [
      'no run id well after the own run ended',
      { threadId: 'open', runId: '' },
      { lastLocalRunEndedAt: 10_000 - OWN_RUN_GRACE_MS },
      'attach',
    ],
    [
      'no run id and no own run yet',
      { threadId: 'open', runId: '' },
      {},
      'attach',
    ],
  ];
  it.each(cases)('%s', (_name, event, local, expected) => {
    const state = { ...base, ...local };
    expect(attachDecision(event, state)).toBe(expected);
    expect(shouldReconnect(event, state)).toBe(expected === 'attach');
  });
});

describe('shouldRefreshOnFinish', () => {
  const local = { ...base, attachedRunIds: new Set(['seen']) };
  it.each([
    [
      'a foreign run it never attached to',
      { threadId: 'open', runId: 'x' },
      {},
      true,
    ],
    [
      'a run it attached to while it ran',
      { threadId: 'open', runId: 'seen' },
      {},
      false,
    ],
    ['its own run', { threadId: 'open', runId: 'mine' }, {}, false],
    [
      'while its own run streams',
      { threadId: 'open', runId: 'x' },
      { busy: true },
      false,
    ],
    ['another thread', { threadId: 'other', runId: 'x' }, {}, false],
  ] as const)('%s', (_name, event, extra, expected) => {
    expect(shouldRefreshOnFinish(event, { ...local, ...extra })).toBe(expected);
  });
});

describe('useAutoAttach', () => {
  type Api = ReturnType<typeof useAutoAttach>;
  let api: Api;
  let root: ReactTestRenderer;
  let initialized: ((params: { input: { runId: string } }) => void) | undefined;
  const reconnect = vi.fn(() => new Promise<void>(() => {}));
  const agent = {
    subscribe(subscriber: {
      onRunInitialized?: (params: { input: { runId: string } }) => void;
    }) {
      initialized = subscriber.onRunInitialized;
      return { unsubscribe: () => (initialized = undefined) };
    },
  };
  function Harness({
    running,
    ready = true,
  }: {
    running: boolean;
    ready?: boolean;
  }) {
    api = useAutoAttach({ threadId: 'open', agent, ready, running, reconnect });
    return null;
  }
  const render = (props: { running: boolean; ready?: boolean }) =>
    act(async () => {
      root.update(createElement(Harness, props));
    });
  const emit = (
    type: 'turn.started' | 'turn.finished',
    runId: string,
    threadId = 'open',
  ) =>
    act(async () => {
      liveEvents.receive({
        event: type,
        data: JSON.stringify({
          threadId,
          dotId: 'd',
          runId,
          source: 'chat',
          status: 'completed',
        }),
      });
    });

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // The shared store opens its feed on subscribe; keep that request pending.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    reconnect.mockClear();
    await act(async () => {
      root = create(createElement(Harness, { running: false }));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    liveEvents.close();
    vi.unstubAllGlobals();
  });

  it('does not reconnect for a turn.started of the run this client started', async () => {
    api.beginLocalRun();
    initialized?.({ input: { runId: 'own-1' } });
    await render({ running: true });
    await emit('turn.started', 'own-1');
    api.endLocalRun();
    await render({ running: false });
    await emit('turn.started', 'own-1');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reconnects at once for a background turn and shows it as running until it finishes', async () => {
    await emit('turn.started', 'resume-1');
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(api.remoteRunId).toBe('resume-1');
    await emit('turn.finished', 'resume-1');
    expect(api.remoteRunId).toBeUndefined();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores other threads', async () => {
    await emit('turn.started', 'x', 'elsewhere');
    await emit('turn.finished', 'x', 'elsewhere');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('waits for its own run to end before catching up on a foreign one', async () => {
    api.beginLocalRun();
    initialized?.({ input: { runId: 'own-2' } });
    await render({ running: true });
    await emit('turn.started', 'foreign');
    expect(reconnect).not.toHaveBeenCalled();
    await emit('turn.finished', 'foreign');
    expect(reconnect).not.toHaveBeenCalled();
    api.endLocalRun();
    await render({ running: false });
    expect(reconnect).toHaveBeenCalledTimes(1);
    // It already finished, so nothing is shown as still running.
    expect(api.remoteRunId).toBeUndefined();
  });

  it('defers until the first connect finished', async () => {
    await render({ running: false, ready: false });
    await emit('turn.started', 'early');
    expect(reconnect).not.toHaveBeenCalled();
    await render({ running: false, ready: true });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('shows a finished foreign turn it missed', async () => {
    await emit('turn.finished', 'missed');
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
