import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ authHeaders: () => ({}) }));
import {
  APP_REFRESH_EVENTS,
  FALLBACK_POLL_MS,
  OFFLINE_POLL_MS,
  debounce,
  pollInterval,
  useLiveRefresh,
} from '../src/client/live-refresh';
import { LiveEventStore } from '../src/client/useLiveEvents';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, 100 ms after the last of a burst', () => {
    const run = vi.fn();
    const refetch = debounce(run);
    refetch.schedule();
    vi.advanceTimersByTime(60);
    refetch.schedule();
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(refetch.pending()).toBe(false);
  });

  it('still runs within the max wait when events never pause', () => {
    const run = vi.fn();
    const refetch = debounce(run, 100, 1000);
    for (let t = 0; t < 1000; t += 50) {
      refetch.schedule();
      vi.advanceTimersByTime(50);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending run', () => {
    const run = vi.fn();
    const refetch = debounce(run);
    refetch.schedule();
    refetch.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });
});

it('polls slowly while the feed is open and every 3 s otherwise', () => {
  expect(pollInterval('open')).toBe(FALLBACK_POLL_MS);
  expect(FALLBACK_POLL_MS).toBe(15_000);
  expect(pollInterval('connecting')).toBe(OFFLINE_POLL_MS);
  expect(pollInterval('closed')).toBe(3000);
});

it('refetches on every event that changes what App shows', () => {
  expect([...APP_REFRESH_EVENTS].sort()).toEqual(
    [
      'approval.changed',
      'delegation.changed',
      'handoff.changed',
      'inbox.changed',
      'task.changed',
      'turn.finished',
      'turn.started',
      'usage.updated',
      'workspace.changed',
    ].sort(),
  );
});

describe('useLiveRefresh', () => {
  let root: ReactTestRenderer;
  let store: LiveEventStore;
  const refresh = vi.fn();
  function Harness() {
    useLiveRefresh(refresh, APP_REFRESH_EVENTS, store);
    return null;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    refresh.mockClear();
    store = new LiveEventStore({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
    });
    await act(async () => {
      root = create(createElement(Harness));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    store.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches on mount, once per burst of events, and after a reset', async () => {
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      store.receive({ event: 'hello', data: '{}' });
      store.receive({ event: 'task.changed', data: '{"taskId":"a"}' });
      store.receive({ event: 'approval.changed', data: '{"id":"b"}' });
      store.receive({ event: 'turn.finished', data: '{"threadId":"c"}' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      store.receive({ event: 'hello', data: '{"reset":true}' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('polls every 3 s while the feed is down and every 15 s once it is open', async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      store.receive({ event: 'hello', data: '{}' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
