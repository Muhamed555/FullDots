// P4 named teams: storage and migrations, the lead's effective delegates, team runs (parallel, step
// by step, direct), start_team_run in a real lead turn (once per turn, gated), cancel, the routes,
// search, mission grouping and team-scoped prompts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalService } from '../src/server/approval-service.js';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { runThreadTurn } from '../src/server/headless.js';
import { wakeOnWork } from '../src/server/live-wiring.js';
import { missionSnapshot } from '../src/server/mission.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { NewResumeMarker } from '../src/server/resume-store.js';
import { Runner } from '../src/server/runner.js';
import { searchWorkspace } from '../src/server/search.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { effectiveDelegates, TeamService } from '../src/server/team-service.js';
import { teamGroups } from '../src/server/teams/team-groups.js';
import { TeamRunService } from '../src/server/teams/team-runs.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { isSingleEmoji, type Team } from '../src/shared/teams.js';
import type { DotRules } from '../src/shared/rules.js';
import type { Delegation, Dot, Handoff } from '../src/shared/types.js';
import { completion } from './fixtures/model-stream.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A workspace with a lead and `count` other Dots, a team service and a team run service. */
function rig(count = 3, options: { turns?: TurnRegistry } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => {
    store.close();
    workspace.close();
  });
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const names = [
    'Scout',
    'Writer',
    'Critic',
    'Coder',
    'Artist',
    'Seller',
    'Helper',
    'Tester',
  ];
  const dots: Dot[] = Array.from({ length: count }, (_, index) =>
    workspace.createDot(
      space,
      names[index]!,
      `${names[index]} role.`,
      true,
      true,
    ),
  );
  const markers: NewResumeMarker[] = [];
  const team = new TeamService({
    workspace,
    store,
    resume: (marker) => markers.push(marker),
  });
  const runs = new TeamRunService({
    workspace,
    team,
    resume: (marker) => markers.push(marker),
    cancelTask: (taskId) => void store.action(taskId, 'cancel'),
    ...(options.turns ? { turns: options.turns } : {}),
    log: () => {},
  });
  team.setRunHook((delegation) => runs.stepFinished(delegation));
  const makeTeam = (
    input: Partial<Parameters<WorkspaceStore['teams']['create']>[0]> = {},
  ) =>
    workspace.teams.create({
      name: 'Launch crew',
      emoji: '🚀',
      color: 'coral',
      leadDotId: lead.id,
      members: dots.map((dot) => ({
        dotId: dot.id,
        role: `${dot.name} things`,
      })),
      ...input,
    });
  const teamChat = (target: Team, id = 'team-chat') => {
    workspace.bindThread(id, target.leadDotId, 'A new thought');
    workspace.teams.bindThread(id, target.id);
    return id;
  };
  return {
    store,
    workspace,
    team,
    runs,
    markers,
    lead,
    dots,
    makeTeam,
    teamChat,
  };
}

describe('storage and migrations', () => {
  it('opens a database built with the old DDL and keeps every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-teams-'));
    cleanups.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    );
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dot_teams(dotId TEXT NOT NULL, delegateId TEXT NOT NULL, PRIMARY KEY(dotId, delegateId));
      CREATE TABLE delegations(id TEXT PRIMARY KEY, parentThreadId TEXT NOT NULL, parentDotId TEXT NOT NULL, childThreadId TEXT NOT NULL, childDotId TEXT NOT NULL, taskId TEXT NOT NULL, depth INTEGER NOT NULL, status TEXT NOT NULL, brief TEXT NOT NULL, deliverable TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, finishedAt INTEGER);
      INSERT INTO spaces VALUES ('s1', 'Home', '', 1);
      INSERT INTO dots VALUES ('lead', 's1', 'Lead', 'Leads.', 1, 1, 1), ('scout', 's1', 'Scout', 'Finds.', 1, 1, 2);
      INSERT INTO thread_bindings VALUES ('t1', 'lead', 'owner', 'Plans', 3), ('t2', 'scout', 'owner', 'Lead → Scout: dig', 4);
      INSERT INTO dot_teams VALUES ('lead', 'scout');
      INSERT INTO delegations VALUES ('d1', 't1', 'lead', 't2', 'scout', 'task-1', 1, 'done', 'Dig.', 'Notes.', 'Found it.', 5, 6);`);
    old.close();
    const workspace = new WorkspaceStore(path, 'owner');
    expect(workspace.dots().map((dot) => dot.id)).toEqual(['lead', 'scout']);
    expect(
      workspace
        .conversations()
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(['t1', 't2']);
    expect(
      workspace.conversations().every((thread) => !('teamId' in thread)),
    ).toBe(true);
    expect(workspace.team.delegates('lead')).toEqual(['scout']);
    expect(workspace.team.get('d1')).toMatchObject({
      status: 'done',
      result: 'Found it.',
      origin: 'dot',
      batchKey: null,
    });
    expect(workspace.teams.list()).toEqual([]);
    // Opening it again adds nothing twice.
    workspace.close();
    const again = new WorkspaceStore(path, 'owner');
    cleanups.push(() => again.close());
    expect(again.team.get('d1')?.origin).toBe('dot');
  });

  it('archives a team whose lead is removed and drops the removed Dot from other teams', () => {
    const f = rig(3);
    const led = f.makeTeam();
    const other = f.workspace.teams.create({
      name: 'Other',
      emoji: '🧭',
      color: 'mint',
      leadDotId: f.dots[0]!.id,
      members: [{ dotId: f.lead.id }, { dotId: f.dots[1]!.id }],
    });
    expect(f.workspace.teams.dotRemoved(f.lead.id)).toEqual({
      archived: [led.id],
    });
    expect(f.workspace.teams.get(led.id)?.archivedAt).toEqual(
      expect.any(Number),
    );
    const kept = f.workspace.teams.get(other.id)!;
    expect(kept.archivedAt).toBeNull();
    expect(kept.members).toEqual([
      { dotId: f.dots[1]!.id, role: '', position: 0 },
    ]);
  });

  it('accepts one emoji only', () => {
    for (const ok of ['🚀', '👩‍💻', '🇪🇬', '🛠️', '1️⃣'])
      expect(isSingleEmoji(ok), ok).toBe(true);
    for (const bad of ['', 'a', 'ab', '🚀🚀', ':)', '7'])
      expect(isSingleEmoji(bad), bad).toBe(false);
  });
});

describe('who may hand work to whom', () => {
  it("unites a Dot's ticked teammates with the members of the active teams it leads", () => {
    const f = rig(4);
    const [scout, writer, critic, coder] = f.dots as [Dot, Dot, Dot, Dot];
    f.workspace.team.setDelegates(f.lead.id, [coder.id]);
    const team = f.makeTeam({
      members: [{ dotId: scout.id }, { dotId: writer.id }],
    });
    expect(effectiveDelegates(f.workspace, f.lead.id).sort()).toEqual(
      [coder.id, scout.id, writer.id].sort(),
    );
    expect(
      f.team
        .teammates(f.lead.id)
        .map((dot) => dot.name)
        .sort(),
    ).toEqual(['Coder', 'Scout', 'Writer']);
    // Nothing is stored: the ticked list is unchanged, and archiving takes the team's share away.
    expect(f.workspace.team.delegates(f.lead.id)).toEqual([coder.id]);
    f.workspace.teams.archive(team.id);
    expect(effectiveDelegates(f.workspace, f.lead.id)).toEqual([coder.id]);
    expect(critic).toBeDefined();
  });

  it('gives members no rights to hand work to each other', () => {
    const f = rig(2);
    const [scout, writer] = f.dots as [Dot, Dot];
    f.makeTeam();
    f.workspace.bindThread('scout-chat', scout.id, 'Scout');
    expect(effectiveDelegates(f.workspace, scout.id)).toEqual([]);
    expect(f.team.canDelegate(scout.id, 'scout-chat')).toBe(false);
    expect(() =>
      f.team.delegate({
        fromDotId: scout.id,
        threadId: 'scout-chat',
        to: writer.name,
        brief: 'Write the launch post please.',
        deliverable: 'A post.',
      }),
    ).toThrow('You have no teammates to hand work to.');
  });
});

describe('team runs', () => {
  it('start_team_run on a team of 8 creates 8 steps, all started at once', () => {
    const f = rig(8);
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      shared: 'Plan the launch of the new app.',
    });
    const steps = f.workspace.teams.steps(run.id);
    expect(steps).toHaveLength(8);
    expect(steps.every((step) => step.status === 'running')).toBe(true);
    const delegations = f.workspace.team.inBatch(`team:${run.id}`);
    expect(delegations).toHaveLength(8);
    expect(new Set(delegations.map((item) => item.childDotId)).size).toBe(8);
    expect(delegations.every((item) => item.origin === 'team')).toBe(true);
    expect(delegations.every((item) => item.parentDotId === f.lead.id)).toBe(
      true,
    );
    expect(
      f.store.tasks().filter((task) => task.status === 'queued'),
    ).toHaveLength(8);
  });

  it('runs step by step in member order whatever order the briefs came in, carrying each result', () => {
    const f = rig(3);
    const [scout, writer, critic] = f.dots as [Dot, Dot, Dot];
    const team = f.makeTeam({ style: 'sequential' });
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      briefs: { Critic: 'Review the draft hard.', scout: 'Find three angles.' },
    });
    // Writer got no brief: skipped entirely. Only the first in member order starts.
    expect(
      f.workspace.teams.steps(run.id).map((step) => [step.dotId, step.status]),
    ).toEqual([
      [scout.id, 'running'],
      [critic.id, 'queued'],
    ]);
    expect(f.workspace.team.forParent(thread)).toHaveLength(1);
    const first = f.workspace.team.forParent(thread)[0]!;
    expect(first.childDotId).toBe(scout.id);
    f.team.completed(first.taskId, 'Angle one, angle two, angle three.');
    const second = f.workspace.team.forParent(thread)[1]!;
    expect(second.childDotId).toBe(critic.id);
    const prompt = f.store.task(second.taskId)!.prompt;
    expect(prompt).toContain('Review the draft hard.');
    expect(prompt).toContain('Scout worked on the step before yours');
    expect(prompt).toContain('Angle one, angle two, angle three.');
    expect(prompt).toContain('Your role on the team: Critic things.');
    // No result went to the lead yet.
    expect(f.markers).toEqual([]);
    f.team.completed(second.taskId, 'Solid. Fix the title.');
    expect(f.markers).toHaveLength(1);
    expect(f.markers[0]).toMatchObject({
      kind: 'delegation',
      refId: run.id,
      threadId: thread,
      dotId: f.lead.id,
      source: 'delegation',
      batchKey: `team:${run.id}`,
    });
    expect(f.markers[0]!.prompt).toContain('step by step, 2 of 2 done');
    expect(f.markers[0]!.prompt.indexOf('1. Scout')).toBeLessThan(
      f.markers[0]!.prompt.indexOf('2. Critic'),
    );
    expect(f.workspace.teams.run(run.id)?.status).toBe('done');
    expect(writer).toBeDefined();
  });

  it('skips the rest of a step-by-step run after a failed step and reports once', () => {
    const f = rig(3);
    const team = f.makeTeam({ style: 'sequential' });
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      shared: 'Do your bit.',
    });
    const first = f.workspace.team.forParent(thread)[0]!;
    f.team.failed(first.taskId, 'Model offline.');
    expect(f.workspace.teams.steps(run.id).map((step) => step.status)).toEqual([
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(f.markers).toHaveLength(1);
    expect(f.markers[0]!.prompt).toContain('could not finish');
    expect(f.workspace.teams.run(run.id)?.status).toBe('failed');
  });

  it('refuses briefs for Dots that are not members, and a member named twice', () => {
    const f = rig(2);
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    expect(() =>
      f.runs.startFromBriefs(team, thread, {
        briefs: { Dot: 'Lead yourself.' },
      }),
    ).toThrow('Dot is not on Launch crew');
    expect(() =>
      f.runs.startFromBriefs(team, thread, {
        briefs: { Scout: 'One thing.', [f.dots[0]!.id]: 'Another thing.' },
      }),
    ).toThrow('Each member takes part once per run');
    expect(() => f.runs.startFromBriefs(team, thread, {})).toThrow(
      'at least one',
    );
    expect(f.workspace.teams.runsForThread(thread)).toEqual([]);
  });

  it('cancel stops every step, without stopping a member busy in another chat', () => {
    const turns = new TurnRegistry();
    const f = rig(2, { turns });
    const [scout, writer] = f.dots as [Dot, Dot];
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      shared: 'Plan the launch.',
    });
    const [toScout, toWriter] = f.workspace.team.forParent(thread) as [
      Delegation,
      Delegation,
    ];
    // Scout works in another chat; Writer is on its step's own conversation.
    const scoutElsewhere = vi.fn();
    const writerOnStep = vi.fn();
    cleanups.push(
      turns.acquire(scout.id, 'somewhere-else', 'chat', scoutElsewhere),
    );
    cleanups.push(
      turns.acquire(
        writer.id,
        toWriter.childThreadId,
        'delegation',
        writerOnStep,
      ),
    );
    const cancelled = f.runs.cancel(run.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(
      f.workspace.teams
        .steps(run.id)
        .every((step) => step.status === 'cancelled'),
    ).toBe(true);
    for (const item of [toScout, toWriter]) {
      expect(f.store.task(item.taskId)?.status).toBe('cancelled');
      expect(f.workspace.team.get(item.id)).toMatchObject({
        status: 'failed',
        result: 'Cancelled by you.',
      });
    }
    expect(writerOnStep).toHaveBeenCalledTimes(1);
    expect(scoutElsewhere).not.toHaveBeenCalled();
    expect(turns.isDotBusy(scout.id)).toBe(true);
    // The aborted turns report late: nothing reaches the lead.
    f.team.failed(toWriter.taskId, 'Run stopped.');
    f.team.completed(toScout.taskId, 'Late result.');
    expect(f.markers).toEqual([]);
    // Cancelling again changes nothing.
    expect(f.runs.cancel(run.id)?.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------------------------
// start_team_run inside a real lead turn
// ---------------------------------------------------------------------------------------------

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};
const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
const text = (content: string) => completion({ role: 'assistant', content });

function leadTurns(rules: Partial<DotRules> = {}) {
  const f = rig(2);
  const runner = new SqliteAgentRunner(':memory:');
  cleanups.push(() => runner.close());
  f.workspace.rules.set(f.lead.id, rules);
  const team = f.makeTeam();
  const thread = f.teamChat(team);
  const approvals = new ApprovalService({
    approvals: f.workspace.approvals,
    resumes: { enqueue: vi.fn() },
    audit: f.workspace.computers,
    notify: async () => {},
    ttlMs: 60_000,
    log: () => {},
  });
  const handoffs = {
    start: vi.fn(async () => ({ id: 'h1' }) as Handoff),
  };
  const queue: Array<() => Response> = [];
  const prompts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).startsWith('https://unused.invalid'))
      return new Response('{}');
    prompts.push(String(init?.body ?? ''));
    const reply = queue.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply();
  });
  const turn = (
    prompt: string,
    metadata?: { source: 'approval' | 'delegation'; ref: string },
  ) =>
    runThreadTurn(
      runner,
      new DotAgent(f.store, f.workspace, config, f.lead.id, {
        approvals,
        handoffs,
        team: f.team,
        teamRuns: f.runs,
      }),
      thread,
      prompt,
      new AbortController().signal,
      metadata,
    );
  const toolMessages = () =>
    runner
      .getThreadMessages(thread)
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
  return { ...f, team, thread, queue, turn, toolMessages, prompts };
}

describe('start_team_run in a lead turn', () => {
  it('tells the lead about its team and refuses a second run in the same turn', async () => {
    const f = leadTurns();
    f.queue.push(
      () =>
        toolCall('t1', 'start_team_run', {
          shared: 'Plan the launch of the app.',
        }),
      () =>
        toolCall('t2', 'start_team_run', {
          briefs: { Scout: 'Again, please.' },
        }),
      () => text('Your team is on it.'),
    );
    expect(await f.turn('Plan our launch.')).toBe('Your team is on it.');
    expect(f.prompts[0]).toContain('You lead the team 🚀 Launch crew');
    expect(f.prompts[0]).toContain('start_team_run');
    const [first, second] = f.toolMessages();
    expect(first).toContain('"started":true');
    expect(second).toContain('already started a team run in this turn');
    expect(f.workspace.teams.runsForThread(f.thread)).toHaveLength(1);
    // Not counted against DELEGATIONS_PER_TURN: two steps from one call.
    expect(f.workspace.team.forParent(f.thread)).toHaveLength(2);
  });

  it('is not offered in the turn that brings the results back', async () => {
    const f = leadTurns();
    f.queue.push(() => text('Here is the plan.'));
    await f.turn('Results are in.', { source: 'delegation', ref: 'run-1' });
    const body = JSON.parse(f.prompts[0]!) as {
      tools?: { function: { name: string } }[];
    };
    const names = (body.tools ?? []).map((tool) => tool.function.name);
    expect(names).not.toContain('start_team_run');
    expect(f.prompts[0]).toContain('You lead the team');
  });

  it('asks first under the hand-off rule Ask, and starts nothing until approved', async () => {
    const f = leadTurns({ hand_off_work: 'ask' });
    f.queue.push(
      () =>
        toolCall('t1', 'start_team_run', {
          briefs: { Scout: 'Find three angles.' },
        }),
      () => text('Waiting for you.'),
    );
    await f.turn('Plan our launch.');
    expect(f.toolMessages()[0]).toContain('pending_approval');
    expect(f.workspace.teams.runsForThread(f.thread)).toEqual([]);
    expect(f.store.tasks()).toEqual([]);
    const [row] = f.workspace.approvals.list({ status: 'pending' });
    expect(row).toMatchObject({
      tool: 'start_team_run',
      summary: `${f.lead.name} wants to start a team run with Scout`,
    });
    expect(row!.argsRedacted).toContain('Scout: Find three angles.');
    f.workspace.approvals.decide(row!.id, 'approve');
    f.queue.push(
      () =>
        toolCall('t2', 'start_team_run', {
          briefs: { Scout: 'Find three angles.' },
        }),
      () => text('Started.'),
    );
    await f.turn('Go', { source: 'approval', ref: row!.id });
    expect(f.workspace.teams.runsForThread(f.thread)).toHaveLength(1);
    expect(f.workspace.approvals.get(row!.id)?.status).toBe('consumed');
  });
});

// ---------------------------------------------------------------------------------------------
// The platform: direct dispatch, routes, search, mission and prompts
// ---------------------------------------------------------------------------------------------

function platformRig() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, config);
  const research = { mode: 'sample' as const, baseUrl: '' };
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const dots = ['Scout', 'Writer', 'Critic'].map((name) =>
    workspace.createDot(space, name, `${name} role.`, true, true),
  );
  return { store, workspace, platform, research, call, lead, dots };
}

describe('direct team chats', () => {
  it('starts min(N, concurrency) steps in one wake and posts the results exactly once', async () => {
    const p = platformRig();
    const created = await p.call('/teams', 'POST', {
      name: 'Launch crew',
      emoji: '🚀',
      color: 'coral',
      leadDotId: p.lead.id,
      mode: 'direct',
      members: p.dots.map((dot) => ({ dotId: dot.id })),
    });
    expect(created.status).toBe(201);
    const teamId = String(created.body.id);
    const chat = await p.call(`/teams/${teamId}/conversations`, 'POST', {});
    expect(chat.status).toBe(201);
    const threadId = String(chat.body.id);
    expect(p.workspace.requireThread(threadId)).toMatchObject({
      dotId: p.lead.id,
      teamId,
    });
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const runner = new Runner(
      p.store,
      p.research,
      async (claim) => {
        started.push(claim.id);
        await new Promise<void>((resolve) => gates.push(resolve));
        const text = `Answer from ${p.workspace.dot(p.workspace.taskDot(claim.id)!)!.name}.`;
        p.platform.team.completed(claim.id, text);
        return { text, sources: [], sample: false };
      },
      60_000,
      { concurrency: 2, dotOf: (id) => p.workspace.taskDot(id) },
    );
    runner.start();
    await flush();
    const unwire = wakeOnWork(p.platform.events, p.platform.turns, runner);
    cleanups.push(() => {
      unwire();
      runner.stop();
    });
    const sent = await p.call(`/teams/${teamId}/dispatch`, 'POST', {
      threadId,
      text: 'What should we call the app?',
    });
    expect(sent.status).toBe(201);
    // One microtask wake claims as many as the runner may run.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveLength(2);
    const delegations = p.workspace.team.forParent(threadId);
    expect(delegations).toHaveLength(3);
    expect(delegations.every((item) => item.origin === 'owner')).toBe(true);
    expect(p.workspace.requireThread(threadId).title).toBe(
      'What should we call the app?',
    );
    for (let index = 0; index < 3; index++) {
      while (!gates.length) await flush();
      gates.shift()!();
      await flush();
    }
    for (
      let i = 0;
      i < 10 &&
      !p.workspace.teams.runsForThread(threadId)[0]?.status.match(/done/);
      i++
    )
      await flush();
    for (let i = 0; i < 10; i++) await flush();
    const messages = p.platform.runner.getThreadMessages(threadId);
    const contents = messages.map((message) => [
      message.role,
      String(message.content),
    ]);
    expect(contents[0]).toEqual(['user', 'What should we call the app?']);
    expect(contents[1]![1]).toContain('Sent to Scout, Writer, Critic');
    const results = contents.filter(([, content]) =>
      content.startsWith('**Results from'),
    );
    expect(results).toHaveLength(1);
    expect(results[0]![1]).toContain('3 of 3 done');
    expect(results[0]![1]).toContain('Answer from Writer.');
    // The results are attributed to the lead, the host of the chat.
    const authors = p.platform.runner.authors(threadId);
    expect(Object.values(authors).every((id) => id === p.lead.id)).toBe(true);
    const [run] = p.workspace.teams.runsForThread(threadId);
    expect(p.workspace.teams.run(run!.id)?.postedAt).toEqual(
      expect.any(Number),
    );
    // A later sweep finds nothing left to post.
    p.platform.teamRuns.recover();
    await flush();
    expect(
      p.platform.runner
        .getThreadMessages(threadId)
        .filter((message) =>
          String(message.content).startsWith('**Results from'),
        ),
    ).toHaveLength(1);
    const detail = await p.call(`/teams/runs/${run!.id}`);
    expect(detail.body).toMatchObject({ status: 'done', mode: 'direct' });
    expect((detail.body.steps as { startedAt: unknown }[]).length).toBe(3);
  });

  it('refuses a dispatch to a team whose lead plans', async () => {
    const p = platformRig();
    const team = p.workspace.teams.create({
      name: 'Planners',
      emoji: '🧭',
      color: 'sky',
      leadDotId: p.lead.id,
      members: [{ dotId: p.dots[0]!.id }],
    });
    const chat = await p.call(`/teams/${team.id}/conversations`, 'POST', {});
    const sent = await p.call(`/teams/${team.id}/dispatch`, 'POST', {
      threadId: chat.body.id,
      text: 'Hello team.',
    });
    expect(sent.status).toBe(400);
    expect(String(sent.body.error)).toContain('lead plans');
  });
});

describe('team routes', () => {
  it('validates names, emoji, colours, leads and members', async () => {
    const p = platformRig();
    const [scout, writer] = p.dots as [Dot, Dot];
    const base = {
      name: 'Launch crew',
      emoji: '🚀',
      color: 'coral',
      leadDotId: p.lead.id,
      members: [{ dotId: scout.id, role: 'Research' }],
    };
    const bad = async (
      patch: Record<string, unknown>,
      status: number,
      message: string,
    ) => {
      const response = await p.call('/teams', 'POST', { ...base, ...patch });
      expect(response.status, message).toBe(status);
      expect(String(response.body.error)).toContain(message);
    };
    await bad({ emoji: 'ab' }, 400, 'one emoji');
    await bad({ emoji: '🚀🚀' }, 400, 'one emoji');
    await bad({ color: 'pink' }, 400, 'Dot colours');
    await bad({ name: '  ' }, 400, 'name');
    await bad({ members: [] }, 400, 'at least one member');
    await bad(
      { members: [{ dotId: p.lead.id }] },
      400,
      'cannot also be a member',
    );
    await bad(
      { members: [{ dotId: scout.id }, { dotId: scout.id }] },
      400,
      'once',
    );
    await bad({ members: [{ dotId: 'nope' }] }, 400, 'not found');
    await bad({ leadDotId: 'nope' }, 400, 'lead Dot was not found');
    await bad(
      {
        members: Array.from({ length: 9 }, (_, index) => ({
          dotId: `d${index}`,
        })),
      },
      400,
      'at most 8',
    );
    const created = await p.call('/teams', 'POST', base);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      style: 'parallel',
      mode: 'lead',
      summarize: false,
    });
    await bad({ name: ' launch CREW ' }, 409, 'already exists');
    const id = String(created.body.id);
    // Members set and reorder in one call.
    const reordered = await p.call(`/teams/${id}/members`, 'PUT', {
      members: [{ dotId: writer.id, role: 'Words' }, { dotId: scout.id }],
    });
    expect(
      (reordered.body.members as { dotId: string }[]).map((m) => m.dotId),
    ).toEqual([writer.id, scout.id]);
    const patched = await p.call(`/teams/${id}`, 'PATCH', {
      style: 'sequential',
      mode: 'direct',
      summarize: true,
      emoji: '🦊',
    });
    expect(patched.body).toMatchObject({
      style: 'sequential',
      mode: 'direct',
      summarize: true,
      emoji: '🦊',
    });
    expect(
      (await p.call(`/teams/${id}`, 'PATCH', { leadDotId: writer.id })).status,
    ).toBe(400);
    expect((await p.call('/teams/missing')).status).toBe(404);
    expect((await p.call('/teams/runs/missing')).status).toBe(404);
    const list = await p.call('/teams');
    expect((list.body.teams as Team[]).map((team) => team.name)).toEqual([
      'Launch crew',
    ]);
    expect(list.body.workingDotIds).toEqual([]);
  });

  it('archiving keeps the Dots and the chats, and ends what the team gave its lead', async () => {
    const p = platformRig();
    const created = await p.call('/teams', 'POST', {
      name: 'Crew',
      emoji: '🐝',
      color: 'amber',
      leadDotId: p.lead.id,
      members: [{ dotId: p.dots[0]!.id }],
    });
    const id = String(created.body.id);
    const chat = await p.call(`/teams/${id}/conversations`, 'POST', {});
    expect(effectiveDelegates(p.workspace, p.lead.id)).toEqual([p.dots[0]!.id]);
    const delegates = await p.call(`/dots/${p.lead.id}/team`);
    expect(delegates.body).toEqual({
      delegateIds: [],
      implied: [
        { dotId: p.dots[0]!.id, teams: [{ id, name: 'Crew', emoji: '🐝' }] },
      ],
    });
    const archived = await p.call(`/teams/${id}/archive`, 'POST', {});
    expect(archived.body.archivedAt).toEqual(expect.any(Number));
    expect(p.workspace.dots()).toHaveLength(4);
    expect(p.workspace.requireThread(String(chat.body.id)).teamId).toBe(id);
    expect(effectiveDelegates(p.workspace, p.lead.id)).toEqual([]);
    expect((await p.call('/teams')).body.teams).toEqual([]);
    expect(
      ((await p.call('/teams?archived=1')).body.teams as Team[])[0]?.id,
    ).toBe(id);
    // An archived team takes no new chats, and its name is free again.
    expect(
      (await p.call(`/teams/${id}/conversations`, 'POST', {})).status,
    ).toBe(404);
    expect(
      (
        await p.call('/teams', 'POST', {
          name: 'Crew',
          emoji: '🐝',
          color: 'amber',
          leadDotId: p.lead.id,
          members: [{ dotId: p.dots[0]!.id }],
        })
      ).status,
    ).toBe(201);
  });

  it('lets saved prompts belong to an active team only', async () => {
    const p = platformRig();
    const team = p.workspace.teams.create({
      name: 'Crew',
      emoji: '🐝',
      color: 'amber',
      leadDotId: p.lead.id,
      members: [{ dotId: p.dots[0]!.id }],
    });
    const prompt = {
      title: 'Kickoff',
      body: 'Plan the week.',
      scope: 'team',
      teamId: team.id,
    };
    expect((await p.call('/prompts', 'POST', prompt)).status).toBe(201);
    expect(
      (await p.call('/prompts', 'POST', { ...prompt, teamId: 'nope' })).status,
    ).toBe(400);
    p.workspace.teams.archive(team.id);
    expect((await p.call('/prompts', 'POST', prompt)).status).toBe(400);
  });
});

describe('search and mission control', () => {
  it('finds active teams by name and description', () => {
    const f = rig(2);
    const team = f.makeTeam({ description: 'Ships the quarterly launch.' });
    f.workspace.teams.create({
      name: 'Old crew',
      emoji: '🧭',
      color: 'mint',
      leadDotId: f.lead.id,
      members: [{ dotId: f.dots[0]!.id }],
    });
    f.workspace.teams.archive(f.workspace.teams.activeNamed('Old crew')!.id);
    const search = (query: string) =>
      searchWorkspace(
        {
          query,
          limit: 20,
          store: f.workspace.search,
          conversations: () => [],
          threads: () => [],
          linkedThreadIds: () => new Set(),
          messages: () => [],
        },
        ['team'],
      );
    expect(search('launch')).toEqual([
      expect.objectContaining({
        type: 'team',
        id: team.id,
        title: '🚀 Launch crew',
      }),
    ]);
    expect(search('quarterly')[0]).toMatchObject({
      id: team.id,
      snippet: expect.stringContaining('quarterly'),
    });
    expect(search('crew').map((hit) => hit.title)).toEqual(['🚀 Launch crew']);
  });

  it('groups mission control by team, a Dot in two teams under each', () => {
    const f = rig(3);
    const [scout, writer, critic] = f.dots as [Dot, Dot, Dot];
    f.makeTeam({ members: [{ dotId: scout.id }, { dotId: writer.id }] });
    f.workspace.teams.create({
      name: 'Words',
      emoji: '📚',
      color: 'lilac',
      leadDotId: writer.id,
      members: [{ dotId: scout.id }],
    });
    const ids = [f.lead.id, scout.id, writer.id, critic.id];
    expect(teamGroups(f.workspace.teams.list(), ids)).toEqual([
      {
        id: expect.stringMatching(/^team:/),
        label: '🚀 Launch crew',
        dotIds: [f.lead.id, scout.id, writer.id],
      },
      {
        id: expect.stringMatching(/^team:/),
        label: '📚 Words',
        dotIds: [writer.id, scout.id],
      },
      { id: 'other', label: 'Not in a team', dotIds: [critic.id] },
    ]);
    expect(teamGroups([], ids)).toEqual([
      { id: 'all', label: 'Your Dots', dotIds: ids },
    ]);
    const snapshot = missionSnapshot({
      store: f.store,
      workspace: f.workspace,
      turns: new TurnRegistry(),
      groups: (dotIds) => teamGroups(f.workspace.teams.list(), dotIds),
    });
    expect(snapshot.groups.map((group) => group.label)).toEqual([
      '🚀 Launch crew',
      '📚 Words',
      'Not in a team',
    ]);
  });
});
