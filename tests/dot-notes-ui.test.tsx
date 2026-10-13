// P11 client: server rendering of the Notes component (Dot dialog and chat sheet) and of the Inbox
// Memory card.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DotNotesButton,
  DotNotesSheet,
  DotNotesView,
  versionPreview,
  type DotNotesViewProps,
} from '../src/client/DotNotes';
import { InboxView } from '../src/client/inbox/InboxView';
import type { InboxItem, InboxResponse } from '../src/shared/inbox';
import type { DotNoteVersion } from '../src/shared/notes';
import type { ConversationSummary, Dot } from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const dot = {
  id: 'dot-1',
  name: 'Scout',
  color: 'mint',
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  instructions: 'Be kind.',
  researchAllowed: true,
  memoryAllowed: true,
} as unknown as Dot;
const NOW = 1_000_000_000;

const version = (patch: Partial<DotNoteVersion>): DotNoteVersion => ({
  id: 'v1',
  dotId: 'dot-1',
  text: 'Likes short answers.',
  createdAt: NOW - 5 * 60_000,
  reason: 'edit',
  ...patch,
});
const noop = () => {};
const view = (patch: Partial<DotNotesViewProps> = {}) =>
  renderToStaticMarkup(
    <DotNotesView
      dot={dot}
      loaded
      draft="I like tea."
      dirty={false}
      versions={[]}
      proposals={false}
      now={NOW}
      onDraft={noop}
      onSave={noop}
      onAskClear={noop}
      onCancelClear={noop}
      onClear={noop}
      onRestore={noop}
      onProposals={noop}
      {...patch}
    />,
  );
/** The opening tag of the button whose label contains `label`. */
const buttonTag = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`))?.[0];

describe('DotNotes', () => {
  it('shows the friendly header, the editable note, Save, Clear and the switch', () => {
    const html = view();
    expect(html).toContain('What Scout remembers about you');
    expect(html).toContain('<textarea');
    expect(html).toContain('I like tea.');
    expect(html).toContain('maxLength="8000"');
    expect(html).toContain('Save note');
    expect(html).toContain('>Clear<');
    expect(html).toContain('Let Scout propose notes');
    expect(html).toContain('wait in your Inbox');
    expect(html).toContain('nothing is saved until you click Save');
    // The switch is a real checkbox with a role, off by default.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*role="switch"/);
    expect(html).not.toMatch(/role="switch"[^>]*checked/);
    expect(html).toContain('<label class="dot-notes-label"');
  });

  it('reflects the switch, unsaved edits and a busy save', () => {
    expect(view({ proposals: true })).toMatch(/role="switch"[^>]*checked/);
    const dirty = view({ dirty: true });
    expect(dirty).toContain('Not saved yet');
    expect(buttonTag(dirty, 'Save note')).not.toContain('disabled');
    // Nothing to save: the button is disabled.
    expect(buttonTag(view(), 'Save note')).toContain('disabled');
    const saving = view({ dirty: true, busy: 'save' });
    expect(saving).toContain('Saving…');
    expect(buttonTag(saving, 'Saving…')).toContain('disabled');
  });

  it('asks before clearing, and says the old note stays in History', () => {
    const html = view({ confirming: true });
    expect(html).toContain('Clear everything Scout remembers about you?');
    expect(html).toContain('Yes, clear it');
    expect(html).toContain('Keep it');
    expect(html).not.toContain('Save note');
  });

  it('lists the history with Restore, newest first, as a disclosure', () => {
    const html = view({
      versions: [
        version({ id: 'v2', reason: 'clear', text: 'Everything it knew.' }),
        version({ id: 'v1', reason: 'proposal' }),
      ],
    });
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('History');
    expect(html.indexOf('Before you cleared it')).toBeLessThan(
      html.indexOf('Before a saved suggestion'),
    );
    expect(html).toContain('Everything it knew.');
    expect(html).toContain('5 min ago');
    expect(html.match(/Restore<\/button>/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-label="Restore this version: Everything it knew."',
    );
    expect(view()).toContain('Earlier versions show up here');
  });

  it('warns when saved memories are off for the Dot, and shows errors accessibly', () => {
    const off = view({ dot: { ...dot, memoryAllowed: false } });
    expect(off).toContain('Saved memories are off for Scout');
    expect(view()).not.toContain('Saved memories are off');
    const failed = view({ error: 'The note is full.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The note is full.');
  });

  it('keeps long versions short in the list', () => {
    expect(versionPreview('a   b\n c')).toBe('a b c');
    const long = versionPreview('x'.repeat(200), 20);
    expect(Array.from(long)).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });

  it('renders the chat header button and the sheet as a labelled modal dialog', () => {
    const button = renderToStaticMarkup(<DotNotesButton dot={dot} />);
    expect(button).toContain(
      'aria-label="Notes: what Scout remembers about you"',
    );
    expect(button).toContain('aria-haspopup="dialog"');
    const sheet = renderToStaticMarkup(
      <DotNotesSheet dot={dot} onClose={noop} />,
    );
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal="true"');
    expect(sheet).toContain('aria-label="Close notes"');
    expect(sheet).toContain('What Scout remembers about you');
  });
});

const chat = {
  id: 'thread-1',
  dotId: 'dot-1',
  ownerId: 'owner',
  title: 'Venue hunt',
  createdAt: 1,
  updatedAt: 1,
  empty: false,
} as ConversationSummary;
const proposal: InboxItem = {
  id: 'm1',
  kind: 'memory',
  dotId: 'dot-1',
  threadId: 'thread-1',
  teamRunId: null,
  title: 'Scout would like to remember something',
  text: 'Prefers metric units.',
  createdAt: Date.now(),
  readAt: null,
  archivedAt: null,
  answer: null,
  answeredAt: null,
};
const inbox = (memory: InboxItem[]): InboxResponse => ({
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
  memory,
  results: [],
});
const asyncNoop = async () => {};
const renderInbox = (data: InboxResponse) =>
  renderToStaticMarkup(
    <InboxView
      inbox={data}
      dots={[dot]}
      conversations={[chat]}
      onDecide={asyncNoop}
      onOpenThread={noop}
      onOpenComputer={noop}
      onTakeOver={asyncNoop}
      onDismissHandoff={asyncNoop}
      onAnswer={asyncNoop}
      onArchive={asyncNoop}
      onSaveNote={asyncNoop}
      onRead={asyncNoop}
      notifications={<span>switch</span>}
    />,
  );

describe('Inbox memory card', () => {
  it('shows a Memory section with the proposed line, Save and Discard', () => {
    const html = renderInbox(inbox([proposal]));
    expect(html).toContain('id="inbox-memory"');
    expect(html).toContain('Scout would like to remember:');
    expect(html).toContain('Prefers metric units.');
    expect(html).toContain('Nothing is saved until you click Save');
    expect(html).toMatch(/Save<\/button>/);
    expect(html).toMatch(/Discard<\/button>/);
    expect(html).toContain('Open conversation');
    expect(html).toContain('in Venue hunt');
    // A proposal is not a blocker: nothing is waiting on the owner.
    expect(html).toContain('Nothing needs you right now');
    expect(html).not.toContain('All caught up');
  });

  it('shows no Memory section when there is no proposal', () => {
    const html = renderInbox(inbox([]));
    expect(html).not.toContain('id="inbox-memory"');
    expect(html).toContain('All caught up');
  });
});
