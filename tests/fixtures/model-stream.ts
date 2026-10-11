export function completion(
  delta: Record<string, unknown>,
  finishReason = 'stop',
  /** The final usage chunk OpenAI-compatible providers send with `stream_options.include_usage`. */
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number },
) {
  const chunks: Record<string, unknown>[] = [
    {
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'custom-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'custom-model',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    },
  ];
  if (usage)
    chunks.push({
      id: 'completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'custom-model',
      choices: [],
      usage: {
        ...usage,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    });
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}
