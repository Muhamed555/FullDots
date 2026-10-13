// One shared connection to the live event feed (GET /api/events) for the whole page. It is read
// with fetch rather than EventSource because EventSource cannot send the owner Authorization header.
// Events carry ids only; a component that hears one refetches what it shows through the normal API.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { authHeaders } from './api';
import {
  LIVE_EVENT_TYPES,
  type LiveEventMap,
  type LiveEventType,
  type LiveHello,
} from '../shared/live-events';

/** One dispatched server-sent event. `id` is set only when the event carried an `id:` line. */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser: feed it decoded chunks, get whole events back. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0) break;
      // A trailing \r may be the first half of \r\n split across chunks.
      if (this.buffer[end] === '\r' && end === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, end);
      const skip =
        this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(end + skip);
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      const message = this.data.length
        ? {
            event: this.event || 'message',
            data: this.data.join('\n'),
            ...(this.id !== undefined ? { id: this.id } : {}),
          }
        : undefined;
      this.data = [];
      this.event = '';
      this.id = undefined;
      return message;
    }
    // Comments (the server's `: ping` heartbeat) only keep the connection alive.
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    return undefined;
  }
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 15_000;

/**
 * Wait before reconnect number `attempt` (0 = first retry): about half a second, doubling, capped at
 * 15 s, with ±25% jitter so many tabs do not reconnect in lockstep. After a `bye` (the server is
 * shutting down or restarting) the schedule starts two steps later, at about 2 s.
 */
export function reconnectDelay(
  attempt: number,
  afterBye = false,
  random: () => number = Math.random,
) {
  const step = Math.max(0, attempt) + (afterBye ? 2 : 0);
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** step);
  return Math.round(Math.min(BACKOFF_CAP_MS, base * (0.75 + random() * 0.5)));
}

/** `open` once `hello` arrived; anything else means callers should fall back to polling. */
export type LiveStatus = 'connecting' | 'open' | 'closed';

export interface LiveEventMeta<K extends LiveEventType = LiveEventType> {
  type: K;
  id?: number;
}

/** `reset` fires when the feed could not replay what this page missed: refetch everything. */
type Channel = LiveEventType | 'reset';
type Handler = (data: unknown, meta: { type: Channel; id?: number }) => void;

export interface LiveStoreOptions {
  url?: string;
  headers?: () => Record<string, string>;
  fetch?: typeof fetch;
  random?: () => number;
  /** No bytes for this long (the server pings every 15 s) means a dead connection. */
  idleMs?: number;
  /** Keeps the connection across a quick unsubscribe and resubscribe (StrictMode, remounts). */
  stopDelayMs?: number;
}

export class LiveEventStore {
  private handlers = new Map<Channel, Set<Handler>>();
  private statusListeners = new Set<() => void>();
  private status: LiveStatus = 'closed';
  private lastId: string | undefined;
  private attempt = 0;
  private afterBye = false;
  private running = false;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: Required<LiveStoreOptions>;

  constructor(options: LiveStoreOptions = {}) {
    this.options = {
      url: '/api/events',
      headers: authHeaders,
      fetch: (...args) => globalThis.fetch(...args),
      random: Math.random,
      idleMs: 45_000,
      stopDelayMs: 1000,
      ...options,
    };
  }

  /** Returns the unsubscribe function. The first subscriber opens the connection. */
  subscribe = (channel: Channel, handler: Handler): (() => void) => {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    this.start();
    return () => {
      set.delete(handler);
      if (!this.subscribers()) this.scheduleStop();
    };
  };

  getStatus = () => this.status;

  subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /** Delivers one parsed message to the subscribers; the reader calls it for every event. */
  receive(message: SseMessage) {
    if (message.id !== undefined) this.lastId = message.id;
    const id = message.id === undefined ? undefined : Number(message.id);
    if (message.event === 'hello') {
      this.attempt = 0;
      this.afterBye = false;
      this.setStatus('open');
      const hello = parse<LiveHello>(message.data);
      if (hello?.reset) this.fire('reset', {}, { type: 'reset', id });
      return;
    }
    if (message.event === 'bye') {
      this.afterBye = true;
      return;
    }
    if (!(LIVE_EVENT_TYPES as readonly string[]).includes(message.event))
      return;
    const data = parse(message.data);
    if (data === undefined) return;
    const type = message.event as LiveEventType;
    this.fire(type, data, { type, id });
  }

  /** Ends the connection and forgets every subscriber (tests). */
  close() {
    this.handlers.clear();
    this.stop();
  }

  private fire(
    channel: Channel,
    data: unknown,
    meta: { type: Channel; id?: number },
  ) {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) {
      try {
        handler(data, meta);
      } catch (error) {
        console.error(
          'Live event handler failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
    }
  }

  private subscribers() {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener();
  }

  private start() {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  private scheduleStop() {
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = undefined;
      if (!this.subscribers()) this.stop();
    }, this.options.stopDelayMs);
  }

  private stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.idleTimer);
    this.retryTimer = this.stopTimer = this.idleTimer = undefined;
    const controller = this.controller;
    this.controller = undefined;
    controller?.abort();
    this.setStatus('closed');
  }

  private touch(controller: AbortController) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => controller.abort(), this.options.idleMs);
  }

  private async connect() {
    if (!this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('connecting');
    try {
      const response = await this.options.fetch(this.options.url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          Accept: 'text/event-stream',
          ...this.options.headers(),
          ...(this.lastId !== undefined
            ? { 'Last-Event-ID': this.lastId }
            : {}),
        },
      });
      if (!response.ok || !response.body)
        throw new Error(`Live feed refused (${response.status}).`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      this.touch(controller);
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.controller !== controller) break;
        this.touch(controller);
        for (const message of parser.feed(
          decoder.decode(value, { stream: true }),
        ))
          this.receive(message);
      }
      void reader.cancel().catch(() => {});
    } catch {
      // Refused, offline, aborted or idle: the retry below handles all of them alike.
    }
    clearTimeout(this.idleTimer);
    if (this.controller !== controller) return;
    this.controller = undefined;
    if (!this.running) return;
    this.setStatus('closed');
    const delay = reconnectDelay(
      this.attempt++,
      this.afterBye,
      this.options.random,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }
}

function parse<T = unknown>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

/** The page's one connection. */
export const liveEvents = new LiveEventStore();

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Calls `handler` for every event of `types` while the component is mounted. */
export function useLiveEvent<K extends LiveEventType>(
  types: K | readonly K[],
  handler: (data: LiveEventMap[K], meta: LiveEventMeta<K>) => void,
  store: LiveEventStore = liveEvents,
) {
  const latest = useLatest(handler);
  const key = typeof types === 'string' ? types : types.join(',');
  useEffect(() => {
    const unsubscribers = key
      .split(',')
      .map((type) =>
        store.subscribe(type as K, (data, meta) =>
          latest.current(data as LiveEventMap[K], meta as LiveEventMeta<K>),
        ),
      );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [key, store, latest]);
}

/** Calls `handler` when the feed says this page missed events it cannot replay. */
export function useLiveReset(
  handler: () => void,
  store: LiveEventStore = liveEvents,
) {
  const latest = useLatest(handler);
  useEffect(
    () => store.subscribe('reset', () => latest.current()),
    [store, latest],
  );
}

export function useLiveStatus(store: LiveEventStore = liveEvents): LiveStatus {
  return useSyncExternalStore(
    store.subscribeStatus,
    store.getStatus,
    () => 'closed',
  );
}
