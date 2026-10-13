// P6 client: desktop notification text, the tab title, and server rendering of the Inbox and
// Mission control views.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  needsYouEvents,
  newSince,
  notificationFor,
  type NotificationState,
} from '../src/client/inbox/notifications';
import { InboxView, NotificationSwitch } from '../src/client/inbox/InboxView';
import { needsYouTitle } from '../src/client/inbox/useInbox';
import {
  activityLine,
  budgetShare,
  MissionView,
} from '../src/client/mission/MissionView';
import type {
  InboxItem,
  InboxResponse,
  MissionDot,
  MissionResponse,
} from '../src/shared/inbox';
import type {
  Approval,
  ConversationSummary,
  Dot,
  Handoff,
} from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const PROMPT = 'SECRET-PROMPT-TEXT';
const ARGS = 'rm -rf /SECRET-ARGS';
const QUESTION = 'SECRET-QUESTION-TEXT';
const RESULT = 'SECRET-RESULT-TEXT';

const dot = {
  id: 'dot-1',
  name: 'Scout',
  color: 'mint',
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  instructions: '',
} as unknown as Dot;
const chat = {
  id: 'thread-1',
  dotId: 'dot-1',
  ownerId: 'owner',
  title: 'Venue hunt',
  createdAt: 1,
  updatedAt: 1,
  empty: false,
} as ConversationSummary;

const approval: Approval = {
  id: 'a1',
  threadId: 'thread-1',
  dotId: 'dot-1',
  toolCallId: 'c1',
  tool: 'computer_exec',
  argsHash: 'h',
  summary: `Scout wants to run ${PROMPT}`,
  argsRedacted: ARGS,
  status: 'pending',
  note: null,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  decidedAt: null,
  consumedAt: null,
};
const handoff: Handoff = {
  id: 'h1',
  dotId: 'dot-1',
  threadId: 'thread-1',
  kind: 'credential',
  reason: `Sign in to ${PROMPT}`,
  status: 'waiting',
  createdAt: Date.now(),
  finishedAt: null,
  controlRequestId: null,
};
const item = (patch: Partial<InboxItem>): InboxItem => ({
  id: 'q1',
  kind: 'question',
  dotId: 'dot-1',
  threadId: 'thread-1',
  teamRunId: null,
  title: 'Scout has a question',
  text: QUESTION,
  createdAt: Date.now(),
  readAt: null,
  archivedAt: null,
  answer: null,
  answeredAt: null,
  ...patch,
});
const inbox: InboxResponse = {
  counts: {
    approvals: 1,
    handoffs: 1,
    questions: 1,
    results: 1,
    unread: 1,
    needsYou: 3,
  },
  approvals: [approval],
  handoffs: [handoff],
  questions: [item({})],
  results: [
    item({
      id: 'r1',
      kind: 'result',
      title: 'Scout finished a scheduled task',
      text: RESULT,
    }),
  ],
};

const state = (patch: Partial<NotificationState> = {}): NotificationState => ({
  permission: 'granted',
  focused: false,
  dotName: (id) => (id === 'dot-1' ? 'Scout' : undefined),
  ...patch,
});

describe('desktop notifications', () => {
  it('names the Dot and the kind of request, and never carries prompt, argument, question or result text', () => {
    const events = needsYouEvents(inbox);
    expect(events.map((event) => event.kind)).toEqual([
      'approval',
      'handoff',
      'question',
    ]);
    const shown = events.map((event) => notificationFor(event, state()));
    expect(shown.map((notification) => notification?.title)).toEqual([
      'Scout needs your approval',
      'Your turn on the computer: Scout',
      'Scout has a question',
    ]);
    expect(shown[0]?.hash).toBe('#/approvals');
    expect(shown[2]?.hash).toBe('#/inbox');
    const text = JSON.stringify({ events, shown });
    for (const secret of [PROMPT, ARGS, QUESTION, RESULT, 'Venue hunt'])
      expect(text).not.toContain(secret);
  });

  it('stays quiet without permission and while the owner looks at that chat', () => {
    const [event] = needsYouEvents(inbox);
    expect(notificationFor(event, state({ permission: 'default' }))).toBeNull();
    expect(notificationFor(event, state({ permission: 'denied' }))).toBeNull();
    expect(
      notificationFor(event, state({ permission: 'unsupported' })),
    ).toBeNull();
    expect(
      notificationFor(
        event,
        state({ focused: true, openThreadId: 'thread-1' }),
      ),
    ).toBeNull();
    // Another chat on screen, or the same chat in a background tab, still notifies.
    expect(
      notificationFor(
        event,
        state({ focused: true, openThreadId: 'thread-2' }),
      ),
    ).not.toBeNull();
    expect(
      notificationFor(
        event,
        state({ focused: false, openThreadId: 'thread-1' }),
      ),
    ).not.toBeNull();
    expect(
      notificationFor(event, state({ dotName: () => undefined }))?.title,
    ).toBe('A Dot needs your approval');
  });

  it('announces only items that appear after the first load', () => {
    const events = needsYouEvents(inbox);
    expect(newSince(undefined, events)).toEqual([]);
    const seen = new Set(['approval:a1', 'handoff:h1']);
    expect(newSince(seen, events).map((event) => event.id)).toEqual(['q1']);
  });

  it('asks for permission only through a button', () => {
    const html = renderToStaticMarkup(<NotificationSwitch initial="default" />);
    expect(html).toContain('Enable desktop notifications');
    expect(html).toContain('<button');
    expect(
      renderToStaticMarkup(<NotificationSwitch initial="granted" />),
    ).toContain('Desktop notifications on');
    expect(
      renderToStaticMarkup(<NotificationSwitch initial="unsupported" />),
    ).toBe('');
  });
});

it('puts the needs-you count in the tab title', () => {
  expect(needsYouTitle(0)).toBe('FullDots');
  expect(needsYouTitle(3)).toBe('(3) FullDots');
  expect(needsYouTitle(250)).toBe('(99+) FullDots');
});

const noop = async () => {};
const renderInbox = (data?: InboxResponse) =>
  renderToStaticMarkup(
    <InboxView
      inbox={data}
      dots={[dot]}
      conversations={[chat]}
      onDecide={noop}
      onOpenThread={() => {}}
      onOpenComputer={() => {}}
      onTakeOver={noop}
      onDismissHandoff={noop}
      onAnswer={noop}
      onArchive={noop}
      onRead={noop}
      notifications={<span>switch</span>}
    />,
  );

describe('Inbox view', () => {
  it('renders the four sections with their items and actions', () => {
    const html = renderInbox(inbox);
    expect(html).toContain('<h1>Inbox</h1>');
    expect(html).toContain('3 things need you');
    for (const label of [
      'Approvals',
      'Your turn on the computer',
      'Questions',
      'Finished work',
    ])
      expect(html).toContain(label);
    expect(html).toContain('id="inbox-approvals"');
    expect(html).toContain('aria-label="Inbox sections"');
    // Approvals reuse the approval card.
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Deny<');
    // Handoffs offer taking over from here.
    expect(html).toContain('Take over here');
    expect(html).toContain('Decline');
    // Questions: an answer box and Skip.
    expect(html).toContain(QUESTION);
    expect(html).toContain('Your answer');
    expect(html).toContain('Send answer');
    expect(html).toContain('Skip');
    // Finished work: unread, open, mark read, archive.
    expect(html).toContain(RESULT);
    expect(html).toContain('>New<');
    expect(html).toContain('Open chat');
    expect(html).toContain('Mark read');
    expect(html).toContain('Archive');
    expect(html).toContain('in Venue hunt');
    expect(html).toContain('Scout');
  });

  it('shows an all-clear state when nothing is there, and a loading line before the first load', () => {
    const empty: InboxResponse = {
      counts: {
        approvals: 0,
        handoffs: 0,
        questions: 0,
        results: 0,
        unread: 0,
        needsYou: 0,
      },
      approvals: [],
      handoffs: [],
      questions: [],
      results: [],
    };
    const html = renderInbox(empty);
    expect(html).toContain('All caught up');
    expect(html).toContain('Nothing needs you right now');
    expect(html).not.toContain('Inbox sections');
    expect(renderInbox(undefined)).toContain('Looking for anything');
  });

  it('marks a read result without the New chip or Mark read', () => {
    const html = renderInbox({
      ...inbox,
      approvals: [],
      handoffs: [],
      questions: [],
      results: [item({ id: 'r2', kind: 'result', text: 'Done.', readAt: 5 })],
    });
    expect(html).not.toContain('>New<');
    expect(html).not.toContain('Mark read');
    expect(html).toContain('Archive');
  });
});

const missionDot = (patch: Partial<MissionDot>): MissionDot => ({
  id: 'dot-1',
  name: 'Scout',
  color: 'mint',
  paused: false,
  state: 'idle',
  activity: null,
  threadId: 'thread-1',
  queued: 0,
  waiting: { approvals: 0, handoffs: 0, questions: 0, total: 0 },
  usage: { today: 0, budget: null },
  ...patch,
});

describe('Mission control view', () => {
  const mission: MissionResponse = {
    dots: [
      missionDot({
        state: 'working',
        queued: 2,
        activity: {
          threadId: 'thread-1',
          threadTitle: 'Venue hunt',
          source: 'task',
          startedAt: 1,
          step: 'navigate · Pricing',
        },
        usage: { today: 8500, budget: 10_000 },
      }),
      missionDot({
        id: 'dot-2',
        name: 'Writer',
        color: 'coral',
        state: 'needs-input',
        waiting: { approvals: 1, handoffs: 0, questions: 2, total: 3 },
      }),
      missionDot({
        id: 'dot-3',
        name: 'Clerk',
        paused: true,
        state: 'paused',
      }),
    ],
    groups: [
      { id: 'all', label: 'Your Dots', dotIds: ['dot-1', 'dot-2', 'dot-3'] },
    ],
    allPaused: false,
    generatedAt: 1,
  };
  const html = renderToStaticMarkup(
    <MissionView
      mission={mission}
      onOpenChat={() => {}}
      onTogglePause={() => {}}
      onStop={() => {}}
      onOpenInbox={() => {}}
    />,
  );

  it('renders a card per Dot with its live character, activity, queue, waits and tokens', () => {
    expect(html).toContain('<h1>Mission control</h1>');
    expect(html).toContain('1 Dot working · 3 waiting on you');
    expect(html).toContain('Your Dots');
    expect(html).toContain('dot-figure working');
    expect(html).toContain('dot-figure needs-input');
    expect(html).toContain('dot-figure paused');
    expect(html).toContain('In “Venue hunt” · navigate · Pricing');
    expect(html).toContain('Scheduled task');
    expect(html).toContain('2 queued tasks');
    expect(html).toContain('3 waiting on you');
    expect(html).toContain('Waiting for you: 1 approval, 2 questions');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="8500"');
    expect(html).toContain('mission-bar is-near');
    expect(html).toContain('no budget');
    expect(html).toContain('>Resume<');
    expect(html).toContain('>Pause<');
    expect(html).toContain('Open chat');
  });

  it('only lets a working Dot be stopped', () => {
    const stops = html.match(
      /<button[^>]*>(?:(?!<\/button>).)*Stop<\/button>/g,
    );
    expect(stops).toHaveLength(3);
    expect(stops!.filter((button) => button.includes('disabled'))).toHaveLength(
      2,
    );
  });

  it('describes activity and budget share', () => {
    expect(activityLine(missionDot({}))).toBe('Ready when you are');
    expect(activityLine(missionDot({ queued: 1 }))).toBe(
      'Up next: its queued work',
    );
    expect(activityLine(missionDot({ state: 'paused', paused: true }))).toMatch(
      /^Paused/,
    );
    expect(budgetShare({ today: 50, budget: 100 })).toBe(0.5);
    expect(budgetShare({ today: 500, budget: 100 })).toBe(1);
    expect(budgetShare({ today: 500, budget: null })).toBeNull();
  });
});
