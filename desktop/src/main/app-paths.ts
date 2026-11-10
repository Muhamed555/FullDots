// Where the desktop app keeps things, and where the server it runs lives.
import { app } from 'electron';
import path from 'node:path';

export interface AppPaths {
  /**
   * The workspace's data folder and the server's working directory. It is laid out like a
   * self-hosted checkout (`.env` and `data/`), so a folder copied from one works in the other.
   */
  home: string;
  dataDir: string;
  database: string;
  envFile: string;
  logs: string;
  settings: string;
  /** The folder holding the built server, its node_modules and the built client. */
  serverRoot: string;
  serverHost: string;
  serverEntry: string;
  clientDir: string;
}

/**
 * Chooses the profile folder. Call before the app is ready and before the single-instance lock,
 * which is keyed by it. A development run keeps its own profile so it never opens real data.
 */
export function chooseProfile(): void {
  const override = process.env.FULLDOTS_DESKTOP_HOME;
  if (override) app.setPath('userData', path.resolve(override));
  else if (!app.isPackaged)
    app.setPath('userData', path.join(app.getPath('appData'), 'FullDots Dev'));
}

export function resolvePaths(): AppPaths {
  const profile = app.getPath('userData');
  const home = path.join(profile, 'workspace');
  // Packaged: Forge copies the staged server next to the app (extraResource). Development: the
  // repository root this package sits in, after `npm run build` there.
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.resolve(app.getAppPath(), '..');
  return {
    home,
    dataDir: path.join(home, 'data'),
    database: path.join(home, 'data', 'opendots.sqlite'),
    envFile: path.join(home, '.env'),
    logs: path.join(profile, 'logs'),
    settings: path.join(profile, 'desktop-settings.json'),
    serverRoot,
    serverHost: app.isPackaged
      ? path.join(serverRoot, 'server-host.mjs')
      : path.join(app.getAppPath(), 'resources', 'server-host.mjs'),
    serverEntry: path.join(serverRoot, 'dist', 'server', 'server', 'index.js'),
    clientDir: path.join(serverRoot, 'dist', 'client'),
  };
}
