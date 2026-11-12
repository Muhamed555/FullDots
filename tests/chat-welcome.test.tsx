// A new chat's start screen: one inviting line above the message box.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatWelcome, greeting, invitation } from '../src/client/ChatWelcome';

const at = (hour: number, day = 10) => new Date(2026, 10, day, hour, 30);

describe('Start screen', () => {
  it('greets by the time of day', () => {
    expect(greeting(at(3))).toBe('Still up');
    expect(greeting(at(8))).toBe('Good morning');
    expect(greeting(at(14))).toBe('Good afternoon');
    expect(greeting(at(21))).toBe('Good evening');
  });

  it('keeps one invitation for the whole day and changes it the next', () => {
    expect(invitation(at(8))).toBe(invitation(at(22)));
    expect(invitation(at(8, 10))).not.toBe(invitation(at(8, 11)));
    expect(invitation(at(8))).toMatch(/\?$/);
  });

  it('shows only a greeting and an invitation once a model is connected', () => {
    const html = renderToStaticMarkup(
      <ChatWelcome
        dotName="Dot"
        configured
        onSettings={() => {}}
        now={at(21)}
      />,
    );
    expect(html).toContain('Good evening. Dot is here.');
    expect(html).toContain(`<h1>${invitation(at(21))}</h1>`);
    expect(html).not.toContain('<button');
  });

  it('points to Settings while no model is connected', () => {
    const onSettings = vi.fn();
    const html = renderToStaticMarkup(
      <ChatWelcome dotName="Dot" configured={false} onSettings={onSettings} />,
    );
    expect(html).toContain('Connect a model and Dot is ready.');
    expect(html).toContain('Open Settings');
  });
});
