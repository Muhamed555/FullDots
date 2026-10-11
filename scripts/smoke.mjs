// Starts FullDots the way a contributor (`npm run dev`) or a deployment (`npm start`) does and
// checks that it answers. Used by CI on Linux, Windows and macOS.
//
//   node scripts/smoke.mjs dev     # API on 4310 and Vite on 5173, including the /api proxy
//   node scripts/smoke.mjs start   # the built app (run `npm run build` first; honours PORT)
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mode = process.argv[2] ?? 'dev';
// `npm start` honours PORT; the dev setup is fixed to 4310 and 5173 by vite.config.ts.
const port = process.env.PORT ?? '4310';
const checks = {
  dev: [
    ['API', 'http://127.0.0.1:4310/api/state', 'application/json'],
    ['web app', 'http://127.0.0.1:5173/', 'text/html'],
    [
      'API through the Vite proxy',
      'http://127.0.0.1:5173/api/state',
      'application/json',
    ],
  ],
  start: [
    ['API', `http://127.0.0.1:${port}/api/state`, 'application/json'],
    ['web app', `http://127.0.0.1:${port}/`, 'text/html'],
  ],
}[mode];
if (!checks) {
  console.error(`Unknown mode "${mode}". Use "dev" or "start".`);
  process.exit(2);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'fulldots-smoke-'));
const child = spawn(`npm run ${mode}`, {
  shell: true,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DATABASE_PATH: path.join(dataDir, 'smoke.sqlite'),
    COPILOTKIT_TELEMETRY_DISABLED: 'true',
    DO_NOT_TRACK: '1',
  },
});
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));
let exited = false;
child.on('exit', () => (exited = true));

function stop() {
  if (exited) return;
  try {
    if (process.platform === 'win32')
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

async function waitFor([name, url, type]) {
  const deadline = Date.now() + 120_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    if (exited)
      throw new Error(`"npm run ${mode}" exited before ${name} answered.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && contentType.includes(type)) return;
      last = `HTTP ${response.status} ${contentType}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${name} at ${url} did not answer in time (last: ${last}).`);
}

let failed = false;
try {
  for (const check of checks) {
    await waitFor(check);
    console.log(`ok  ${check[0]}  ${check[1]}`);
  }
} catch (error) {
  failed = true;
  console.error(`FAIL  ${error instanceof Error ? error.message : error}`);
  console.error(`--- output of "npm run ${mode}" ---\n${output.slice(-6_000)}`);
} finally {
  stop();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  rmSync(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500,
  });
}
process.exit(failed ? 1 : 0);
