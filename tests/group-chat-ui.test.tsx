// P2 group chat UI: the @mention popover and its keyboard, the confirm dialog, the participant strip,
// attributed bubbles and the client turn tracking.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { buildTranscriptItems } from '../src/client/chat-turns';
import { Composer } from '../src/client/composer/Composer';
import { AddDotDialog } from '../src/client/room/AddDotDialog';
import {
  MentionList,
  useMentionTrigger,
} from '../src/client/room/MentionPopover';
import { ParticipantStrip } from '../src/client/room/ParticipantStrip';
import {
  filterMentionDots,
  findMentions,
  mentionKey,
  mentionPlan,
  mentionText,
  roleLine,
} from '../src/client/room/mentions';
import { ThreadRuns, waitForTurnEnd } from '../src/client/room/turn-queue';
import { LiveEventStore } from '../src/client/useLiveEvents';
import type { Dot } from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const make = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
  id,
  spaceId: 'space',
  spaceIds: ['space'],
  name,
  instructions: `${name} role line.\nMore detail.`,
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  ...extra,
});
const host = make('host', 'Dot');
const writer = make('writer', 'Writer', { color: 'coral' });
const scout = make('scout', 'Scout');
const scoutPro = make('scout-pro', 'Scout Pro');
const dots = [host, writer, scout, scoutPro];

describe('mentions', () => {
  it('finds owner mentions in order, longest name first, case-insensitive, at word starts', () => {
    expect(findMentions('@writer and @Scout Pro, then @scout', dots)).toEqual([
      'writer',
      'scout-pro',
      'scout',
    ]);
    expect(findMentions('(@Writer) again @Writer', dots)).toEqual(['writer']);
    // Not a mention: inside a word, or a longer word than the name.
    expect(findMentions('mail me@Writer.com or @Writers', dots)).toEqual([]);
    expect(findMentions('no mentions here', dots)).toEqual([]);
  });

  it('plans turns in mention order and asks only for Dots not in the chat', () => {
    expect(mentionPlan('@Dot hello', dots, 'host', [])).toEqual({
      targets: [],
      toConfirm: [],
    });
    expect(mentionPlan('just text', dots, 'host', ['writer'])).toEqual({
      targets: [],
      toConfirm: [],
    });
    expect(
      mentionPlan('@Scout find it, @Writer draft it', dots, 'host', ['writer']),
    ).toEqual({ targets: ['scout', 'writer'], toConfirm: ['scout'] });
    expect(mentionPlan('@Writer and @Dot', dots, 'host', [])).toEqual({
      targets: ['writer', 'host'],
      toConfirm: ['writer'],
    });
  });

  it('filters by prefix first and inserts @Name', () => {
    expect(filterMentionDots(dots, 'sc').map((dot) => dot.id)).toEqual([
      'scout',
      'scout-pro',
    ]);
    expect(filterMentionDots(dots, 'pro').map((dot) => dot.id)).toEqual([
      'scout-pro',
    ]);
    expect(filterMentionDots(dots, '')).toHaveLength(4);
    expect(mentionText(writer)).toBe('@Writer ');
    expect(roleLine('  \nFirst line here.\nSecond.')).toBe('First line here.');
  });

  it('moves with Up/Down (wrapping), picks with Enter/Tab, closes with Escape', () => {
    const state = { count: 3, active: 0 };
    expect(mentionKey('ArrowDown', state)).toEqual({
      handled: true,
      active: 1,
    });
    expect(mentionKey('ArrowUp', state)).toEqual({ handled: true, active: 2 });
    expect(mentionKey('ArrowDown', { count: 3, active: 2 })).toEqual({
      handled: true,
      active: 0,
    });
    expect(mentionKey('Enter', { count: 3, active: 1 })).toEqual({
      handled: true,
      choose: 1,
    });
    expect(mentionKey('Tab', state)).toEqual({ handled: true, choose: 0 });
    expect(mentionKey('Escape', state)).toEqual({ handled: true, close: true });
    expect(mentionKey('a', state)).toEqual({ handled: false });
    expect(mentionKey('Enter', { count: 0, active: 0 })).toEqual({
      handled: false,
    });
  });
});

describe('mention popover SSR', () => {
  it('renders a listbox of Dots with character, name, role line and status', () => {
    const html = renderToStaticMarkup(
      <MentionList
        dots={[host, writer, scout]}
        active={1}
        listId="list"
        query=""
        hostId="host"
        participantIds={['writer']}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="list"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toMatch(/id="list-writer" role="option" aria-selected="true"/);
    expect(html).toMatch(/id="list-host" role="option" aria-selected="false"/);
    expect(html).toContain('Writer role line.');
    expect(html).not.toContain('More detail.');
    expect(html).toContain('Host');
    expect(html).toContain('In this chat');
    expect(html).toContain('Asks to add');
    expect(html).toContain('class="mascot idle small"');
  });

  it('says so when no Dot matches', () => {
    const html = renderToStaticMarkup(
      <MentionList
        dots={[]}
        active={0}
        listId="list"
        query="zz"
        hostId="host"
        participantIds={[]}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('No Dot is called “zz”.');
  });

  it('opens from the composer on @ with the textarea pointing at the highlighted option', () => {
    function Harness({ value }: { value: string }) {
      const trigger = useMentionTrigger({
        dots,
        hostId: 'host',
        participantIds: [],
      });
      return (
        <Composer
          mode="chat"
          label="Message your Dot"
          placeholder="Message Dot…"
          submitLabel="Send message"
          value={value}
          onChange={() => {}}
          onSubmit={() => {}}
          canSubmit
          triggers={[trigger]}
        />
      );
    }
    const html = renderToStaticMarkup(<Harness value="ask @wri" />);
    expect(html).toContain('class="fd-composer-popover"');
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    const active = html.match(/aria-activedescendant="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}" role="listbox"`);
    expect(active).toBe(`${controls}-writer`);
    expect(renderToStaticMarkup(<Harness value="ask wri" />)).not.toContain(
      'fd-composer-popover',
    );
  });
});

describe('confirm dialog SSR', () => {
  it('asks once before a Dot joins', () => {
    const html = renderToStaticMarkup(
      <AddDotDialog dot={writer} onAdd={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Add Writer to this chat?');
    expect(html).toContain('It will see the whole conversation.');
    expect(html).toMatch(/>Cancel</);
    expect(html).toMatch(/>Add</);
  });
});

describe('participant strip SSR', () => {
  it('shows the host and participants with names, a remove per participant and an add button', () => {
    const html = renderToStaticMarkup(
      <ParticipantStrip
        host={host}
        participants={[writer, scout]}
        dots={dots}
        runningDotId="writer"
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Dots in this chat"');
    expect(html.match(/class="fd-room-avatar"/g)).toHaveLength(3);
    expect(html).toContain('Dot (host)');
    expect(html).toContain('title="Writer"');
    expect(html).toContain('aria-label="Remove Writer from this chat"');
    expect(html).toContain('aria-label="Remove Scout from this chat"');
    expect(html).not.toContain('Remove Dot from this chat');
    // The Dot whose turn runs shows working and cannot be removed mid-turn.
    expect(html).toContain('Writer is working');
    expect(html).toMatch(
      /aria-label="Remove Writer from this chat"[^>]*disabled=""/,
    );
    expect(html).toContain('aria-label="Add a Dot to this chat"');
  });

  it('shows only the add button in a chat without participants', () => {
    const html = renderToStaticMarkup(
      <ParticipantStrip
        host={host}
        participants={[]}
        dots={dots}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).not.toContain('fd-room-avatar');
    expect(html).toContain('aria-label="Add a Dot to this chat"');
  });
});

describe('attributed bubbles', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      content: '@Writer draft it, @Scout check it',
      metadata: { source: 'chat', to: 'writer' },
    } as Message,
    { id: 'a1', role: 'assistant', content: 'Draft ready.' },
    {
      id: 'u2',
      role: 'user',
      content: '@Writer draft it, @Scout check it',
      metadata: { source: 'chat', to: 'scout' },
    } as Message,
    { id: 'a2', role: 'assistant', content: 'Checked.' },
    {
      id: 'u3',
      role: 'user',
      content: 'Scout handed to Writer.\n\nNote from Scout: polish it.',
      metadata: { source: 'relay', ref: 'r1' },
    } as Message,
    { id: 'a3', role: 'assistant', content: 'Polished.' },
  ];
  const byId = new Map(dots.map((dot) => [dot.id, dot]));
  const authors: Record<string, string> = {
    a1: 'writer',
    a2: 'scout',
    a3: 'writer',
  };
  const group = {
    authorOf: (id: string) => byId.get(authors[id]),
    dot: (id: string) => byId.get(id),
  };

  it("renders each reply with its author's character, name and colour", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript messages={messages} calls={[]} group={group} />,
    );
    expect(html.match(/class="fd-authored"/g)).toHaveLength(3);
    expect(html).toMatch(/data-author="writer" style="--fd-author:#[0-9a-f]+/);
    expect(html).toContain('class="fd-authored-name">Writer<');
    expect(html).toContain('class="fd-authored-name">Scout<');
    // The owner's message shows once, with who it went to.
    expect(html.match(/@Writer draft it/g)).toHaveLength(1);
    expect(html).toContain('To Writer');
    expect(html).toContain('Also to Scout');
    // The baton pass is an event line.
    expect(html).toContain('Handed over');
    expect(html).toContain('Scout handed to Writer.');
  });

  it("keeps today's look without a group", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript messages={messages.slice(0, 2)} calls={[]} />,
    );
    expect(html).not.toContain('fd-authored');
    expect(html).not.toContain('To Writer');
    expect(html).toContain('class="chat-bubble assistant"');
  });

  it('marks addressed owner messages and repeats in the transcript items', () => {
    const items = buildTranscriptItems(messages, []);
    const bubbles = items.filter((item) => item.kind === 'bubble');
    expect(bubbles[0]).toMatchObject({ role: 'user', to: 'writer' });
    expect(bubbles[0]).not.toHaveProperty('repeat');
    expect(bubbles[2]).toMatchObject({ to: 'scout', repeat: true });
    expect(bubbles[1]).toMatchObject({ role: 'assistant', messageId: 'a1' });
    expect(items.find((item) => item.kind === 'event')).toMatchObject({
      source: 'relay',
    });
  });
});

describe('thread turn tracking', () => {
  const started = (runId: string, dotId: string, threadId = 'room') => ({
    threadId,
    dotId,
    runId,
    source: 'chat' as const,
  });
  const finished = (runId: string, dotId: string, threadId = 'room') => ({
    threadId,
    dotId,
    runId,
    status: 'completed' as const,
  });

  it('is busy from turn.started until the matching turn.finished', () => {
    const runs = new ThreadRuns('room');
    expect(runs.busy).toBe(false);
    expect(runs.started(started('r1', 'writer', 'other'))).toBe(false);
    expect(runs.started(started('r1', 'writer'))).toBe(true);
    expect(runs.busy).toBe(true);
    expect(runs.dotId).toBe('writer');
    expect(runs.finished(finished('r9', 'writer'))).toBe(false);
    expect(runs.busy).toBe(true);
    expect(runs.finished(finished('r1', 'writer'))).toBe(true);
    expect(runs.busy).toBe(false);
    // A start whose finish was missed is dropped once the server says the thread is free.
    runs.started(started('r2', 'scout'), 0);
    expect(runs.settle(1000)).toBe(false);
    expect(runs.settle(10_000)).toBe(true);
    expect(runs.busy).toBe(false);
  });

  it('waits for the Dot turn to finish, by event or by poll', async () => {
    const store = new LiveEventStore({
      fetch: () => new Promise<Response>(() => {}),
    });
    const handlers: Array<(data: unknown) => void> = [];
    vi.spyOn(store, 'subscribe').mockImplementation((_channel, handler) => {
      handlers.push(handler as (data: unknown) => void);
      return () => {};
    });
    let resolved = false;
    const byEvent = waitForTurnEnd(
      'room',
      'writer',
      new AbortController().signal,
      {
        store,
        pollMs: 60_000,
        fetchView: async () => ({
          hostId: 'host',
          participants: [],
          running: { dotId: 'writer' },
        }),
      },
    ).then(() => (resolved = true));
    handlers[0](finished('r1', 'scout'));
    await Promise.resolve();
    expect(resolved).toBe(false);
    handlers[0](finished('r1', 'writer'));
    await byEvent;
    expect(resolved).toBe(true);

    await waitForTurnEnd('room', 'writer', new AbortController().signal, {
      store,
      pollMs: 5,
      fetchView: async () => ({
        hostId: 'host',
        participants: [],
        running: null,
      }),
    });

    const controller = new AbortController();
    const stopped = waitForTurnEnd('room', 'writer', controller.signal, {
      store,
      pollMs: 60_000,
    });
    controller.abort();
    await expect(stopped).rejects.toThrow('stopped');
  });
});
