import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer, type ComposerProps } from '../src/client/composer/Composer';
import {
  COMPOSER_LIMIT,
  activeTrigger,
  composeMessage,
  composerKeyAction,
  replaceToken,
} from '../src/client/composer/composer-keys';

const noop = () => {};
const STARTERS = [
  'Help me think this through',
  'Research a public page',
  'Make a plan I can follow',
];

function newChat(props: Partial<ComposerProps> = {}) {
  return renderToStaticMarkup(
    <Composer
      mode="new"
      label="Start a conversation"
      placeholder="Message Scout…"
      submitLabel="Start conversation"
      value=""
      onChange={noop}
      onSubmit={noop}
      canSubmit
      note="Text and calls, one continuing conversation"
      starters={STARTERS}
      {...props}
    />,
  );
}

function openChat(props: Partial<ComposerProps> = {}) {
  return renderToStaticMarkup(
    <Composer
      mode="chat"
      label="Message your Dot"
      placeholder="Message Scout…"
      submitLabel="Send message"
      value=""
      onChange={noop}
      onSubmit={noop}
      canSubmit
      sourceLink
      note="Text and voice, one conversation."
      {...props}
    />,
  );
}

const disabledButton = (html: string, label: string) =>
  new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled=""`).test(html);

describe('Composer SSR: new chat', () => {
  it('renders the home composer with its starter chips and the old labels', () => {
    const html = newChat();
    expect(html).toContain('class="composer fd-composer fd-composer--new"');
    expect(html).toContain('aria-label="Start a conversation"');
    expect(html).toContain('placeholder="Message Scout…"');
    expect(html).toContain(`maxLength="${COMPOSER_LIMIT}"`);
    expect(html).toContain('class="composer-bottom"');
    expect(html).toContain('Text and calls, one continuing conversation');
    expect(html).toContain('class="starter-suggestions fd-composer-chips"');
    for (const text of STARTERS) expect(html).toContain(text);
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html).not.toContain('Stop response');
    expect(html).not.toContain('Add source page link');
  });

  it('enables Start only with text and while it may send', () => {
    expect(disabledButton(newChat(), 'Start conversation')).toBe(true);
    expect(disabledButton(newChat({ value: '  ' }), 'Start conversation')).toBe(
      true,
    );
    expect(disabledButton(newChat({ value: 'hi' }), 'Start conversation')).toBe(
      false,
    );
    expect(
      disabledButton(
        newChat({ value: 'hi', canSubmit: false }),
        'Start conversation',
      ),
    ).toBe(true);
  });

  it('disables typing and the chips before setup', () => {
    const html = newChat({ disabled: true, value: 'hi' });
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html.match(/<button type="button" disabled=""/g)).toHaveLength(3);
    expect(disabledButton(html, 'Start conversation')).toBe(true);
  });
});

describe('Composer SSR: open chat', () => {
  it('renders the chat composer with the source link toggle and note', () => {
    const html = openChat({ value: 'hello' });
    expect(html).toContain(
      'class="chat-composer fd-composer fd-composer--chat"',
    );
    expect(html).toContain('class="chat-compose-row"');
    expect(html).toContain('aria-label="Message your Dot"');
    expect(html).toContain('rows="1"');
    expect(html).toContain(`maxLength="${COMPOSER_LIMIT}"`);
    expect(html).toContain('aria-label="Add source page link"');
    expect(html).toContain('aria-expanded="false"');
    // The URL field opens only after the toggle.
    expect(html).not.toContain('Source page URL');
    expect(html).toContain('Text and voice, one conversation.');
    expect(disabledButton(html, 'Send message')).toBe(false);
    expect(html).not.toContain('starter-suggestions');
  });

  it('swaps Send for Stop while a turn runs', () => {
    const html = openChat({ running: true, canSubmit: false, value: 'x' });
    expect(html).toContain('aria-label="Stop response"');
    expect(html).not.toContain('aria-label="Send message"');
  });

  it('keeps Send disabled while not connected, paused or empty', () => {
    expect(disabledButton(openChat({ value: '' }), 'Send message')).toBe(true);
    expect(
      disabledButton(
        openChat({ value: 'x', canSubmit: false }),
        'Send message',
      ),
    ).toBe(true);
  });

  it('leaves the source toggle out when not asked for', () => {
    expect(openChat({ sourceLink: false })).not.toContain(
      'Add source page link',
    );
  });
});

describe('Composer SSR: hint, count and triggers', () => {
  it('shows the keyboard hint, and the count only near the limit', () => {
    const short = openChat({ value: 'hi' });
    expect(short).toContain('<kbd>Enter</kbd> to send');
    expect(short).not.toContain('fd-composer-count');
    const near = openChat({ value: 'x'.repeat(3700) });
    expect(near).toContain(`3700 / ${COMPOSER_LIMIT}`);
    expect(near).toContain('data-level="near"');
    expect(near).toMatch(/<textarea[^>]*aria-describedby="[^"]+"/);
    expect(openChat({ value: 'x'.repeat(COMPOSER_LIMIT) })).toContain(
      'data-level="full"',
    );
  });

  it('renders a trigger popover for the token at the caret', () => {
    const triggers = [
      {
        char: '@',
        render: ({ query }: { query: string }) => (
          <ul role="listbox">
            <li>match {query}</li>
          </ul>
        ),
      },
    ];
    const html = openChat({ value: 'ask @sc', triggers });
    expect(html).toContain('class="fd-composer-popover"');
    expect(html).toContain('match sc');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toMatch(/<textarea[^>]*aria-controls="[^"]+"/);
    expect(openChat({ value: 'ask sc', triggers })).not.toContain(
      'fd-composer-popover',
    );
    expect(openChat({ value: 'ask @sc' })).not.toContain('aria-autocomplete');
  });
});

function key(init: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}) {
  return {
    key: init.key ?? 'Enter',
    shiftKey: init.shiftKey ?? false,
    nativeEvent: { isComposing: init.isComposing, keyCode: init.keyCode },
  };
}

describe('composerKeyAction', () => {
  it.each([
    ['Enter with something to send', key({}), true, 'submit'],
    ['Enter with nothing to send', key({}), false, 'hold'],
    ['Shift+Enter', key({ shiftKey: true }), true, 'none'],
    ['Enter while an IME composes', key({ isComposing: true }), true, 'none'],
    ['legacy IME Enter (keyCode 229)', key({ keyCode: 229 }), true, 'none'],
    ['any other key', key({ key: 'a' }), true, 'none'],
  ] as const)('%s', (_name, event, canSubmit, expected) => {
    expect(composerKeyAction(event, canSubmit)).toBe(expected);
  });
});

describe('trigger helpers', () => {
  const at = [{ char: '@' }];
  const slash = [{ char: '/', atStart: true }];

  it('finds the token the caret is in', () => {
    expect(activeTrigger('hi @sco', 7, at)).toEqual({
      char: '@',
      query: 'sco',
      start: 3,
      end: 7,
    });
    expect(activeTrigger('@', 1, at)).toMatchObject({ query: '', start: 0 });
    expect(activeTrigger('hi @sco and', 11, at)).toBeUndefined();
    expect(activeTrigger('mail@x', 6, at)).toBeUndefined();
    expect(activeTrigger('line\n@w', 7, at)).toMatchObject({ start: 5 });
  });

  it('honours atStart for slash commands', () => {
    expect(activeTrigger('/sum', 4, slash)).toMatchObject({ query: 'sum' });
    expect(activeTrigger('do /sum', 7, slash)).toBeUndefined();
  });

  it('replaces the token and moves the caret after it', () => {
    expect(
      replaceToken('hi @sc there', { start: 3, end: 6 }, '@Scout '),
    ).toEqual({ value: 'hi @Scout  there', caret: 10 });
  });

  it('puts the source page on its own line first', () => {
    expect(composeMessage('Summarise', '')).toBe('Summarise');
    expect(composeMessage('Summarise', 'https://a.example')).toBe(
      'From https://a.example:\n\nSummarise',
    );
  });
});
