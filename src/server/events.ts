// The in-process event bus behind the live feed (GET /api/events). Events carry ids and small enums
// only (see src/shared/live-events.ts); nothing here may carry prompt, page or message text.
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type {
  LiveEvent,
  LiveEventMap,
  LiveEventType,
  LiveHello,
} from '../shared/live-events.js';

type Listener<K extends LiveEventType> = (data: LiveEventMap[K]) => void;
type AnyListener = (event: LiveEvent) => void;

/** Recent events kept for `Last-Event-ID` replay after a reconnect. */
const HISTORY = 200;
const HEARTBEAT_MS = 15_000;
/** Writes a stalled client may have outstanding before its stream is dropped (it reconnects). */
const MAX_PENDING_WRITES = 500;

interface OpenStream {
  stream: SSEStreamingApi;
  end: () => void;
}

export class EventBus {
  private listeners = new Map<LiveEventType, Set<Listener<LiveEventType>>>();
  private all = new Set<AnyListener>();
  private history: LiveEvent[] = [];
  // Starts at the boot time so ids keep increasing across restarts: a Last-Event-ID from an
  // earlier process is always below this one's first id and gets a reset instead of a wrong replay.
  private seq: number;
  private streams = new Set<OpenStream>();
  private closed = false;

  constructor(now = Date.now()) {
    this.seq = now;
  }

  emit<K extends LiveEventType>(type: K, data: LiveEventMap[K]): LiveEvent {
    const event = { id: ++this.seq, type, data } as LiveEvent;
    this.history.push(event);
    if (this.history.length > HISTORY) this.history.shift();
    for (const listener of this.listeners.get(type) ?? [])
      this.safely(() => listener(data));
    for (const listener of this.all) this.safely(() => listener(event));
    return event;
  }

  /** Returns the unsubscribe function. */
  subscribe<K extends LiveEventType>(
    type: K,
    listener: Listener<K>,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as Listener<LiveEventType>);
    return () => this.unsubscribe(type, listener);
  }

  unsubscribe<K extends LiveEventType>(type: K, listener: Listener<K>) {
    this.listeners.get(type)?.delete(listener as Listener<LiveEventType>);
  }

  /** Every event, with its id; the SSE feed uses this. */
  subscribeAll(listener: AnyListener): () => void {
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  /** The newest id handed out (the boot time while nothing was emitted). */
  lastId(): number {
    return this.seq;
  }

  /**
   * The events after `lastId`, or undefined when they can no longer be replayed: the id is from
   * the future (another process) or older than the history kept.
   */
  since(lastId: number): LiveEvent[] | undefined {
    if (!Number.isSafeInteger(lastId) || lastId > this.seq) return undefined;
    const oldest = this.history[0]?.id ?? this.seq + 1;
    if (lastId < oldest - 1) return undefined;
    return this.history.filter((event) => event.id > lastId);
  }

  /** Open SSE connections. */
  openStreams(): number {
    return this.streams.size;
  }

  /**
   * Sends `bye` on every open stream and ends it, so an open tab cannot hold the server's close.
   * Later connections are refused. Idempotent.
   */
  close() {
    this.closed = true;
    for (const open of [...this.streams]) open.end();
  }

  /** GET /api/events: `hello`, then live events, a heartbeat comment every 15 s, `bye` on shutdown. */
  stream(c: Context) {
    if (this.closed)
      return c.json({ error: 'The server is shutting down.' }, 503);
    const header = c.req.header('last-event-id');
    const lastId = header?.trim() ? Number(header) : undefined;
    const replay = lastId === undefined ? [] : this.since(lastId);
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let pending = 0;
      let ended = false;
      let queue: Promise<unknown> = Promise.resolve();
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // Writes go out one at a time and in order.
      const write = (text: () => Promise<unknown>) => {
        pending++;
        queue = queue
          .then(text)
          .catch(() => {})
          .finally(() => {
            pending--;
          });
      };
      const unsubscribers: (() => void)[] = [];
      const end = (options: { bye?: boolean; drop?: boolean } = {}) => {
        if (ended) return;
        ended = true;
        for (const unsubscribe of unsubscribers) unsubscribe();
        if (options.bye) send({ event: 'bye', data: {} });
        // A client that stopped reading must not hold the stream (or the server's close) open.
        if (options.drop) stream.abort();
        const timer = setTimeout(() => stream.abort(), 1000);
        void queue.then(() => {
          clearTimeout(timer);
          finish();
        });
      };
      const send = (message: { event: string; data: unknown; id?: number }) => {
        if (stream.aborted) return;
        if (pending >= MAX_PENDING_WRITES) return end({ drop: true });
        write(() =>
          stream.writeSSE({
            event: message.event,
            data: JSON.stringify(message.data),
            ...(message.id !== undefined ? { id: String(message.id) } : {}),
          }),
        );
      };
      const open: OpenStream = { stream, end: () => end({ bye: true }) };
      this.streams.add(open);
      const hello: LiveHello = replay ? {} : { reset: true };
      // A replay resumes from the client's id; otherwise the client is current as of now.
      send({
        event: 'hello',
        data: hello,
        id: replay?.length ? lastId : this.seq,
      });
      for (const event of replay ?? [])
        send({ event: event.type, data: event.data, id: event.id });
      unsubscribers.push(
        this.subscribeAll((event) =>
          send({ event: event.type, data: event.data, id: event.id }),
        ),
      );
      const heartbeat = setInterval(() => {
        if (pending < MAX_PENDING_WRITES)
          write(() => stream.write(': ping\n\n'));
      }, HEARTBEAT_MS);
      unsubscribers.push(() => clearInterval(heartbeat));
      stream.onAbort(() => end());
      try {
        await done;
      } finally {
        this.streams.delete(open);
      }
    });
  }

  private safely(run: () => void) {
    try {
      run();
    } catch (error) {
      console.error(
        'Live event listener failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }
}
