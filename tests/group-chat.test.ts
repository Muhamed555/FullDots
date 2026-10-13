// P2 group chats: participants on every entry path, owner-addressed turns, the baton tool, the relay
// cap, and mentions in model or tool text staying inert.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { DotAgent, turnOrigin } from '../src/server/dot-agent.js';
import {
  dotTurnsInARow,
  GroupChat,
  DEFAULT_RELAY_MAX,
} from '../src/server/group-chat.js';
import { runThreadTurn } from '../src/server/headless.js';
import { readIntegrationSettings } from '../src/server/limits.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { validateRuntimeScope } from '../src/server/runtime-scope.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { LiveEventMap } from '../src/shared/live-events.js';
import { completion } from './fixtures/model-stream.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};
const calls = (
  ...list: { id: string; name: string; args: Record<string, unknown> }[]
) =>
  completion(
    {
      role: 'assistant',
      tool_calls: list.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    'tool_calls',
  );
const text = (content: string) => completion({ role: 'assistant', content });

class ReplyAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `reply-${input.runId}`;
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Done.' },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

/** A host Dot, Writer and Scout, one conversation, a Platform and the HTTP app over it. */
function rig() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, config);
  const research = { mode: 'sample' as const, baseUrl: '' };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const space = workspace.spaces()[0].id;
  const host = workspace.dots()[0];
  const writer = workspace.createDot(
    space,
    'Writer',
    'Writes the copy.',
    true,
    true,
  );
  const scout = workspace.createDot(space, 'Scout', 'Finds facts.', true, true);
  workspace.bindThread('room', host.id, 'Room');
  // Model replies, in order; a reply may wait on a promise to keep a turn running.
  const queue: Array<() => Response | Promise<Response>> = [];
  const requests: { tools?: { function: { name: string } }[] }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).startsWith('https://unused.invalid'))
      return new Response('{}');
    requests.push(JSON.parse(String(init?.body)));
    const reply = queue.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply();
  });
  const started: LiveEventMap['turn.started'][] = [];
  platform.events.subscribe('turn.started', (event) => started.push(event));
  const finished = (dotId?: string) =>
    new Promise<LiveEventMap['turn.finished']>((resolve) => {
      const off = platform.events.subscribe('turn.finished', (event) => {
        if (dotId && event.dotId !== dotId) return;
        off();
        resolve(event);
      });
    });
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const messages = () => platform.runner.getThreadMessages('room');
  const toolNames = (index: number) =>
    (requests[index]?.tools ?? []).map((tool) => tool.function.name);
  return {
    store,
    workspace,
    platform,
    host,
    writer,
    scout,
    queue,
    requests,
    started,
    finished,
    request,
    messages,
    toolNames,
  };
}

const signal = () => new AbortController().signal;

describe('participants', () => {
  it('lets the host or a participant act in a thread, and nobody else', () => {
    const { workspace, host, writer } = rig();
    expect(workspace.requireThread('room', host.id).dotId).toBe(host.id);
    expect(() => workspace.requireThread('room', writer.id)).toThrow(
      'does not belong',
    );
    workspace.participants.add('room', writer.id);
    expect(workspace.requireThread('room', writer.id).dotId).toBe(host.id);
    expect(workspace.threadMembers('room')).toEqual([host.id, writer.id]);
    workspace.participants.remove('room', writer.id);
    expect(() => workspace.requireThread('room', writer.id)).toThrow();
  });

  it('refuses a non-participant on the CopilotKit run, connect and stop routes', () => {
    const { workspace, writer } = rig();
    const check = (path: string, body: unknown) => () =>
      validateRuntimeScope(
        new Request(`http://localhost/api/copilotkit${path}`, {
          method: 'POST',
        }),
        workspace,
        body,
      );
    const routes: [string, unknown][] = [
      [`/agent/${writer.id}/run`, { threadId: 'room' }],
      [`/agent/${writer.id}/connect`, { threadId: 'room' }],
      [`/agent/${writer.id}/stop/room`, {}],
    ];
    for (const [path, body] of routes) expect(check(path, body)).toThrow();
    workspace.participants.add('room', writer.id);
    for (const [path, body] of routes) expect(check(path, body)).not.toThrow();
  });

  it("keeps the host as the thread's agent when a participant's run is stored", async () => {
    const { platform, workspace, host, writer } = rig();
    await runThreadTurn(
      platform.runner,
      new ReplyAgent({ agentId: host.id }),
      'room',
      'Hello.',
      signal(),
    );
    workspace.participants.add('room', writer.id);
    await runThreadTurn(
      platform.runner,
      new ReplyAgent({ agentId: writer.id }),
      'room',
      'Writer, go.',
      signal(),
    );
    const thread = platform.runner
      .listThreads()
      .find((item) => item.id === 'room');
    expect(thread?.agentId).toBe(host.id);
    expect(Object.values(platform.runner.authors('room')).sort()).toEqual(
      [host.id, writer.id].sort(),
    );
  });

  it('refuses a non-participant on the headless path (DotAgent and turnAs) and runs a participant', async () => {
    const f = rig();
    const runner = new SqliteAgentRunner(':memory:');
    cleanups.push(() => runner.close());
    await expect(
      runThreadTurn(
        runner,
        new DotAgent(f.store, f.workspace, config, f.writer.id),
        'room',
        'Hi.',
        signal(),
      ),
    ).rejects.toThrow('does not belong');
    await expect(
      f.platform.turnAs('room', f.writer.id, 'Hi.', signal()),
    ).rejects.toThrow('does not belong');
    expect(f.requests).toHaveLength(0);

    f.workspace.participants.add('room', f.writer.id);
    f.queue.push(() => text('Writer here.'));
    expect(await f.platform.turnAs('room', f.writer.id, 'Hi.', signal())).toBe(
      'Writer here.',
    );
    const reply = f.messages().find((m) => m.role === 'assistant')!;
    expect(f.platform.runner.authors('room')[reply.id]).toBe(f.writer.id);
  });

  it('gives up a resume marker of a Dot that is not in the thread, and delivers one that is', async () => {
    const f = rig();
    f.platform.resumes.start();
    f.platform.resumes.enqueue({
      kind: 'relay',
      refId: 'r1',
      threadId: 'room',
      dotId: f.writer.id,
      prompt: 'Your turn.',
      source: 'relay',
    });
    await vi.waitFor(() => expect(f.workspace.resumes.all()).toEqual([]));
    expect(f.requests).toHaveLength(0);
    expect(f.messages()).toEqual([]);

    f.workspace.participants.add('room', f.writer.id);
    f.queue.push(() => text('On it.'));
    const done = f.finished(f.writer.id);
    f.platform.resumes.enqueue({
      kind: 'relay',
      refId: 'r2',
      threadId: 'room',
      dotId: f.writer.id,
      prompt: 'Your turn.',
      source: 'relay',
    });
    await done;
    await vi.waitFor(() => expect(f.workspace.resumes.all()).toEqual([]));
    const reply = f.messages().find((m) => m.role === 'assistant')!;
    expect(f.platform.runner.authors('room')[reply.id]).toBe(f.writer.id);
  });
});

describe('routes', () => {
  it('adds, lists and removes participants, and lists them with the conversations', async () => {
    const f = rig();
    const added = await f.request('/conversations/room/participants', 'POST', {
      dotId: f.writer.id,
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      hostId: f.host.id,
      participants: [{ dotId: f.writer.id }],
      running: null,
    });
    // The host is not a participant of its own chat; unknown Dots are refused.
    expect(
      (
        await f.request('/conversations/room/participants', 'POST', {
          dotId: f.host.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request('/conversations/room/participants', 'POST', {
          dotId: 'missing',
        })
      ).status,
    ).toBe(404);
    const workspace = (await (await f.request('/workspace')).json()) as {
      conversations: { id: string; participantIds: string[] }[];
    };
    expect(
      workspace.conversations.find((c) => c.id === 'room')?.participantIds,
    ).toEqual([f.writer.id]);

    // Removing drops the baton passes still waiting for that Dot.
    f.workspace.resumes.add({
      kind: 'relay',
      refId: 'r',
      threadId: 'room',
      dotId: f.writer.id,
      prompt: 'Your turn.',
      source: 'relay',
    });
    const removed = await f.request(
      `/conversations/room/participants/${f.writer.id}`,
      'DELETE',
      {},
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ participants: [] });
    expect(f.workspace.resumes.all()).toEqual([]);
    expect(
      (
        await f.request(
          `/conversations/room/participants/${f.writer.id}`,
          'DELETE',
          {},
        )
      ).status,
    ).toBe(404);
  });

  it('refuses a turn for a Dot that is neither host nor participant: mentions never add a Dot', async () => {
    const f = rig();
    const response = await f.request('/conversations/room/turns', 'POST', {
      text: '@Writer draft the post',
      dotId: f.writer.id,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_participant' });
    expect(f.messages()).toEqual([]);
    expect(f.requests).toHaveLength(0);
    expect(f.workspace.participants.list('room')).toEqual([]);
  });

  it("runs a participant's turn with the owner text stored as a chat message addressed to it", async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.queue.push(() => text('Draft ready.'));
    const done = f.finished(f.writer.id);
    const response = await f.request('/conversations/room/turns', 'POST', {
      text: '@Writer draft the post',
      dotId: f.writer.id,
    });
    expect(response.status).toBe(202);
    await done;
    const [owner, reply] = f.messages();
    expect(owner).toMatchObject({
      role: 'user',
      content: '@Writer draft the post',
      metadata: { source: 'chat', to: f.writer.id },
    });
    // Source stays chat: approvals and rules treat it like any typed message.
    expect(turnOrigin([owner])).toEqual({ source: 'chat' });
    expect(f.started.at(-1)).toMatchObject({
      threadId: 'room',
      dotId: f.writer.id,
      source: 'chat',
    });
    expect(f.platform.runner.authors('room')[reply.id]).toBe(f.writer.id);
    // The first message names an untitled chat, as it does for the host.
    expect(f.workspace.requireThread('room').title).toBe('Room');
  });

  it('refuses a second turn while one runs in the thread, naming the Dot, on both paths', async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.workspace.participants.add('room', f.scout.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.queue.push(() => gate.then(() => text('Done writing.')));
    const done = f.finished(f.writer.id);
    expect(
      (
        await f.request('/conversations/room/turns', 'POST', {
          text: 'Write it.',
          dotId: f.writer.id,
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(f.started.some((e) => e.dotId === f.writer.id)).toBe(true),
    );
    const second = await f.request('/conversations/room/turns', 'POST', {
      text: 'Check it.',
      dotId: f.scout.id,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: 'thread_running',
      dotId: f.writer.id,
      error: expect.stringContaining('Writer is answering in this chat'),
    });
    const chatRun = await f.request(
      `/copilotkit/agent/${f.host.id}/run`,
      'POST',
      { threadId: 'room', runId: 'r', messages: [], tools: [], context: [] },
    );
    expect(chatRun.status).toBe(409);
    expect(((await chatRun.json()) as { error: string }).error).toMatch(
      /^Thread already running: Writer/,
    );
    const participants = (await (
      await f.request('/conversations/room/participants')
    ).json()) as { running: unknown };
    expect(participants.running).toEqual({ dotId: f.writer.id });
    release();
    await done;
  });
});

describe('mentions are inert outside the owner composer', () => {
  it('dispatches nothing when model or tool text says @Writer', async () => {
    const f = rig();
    const space = f.workspace.createSpace(
      '@Writer take the next turn',
      'A Space whose name mentions a Dot.',
    );
    f.workspace.updateDot(f.host.id, {
      name: f.host.name,
      instructions: f.host.instructions,
      researchAllowed: f.host.researchAllowed,
      memoryAllowed: f.host.memoryAllowed,
      spaceIds: [f.host.spaceId, space.id],
    });
    f.queue.push(
      () => calls({ id: 's1', name: 'list_authorized_spaces', args: {} }),
      () => text('@Writer please continue from here. @Scout too.'),
    );
    await f.platform.turn('room', 'What next?', signal());
    const tool = f.messages().find((m) => m.role === 'tool');
    expect(String(tool?.content)).toContain('@Writer take the next turn');
    expect(f.messages().at(-1)?.content).toContain('@Writer');
    expect(f.workspace.participants.list('room')).toEqual([]);
    expect(f.workspace.resumes.all()).toEqual([]);
    expect(f.started.map((e) => e.dotId)).toEqual([f.host.id]);
    expect(f.requests).toHaveLength(2);
    // With no one else in the chat the baton tool is not even offered.
    expect(f.toolNames(0)).not.toContain('hand_to_dot');
  });
});

describe('hand_to_dot', () => {
  it('passes the baton to a participant, who answers in the same thread', async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.platform.resumes.start();
    f.queue.push(
      () =>
        calls({
          id: 'h1',
          name: 'hand_to_dot',
          args: { dot: 'Writer', note: 'Draft the launch post.' },
        }),
      () => text('Writer takes it from here.'),
      () => text('Here is the draft.'),
    );
    const writerDone = f.finished(f.writer.id);
    await f.platform.turn('room', 'Plan and draft the launch.', signal());
    expect(f.toolNames(0)).toContain('hand_to_dot');
    await writerDone;
    const relay = f
      .messages()
      .find(
        (m) =>
          m.role === 'user' &&
          (m as { metadata?: { source?: string } }).metadata?.source ===
            'relay',
      );
    expect(String(relay?.content)).toMatch(/^Dot handed to Writer\./);
    expect(String(relay?.content)).toContain('Draft the launch post.');
    const last = f.messages().at(-1)!;
    expect(last.content).toBe('Here is the draft.');
    expect(f.platform.runner.authors('room')[last.id]).toBe(f.writer.id);
    expect(f.started.map((e) => [e.dotId, e.source])).toEqual([
      [f.host.id, 'chat'],
      [f.writer.id, 'relay'],
    ]);
  });

  it('only hands to members of this chat, never to itself', async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.queue.push(
      () =>
        calls(
          {
            id: 'h1',
            name: 'hand_to_dot',
            args: { dot: 'Scout', note: 'Dig in.' },
          },
          {
            id: 'h2',
            name: 'hand_to_dot',
            args: { dot: f.host.name, note: 'Me.' },
          },
        ),
      () => text('I could not hand over.'),
    );
    await f.platform.turn('room', 'Go.', signal());
    const results = f
      .messages()
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content));
    expect(results[0]).toContain('Scout is not in this chat');
    expect(results[0]).toContain('You can hand to: Writer');
    expect(results[1]).toContain('You already have the turn');
    expect(f.workspace.resumes.all()).toEqual([]);
  });

  it('counts against the per-turn hand-off cap shared with delegate_to_dot', async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.workspace.team.setDelegates(f.host.id, [f.scout.id]);
    const brief = {
      dot: 'Scout',
      brief: 'Research the launch dates in detail.',
      deliverable: 'Five bullets.',
    };
    f.queue.push(
      () =>
        calls(
          { id: 'd1', name: 'delegate_to_dot', args: brief },
          { id: 'd2', name: 'delegate_to_dot', args: brief },
          {
            id: 'h1',
            name: 'hand_to_dot',
            args: { dot: 'Writer', note: 'Draft.' },
          },
          {
            id: 'h2',
            name: 'hand_to_dot',
            args: { dot: 'Writer', note: 'Again.' },
          },
        ),
      () => text('Handed over.'),
    );
    await f.platform.turn('room', 'Go.', signal());
    const results = f
      .messages()
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content));
    expect(results.filter((r) => r.includes('"started":true'))).toHaveLength(2);
    expect(results.filter((r) => r.includes('"handed":true'))).toHaveLength(1);
    expect(results.at(-1)).toContain('at most 3 times per turn');
    expect(
      f.workspace.resumes.all().filter((m) => m.kind === 'relay'),
    ).toHaveLength(1);
  });

  it('asks the owner first under the "Hand work to teammates: Ask" rule', async () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.workspace.rules.set(f.host.id, { hand_off_work: 'ask' });
    f.queue.push(
      () =>
        calls({
          id: 'h1',
          name: 'hand_to_dot',
          args: { dot: 'Writer', note: 'Draft the post.' },
        }),
      () => text('Waiting for you.'),
    );
    await f.platform.turn('room', 'Go.', signal());
    expect(
      String(f.messages().find((m) => m.role === 'tool')?.content),
    ).toContain('pending_approval');
    const [row] = f.workspace.approvals.list({ status: 'pending' });
    expect(row).toMatchObject({
      tool: 'hand_to_dot',
      dotId: f.host.id,
      summary: `${f.host.name} wants to hand this chat to Writer`,
    });
    expect(row.argsRedacted).toContain('Draft the post.');
    expect(f.workspace.resumes.all()).toEqual([]);
  });
});

describe('relay cap', () => {
  const user = (source?: string) => ({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: 'x',
    ...(source ? { metadata: { source } } : {}),
  });
  const reply = { id: 'a', role: 'assistant' as const, content: 'ok' };

  it('counts Dot turns since the last owner message', () => {
    expect(dotTurnsInARow([user()])).toBe(1);
    expect(dotTurnsInARow([user(), reply, user('relay')])).toBe(2);
    // Other background turns neither count nor end the run; an owner message does.
    expect(
      dotTurnsInARow([
        user(),
        reply,
        user('relay'),
        user('approval'),
        user('relay'),
      ]),
    ).toBe(3);
    expect(dotTurnsInARow([user('relay'), user('relay'), user()])).toBe(1);
  });

  it('refuses a hand-off beyond TEAM_RELAY_MAX, counting queued passes, until the owner writes', () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    const resume = vi.fn();
    const group = new GroupChat({ workspace: f.workspace, resume });
    expect(group.relayMax).toBe(DEFAULT_RELAY_MAX);
    const hand = (messages: ReturnType<typeof user>[]) =>
      group.handTo({
        fromDotId: f.host.id,
        threadId: 'room',
        to: 'Writer',
        note: 'Your turn.',
        messages,
      });
    const chain = [user(), user('relay'), user('relay')];
    expect(hand(chain).id).toBe(f.writer.id); // turn 4 of 4
    expect(() => hand([...chain, user('relay')])).toThrow(
      'limit of 4 Dot turns in a row',
    );
    // A pass still queued counts as a turn already.
    f.workspace.resumes.add({
      kind: 'relay',
      refId: 'q',
      threadId: 'room',
      dotId: f.writer.id,
      prompt: 'Queued.',
      source: 'relay',
    });
    expect(() => hand(chain)).toThrow('limit of 4');
    // The owner writing starts a new run.
    f.workspace.resumes.all().forEach((m) => f.workspace.resumes.remove(m.id));
    expect(hand([...chain, user('relay'), user()]).id).toBe(f.writer.id);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('reads TEAM_RELAY_MAX from the environment', () => {
    expect(readIntegrationSettings({}).teamRelayMax).toBe(4);
    expect(readIntegrationSettings({ TEAM_RELAY_MAX: '2' }).teamRelayMax).toBe(
      2,
    );
    expect(() => readIntegrationSettings({ TEAM_RELAY_MAX: '0' })).toThrow();
  });
});

describe('baton to a paused Dot', () => {
  it('is refused instead of holding up the thread', () => {
    const f = rig();
    f.workspace.participants.add('room', f.writer.id);
    f.workspace.setDotPaused(f.writer.id, true);
    const resume = vi.fn();
    const group = new GroupChat({ workspace: f.workspace, resume });
    expect(() =>
      group.handTo({
        fromDotId: f.host.id,
        threadId: 'room',
        to: 'writer',
        note: 'Your turn.',
        messages: [{ id: 'u', role: 'user', content: 'Go.' }],
      }),
    ).toThrow('Writer is paused');
    expect(resume).not.toHaveBeenCalled();
  });
});
