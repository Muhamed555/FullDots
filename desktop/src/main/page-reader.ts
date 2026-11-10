// The page reader: the small read-only service Dots use to open public pages for search and
// research (src/browser). A web deployment runs it as a container of its own; here it is a second
// utility process, driving a browser already installed on this computer. It listens on this
// machine only, behind a secret made for this run.
import { utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import type { Log } from './log';

export interface PageReader {
  url: string;
  secret: string;
  stop(): void;
}

export function startPageReader(options: {
  /** resources/server-host.mjs */
  hostScript: string;
  /** dist/server/browser/index.js */
  entry: string;
  cwd: string;
  port: number;
  /** The installed browser to drive. */
  browserPath: string;
  log: Log;
}): PageReader {
  const { log } = options;
  const secret = randomBytes(32).toString('hex');
  const child = utilityProcess.fork(options.hostScript, [], {
    cwd: options.cwd,
    env: {
      ...(process.env as Record<string, string>),
      FULLDOTS_SERVER_ENTRY: options.entry,
      BROWSER_HOST: '127.0.0.1',
      BROWSER_PORT: String(options.port),
      BROWSER_SECRET: secret,
      BROWSER_EXECUTABLE_PATH: options.browserPath,
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
    serviceName: 'FullDots page reader',
  });
  let gone = false;
  child.once('exit', (code) => {
    gone = true;
    log.info(`Page reader exited with code ${code}.`);
  });
  child.stdout?.on('data', (chunk: Buffer) => log.server(chunk));
  child.stderr?.on('data', (chunk: Buffer) => log.server(chunk));
  log.info(`Page reader starting on port ${options.port}.`);
  return {
    url: `http://127.0.0.1:${options.port}`,
    secret,
    stop() {
      // It holds nothing to save: a browser is opened per page and closed again.
      if (!gone) child.kill();
    },
  };
}
