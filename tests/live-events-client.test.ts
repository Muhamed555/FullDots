import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ authHeaders: () => ({}) }));
import {
  BACKOFF_CAP_MS,
  LiveEventStore,
  SseParser,
  reconnectDelay,
} from '../src/client/useLiveEvents';

describe('SseParser', () => {
  it('parses event, id and data lines into one message per blank line', () => {
    const parser = new SseParser();
    expect(
      parser.feed(
        'id: 7\nevent: turn.started\ndata: {"threadId":"t"}\n\nevent: hello\ndata: {}\n\n',
      ),
    ).toEqual([
      { event: 'turn.started', data: '{"threadId":"t"}', id: '7' },
      { event: 'hello', data: '{}' },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    expect(
      new SseParser().feed('event: x\ndata: first\ndata:second\ndata: \n\n'),
    ).toEqual([{ event: 'x', data: 'first\nsecond\n' }]);
  });

  it('skips comments and heartbeats, and blocks without data', () => {
    const parser = new SseParser();
    expect(parser.feed(': ping\n\n:another\n\nid: 9\n\n')).toEqual([]);
    expect(parser.feed('data: after\n\n')).toEqual([
      { event: 'message', data: 'after' },
    ]);
  });

  it('handles CRLF and chunks split anywhere, including between CR and LF', () => {
    const parser = new SseParser();
    const text = 'id: 3\r\nevent: bye\r\ndata: {}\r\n\r\n';
    const out = [];
    for (const character of text) out.push(...parser.feed(character));
    expect(out).toEqual([{ event: 'bye', data: '{}', id: '3' }]);
    expect(parser.feed('data: a\r')).toEqual([]);
    expect(parser.feed('\n\r\n')).toEqual([{ event: 'message', data: 'a' }]);
  });
});

describe('reconnectDelay', () => {
  const middle = () => 0.5;

  it('doubles from about half a second and caps at 15 s', () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 10].map((n) => reconnectDelay(n, false, middle)),
    ).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('starts later after a bye', () => {
    expect(reconnectDelay(0, true, middle)).toBe(2000);
    expect(reconnectDelay(1, true, middle)).toBe(4000);
  });

  it('jitters by a quarter either way and never passes the cap', () => {
    expect(reconnectDelay(0, false, () => 0)).toBe(375);
    expect(reconnectDelay(0, false, () => 1)).toBe(625);
    for (let attempt = 0; attempt < 12; attempt++)
      expect(reconnectDelay(attempt, false, () => 1)).toBeLessThanOrEqual(
        BACKOFF_CAP_MS,
      );
  });
});

/** A fetch whose responses are streams the test writes to. */
function fakeFeed(status = 200) {
  const encoder = new TextEncoder();
  const streams: {
    write(text: string): void;
    end(): void;
    init: RequestInit;
  }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('Aborted', 'AbortError'));
      } catch {
        // already closed
      }
    });
    streams.push({
      write: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      init,
    });
    return new Response(body, { status });
  });
  return { fetch, streams };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('LiveEventStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fans one event out to every subscriber of its type, and stops calling after unsubscribe', () => {
    const store = new LiveEventStore({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
    });
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    const offA = store.subscribe('task.changed', a);
    store.subscribe('task.changed', b);
    store.subscribe('approval.changed', other);
    const event = {
      event: 'task.changed',
      id: '11',
      data: '{"taskId":"t1","status":"running"}',
    };
    store.receive(event);
    expect(a).toHaveBeenCalledWith(
      { taskId: 't1', status: 'running' },
      { type: 'task.changed', id: 11 },
    );
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    offA();
    store.receive(event);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('ignores unknown events and unreadable data, and survives a throwing handler', () => {
    const store = new LiveEventStore({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    store.subscribe('inbox.changed', () => {
      throw new Error('boom');
    });
    store.subscribe('inbox.changed', good);
    store.receive({ event: 'something.else', data: '{}' });
    store.receive({ event: 'inbox.changed', data: 'not json' });
    expect(good).not.toHaveBeenCalled();
    store.receive({ event: 'inbox.changed', data: '{}' });
    expect(good).toHaveBeenCalledTimes(1);
    error.mockRestore();
    store.close();
  });

  it('opens one connection with the owner header, resumes with Last-Event-ID, backs off after bye', async () => {
    const feed = fakeFeed();
    const store = new LiveEventStore({
      fetch: feed.fetch as unknown as typeof fetch,
      headers: () => ({ Authorization: 'Bearer owner' }),
      random: () => 0.5,
      stopDelayMs: 0,
    });
    const started = vi.fn();
    const reset = vi.fn();
    const statuses: string[] = [];
    store.subscribeStatus(() => statuses.push(store.getStatus()));
    store.subscribe('turn.started', started);
    store.subscribe('reset', reset);
    await flush();
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    expect(headersOf(feed.streams[0].init)).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer owner',
    });

    feed.streams[0].write('id: 100\nevent: hello\ndata: {}\n\n');
    await flush();
    expect(store.getStatus()).toBe('open');
    expect(reset).not.toHaveBeenCalled();
    feed.streams[0].write(
      'id: 101\nevent: turn.started\ndata: {"threadId":"t","dotId":"d","runId":"r","source":"chat"}\n\n: ping\n\n',
    );
    await flush();
    expect(started).toHaveBeenCalledWith(
      { threadId: 't', dotId: 'd', runId: 'r', source: 'chat' },
      { type: 'turn.started', id: 101 },
    );

    feed.streams[0].write('event: bye\ndata: {}\n\n');
    feed.streams[0].end();
    await flush();
    expect(store.getStatus()).toBe('closed');
    await vi.advanceTimersByTimeAsync(1999);
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.fetch).toHaveBeenCalledTimes(2);
    expect(headersOf(feed.streams[1].init)['Last-Event-ID']).toBe('101');

    feed.streams[1].write('id: 900\nevent: hello\ndata: {"reset":true}\n\n');
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      'connecting',
      'open',
      'closed',
      'connecting',
      'open',
    ]);
    store.close();
    await flush();
    expect(feed.streams[1].init.signal?.aborted).toBe(true);
  });

  it('retries a refused or dropped feed sooner first, then backs off', async () => {
    const feed = fakeFeed(401);
    const store = new LiveEventStore({
      fetch: feed.fetch as unknown as typeof fetch,
      random: () => 0.5,
    });
    store.subscribe('workspace.changed', () => {});
    await flush();
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(feed.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(feed.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.fetch).toHaveBeenCalledTimes(3);
    expect(store.getStatus()).toBe('closed');
    store.close();
  });

  it('reconnects when the feed goes silent past the idle limit', async () => {
    const feed = fakeFeed();
    const store = new LiveEventStore({
      fetch: feed.fetch as unknown as typeof fetch,
      random: () => 0.5,
      idleMs: 30_000,
    });
    store.subscribe('workspace.changed', () => {});
    await flush();
    feed.streams[0].write('id: 1\nevent: hello\ndata: {}\n\n');
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    feed.streams[0].write(': ping\n\n');
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000 + 500);
    expect(feed.fetch).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('keeps the connection across a quick resubscribe and closes it after the last one leaves', async () => {
    const feed = fakeFeed();
    const store = new LiveEventStore({
      fetch: feed.fetch as unknown as typeof fetch,
      stopDelayMs: 1000,
    });
    const off = store.subscribe('task.changed', () => {});
    await flush();
    off();
    const offAgain = store.subscribe('task.changed', () => {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    expect(feed.streams[0].init.signal?.aborted).toBe(false);
    offAgain();
    await vi.advanceTimersByTimeAsync(1000);
    expect(feed.streams[0].init.signal?.aborted).toBe(true);
    expect(store.getStatus()).toBe('closed');
  });
});
