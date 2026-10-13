// Mission control: GET /api/mission aggregates running turns, queued tasks, what waits for the owner
// and today's tokens, one card per Dot.
import { afterEach, expect, it } from 'vitest';
import { missionRoutes, missionSnapshot } from '../src/server/mission.js';
import { Store } from '../src/server/store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { MissionResponse } from '../src/shared/inbox.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function rig() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => {
    store.close();
    workspace.close();
  });
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const scout = workspace.createDot(space, 'Scout', 'Research.', true, true);
  const writer = workspace.createDot(space, 'Writer', 'Write.', true, true);
  const turns = new TurnRegistry();
  return { store, workspace, lead, scout, writer, turns };
}

it('shows who works where, what is queued, what waits and the tokens against the budget', () => {
  const r = rig();
  r.workspace.bindThread('lead-old', r.lead.id, 'Older chat');
  r.workspace.bindThread('lead-work', r.lead.id, 'Quarterly report');
  r.workspace.bindThread('scout-chat', r.scout.id, 'Venues');
  r.workspace.bindThread('writer-chat', r.writer.id, 'Draft');
  // The lead holds a turn and has a queued task.
  const release = r.turns.acquire(r.lead.id, 'lead-work', 'task', () => {});
  cleanups.push(release);
  r.workspace.frames.add(
    {
      dotId: r.lead.id,
      threadId: 'lead-work',
      toolCallId: 'c1',
      action: 'navigate',
      url: 'https://example.com/',
      title: 'Pricing',
      outcome: 'succeeded',
    },
    100,
    Date.now() + 10,
  );
  const task = r.store.createTask('Again tomorrow.');
  r.workspace.bindTask(task.id, 'lead-old');
  // Scout waits for an approval and a question.
  r.workspace.approvals.create({
    threadId: 'scout-chat',
    dotId: r.scout.id,
    toolCallId: 'c1',
    tool: 'computer_exec',
    argsHash: 'h',
    summary: 'Run',
    argsRedacted: 'ls',
    ttlMs: 60_000,
  });
  r.workspace.inbox.create({
    kind: 'question',
    dotId: r.scout.id,
    threadId: 'scout-chat',
    title: 'Scout has a question',
    text: 'Which?',
  });
  r.workspace.usage.record(r.scout.id, { input: 1200, output: 300 });
  r.workspace.usage.setBudget(r.scout.id, 10_000);
  // Writer is paused.
  r.workspace.setDotPaused(r.writer.id, true);

  const mission = missionSnapshot(r);
  const card = (id: string) => mission.dots.find((dot) => dot.id === id)!;
  expect(card(r.lead.id)).toMatchObject({
    state: 'working',
    threadId: 'lead-work',
    queued: 1,
    activity: {
      threadId: 'lead-work',
      threadTitle: 'Quarterly report',
      source: 'task',
      step: 'navigate · Pricing',
    },
    waiting: { total: 0 },
  });
  expect(card(r.scout.id)).toMatchObject({
    state: 'needs-input',
    activity: null,
    threadId: 'scout-chat',
    queued: 0,
    waiting: { approvals: 1, handoffs: 0, questions: 1, total: 2 },
    usage: { today: 1500, budget: 10_000 },
  });
  expect(card(r.writer.id)).toMatchObject({
    state: 'paused',
    paused: true,
    usage: { today: 0, budget: null },
  });
  expect(mission.groups).toEqual([
    {
      id: 'all',
      label: 'Your Dots',
      dotIds: [r.lead.id, r.scout.id, r.writer.id],
    },
  ]);
  // The payload carries titles and counts, never message or question text.
  expect(JSON.stringify(mission)).not.toContain('Which?');
});

it('marks every Dot paused while all are paused, keeps a working one working, and groups through the hook', async () => {
  const r = rig();
  r.store.updateSettings({ paused: true });
  r.workspace.bindThread('t', r.scout.id, 'Chat');
  cleanups.push(r.turns.acquire(r.scout.id, 't', 'chat', () => {}));
  const mission = missionSnapshot({
    ...r,
    groups: (ids) => [{ id: 'team', label: 'Team', dotIds: ids.slice(0, 1) }],
  });
  expect(mission.allPaused).toBe(true);
  expect(mission.dots.map((dot) => dot.state)).toEqual([
    'paused',
    'working',
    'paused',
  ]);
  expect(mission.groups).toEqual([
    { id: 'team', label: 'Team', dotIds: [r.lead.id] },
  ]);

  const app = missionRoutes(r);
  const body = (await (
    await app.request('/mission')
  ).json()) as MissionResponse;
  expect(body.dots).toHaveLength(3);
  expect(body.dots[1].activity?.source).toBe('chat');
});
