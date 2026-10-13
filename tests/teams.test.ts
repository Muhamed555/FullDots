import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DELEGATIONS_PER_TURN,
  TeamService,
  teamTools,
} from '../src/server/team-service.js';
import type { NewResumeMarker } from '../src/server/resume-store.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { completion } from './fixtures/model-stream.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

function setup(maxDepth = 2) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(store, workspace);
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const scout = workspace.createDot(
    space,
    'Scout',
    'Research partner. Cite sources.',
    true,
    true,
  );
  const writer = workspace.createDot(
    space,
    'Writer',
    'Writes clear posts.',
    true,
    true,
  );
  workspace.bindThread('lead-thread', lead.id, 'Launch');
  const resumes: NewResumeMarker[] = [];
  const team = new TeamService({
    workspace,
    store,
    resume: (marker) => resumes.push(marker),
    maxDepth,
  });
  return { store, workspace, team, resumes, lead, scout, writer };
}

describe('handing work to a teammate', () => {
  it('starts the teammate in a new conversation of its own and reports the result back', () => {
    const { store, workspace, team, resumes, lead, scout } = setup();
    workspace.team.setDelegates(lead.id, [scout.id]);
    const delegation = team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to: 'scout',
      brief: 'Find three competitors of FullDots and what they charge.',
      deliverable: 'A table with name, price and one line each.',
    });
    expect(delegation).toMatchObject({
      childDotId: scout.id,
      depth: 1,
      status: 'running',
    });
    const child = workspace.requireThread(delegation.childThreadId);
    expect(child).toMatchObject({
      dotId: scout.id,
      title: `${lead.name} → Scout: Find three competitors of FullDots and what they charge.`,
    });
    const task = store.task(delegation.taskId)!;
    expect(task).toMatchObject({ kind: 'delegation', status: 'queued' });
    expect(task.prompt).toContain(
      'What to deliver: A table with name, price and one line each.',
    );
    expect(workspace.taskThread(task.id)).toBe(child.id);

    team.completed(task.id, '| Name | Price |');
    expect(workspace.team.get(delegation.id)).toMatchObject({
      status: 'done',
      result: '| Name | Price |',
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      kind: 'delegation',
      refId: delegation.id,
      threadId: 'lead-thread',
      dotId: lead.id,
      source: 'delegation',
    });
    expect(resumes[0].prompt).toContain(
      'Scout finished the work you handed over.',
    );
    expect(resumes[0].prompt).toContain('| Name | Price |');
    // Reported once only.
    team.completed(task.id, 'again');
    expect(resumes).toHaveLength(1);
  });

  it('tells the Dot that asked when the teammate fails', () => {
    const { team, resumes, lead, scout, workspace } = setup();
    workspace.team.setDelegates(lead.id, [scout.id]);
    const delegation = team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to: scout.id,
      brief: 'Check the pricing page.',
      deliverable: 'The prices.',
    });
    team.failed(delegation.taskId, 'Connection error.');
    expect(workspace.team.get(delegation.id)!.status).toBe('failed');
    expect(resumes[0].prompt).toContain(
      'Scout could not finish the work you handed over (Connection error.)',
    );
  });

  it('only hands work to granted teammates', () => {
    const { team, lead, writer, workspace, scout } = setup();
    workspace.team.setDelegates(lead.id, [scout.id]);
    expect(() =>
      team.delegate({
        fromDotId: lead.id,
        threadId: 'lead-thread',
        to: writer.name,
        brief: 'Write the post.',
        deliverable: 'A draft.',
      }),
    ).toThrow('Writer is not on your team. You can hand work to: Scout.');
  });

  it('stops chains at the depth limit and refuses loops', () => {
    const { team, lead, scout, writer, workspace } = setup(2);
    workspace.team.setDelegates(lead.id, [scout.id]);
    workspace.team.setDelegates(scout.id, [writer.id, lead.id]);
    workspace.team.setDelegates(writer.id, [scout.id, lead.id]);
    const first = team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to: 'Scout',
      brief: 'Research the launch.',
      deliverable: 'Notes.',
    });
    // Scout hands on to Writer (depth 2): allowed.
    const second = team.delegate({
      fromDotId: scout.id,
      threadId: first.childThreadId,
      to: 'Writer',
      brief: 'Turn the notes into a post.',
      deliverable: 'A post.',
    });
    expect(second.depth).toBe(2);
    // Scout handing back to the lead would loop.
    expect(() =>
      team.delegate({
        fromDotId: scout.id,
        threadId: first.childThreadId,
        to: lead.name,
        brief: 'Back to you.',
        deliverable: 'Anything.',
      }),
    ).toThrow('handing it back would loop');
    // Writer is two levels down already.
    expect(team.canDelegate(writer.id, second.childThreadId)).toBe(false);
    expect(() =>
      team.delegate({
        fromDotId: writer.id,
        threadId: second.childThreadId,
        to: 'Scout',
        brief: 'One more level.',
        deliverable: 'Anything.',
      }),
    ).toThrow('Hand-offs can only go 2 levels deep.');
  });

  it('allows at most three hand-offs in one turn', async () => {
    const { team, lead, scout, workspace } = setup();
    workspace.team.setDelegates(lead.id, [scout.id]);
    const [delegate] = teamTools(team, {
      dotId: lead.id,
      threadId: 'lead-thread',
    });
    const run = (n: number) =>
      (delegate.execute as (args: unknown) => Promise<Record<string, unknown>>)(
        {
          dot: 'Scout',
          brief: `Research topic number ${n} in detail.`,
          deliverable: 'Notes.',
        },
      );
    for (let i = 0; i < DELEGATIONS_PER_TURN; i++)
      expect((await run(i)).started).toBe(true);
    expect(await run(9)).toMatchObject({
      started: false,
      error: expect.stringContaining('at most 3'),
    });
  });

  it('cancels running hand-offs when the asking conversation is deleted', () => {
    const { store, team, lead, scout, workspace } = setup();
    workspace.team.setDelegates(lead.id, [scout.id]);
    const delegation = team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to: 'Scout',
      brief: 'Research the launch.',
      deliverable: 'Notes.',
    });
    team.cancelFrom('lead-thread');
    expect(store.task(delegation.taskId)!.status).toBe('cancelled');
    expect(workspace.team.get(delegation.id)!.status).toBe('failed');
  });
});

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};

describe('team tools in a turn', () => {
  it('offers delegate_to_dot and names the teammates only when the Dot has a team', async () => {
    const { store, workspace, team, lead, scout } = setup();
    const requests: {
      tools?: { function: { name: string } }[];
      messages: unknown[];
    }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith('https://unused.invalid')) {
        requests.push(JSON.parse(String(init?.body)));
        return completion({ role: 'assistant', content: 'Ok.' });
      }
      return new Response('{}');
    });
    const agent = new DotAgent(store, workspace, config, lead.id, { team });
    const input: RunAgentInput = {
      threadId: 'lead-thread',
      runId: 'r',
      state: {},
      context: [],
      messages: [{ id: 'u', role: 'user', content: 'Hi' }],
      tools: [],
      forwardedProps: {},
    };
    await lastValueFrom(agent.run(input).pipe(toArray()));
    workspace.team.setDelegates(lead.id, [scout.id]);
    await lastValueFrom(agent.run({ ...input, runId: 'r2' }).pipe(toArray()));
    const names = (index: number) =>
      (requests[index].tools ?? []).map((tool) => tool.function.name);
    expect(names(0)).not.toContain('delegate_to_dot');
    expect(names(1)).toEqual(
      expect.arrayContaining(['delegate_to_dot', 'check_delegation']),
    );
    expect(JSON.stringify(requests[1].messages)).toContain(
      'Scout (Research partner. Cite sources.)',
    );
  });
});

describe('team API', () => {
  it('saves teammates, refuses unknown ones, and lists hand-offs', async () => {
    const { store, workspace, lead, scout } = setup();
    const platform = new Platform(store, workspace, config);
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      platform,
    });
    const put = (delegateIds: string[], id = lead.id) =>
      app.request(`/api/dots/${id}/team`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegateIds }),
      });
    expect((await put([scout.id])).status).toBe(200);
    expect(
      await (await app.request(`/api/dots/${lead.id}/team`)).json(),
    ).toEqual({ delegateIds: [scout.id], implied: [] });
    expect((await put([lead.id])).status).toBe(400);
    expect((await put(['missing'])).status).toBe(400);
    expect((await put([], 'nope')).status).toBe(404);
    platform.team.delegate({
      fromDotId: lead.id,
      threadId: 'lead-thread',
      to: 'Scout',
      brief: 'Research the launch.',
      deliverable: 'Notes.',
    });
    const listed = (await (
      await app.request('/api/conversations/lead-thread/delegations')
    ).json()) as { delegations: unknown[] };
    expect(listed.delegations).toHaveLength(1);
  });
});
