import { describe, expect, it } from 'vitest';
import { providerFetch, retryDelay } from '../src/server/model-providers.js';
import { modelPreset } from '../src/shared/model-presets.js';
import {
  isProviderBusyMessage,
  turnErrorMessage,
} from '../src/client/chat-errors.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const busy = (headers: Record<string, string> = {}) =>
  new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', {
    status: 503,
    headers,
  });
const ok = () =>
  new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });

/** A fake provider that answers with each response in turn and counts the calls. */
function provider(...responses: (() => Response)[]) {
  const calls: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(init?.body));
    return (responses[calls.length - 1] ?? responses.at(-1)!)();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const chat = (
  fake: ReturnType<typeof provider>,
  extra: { mode?: 'list'; retryDelaysMs?: number[] } = {},
) =>
  providerFetch(modelPreset('gemini')!, GEMINI, {
    fetch: fake.fetch,
    retryDelaysMs: [0, 0, 0],
    ...extra,
  });

describe('provider retries on busy answers', () => {
  it('sends the same request again after a 503 and returns the answer that worked', async () => {
    const fake = provider(busy, busy, ok);
    const response = await chat(fake)(`${GEMINI}/chat/completions`, {
      method: 'POST',
      body: '{"messages":[]}',
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toEqual([
      '{"messages":[]}',
      '{"messages":[]}',
      '{"messages":[]}',
    ]);
  });

  it('gives up after the last retry and returns the busy answer', async () => {
    const fake = provider(busy);
    const response = await chat(fake)(`${GEMINI}/chat/completions`, {
      method: 'POST',
      body: '{"messages":[]}',
    });
    expect(response.status).toBe(503);
    expect(fake.calls).toHaveLength(4);
  });

  it('does not retry other errors, model lists, or bodies it cannot resend', async () => {
    const denied = provider(() => new Response('no', { status: 401 }));
    expect(
      (await chat(denied)(`${GEMINI}/chat/completions`, { body: '{}' })).status,
    ).toBe(401);
    expect(denied.calls).toHaveLength(1);

    const list = provider(busy, ok);
    await chat(list, { mode: 'list' })(`${GEMINI}/models`);
    expect(list.calls).toHaveLength(1);

    const stream = provider(busy, ok);
    await chat(stream)(`${GEMINI}/chat/completions`, {
      method: 'POST',
      body: new Blob(['{}']),
    });
    expect(stream.calls).toHaveLength(1);
  });

  it('stops waiting when the turn is stopped', async () => {
    const fake = provider(busy, ok);
    const controller = new AbortController();
    const pending = chat(fake, { retryDelaysMs: [60_000] })(
      `${GEMINI}/chat/completions`,
      { method: 'POST', body: '{}', signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeDefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('honours a sane Retry-After and caps a long one', () => {
    expect(retryDelay(busy({ 'retry-after': '2' }), 1500)).toBe(2000);
    expect(retryDelay(busy({ 'retry-after': '600' }), 1500)).toBe(20_000);
    expect(retryDelay(busy(), 1500)).toBe(1500);
    expect(retryDelay(busy({ 'retry-after': 'soon' }), 1500)).toBe(1500);
  });
});

describe('busy provider message in the chat', () => {
  it('explains an overloaded provider instead of showing the raw status', () => {
    for (const raw of [
      'Error: 503 status code (no body)',
      'Service unavailable.',
      '429 status code (no body)',
      'This model is currently experiencing high demand.',
    ])
      expect(isProviderBusyMessage(raw), raw).toBe(true);
    expect(turnErrorMessage('Error: 503 status code (no body)')).toMatch(
      /overloaded.*Settings → Models/,
    );
    expect(isProviderBusyMessage('401 status code (no body)')).toBe(false);
    expect(turnErrorMessage('bad key')).toBe(
      'The model could not answer: bad key',
    );
  });
});
