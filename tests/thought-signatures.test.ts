import { describe, expect, it } from 'vitest';
import {
  FALLBACK_THOUGHT_SIGNATURE,
  ThoughtSignatures,
  addThoughtSignatures,
  captureThoughtSignatures,
  isGeminiEndpoint,
} from '../src/server/thought-signatures.js';
import { providerFetch } from '../src/server/model-providers.js';
import { modelPreset } from '../src/shared/model-presets.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';

const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const toolCallChunk = (signature?: string) => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'list_spaces', arguments: '{}' },
            ...(signature
              ? { extra_content: { google: { thought_signature: signature } } }
              : {}),
          },
        ],
      },
    },
  ],
});
const followUp = (ids: string[]) =>
  JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    messages: [
      { role: 'user', content: 'How many spaces?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: ids.map((id) => ({
          id,
          type: 'function',
          function: { name: 'list_spaces', arguments: '{}' },
        })),
      },
      ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: '[]' })),
    ],
  });
const signaturesIn = (body: string) =>
  JSON.parse(body).messages[1].tool_calls.map(
    (call: { extra_content?: { google?: { thought_signature?: string } } }) =>
      call.extra_content?.google?.thought_signature,
  );

describe('Gemini thought signatures', () => {
  it('recognises Gemini by preset or URL', () => {
    expect(isGeminiEndpoint('gemini', 'https://x.example')).toBe(true);
    expect(isGeminiEndpoint('custom', GEMINI)).toBe(true);
    expect(isGeminiEndpoint('openai', 'https://api.openai.com/v1')).toBe(false);
  });

  it('remembers signatures from a stream and passes the stream through unchanged', async () => {
    const cache = new ThoughtSignatures();
    const original = sse([toolCallChunk('sig-real')]);
    const text = await captureThoughtSignatures(original.clone(), cache).text();
    expect(text).toBe(await original.text());
    expect(cache.get('call_1')).toBe('sig-real');
  });

  it('reads a signature that arrives in a later chunk for the same call', async () => {
    const cache = new ThoughtSignatures();
    const later = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                extra_content: { google: { thought_signature: 'sig-late' } },
              },
            ],
          },
        },
      ],
    };
    await captureThoughtSignatures(sse([toolCallChunk(), later]), cache).text();
    expect(cache.get('call_1')).toBe('sig-late');
  });

  it('reads signatures from a plain JSON response too', async () => {
    const cache = new ThoughtSignatures();
    const body = JSON.stringify(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_9',
                  extra_content: { google: { thought_signature: 'sig-json' } },
                },
              ],
            },
          },
        ],
      },
      null,
      2,
    );
    await captureThoughtSignatures(
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      cache,
    ).text();
    expect(cache.get('call_9')).toBe('sig-json');
  });

  it('puts the remembered signature back, and the placeholder when it is unknown', () => {
    const cache = new ThoughtSignatures();
    cache.remember('call_1', 'sig-real');
    const body = addThoughtSignatures(
      followUp(['call_1', 'call_2']),
      cache,
    ) as string;
    expect(signaturesIn(body)).toEqual([
      'sig-real',
      FALLBACK_THOUGHT_SIGNATURE,
    ]);
    // A request without tool calls is left exactly as it was.
    const plain = JSON.stringify({
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(addThoughtSignatures(plain, cache)).toBe(plain);
  });

  it('round-trips through the provider fetch for Gemini only', async () => {
    const sent: string[] = [];
    const fake = async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return sent.length === 1
        ? sse([toolCallChunk('sig-from-gemini')])
        : sse([{ choices: [{ index: 0, delta: { content: 'Two.' } }] }]);
    };
    const gemini = providerFetch(modelPreset('gemini')!, GEMINI, {
      fetch: fake as typeof fetch,
    });
    await (
      await gemini(`${GEMINI}/chat/completions`, {
        method: 'POST',
        body: '{"messages":[]}',
      })
    ).text();
    // The library sends the tool call back without its signature; the fetch restores it.
    await (
      await gemini(`${GEMINI}/chat/completions`, {
        method: 'POST',
        body: followUp(['call_1']),
      })
    ).text();
    expect(signaturesIn(sent[1])).toEqual(['sig-from-gemini']);

    const other = providerFetch(
      modelPreset('openai')!,
      'https://api.openai.com/v1',
      {
        fetch: fake as typeof fetch,
      },
    );
    await other('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: followUp(['call_1']),
    });
    expect(signaturesIn(sent[2])).toEqual([undefined]);
  });
});
