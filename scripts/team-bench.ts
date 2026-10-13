// Team hand-off bench (owner-run, not part of CI): times the hand-off mechanics on this machine with
// an instant fake model, a temp database and the same Platform, runner and event feed the server
// builds. Usage: npm run bench:team [-- iterations]
//
// Measured, p50 and p95 over the iterations (one iteration = a lead handing work to three teammates):
// - hand-off start: delegate_to_dot returned -> the teammate's turn started (turn.started)
// - result return: the last teammate's turn finished -> the lead's resume turn started
// - fan-out spread: first to last of the three teammate turns starting
// - event delivery: an event emitted on the server -> read from an open GET /api/events stream
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/server/app.js';
import { wakeOnWork } from '../src/server/live-wiring.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { createBackgroundRunner } from '../src/server/task-executor.js';
import { teamTools } from '../src/server/team-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const iterations = Math.max(1, Number(process.argv[2] ?? 20) || 20);
const MODEL_URL = 'https://bench.invalid/v1';
const TOKEN = 'team-bench-owner-token-0123456789';

/** An OpenAI-compatible streamed reply with one text message, sent at once. */
function reply(content: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'bench',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'bench-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    chunk({ role: 'assistant', content }, null) +
      chunk({}, 'stop') +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

// The model library warns about tool schemas on every turn; keep the output to the table.
const print = console.log.bind(console);
for (const level of ['log', 'info', 'warn', 'debug', 'dir'] as const)
  console[level] = () => {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  String(input instanceof Request ? input.url : input).startsWith(MODEL_URL)
    ? reply('Deliverable.')
    : realFetch(input, init)) as typeof fetch;

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

function waitFor<T>(
  check: () => T | undefined,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value !== undefined) return resolve(value);
      if (performance.now() - started > timeoutMs)
        return reject(new Error(`Timed out waiting for ${what}.`));
      setTimeout(poll, 1);
    };
    poll();
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-bench-'));
  const path = join(dir, 'bench.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const config: PlatformConfig = {
    apiKey: 'bench',
    model: 'bench-model',
    baseUrl: MODEL_URL,
    voiceName: 'marin',
    webSearchProvider: 'disabled',
    ownerToken: TOKEN,
    backgroundConcurrency: 4,
    teamResultBatchMs: 1500,
  };
  const platform = new Platform(store, workspace, config, path);
  const research = { mode: 'sample' as const, baseUrl: '' };
  const runner = createBackgroundRunner(platform, research);
  const unwake = wakeOnWork(platform.events, platform.turns, runner);
  const app = createApp({
    store,
    runner,
    config: research,
    ownerToken: TOKEN,
    platform,
  });
  await platform.start();
  runner.start();

  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const members = ['Scout', 'Writer', 'Editor'].map((name) =>
    workspace.createDot(space, name, `${name} for the bench.`, true, true),
  );
  workspace.team.setDelegates(
    lead.id,
    members.map((dot) => dot.id),
  );
  workspace.bindThread('bench-lead', lead.id, 'Bench');

  // Turn events, timed as they are emitted.
  const startedByThread = new Map<string, number>();
  const finishedByThread = new Map<string, number>();
  platform.events.subscribe('turn.started', ({ threadId }) =>
    startedByThread.set(threadId, performance.now()),
  );
  platform.events.subscribe('turn.finished', ({ threadId }) =>
    finishedByThread.set(threadId, performance.now()),
  );

  const handOffStart: number[] = [];
  const resultReturn: number[] = [];
  const spread: number[] = [];
  for (let i = 0; i < iterations; i++) {
    startedByThread.delete('bench-lead');
    const [delegate] = teamTools(platform.team, {
      dotId: lead.id,
      threadId: 'bench-lead',
      runId: `bench-run-${i}`,
    });
    const execute = delegate.execute as (
      args: unknown,
    ) => Promise<{ started: boolean; id?: string; error?: string }>;
    const handed: { id: string; returnedAt: number }[] = [];
    for (const member of members) {
      const result = await execute({
        dot: member.name,
        brief: `Bench work ${i} for ${member.name}.`,
        deliverable: 'One line.',
      });
      if (!result.started || !result.id)
        throw new Error(result.error ?? 'Hand-off refused.');
      handed.push({ id: result.id, returnedAt: performance.now() });
    }
    const children = handed.map(({ id, returnedAt }) => ({
      returnedAt,
      thread: workspace.team.get(id)!.childThreadId,
    }));
    const childStarts = await Promise.all(
      children.map(({ thread }) =>
        waitFor(() => startedByThread.get(thread), 'a teammate to start'),
      ),
    );
    children.forEach(({ returnedAt }, index) =>
      handOffStart.push(childStarts[index] - returnedAt),
    );
    spread.push(Math.max(...childStarts) - Math.min(...childStarts));
    const childEnds = await Promise.all(
      children.map(({ thread }) =>
        waitFor(() => finishedByThread.get(thread), 'a teammate to finish'),
      ),
    );
    const leadStart = await waitFor(
      () => startedByThread.get('bench-lead'),
      'the lead to resume',
    );
    resultReturn.push(leadStart - Math.max(...childEnds));
    await waitFor(
      () =>
        workspace.resumes.all().length === 0 &&
        !platform.turns.isDotBusy(lead.id) &&
        (finishedByThread.get('bench-lead') ?? 0) > leadStart
          ? true
          : undefined,
      'the lead to finish',
    );
  }

  // Event delivery through the real SSE route.
  const response = await app.request('/api/events', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = '';
  const nextEvent = async (type: string) => {
    for (;;) {
      const marker = `event: ${type}\n`;
      const at = buffer.indexOf(marker);
      if (at >= 0) {
        buffer = buffer.slice(at + marker.length);
        return performance.now();
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('The event stream ended.');
      buffer += value;
    }
  };
  await nextEvent('hello');
  const delivery: number[] = [];
  for (let i = 0; i < Math.max(iterations, 50); i++) {
    const sent = performance.now();
    const received = nextEvent('inbox.changed');
    platform.events.emit('inbox.changed', {});
    delivery.push((await received) - sent);
  }
  await reader.cancel().catch(() => {});

  const rows: [string, number[], number, string][] = [
    [
      'hand-off tool return -> teammate turn started',
      handOffStart,
      300,
      'p95 < 300 ms',
    ],
    [
      'last teammate finished -> lead resume started',
      resultReturn,
      500,
      'p95 < 500 ms',
    ],
    ['3-way fan-out start spread', spread, 500, 'p95 < 500 ms'],
    ['event emitted -> read from /api/events', delivery, 500, 'p95 < 500 ms'],
  ];
  const fmt = (ms: number) => `${ms.toFixed(1)} ms`;
  const table = rows.map(([name, values, limit, target]) => ({
    measure: name,
    n: values.length,
    p50: fmt(percentile(values, 50)),
    p95: fmt(percentile(values, 95)),
    target,
    met: percentile(values, 95) < limit ? 'yes' : 'NO',
  }));
  print(`Team bench: ${iterations} iterations, fake instant model.`);
  console.log = print;
  console.table(table);

  unwake();
  runner.stop();
  await platform.stop();
  store.close();
  workspace.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return table.every((row) => row.met === 'yes');
}

main().then(
  (met) => process.exit(met ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
