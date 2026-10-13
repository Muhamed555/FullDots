// P3 work lanes on the server: the progress endpoint, Stop, Stop everything and Try again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/client';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import { LaneService, MAX_ATTEMPTS } from '../src/server/lanes.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { LaneProgressResponse } from '../src/shared/lanes.js';
import { previewLines } from '../src/shared/lanes.js';
import type { ConversationSummary, Delegation } from '../src/shared/types.js';

const TOKEN = 'lanes-test-owner-token-0123456789';
const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

function setup() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(store, workspace);
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const scout = workspace.createDot(space, 'Scout', 'Research.', true, true);
  const writer = workspace.createDot(space, 'Writer', 'Writes.', true, true);
  workspace.team.setDelegates(lead.id, [scout.id, writer.id]);
  workspace.bindThread('lead-thread', lead.id, 'Launch');
  const platform = new Platform(store, workspace, config);
  closers.push({ close: () => platform.runner.close() });
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  const aborted: string[] = [];
  vi.spyOn(runner, 'abort').mockImplementation((id) => void aborted.push(id));
  const app = createApp({
    store,
    runner,
    config: { mode: 'sample', baseUrl: '' },
    ownerToken: TOKEN,
    platform,
  });
  const request = (path: string, method = 'GET') =>
    app.request(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  const hand = (to: string, runId = 'run-1') =>
    platform.team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to,
      brief: `Work for ${to}: research the launch carefully.`,
      deliverable: 'Notes.',
      runId,
    });
  return {
    store,
    workspace,
    platform,
    app,
    request,
    hand,
    lead,
    scout,
    writer,
    aborted,
  };
}

const progress = async (
  request: (path: string) => Response | Promise<Response>,
): Promise<LaneProgressResponse> =>
  (await (
    await request('/conversations/lead-thread/delegations/progress')
  ).json()) as LaneProgressResponse;

describe('lane progress', () => {
  it('reports status, step, tokens, preview and ids, owner only', async () => {
    const { platform, request, hand, app, scout, writer } = setup();
    const first = hand('Scout');
    const second = hand('Writer');
    // Scout works in its own chat; its run streams a tool call and some text.
    const release = platform.turns.acquire(
      scout.id,
      first.childThreadId,
      'delegation',
      () => {},
      'child-run',
    );
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'm1',
        delta: 'Looking at three competitors.\nFirst: Acme.',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: 't1',
        toolCallName: 'computer_navigate',
      } as BaseEvent,
    ];
    vi.spyOn(platform.runner, 'liveRun').mockImplementation((threadId) =>
      threadId === first.childThreadId
        ? { runId: 'child-run', events }
        : undefined,
    );
    vi.spyOn(platform.runner, 'runsAfter').mockImplementation(
      (threadId, afterId) =>
        threadId === first.childThreadId && afterId === 0
          ? [
              {
                id: 7,
                events: [
                  {
                    type: EventType.RUN_FINISHED,
                    usage: [{ inputTokens: 1200, outputTokens: 300 }],
                  } as BaseEvent,
                ],
              },
            ]
          : [],
    );
    const data = await progress(request);
    expect(data.now).toBeGreaterThan(0);
    const [scoutLane, writerLane] = data.lanes;
    expect(scoutLane).toMatchObject({
      id: first.id,
      childThreadId: first.childThreadId,
      childDotId: scout.id,
      status: 'working',
      wait: null,
      step: 'Opening website',
      tokens: 1500,
      preview: ['Looking at three competitors.', 'First: Acme.'],
      runId: 'child-run',
      attempt: 1,
      result: null,
    });
    expect(writerLane).toMatchObject({
      id: second.id,
      childDotId: writer.id,
      status: 'queued',
      tokens: null,
      preview: [],
    });
    // Tokens are read once per stored run.
    expect((await progress(request)).lanes[0].tokens).toBe(1500);
    release();

    // Owner only: no token, no progress; an unknown chat is not found.
    expect(
      (await app.request('/api/conversations/lead-thread/delegations/progress'))
        .status,
    ).toBe(401);
    expect(
      (await request('/conversations/nope/delegations/progress')).status,
    ).toBe(404);
  });

  it('says why a lane waits: busy elsewhere, budget, paused, approval, handoff', async () => {
    const { platform, workspace, request, hand, scout, writer, store } =
      setup();
    const first = hand('Scout');
    const second = hand('Writer');
    workspace.bindThread('elsewhere', scout.id, 'Other chat');
    const release = platform.turns.acquire(
      scout.id,
      'elsewhere',
      'chat',
      () => {},
    );
    workspace.usage.setBudget(writer.id, 10);
    workspace.usage.record(writer.id, { input: 50, output: 0 });
    let lanes = (await progress(request)).lanes;
    expect(lanes[0]).toMatchObject({
      status: 'waiting',
      wait: { kind: 'busy' },
    });
    expect(lanes[1]).toMatchObject({
      status: 'waiting',
      wait: { kind: 'budget' },
    });
    release();
    workspace.setDotPaused(scout.id, true);
    lanes = (await progress(request)).lanes;
    expect(lanes[0].wait).toEqual({ kind: 'paused' });
    workspace.setDotPaused(scout.id, false);

    // The teammate ran and stopped for an approval: the lane holds and points at it.
    store.action(first.taskId, 'cancel');
    const approval = workspace.approvals.create({
      threadId: first.childThreadId,
      dotId: scout.id,
      toolCallId: 'call-1',
      tool: 'computer_exec',
      argsHash: 'h',
      summary: 'Scout wants to run a command',
      argsRedacted: 'ls',
      ttlMs: 60_000,
    });
    lanes = (await progress(request)).lanes;
    expect(lanes[0]).toMatchObject({
      status: 'waiting',
      wait: { kind: 'approval', approval: { id: approval.id } },
    });
    workspace.approvals.decide(approval.id, 'deny');
    workspace.handoffs.create({
      dotId: scout.id,
      threadId: first.childThreadId,
      kind: 'two_factor',
      reason: 'Enter the code',
    });
    lanes = (await progress(request)).lanes;
    expect(lanes[0]).toMatchObject({
      status: 'waiting',
      wait: { kind: 'handoff', handoff: { kind: 'two_factor' } },
    });
    expect(second.status).toBe('running');
  });

  it('ends with the result excerpt once a teammate is done', async () => {
    const { platform, request, hand } = setup();
    const first = hand('Scout');
    platform.team.completed(
      first.taskId,
      '# Findings\n- Acme: $10\n- Beta: $12',
    );
    const [lane] = (await progress(request)).lanes;
    expect(lane).toMatchObject({
      status: 'done',
      step: null,
      wait: null,
      preview: ['Acme: $10', 'Beta: $12'],
      resultLength: 34,
    });
    expect(lane.result).toContain('Acme');
  });
});

describe('stopping lanes', () => {
  it('stop everything cancels every child and leaves a member busy in another chat running', async () => {
    const {
      platform,
      workspace,
      request,
      hand,
      scout,
      writer,
      store,
      aborted,
    } = setup();
    const first = hand('Scout');
    const second = hand('Writer');
    // Scout works on the hand-off in its own chat: that turn is stopped.
    const stopScout = vi.fn();
    const releaseScout = platform.turns.acquire(
      scout.id,
      first.childThreadId,
      'delegation',
      stopScout,
    );
    // Writer is busy in another chat; its hand-off is only queued. That turn must keep running.
    workspace.bindThread('writer-chat', writer.id, 'Writer elsewhere');
    const stopWriter = vi.fn();
    const releaseWriter = platform.turns.acquire(
      writer.id,
      'writer-chat',
      'chat',
      stopWriter,
    );
    const response = await request(
      '/conversations/lead-thread/delegations/stop',
      'POST',
    );
    expect(await response.json()).toEqual({ stopped: 2 });
    expect(stopScout).toHaveBeenCalledOnce();
    expect(stopWriter).not.toHaveBeenCalled();
    expect(platform.turns.isDotBusy(writer.id)).toBe(true);
    for (const delegation of [first, second]) {
      expect(workspace.team.get(delegation.id)).toMatchObject({
        status: 'stopped',
        result: 'Stopped by you.',
      });
      expect(store.task(delegation.taskId)!.status).toBe('cancelled');
    }
    expect(aborted).toEqual([first.taskId, second.taskId]);
    // The run that ends because of the stop reports nothing.
    platform.team.completed(first.taskId, 'late result');
    platform.team.failed(second.taskId, 'aborted');
    expect(workspace.team.get(first.id)!.status).toBe('stopped');
    expect(workspace.resumes.all()).toEqual([]);
    const lanes = (await progress(request)).lanes;
    expect(lanes.map((lane) => lane.status)).toEqual(['stopped', 'stopped']);
    releaseScout();
    releaseWriter();
  });

  it('stops one lane and what it handed on, and tells the lead with the batch', async () => {
    const { platform, workspace, request, hand, scout, writer, lead } = setup();
    workspace.team.setDelegates(scout.id, [writer.id]);
    const first = hand('Scout');
    const second = hand('Writer');
    const below = platform.team.delegate({
      fromDotId: scout.id,
      threadId: first.childThreadId,
      to: 'Writer',
      brief: 'Draft the summary for Scout please.',
      deliverable: 'A draft.',
    });
    const response = await request(`/delegations/${first.id}/stop`, 'POST');
    expect(await response.json()).toMatchObject({
      stopped: 2,
      delegation: { id: first.id, status: 'stopped' },
    });
    expect(workspace.team.get(below.id)!.status).toBe('stopped');
    expect(workspace.team.get(second.id)!.status).toBe('running');
    // Stopping again changes nothing.
    expect(
      await (await request(`/delegations/${first.id}/stop`, 'POST')).json(),
    ).toMatchObject({ stopped: 0 });
    // The other result goes back with a note about the stopped one.
    platform.team.completed(second.taskId, 'Draft ready.');
    const prompt = platform.team
      .batches(1500)
      .prompt(
        workspace.resumes.all().filter((marker) => marker.dotId === lead.id),
      );
    expect(prompt).toContain('## Writer: done');
    expect(prompt).toContain('## Scout: stopped by the owner');
    expect(prompt).toContain('Do not redo the work the owner stopped');
    expect((await request('/delegations/nope/stop', 'POST')).status).toBe(404);
  });
});

describe('trying again', () => {
  it('hands the same brief to the same teammate as a new delegation', async () => {
    const { platform, workspace, request, hand, scout } = setup();
    const first = hand('Scout');
    expect(
      (await request(`/delegations/${first.id}/retry`, 'POST')).status,
    ).toBe(409);
    platform.team.failed(first.taskId, 'Connection error.');
    const response = await request(`/delegations/${first.id}/retry`, 'POST');
    expect(response.status).toBe(201);
    const { delegation } = (await response.json()) as {
      delegation: Delegation;
    };
    expect(delegation).toMatchObject({
      parentThreadId: 'lead-thread',
      childDotId: scout.id,
      brief: first.brief,
      deliverable: first.deliverable,
      status: 'running',
      retryOf: first.id,
    });
    expect(delegation.id).not.toBe(first.id);
    expect(delegation.childThreadId).not.toBe(first.childThreadId);
    // Nothing is deleted: the failed one stays.
    expect(workspace.team.get(first.id)!.status).toBe('failed');
    const lanes = (await progress(request)).lanes;
    expect(lanes.map((lane) => [lane.status, lane.attempt])).toEqual([
      ['failed', 1],
      ['queued', 2],
    ]);
    // Only the newest attempt can be tried again.
    expect(
      (await request(`/delegations/${first.id}/retry`, 'POST')).status,
    ).toBe(409);
  });

  it('respects pause, rules and the attempt cap', () => {
    const { platform, workspace, hand, scout, lead, store } = setup();
    const lanes = new LaneService({
      workspace,
      store,
      turns: platform.turns,
      runner: platform.runner,
      team: platform.team,
    });
    let current = hand('Scout');
    platform.team.failed(current.taskId, 'Broken.');
    workspace.setDotPaused(scout.id, true);
    expect(() => lanes.retry(current.id)).toThrow('Scout is paused');
    workspace.setDotPaused(scout.id, false);
    workspace.rules.set(lead.id, { hand_off_work: 'never' });
    expect(() => lanes.retry(current.id)).toThrow('never hands work over');
    workspace.rules.set(lead.id, { hand_off_work: 'inherit' });
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      current = lanes.retry(current.id);
      lanes.stop(current.id);
    }
    expect(() => lanes.retry(current.id)).toThrow(`${MAX_ATTEMPTS} times`);
  });
});

describe('teammates that wait for the owner', () => {
  it('hold their result until the resumed turn ends', () => {
    const { platform, workspace, hand, scout } = setup();
    const first = hand('Scout');
    // The teammate's run ended while it waited for an approval: the run is over, the work is not.
    platform.store.action(first.taskId, 'cancel');
    platform.team.resumed(first.childThreadId, 'Still waiting.', true);
    expect(workspace.team.get(first.id)!.status).toBe('running');
    platform.team.resumed(first.childThreadId, 'Done after approval.', false);
    expect(workspace.team.get(first.id)).toMatchObject({
      status: 'done',
      result: 'Done after approval.',
    });
    expect(scout.id).toBeTruthy();
  });
});

describe('sidebar data', () => {
  it('names the chat that handed work over, and whether a chat runs', async () => {
    const { request, hand, lead } = setup();
    const first = hand('Scout');
    const data = (await (await request('/workspace')).json()) as {
      conversations: ConversationSummary[];
    };
    const child = data.conversations.find(
      (item) => item.id === first.childThreadId,
    );
    expect(child).toMatchObject({
      handedBy: { threadId: 'lead-thread', dotId: lead.id },
      running: false,
    });
    expect(
      data.conversations.find((item) => item.id === 'lead-thread')!.handedBy,
    ).toBeUndefined();
  });
});

describe('preview lines', () => {
  it('keeps the last two lines without Markdown', () => {
    expect(
      previewLines('# Title\n\n- **one**\n| a | b |\n|---|---|\n> [two](x)'),
    ).toEqual(['| a | b |', 'two']);
    expect(previewLines('x'.repeat(300))[0]).toHaveLength(140);
  });
});
