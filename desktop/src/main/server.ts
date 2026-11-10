// Starts and stops the FullDots server: the same build the web deployment runs, in a utility
// process of its own so a busy server never freezes the window.
import { utilityProcess } from 'electron';
import type { Log } from './log';

export interface ServerOptions {
  /** resources/server-host.mjs: imports the server and listens for the stop message. */
  hostScript: string;
  /** dist/server/server/index.js */
  entry: string;
  cwd: string;
  env: Record<string, string>;
  /** Where the server will answer, e.g. http://127.0.0.1:4390 */
  origin: string;
  log: Log;
  /** Called when the server goes away without being asked to. */
  onUnexpectedExit: (code: number) => void;
  timeoutMs?: number;
}

export interface RunningServer {
  origin: string;
  stop(): Promise<void>;
}

// Generous: the first start after an install reads thousands of files a virus scanner has not
// seen yet. The boot screen says it is still starting.
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 150;
/** The server gives itself 8 s to shut down; after that it is ended for it. */
const STOP_TIMEOUT_MS = 9_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const { log } = options;
  const child = utilityProcess.fork(options.hostScript, [], {
    cwd: options.cwd,
    env: { ...options.env, FULLDOTS_SERVER_ENTRY: options.entry },
    stdio: 'pipe',
    serviceName: 'FullDots server',
  });
  let exitCode: number | undefined;
  let stopping = false;
  let ready = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exitCode = code;
      log.info(`Server exited with code ${code}.`);
      resolve();
      if (ready && !stopping) options.onUnexpectedExit(code);
    });
  });
  child.stdout?.on('data', (chunk: Buffer) => log.server(chunk));
  child.stderr?.on('data', (chunk: Buffer) => log.server(chunk));

  const stop = async () => {
    if (exitCode !== undefined) return;
    stopping = true;
    child.postMessage('shutdown');
    const timer = setTimeout(() => {
      log.warn('Server did not stop in time; ending it.');
      child.kill();
    }, STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS);
  for (;;) {
    if (exitCode !== undefined)
      throw new Error(
        `The FullDots server stopped while starting (exit code ${exitCode}).`,
      );
    if (await answers(options.origin)) break;
    if (Date.now() > deadline) {
      stopping = true;
      child.kill();
      throw new Error('The FullDots server did not answer in time.');
    }
    await sleep(POLL_MS);
  }
  ready = true;
  log.info(`Server ready on ${options.origin}.`);
  return { origin: options.origin, stop };
}
