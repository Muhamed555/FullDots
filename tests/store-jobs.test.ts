import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const result = { text: 'done', sources: [], sample: false };

describe('task kinds', () => {
  it('derives once and repeat from the interval, as before', () => {
    const store = new Store(':memory:');
    expect(store.createTask('Once').kind).toBe('once');
    expect(store.createTask('Again', 3600).kind).toBe('repeat');
    expect(store.createTask('Again', { intervalSeconds: 60 }).kind).toBe(
      'repeat',
    );
    store.close();
  });

  it('refuses a goal without a check interval', () => {
    const store = new Store(':memory:');
    expect(() => store.createTask('Ship it', { kind: 'goal' })).toThrow(
      'A goal needs a check interval.',
    );
    store.close();
  });

  it('counts runs and schedules the next one for a repeat', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Check mail', 3600);
    const claim = store.claim(1_000)!;
    expect(store.finish(claim, result, 2_000)).toBe(true);
    const after = store.task(task.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBe(2_000);
    expect(after.nextRunAt).toBe(2_000 + 3_600_000);
    store.close();
  });

  it('stops a repeat at its run limit', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Twice', {
      intervalSeconds: 60,
      maxRuns: 2,
    });
    store.finish(store.claim(1_000)!, result, 1_000);
    expect(store.task(task.id)!.nextRunAt).toBe(61_000);
    store.finish(store.claim(61_000)!, result, 61_000);
    const done = store.task(task.id)!;
    expect(done.runCount).toBe(2);
    expect(done.nextRunAt).toBeNull();
    expect(store.claim(10_000_000)).toBeNull();
    expect(store.detail(task.id)!.events.at(-1)!.text).toBe(
      'Stopped after 2 runs, its run limit.',
    );
    store.close();
  });

  it('keeps a goal running until the Dot marks it achieved', () => {
    const store = new Store(':memory:');
    const goal = store.createTask('Get the docs to 100% coverage', {
      kind: 'goal',
      intervalSeconds: 600,
    });
    expect(goal.kind).toBe('goal');
    store.finish(store.claim(1_000)!, result, 1_000);
    expect(store.task(goal.id)!.nextRunAt).toBe(601_000);

    const claim = store.claim(601_000)!;
    expect(store.completeGoal(goal.id, 'All pages documented.')!.summary).toBe(
      'All pages documented.',
    );
    store.finish(claim, result, 602_000);
    const done = store.task(goal.id)!;
    expect(done.status).toBe('completed');
    expect(done.runCount).toBe(2);
    expect(done.nextRunAt).toBeNull();
    expect(store.claim(10_000_000)).toBeNull();
    expect(
      store
        .detail(goal.id)!
        .events.some(
          (event) => event.text === 'Goal achieved: All pages documented.',
        ),
    ).toBe(true);
    store.close();
  });

  it('only completes goals', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Plain', 60);
    expect(store.completeGoal(task.id, 'nope')).toBeUndefined();
    expect(store.completeGoal('missing', 'nope')).toBeUndefined();
    expect(store.task(task.id)!.summary).toBeNull();
    store.close();
  });

  it('records the trigger of an event task', () => {
    const store = new Store(':memory:');
    const task = store.createTask('New issue', {
      kind: 'event',
      triggerId: 'trigger-1',
    });
    expect(task).toMatchObject({ kind: 'event', triggerId: 'trigger-1' });
    expect(store.detail(task.id)!.events[0].text).toBe('Started by a trigger.');
    store.close();
  });
});

describe('task table migration', () => {
  it('adds the new columns to an existing database and keeps its tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-jobs-'));
    dirs.push(dir);
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      'CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER)',
    );
    old
      .prepare(
        "INSERT INTO tasks VALUES ('r', 'Repeat me', 'completed', 3600, NULL, 1, 1, NULL, NULL, NULL), ('o', 'Once', 'queued', NULL, NULL, 2, 2, NULL, NULL, NULL)",
      )
      .run();
    old.close();
    const store = new Store(path);
    expect(store.task('r')).toMatchObject({
      prompt: 'Repeat me',
      kind: 'repeat',
      runCount: 0,
      maxRuns: null,
      summary: null,
    });
    expect(store.task('o')!.kind).toBe('once');
    store.close();
    // Opening it again does not fail on columns that already exist.
    new Store(path).close();
  });
});
