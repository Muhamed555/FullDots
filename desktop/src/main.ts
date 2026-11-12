// FullDots Desktop: the web app in a window of its own.
//
// The shell is deliberately thin. It starts the same server build a web deployment runs, on this
// machine only, and opens the same client in a window. Everything a person sees and does is the
// web app; what lives here is what a browser tab cannot do: start with the computer, stay in the
// tray, keep its own window, and update itself.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  type Tray,
} from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import type { DesktopUpdate } from '../../src/shared/desktop-bridge';
import { IPC, type BootState } from './ipc';
import { chooseProfile, resolvePaths } from './main/app-paths';
import { findBrowser } from './main/browser-finder';
import { syncComputerKit } from './main/computer-kit';
import { attachContextMenu } from './main/context-menu';
import { createLog } from './main/log';
import { HIDDEN_ARGUMENT } from './main/login-item';
import { installMenu } from './main/menu';
import { startPageReader, type PageReader } from './main/page-reader';
import {
  attachNavigation,
  senderPage,
  type ShellPages,
} from './main/navigation';
import { restrictPermissions } from './main/permissions';
import { findPort } from './main/ports';
import { startServer, type RunningServer } from './main/server';
import {
  LOOPBACK_HOST,
  parseEnvFile,
  preferredPort,
  serverEnv,
} from './main/server-env';
import { SettingsStore } from './main/settings';
import { createTray } from './main/tray';
import { createUpdates } from './main/updates';
import {
  applyChrome,
  asThemeReport,
  createMainWindow,
  savedChrome,
} from './main/window';

const VERSION = __FULLDOTS_VERSION__;

function main(): void {
  chooseProfile();
  // A second launch hands over to the first: one workspace, one database, one window.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Matches the shortcut Squirrel creates, so Windows groups notifications under FullDots.
  if (process.platform === 'win32' && app.isPackaged)
    app.setAppUserModelId('com.squirrel.FullDots.fulldots');

  const paths = resolvePaths();
  const log = createLog(path.join(paths.logs, 'desktop.log'));
  const settings = new SettingsStore(paths.settings, (message) =>
    log.warn(message),
  );
  log.info(`FullDots Desktop ${VERSION} starting (${process.platform}).`);

  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let server: RunningServer | undefined;
  let pageReader: PageReader | undefined;
  let appOrigin: string | undefined;
  let boot: BootState = { phase: 'starting' };
  let launching = false;
  let quitting = false;

  // The boot screen is this package's own small page (index.html), shown while the server starts.
  const bootFile = path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  );
  const bootUrl =
    MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(bootFile).href;
  const pages = (): ShellPages => ({ appOrigin, bootUrl });

  const send = (channel: string, payload: unknown) => {
    if (window && !window.isDestroyed())
      window.webContents.send(channel, payload);
  };

  /** What the window was last pointed at, so the boot screen is not loaded over itself. */
  let showing: 'boot' | 'app' | undefined;
  const showBoot = () => {
    if (!window || window.isDestroyed() || showing === 'boot') return;
    showing = 'boot';
    const theme = savedChrome(settings).theme;
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      url.searchParams.set('theme', theme);
      void window.loadURL(url.href);
    } else void window.loadFile(bootFile, { query: { theme } });
  };
  const showApp = async () => {
    if (!window || window.isDestroyed() || !appOrigin) return;
    showing = 'app';
    await window.loadURL(`${appOrigin}/`);
  };

  const setBoot = (next: BootState) => {
    boot = next;
    send(IPC.bootChanged, next);
  };

  const fail = (message: string) => {
    log.error(message);
    appOrigin = undefined;
    setBoot({ phase: 'failed', message, log: log.tail() });
    showBoot();
  };

  /** Starts the server and points the window at it. Any failure lands on the boot screen. */
  const launch = async () => {
    if (launching || server) return;
    launching = true;
    setBoot({ phase: 'starting' });
    showBoot();
    try {
      // For work on the shell itself: use a server that is already running (`npm run dev`).
      const external = app.isPackaged
        ? undefined
        : process.env.FULLDOTS_DESKTOP_URL;
      if (external) appOrigin = new URL(external).origin;
      else {
        if (!existsSync(paths.serverEntry) || !existsSync(paths.clientDir))
          throw new Error(
            app.isPackaged
              ? 'Part of FullDots is missing from this installation. Install it again.'
              : 'The app is not built yet. Run "npm run build" in the repository root.',
          );
        mkdirSync(paths.dataDir, { recursive: true });
        const userEnv = existsSync(paths.envFile)
          ? parseEnvFile(readFileSync(paths.envFile, 'utf8'))
          : {};
        const port = await findPort(
          preferredPort(userEnv, settings.value.port),
          LOOPBACK_HOST,
        );
        settings.update({ port });
        const origin = `http://${LOOPBACK_HOST}:${port}`;
        // The guided Docker setup for Dot computers works from the data folder.
        try {
          if (!syncComputerKit(paths.computerKit, paths.home))
            log.warn('The computer setup files are missing from this build.');
        } catch (error) {
          log.error('Could not copy the computer setup files', error);
        }
        server = await startServer({
          hostScript: paths.serverHost,
          entry: paths.serverEntry,
          cwd: paths.home,
          env: serverEnv({
            base: process.env,
            userEnv,
            provided: await pageReaderEnv(userEnv, port),
            port,
            clientDir: paths.clientDir,
            databasePath: paths.database,
            version: VERSION,
          }),
          origin,
          port,
          log,
          onUnexpectedExit: (code) => {
            server = undefined;
            if (!quitting)
              fail(`FullDots stopped unexpectedly (exit code ${code}).`);
          },
        });
        appOrigin = origin;
      }
      await showApp();
    } catch (error) {
      fail(
        error instanceof Error ? error.message : 'FullDots could not start.',
      );
    } finally {
      launching = false;
    }
  };

  /**
   * Starts the page reader once, when a browser is installed and `.env` does not already point at
   * one, and returns what the server needs to reach it. Without it, search still works; Dots just
   * cannot open the pages they find.
   */
  const pageReaderEnv = async (
    userEnv: Record<string, string>,
    serverPort: number,
  ): Promise<Record<string, string>> => {
    if (userEnv.BROWSER_URL || process.env.BROWSER_URL) return {};
    try {
      if (!pageReader) {
        const browserPath = findBrowser(
          process.platform,
          process.env,
          existsSync,
        );
        if (!browserPath || !existsSync(paths.pageReaderEntry)) {
          log.info(
            browserPath
              ? 'This build has no page reader.'
              : 'No Chrome or Edge found: the page reader is not started.',
          );
          return {};
        }
        pageReader = startPageReader({
          hostScript: paths.serverHost,
          entry: paths.pageReaderEntry,
          cwd: paths.home,
          port: await findPort(serverPort + 1, LOOPBACK_HOST),
          browserPath,
          log,
        });
      }
      return { BROWSER_URL: pageReader.url, BROWSER_SECRET: pageReader.secret };
    } catch (error) {
      log.error('Could not start the page reader', error);
      return {};
    }
  };

  const stopServer = async () => {
    const running = server;
    server = undefined;
    await running?.stop();
  };

  const keepRunning = () =>
    // Only where there is a tray icon to come back through.
    !!tray &&
    !tray.isDestroyed() &&
    (settings.value.keepRunning ?? process.platform === 'win32');

  const openWindow = () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    const created = createMainWindow({
      settings,
      preload: path.join(__dirname, 'preload.cjs'),
      version: VERSION,
    });
    window = created;
    showing = undefined;
    attachNavigation(created, pages, log);
    attachContextMenu(created, { inspect: !app.isPackaged });
    created.on('enter-full-screen', () =>
      send(IPC.windowState, { fullscreen: true }),
    );
    created.on('leave-full-screen', () =>
      send(IPC.windowState, { fullscreen: false }),
    );
    created.webContents.on(
      'did-fail-load',
      (_event, code, description, url, isMainFrame) => {
        // -3 is a load this app replaced with another; it is not a failure.
        if (!isMainFrame || code === -3 || !appOrigin) return;
        if (url.startsWith(appOrigin))
          fail(`The workspace did not load (${description}).`);
      },
    );
    created.on('close', (event) => {
      if (quitting || process.platform === 'darwin' || !keepRunning()) return;
      // Closing the window leaves the Dots at work; the tray icon brings it back.
      event.preventDefault();
      created.hide();
      if (!settings.value.backgroundHintShown && Notification.isSupported()) {
        settings.update({ backgroundHintShown: true });
        new Notification({
          title: 'FullDots is still running',
          body: 'Your Dots keep working in the background. Open or quit FullDots from its tray icon.',
        }).show();
      }
    });
    created.on('closed', () => {
      if (window === created) window = undefined;
    });
    if (appOrigin && boot.phase !== 'failed') void showApp();
    else showBoot();
  };

  const openDataFolder = () => {
    mkdirSync(paths.home, { recursive: true });
    void shell.openPath(paths.home);
  };
  const openLogs = () => {
    mkdirSync(paths.logs, { recursive: true });
    void shell.openPath(paths.logs);
  };

  const updates = createUpdates({
    version: VERSION,
    log,
    onChange: (update: DesktopUpdate) => send(IPC.updateChanged, update),
    beforeInstall: async () => {
      quitting = true;
      settings.flush();
      await stopServer();
    },
  });

  /** "Check for Updates…" from a menu: the answer is a dialog, since no page asked. */
  const checkForUpdates = async () => {
    const result = await updates.check();
    const about = (message: string, detail: string, buttons = ['OK']) =>
      dialog.showMessageBox({
        type: 'info',
        title: 'FullDots',
        message,
        detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
    if (result.status === 'ready' || result.status === 'available') {
      const named = /^\d/.test(result.version)
        ? `FullDots ${result.version}`
        : 'A new version of FullDots';
      const { response } = await about(
        `${named} is available`,
        result.status === 'ready'
          ? 'It has been downloaded. Restart FullDots to finish updating.'
          : 'Download it from the releases page to update.',
        [
          result.status === 'ready' ? 'Restart Now' : 'Open Download Page',
          'Later',
        ],
      );
      if (response === 0) await updates.install();
    } else if (result.status === 'downloading')
      await about(
        'An update is downloading',
        'FullDots will let you know when it is ready to install.',
      );
    else if (result.status === 'error')
      await about('Could not check for updates', result.message);
    else await about('FullDots is up to date', `You have version ${VERSION}.`);
  };

  // ---- Requests from the pages --------------------------------------------------------------
  ipcMain.on(IPC.theme, (event, payload: unknown) => {
    const report = asThemeReport(payload);
    if (report && window && senderPage(event, pages()))
      applyChrome(window, settings, report);
  });
  const fromApp =
    <T>(handler: () => T | Promise<T>) =>
    (event: Electron.IpcMainInvokeEvent) => {
      if (!senderPage(event, pages())) throw new Error('Not allowed.');
      return handler();
    };
  const fromBoot =
    <T>(handler: () => T | Promise<T>) =>
    (event: Electron.IpcMainInvokeEvent) => {
      if (senderPage(event, pages()) !== 'boot')
        throw new Error('Not allowed.');
      return handler();
    };
  ipcMain.handle(
    IPC.updateGet,
    fromApp(() => updates.state()),
  );
  ipcMain.handle(
    IPC.updateCheck,
    fromApp(() => updates.check()),
  );
  ipcMain.handle(
    IPC.updateInstall,
    fromApp(() => updates.install()),
  );
  ipcMain.handle(
    IPC.bootGet,
    fromBoot(() => boot),
  );
  ipcMain.handle(
    IPC.bootRetry,
    fromBoot(() => void launch()),
  );
  ipcMain.handle(IPC.bootOpenLogs, fromBoot(openLogs));
  ipcMain.handle(IPC.bootOpenData, fromBoot(openDataFolder));
  ipcMain.handle(
    IPC.bootQuit,
    fromBoot(() => app.quit()),
  );

  // ---- Life cycle -----------------------------------------------------------------------------
  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    quitting = true;
    settings.flush();
    if (!server) return;
    // Let the server close its database and channels before the process goes.
    event.preventDefault();
    void stopServer().finally(() => app.quit());
  });

  // Closing the windows on the way out records their position; write it before the process ends.
  app.on('will-quit', () => {
    settings.flush();
    pageReader?.stop();
  });

  void app.whenReady().then(() => {
    restrictPermissions(pages);
    installMenu({ checkForUpdates, openDataFolder, openLogs }, VERSION);
    tray = createTray({
      open: openWindow,
      openInBrowser: () => {
        if (appOrigin) void shell.openExternal(appOrigin);
      },
      checkForUpdates: () => void checkForUpdates(),
      openDataFolder,
      quit: () => app.quit(),
      keepRunning,
      setKeepRunning: (keep) => settings.update({ keepRunning: keep }),
    });
    // Started at sign-in: stay in the tray until asked for, when there is one.
    if (!(process.argv.includes(HIDDEN_ARGUMENT) && keepRunning()))
      openWindow();
    void launch();
    updates.start();
  });
}

// Squirrel runs the app briefly to create or remove shortcuts on Windows; that is all it does.
if (started) app.quit();
else main();
