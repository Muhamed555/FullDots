// App updates. Windows and signed macOS builds update themselves from this repository's GitHub
// releases: Windows through electron-updater, which reads the latest.yml the setup wizard's build
// publishes and installs into the folder the person chose; macOS through Electron's updater, fed by
// update.electronjs.org. Where that cannot install for us (Linux packages, unsigned macOS builds)
// the app still looks for a newer release and offers the download page. Either way the page is
// told, and shows its own notice.
import { app, autoUpdater, net, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import type { DesktopUpdate } from '../../../src/shared/desktop-bridge';
import type { Log } from './log';
import {
  latestReleaseUrl,
  newerRelease,
  RELEASE_REPOSITORY,
  versionInName,
} from './update-feed';

export interface Updates {
  start(): void;
  state(): DesktopUpdate;
  /** Looks now; resolves with where that ended up. */
  check(): Promise<DesktopUpdate>;
  /** Restarts into a downloaded update, or opens the download page. */
  install(): Promise<void>;
}

const MANUAL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WINDOWS_INTERVAL_MS = 60 * 60 * 1000;
const [OWNER, REPO] = RELEASE_REPOSITORY.split('/');
const CHECK_TIMEOUT_MS = 45_000;
const settled = (update: DesktopUpdate) =>
  update.status !== 'checking' && update.status !== 'idle';

export function createUpdates(options: {
  version: string;
  log: Log;
  onChange: (update: DesktopUpdate) => void;
  /** Stops the server before the app quits to install. */
  beforeInstall: () => Promise<void>;
}): Updates {
  const { log, version } = options;
  let current: DesktopUpdate = { status: 'idle' };
  // Electron's updater handles Windows and macOS; a failure there (an unsigned macOS build) moves
  // this run over to the release lookup.
  let native =
    app.isPackaged &&
    (process.platform === 'win32' || process.platform === 'darwin');
  const waiting = new Set<(update: DesktopUpdate) => void>();

  const set = (next: DesktopUpdate) => {
    // A downloaded update stays offered whatever a later check says.
    if (current.status === 'ready' && next.status !== 'ready') return;
    current = next;
    options.onChange(next);
    if (settled(next)) {
      for (const resolve of waiting) resolve(next);
      waiting.clear();
    }
  };

  const lookUp = async () => {
    set({ status: 'checking' });
    try {
      const response = await net.fetch(latestReleaseUrl(), {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      const release = newerRelease(await response.json(), version);
      set(
        release ? { status: 'available', ...release } : { status: 'current' },
      );
    } catch (error) {
      log.error('Update lookup failed', error);
      set({ status: 'error', message: 'Could not check for updates.' });
    }
  };

  return {
    start() {
      if (!app.isPackaged) return;
      if (!native) {
        void lookUp();
        setInterval(() => void lookUp(), MANUAL_INTERVAL_MS).unref();
        return;
      }
      if (process.platform === 'win32') {
        // electron-updater (the NSIS setup wizard's updater). The feed is set here rather than
        // read from app-update.yml, so the packaged app needs no extra file.
        const updater = electronUpdater.autoUpdater;
        updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = true;
        updater.logger = {
          info: (message) => log.info(String(message)),
          warn: (message) => log.warn(String(message)),
          error: (message) => log.error(String(message)),
          debug: () => {},
        };
        updater.on('checking-for-update', () => set({ status: 'checking' }));
        updater.on('update-available', () => set({ status: 'downloading' }));
        updater.on('update-not-available', () => set({ status: 'current' }));
        updater.on('update-downloaded', (info) =>
          set({ status: 'ready', version: info.version }),
        );
        updater.on('error', (error) => {
          log.error('The Windows updater failed', error);
          native = false;
          void lookUp();
        });
        const look = () =>
          void updater.checkForUpdates().catch((error: unknown) => {
            log.error('Could not check for updates', error);
          });
        look();
        setInterval(look, WINDOWS_INTERVAL_MS).unref();
        return;
      }
      autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
      autoUpdater.on('update-available', () => set({ status: 'downloading' }));
      autoUpdater.on('update-not-available', () => set({ status: 'current' }));
      autoUpdater.on('update-downloaded', (_event, _notes, name) =>
        set({ status: 'ready', version: versionInName(name) }),
      );
      autoUpdater.on('error', (error) => {
        log.error('The system updater failed', error);
        native = false;
        void lookUp();
      });
      updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: RELEASE_REPOSITORY,
        },
        updateInterval: '1 hour',
        // The page shows the notice; no system dialog interrupts the person.
        notifyUser: false,
        logger: {
          log: (message) => log.info(String(message)),
          info: (message) => log.info(String(message)),
          warn: (message) => log.warn(String(message)),
          error: (message) => log.error(String(message)),
        },
      });
    },
    state: () => current,
    check() {
      if (!app.isPackaged)
        return Promise.resolve<DesktopUpdate>({
          status: 'error',
          message: 'Updates are checked in an installed copy of FullDots.',
        });
      if (current.status === 'ready' || current.status === 'downloading')
        return Promise.resolve(current);
      const result = new Promise<DesktopUpdate>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(finish);
          resolve(current);
        }, CHECK_TIMEOUT_MS);
        const finish = (update: DesktopUpdate) => {
          clearTimeout(timer);
          resolve(update);
        };
        waiting.add(finish);
      });
      if (native && process.platform === 'win32') {
        electronUpdater.autoUpdater
          .checkForUpdates()
          .catch((error: unknown) => {
            log.error('Could not start an update check', error);
            set({ status: 'error', message: 'Could not check for updates.' });
          });
      } else if (native) {
        try {
          autoUpdater.checkForUpdates();
        } catch (error) {
          log.error('Could not start an update check', error);
          set({ status: 'error', message: 'Could not check for updates.' });
        }
      } else void lookUp();
      return result;
    },
    async install() {
      if (current.status === 'available') {
        await shell.openExternal(current.url);
        return;
      }
      if (current.status !== 'ready') return;
      await options.beforeInstall();
      // Windows: install silently into the same folder, then open FullDots again.
      if (process.platform === 'win32')
        electronUpdater.autoUpdater.quitAndInstall(true, true);
      else autoUpdater.quitAndInstall();
    },
  };
}
