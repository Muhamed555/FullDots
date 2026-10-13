// GET /api/events end to end: the owner checks, `hello`, turn events from a real turn (fake model
// behind fetch), Last-Event-ID replay, and the stream ending on shutdown.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { Config } from '../src/server/research.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

const research: Config = { mode: 'sample', baseUrl: 'https://unused.invalid' };
const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};
const TOKEN = 'owner-token-for-live-feed-tests';
const auth = { Authorization: `Bearer ${TOKEN}` };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot(options: { token?: string; origin?: string } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, config);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await platform.stop();
  };
  cleanups.push(async () => {
    await stop();
    store.close();
    workspace.close();
  });
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    ownerToken: 'token' in options ? options.token : TOKEN,
    origin: options.origin,
    platform,
  });
  const dot = workspace.dots()[0];
  return { store, workspace, platform, app, dot, stop };
}

interface Received {
  event: string;
  data: unknown;
  id?: string;
}

/** Reads one SSE response event by event; heartbeat comments are skipped. */
function reader(response: Response) {
  const stream = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = '';
  const next = async (): Promise<Received | undefined> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split('\n').filter((line) => !line.startsWith(':'));
        if (!lines.length) continue;
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        return {
          event: field('event') ?? 'message',
          data: JSON.parse(field('data') ?? 'null'),
          ...(field('id') !== undefined ? { id: field('id') } : {}),
        };
      }
      const { value, done } = await stream.read();
      if (done) return undefined;
      buffer += value;
    }
  };
  /** The next event of this type, skipping others. */
  const until = async (type: string) => {
    for (;;) {
      const event = await next();
      if (!event || event.event === type) return event;
    }
  };
  return { next, until, cancel: () => stream.cancel() };
}

async function open(
  app: ReturnType<typeof boot>['app'],
  headers: Record<string, string> = auth,
) {
  const response = await app.request('/api/events', { headers });
  expect(response.status).toBe(200);
  const events = reader(response);
  cleanups.push(() => events.cancel().catch(() => {}));
  return { response, ...events };
}

function fakeModel(reply = 'Hello from the Dot.') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    completion({ role: 'assistant', content: reply }),
  );
}

describe('GET /api/events access', () => {
  it('refuses a request without the owner token', async () => {
    const { app } = boot();
    expect((await app.request('/api/events')).status).toBe(401);
    expect(
      (
        await app.request('/api/events', {
          headers: { Authorization: 'Bearer wrong-token-of-the-same-size!!' },
        })
      ).status,
    ).toBe(401);
  });

  it('refuses cross-site and cross-origin requests even with the token', async () => {
    const { app } = boot({ origin: 'http://127.0.0.1:5173' });
    expect(
      (
        await app.request('/api/events', {
          headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/events', {
          headers: { ...auth, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('refuses an unrecognised host when no owner token is set', async () => {
    const { app } = boot({ token: undefined });
    expect((await app.request('http://evil.example/api/events')).status).toBe(
      403,
    );
  });
});

describe('GET /api/events stream', () => {
  it('sends hello first, with SSE headers that keep proxies from buffering', async () => {
    const { app, platform } = boot();
    const feed = await open(app);
    expect(feed.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    expect(feed.response.headers.get('cache-control')).toBe('no-cache');
    expect(feed.response.headers.get('x-accel-buffering')).toBe('no');
    const hello = await feed.next();
    expect(hello).toEqual({
      event: 'hello',
      data: {},
      id: String(platform.events.lastId()),
    });
  });

  it('streams turn.started with the runId, then turn.finished, for a real turn', async () => {
    fakeModel();
    const { app, platform, workspace, dot } = boot();
    workspace.bindThread('thread-1', dot.id, 'Live');
    const feed = await open(app);
    expect((await feed.next())?.event).toBe('hello');

    const reply = platform.turn(
      'thread-1',
      'Say hello.',
      new AbortController().signal,
    );
    const started = await feed.until('turn.started');
    expect(started?.data).toEqual({
      threadId: 'thread-1',
      dotId: dot.id,
      runId: expect.any(String),
      source: 'chat',
    });
    const runId = (started?.data as { runId: string }).runId;
    expect(runId).not.toBe('');
    const finished = await feed.until('turn.finished');
    expect(finished?.data).toEqual({
      threadId: 'thread-1',
      dotId: dot.id,
      runId,
      status: 'completed',
    });
    expect(Number(finished?.id)).toBeGreaterThan(Number(started?.id));
    await expect(reply).resolves.toBe('Hello from the Dot.');
    // Emitted after the run was stored: the thread no longer runs.
    expect(await platform.runner.isRunning({ threadId: 'thread-1' })).toBe(
      false,
    );
  });

  it('never carries prompt or reply text', async () => {
    fakeModel('SECRET-REPLY-TEXT');
    const { app, platform, workspace, dot, stop } = boot();
    workspace.bindThread('thread-1', dot.id, 'Live');
    const response = await app.request('/api/events', { headers: auth });
    const body = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    cleanups.push(() => body.cancel().catch(() => {}));
    await platform.turn(
      'thread-1',
      'SECRET-PROMPT-TEXT',
      new AbortController().signal,
    );
    await stop();
    let text = '';
    for (;;) {
      const { value, done } = await body.read();
      if (done) break;
      text += value;
    }
    expect(text).toContain('turn.finished');
    expect(text).not.toContain('SECRET');
  });

  it('replays missed events after Last-Event-ID and resets for an unknown id', async () => {
    const { app, platform } = boot();
    const first = platform.events.emit('usage.updated', { dotId: 'a' });
    platform.events.emit('usage.updated', { dotId: 'b' });
    platform.events.emit('inbox.changed', {});

    const resumed = await open(app, {
      ...auth,
      'Last-Event-ID': String(first.id),
    });
    expect(await resumed.next()).toEqual({
      event: 'hello',
      data: {},
      id: String(first.id),
    });
    expect(await resumed.next()).toEqual({
      event: 'usage.updated',
      data: { dotId: 'b' },
      id: String(first.id + 1),
    });
    expect((await resumed.next())?.event).toBe('inbox.changed');

    // An id from an earlier server process is below this one's first id.
    const stale = await open(app, { ...auth, 'Last-Event-ID': '12' });
    expect(await stale.next()).toEqual({
      event: 'hello',
      data: { reset: true },
      id: String(platform.events.lastId()),
    });
    const future = await open(app, {
      ...auth,
      'Last-Event-ID': String(platform.events.lastId() + 5),
    });
    expect((await future.next())?.data).toEqual({ reset: true });
  });

  it('ends an open stream with bye when the platform stops', async () => {
    const { app, platform, stop } = boot();
    const feed = await open(app);
    expect((await feed.next())?.event).toBe('hello');
    expect(platform.events.openStreams()).toBe(1);
    await stop();
    expect(await feed.next()).toEqual({ event: 'bye', data: {} });
    expect(await feed.next()).toBeUndefined();
    await vi.waitFor(() => expect(platform.events.openStreams()).toBe(0));
    expect((await app.request('/api/events', { headers: auth })).status).toBe(
      503,
    );
  });

  it('emits workspace.changed after a successful Dot or conversation write only', async () => {
    const { app, platform, dot } = boot();
    const seen: string[] = [];
    platform.events.subscribe('workspace.changed', () => seen.push('changed'));
    const json = (method: string, body: unknown) => ({
      method,
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = await app.request(
      '/api/conversations',
      json('POST', { dotId: dot.id }),
    );
    expect(created.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect((await app.request('/api/dots/nope', json('PUT', {}))).status).toBe(
      400,
    );
    await app.request('/api/workspace', { headers: auth });
    expect(seen).toHaveLength(1);
  });
});
