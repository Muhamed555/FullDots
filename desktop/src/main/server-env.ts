// The environment the bundled FullDots server starts with. Pure, so it is tested without Electron.
import { parseEnv } from 'node:util';

/** The desktop's own port, so a checkout running `npm run dev` on 4310 is left alone. */
export const DEFAULT_PORT = 4390;
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Settings the shell decides. A person's `.env` cannot change them: the window is the only client,
 * so the server always listens on this machine only, on the port the window was told to open.
 */
const SHELL_OWNED = ['HOST', 'PORT', 'APP_ORIGIN', 'NODE_ENV', 'CLIENT_DIR'];
/** Never handed down: they would change how Electron's own Node starts. */
const NEVER_INHERITED = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'];

/** `KEY=value` lines of the data folder's `.env`, the same format the web app reads. */
export function parseEnvFile(text: string): Record<string, string> {
  const parsed = parseEnv(text) as Record<string, string | undefined>;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed))
    if (typeof value === 'string' && value !== '') values[key] = value;
  return values;
}

/** The port a person asked for in `.env`, when it is one a server can listen on. */
export function preferredPort(
  userEnv: Record<string, string>,
  saved?: number,
): number {
  for (const candidate of [Number(userEnv.PORT), saved]) {
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 1024 &&
      candidate <= 65535
    )
      return candidate;
  }
  return DEFAULT_PORT;
}

export interface ServerEnvOptions {
  /** The shell's own environment (API keys exported in the person's shell still apply). */
  base: Record<string, string | undefined>;
  /** The data folder's `.env`. */
  userEnv: Record<string, string>;
  /** What the shell set up for this run (the page reader); `.env` still wins. */
  provided?: Record<string, string>;
  port: number;
  /** Absolute path of the built client (`dist/client`). */
  clientDir: string;
  /** Absolute path of the database inside the data folder. */
  databasePath: string;
  version: string;
}

export function serverEnv(options: ServerEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base))
    if (typeof value === 'string' && !NEVER_INHERITED.includes(key))
      env[key] = value;
  // Docker names a compose project after its folder; the data folder is just "workspace".
  env.COMPOSE_PROJECT_NAME ??= 'fulldots-desktop';
  Object.assign(env, options.provided);
  // The data folder's `.env` wins over the shell's environment, as `--env-file` does not; a file
  // someone edited on purpose is the clearer statement of what they want.
  for (const [key, value] of Object.entries(options.userEnv))
    if (!NEVER_INHERITED.includes(key)) env[key] = value;
  for (const key of SHELL_OWNED) delete env[key];
  return {
    ...env,
    // A relative DATABASE_PATH in `.env` still lands in the data folder: it is the server's cwd.
    DATABASE_PATH: env.DATABASE_PATH ?? options.databasePath,
    HOST: LOOPBACK_HOST,
    PORT: String(options.port),
    NODE_ENV: 'production',
    CLIENT_DIR: options.clientDir,
    FULLDOTS_DESKTOP: options.version,
  };
}
