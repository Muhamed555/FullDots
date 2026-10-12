// Gemini 3 models (through Google's OpenAI-compatible API) attach a `thought_signature` to every tool
// call (`extra_content.google.thought_signature`) and refuse the next request with a 400 when the
// call comes back without it. The model library drops that field, so the provider fetch keeps the
// signatures it sees in responses and puts them back on the tool calls of later requests. A call
// whose signature is unknown (for example after a restart) gets Google's documented placeholder.

/** Google's documented value for tool calls whose real signature is not available. */
export const FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const MAX_REMEMBERED = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Tool call id to signature, most recent last; process-wide so it survives across turns. */
export class ThoughtSignatures {
  private byId = new Map<string, string>();
  remember(id: string, signature: string) {
    this.byId.delete(id);
    this.byId.set(id, signature);
    if (this.byId.size > MAX_REMEMBERED)
      this.byId.delete(this.byId.keys().next().value!);
  }
  get(id: string): string | undefined {
    return this.byId.get(id);
  }
  get size() {
    return this.byId.size;
  }
}

export const thoughtSignatures = new ThoughtSignatures();

/** Whether a provider endpoint is Google's Gemini API (preset or custom URL). */
export function isGeminiEndpoint(presetId: string, baseUrl: string): boolean {
  if (presetId === 'gemini') return true;
  try {
    return new URL(baseUrl).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

const signatureOf = (call: Record<string, unknown>): string | undefined => {
  const extra = call.extra_content;
  if (!isRecord(extra) || !isRecord(extra.google)) return undefined;
  const value = extra.google.thought_signature;
  return typeof value === 'string' && value ? value : undefined;
};

/** Puts a signature on every assistant tool call of a chat request that lacks one. */
export function addThoughtSignatures(
  body: unknown,
  cache: ThoughtSignatures = thoughtSignatures,
): unknown {
  if (typeof body !== 'string') return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return body;
  let changed = false;
  for (const message of parsed.messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || signatureOf(call)) continue;
      const signature =
        (typeof call.id === 'string' && cache.get(call.id)) ||
        FALLBACK_THOUGHT_SIGNATURE;
      const extra = isRecord(call.extra_content) ? call.extra_content : {};
      const google = isRecord(extra.google) ? extra.google : {};
      call.extra_content = {
        ...extra,
        google: { ...google, thought_signature: signature },
      };
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : body;
}

/** Remembers the signatures in one parsed response chunk (streamed delta or whole message). */
function rememberFrom(
  chunk: unknown,
  cache: ThoughtSignatures,
  idsByIndex: Map<number, string>,
) {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return;
  for (const choice of chunk.choices) {
    if (!isRecord(choice)) continue;
    const holder = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : undefined;
    if (!holder || !Array.isArray(holder.tool_calls)) continue;
    holder.tool_calls.forEach((call: unknown, position: number) => {
      if (!isRecord(call)) return;
      const index = typeof call.index === 'number' ? call.index : position;
      if (typeof call.id === 'string' && call.id)
        idsByIndex.set(index, call.id);
      const signature = signatureOf(call);
      const id = idsByIndex.get(index);
      if (signature && id) cache.remember(id, signature);
    });
  }
}

/**
 * Passes a provider response through unchanged while noting the tool call signatures in it, for
 * both streamed (`text/event-stream`) and plain JSON responses.
 */
export function captureThoughtSignatures(
  response: Response,
  cache: ThoughtSignatures = thoughtSignatures,
): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  const idsByIndex = new Map<number, string>();
  const streamed = (response.headers.get('content-type') ?? '').includes(
    'event-stream',
  );
  let buffer = '';
  const scanLine = (line: string) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!data || data === '[DONE]' || !data.startsWith('{')) return;
    try {
      rememberFrom(JSON.parse(data), cache, idsByIndex);
    } catch {
      // A partial or unrelated line; nothing to remember.
    }
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        // A plain JSON response is one document: read it whole at the end.
        if (!streamed) return;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) scanLine(line);
      },
      flush() {
        buffer += decoder.decode();
        // A plain JSON response arrives as one document rather than lines.
        if (buffer.trim()) scanLine(buffer.replace(/\n/g, ' '));
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
