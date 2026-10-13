import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { PROMPT_BODY_MAX, PROMPT_TITLE_MAX } from '../src/shared/prompts.js';
import type { Prompt } from '../src/shared/prompts.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function fixture(ownerToken?: string, path = ':memory:') {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(path, 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  return { ws, app };
}
const send = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const DELETE = {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
};
const list = async (app: ReturnType<typeof fixture>['app'], query = '') =>
  (
    (await (await app.request(`/api/prompts${query}`)).json()) as {
      prompts: Prompt[];
    }
  ).prompts;

it('creates, reads, edits and lists prompts', async () => {
  const { app } = fixture();
  const created = await app.request(
    '/api/prompts',
    send({ title: '  Weekly review ', body: 'Summarise my week.' }),
  );
  expect(created.status).toBe(201);
  const prompt = (await created.json()) as Prompt;
  expect(prompt).toMatchObject({
    title: 'Weekly review',
    body: 'Summarise my week.',
    scope: 'global',
    dotId: null,
    teamId: null,
    archivedAt: null,
  });
  expect((await list(app)).map((item) => item.id)).toEqual([prompt.id]);
  const read = await app.request(`/api/prompts/${prompt.id}`);
  expect(((await read.json()) as Prompt).body).toBe('Summarise my week.');

  const edited = await app.request(
    `/api/prompts/${prompt.id}`,
    send({ body: 'Summarise my week in five bullets.' }, 'PATCH'),
  );
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    title: 'Weekly review',
    body: 'Summarise my week in five bullets.',
    createdAt: prompt.createdAt,
  });
});

it('checks title and body length and rejects unknown fields', async () => {
  const { app } = fixture();
  const post = (body: unknown) => app.request('/api/prompts', send(body));
  const title = (length: number) => 'a'.repeat(length);
  expect(
    (await post({ title: title(PROMPT_TITLE_MAX), body: 'ok' })).status,
  ).toBe(201);
  expect(
    (await post({ title: title(PROMPT_TITLE_MAX + 1), body: 'ok' })).status,
  ).toBe(400);
  expect(
    (await post({ title: 'ok', body: title(PROMPT_BODY_MAX) })).status,
  ).toBe(201);
  const long = await post({ title: 'ok', body: title(PROMPT_BODY_MAX + 1) });
  expect(long.status).toBe(400);
  expect(((await long.json()) as { error: string }).error).toContain('4000');
  expect((await post({ title: '   ', body: 'ok' })).status).toBe(400);
  expect((await post({ title: 'ok', body: '' })).status).toBe(400);
  expect((await post({ title: 'ok', body: 'ok', extra: 1 })).status).toBe(400);
  expect((await post(null)).status).toBe(400);
  const first = (await list(app))[0]!;
  const patch = (body: unknown) =>
    app.request(`/api/prompts/${first.id}`, send(body, 'PATCH'));
  expect((await patch({ title: title(PROMPT_TITLE_MAX + 1) })).status).toBe(
    400,
  );
  expect((await patch({ body: title(PROMPT_BODY_MAX + 1) })).status).toBe(400);
});

it('ties a prompt to one existing Dot, and keeps team prompts for later', async () => {
  const { app, ws } = fixture();
  const dot = ws.dots()[0]!;
  const post = (body: unknown) => app.request('/api/prompts', send(body));
  const scoped = await post({ title: 'Plan', body: 'Plan it', dotId: dot.id });
  expect(scoped.status).toBe(201);
  expect(await scoped.json()).toMatchObject({ scope: 'dot', dotId: dot.id });
  expect(
    (await post({ title: 'x', body: 'x', scope: 'dot', dotId: 'missing' }))
      .status,
  ).toBe(400);
  expect((await post({ title: 'x', body: 'x', scope: 'dot' })).status).toBe(
    400,
  );
  expect(
    (await post({ title: 'x', body: 'x', scope: 'global', dotId: dot.id }))
      .status,
  ).toBe(400);
  // Teams do not exist yet, so no team id is accepted.
  expect(
    (await post({ title: 'x', body: 'x', scope: 'team', teamId: 't1' })).status,
  ).toBe(400);

  const global = (await (
    await post({ title: 'Anyone', body: 'For all' })
  ).json()) as Prompt;
  const other = ws.createDot(dot.spaceId, 'Other', 'Other role', true, true);
  await post({ title: 'Mine', body: 'Other only', dotId: other.id });
  expect((await list(app)).map((item) => item.title).sort()).toEqual([
    'Anyone',
    'Mine',
    'Plan',
  ]);
  expect(
    (await list(app, `?dotId=${dot.id}`)).map((p) => p.title).sort(),
  ).toEqual(['Anyone', 'Plan']);
  // Moving a prompt to everyone drops its Dot; moving it to a Dot needs the Dot.
  const moved = await app.request(
    `/api/prompts/${global.id}`,
    send({ scope: 'dot', dotId: other.id }, 'PATCH'),
  );
  expect(await moved.json()).toMatchObject({ scope: 'dot', dotId: other.id });
  const back = await app.request(
    `/api/prompts/${global.id}`,
    send({ scope: 'global' }, 'PATCH'),
  );
  expect(await back.json()).toMatchObject({ scope: 'global', dotId: null });
  expect(
    (
      await app.request(
        `/api/prompts/${global.id}`,
        send({ scope: 'dot' }, 'PATCH'),
      )
    ).status,
  ).toBe(400);
});

it('archives on DELETE and never removes the row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-prompts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const { app } = fixture(undefined, path);
  const prompt = (await (
    await app.request('/api/prompts', send({ title: 'Keep', body: 'Body' }))
  ).json()) as Prompt;

  const deleted = await app.request(`/api/prompts/${prompt.id}`, DELETE);
  expect(deleted.status).toBe(200);
  expect(await list(app)).toEqual([]);
  expect((await app.request(`/api/prompts/${prompt.id}`)).status).toBe(404);
  expect(
    (
      await app.request(
        `/api/prompts/${prompt.id}`,
        send({ title: 'Revived' }, 'PATCH'),
      )
    ).status,
  ).toBe(404);
  expect((await app.request(`/api/prompts/${prompt.id}`, DELETE)).status).toBe(
    404,
  );

  const inspect = new DatabaseSync(path);
  try {
    const row = inspect
      .prepare('SELECT title, body, archivedAt FROM prompts WHERE id=?')
      .get(prompt.id);
    expect(row).toMatchObject({ title: 'Keep', body: 'Body' });
    expect(typeof row?.archivedAt).toBe('number');
  } finally {
    inspect.close();
  }
  expect((await app.request('/api/prompts/nope', DELETE)).status).toBe(404);
});

it('archives a Dot’s prompts when the Dot goes away, keeping the others', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => ws.close());
  const space = ws.spaces()[0]!.id;
  const a = ws.createDot(space, 'A', 'Role A', true, true);
  const b = ws.createDot(space, 'B', 'Role B', true, true);
  const make = (title: string, dotId: string | null) =>
    ws.prompts.create({
      title,
      body: title,
      scope: dotId ? 'dot' : 'global',
      dotId,
      teamId: null,
    });
  const a1 = make('a1', a.id);
  make('a2', a.id);
  make('b1', b.id);
  make('everyone', null);
  expect(ws.prompts.archiveForDot(a.id)).toBe(2);
  expect(ws.prompts.archiveForDot(a.id)).toBe(0);
  expect(
    ws.prompts
      .list()
      .map((prompt) => prompt.title)
      .sort(),
  ).toEqual(['b1', 'everyone']);
  expect(ws.prompts.get(a1.id)).toBeUndefined();
});

it('keeps saved prompts when the database is opened again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-prompts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const first = new WorkspaceStore(path, 'owner');
  first.prompts.create({
    title: 'Stays',
    body: 'Still here',
    scope: 'global',
    dotId: null,
    teamId: null,
  });
  first.close();
  const second = new WorkspaceStore(path, 'owner');
  cleanup.push(() => second.close());
  expect(second.prompts.list().map((prompt) => prompt.title)).toEqual([
    'Stays',
  ]);
});

it('is owner only like the other routes', async () => {
  const { app } = fixture('owner-secret');
  expect((await app.request('/api/prompts')).status).toBe(401);
  expect((await app.request('/api/prompts', send({}))).status).toBe(401);
  const authed = await app.request('/api/prompts', {
    headers: { Authorization: 'Bearer owner-secret' },
  });
  expect(authed.status).toBe(200);
});
