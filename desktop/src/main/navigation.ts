// Keeps the window on FullDots. Anything else a page points at opens in the person's own browser,
// where their sign-ins and password manager already are.
import { shell, type BrowserWindow, type WebContents } from 'electron';
import { classifyLink, isBlankPopup, isShellPage } from './links';
import type { Log } from './log';

export interface ShellPages {
  appOrigin?: string;
  bootUrl?: string;
}

/** How long a sign-in may take before its stand-in window is cleared away. */
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

export function attachNavigation(
  window: BrowserWindow,
  pages: () => ShellPages,
  log: Log,
): void {
  const contents = window.webContents;

  const openOutside = (url: string) => {
    const origin = pages().appOrigin;
    const target = origin ? classifyLink(url, origin) : 'blocked';
    if (target === 'external' || target === 'app-api') {
      void shell.openExternal(url).catch((error) => {
        log.error('Could not open a link in the browser', error);
      });
      return true;
    }
    return false;
  };

  // A connector's sign-in opens a blank window inside the click and points it at the provider a
  // moment later. The blank window is allowed, but hidden: when it is sent somewhere, that address
  // opens in the browser instead. The page keeps checking the connector, so it notices the sign-in
  // finishing there, and closes its window itself.
  let standIn: BrowserWindow | undefined;
  const clearStandIn = () => {
    if (standIn && !standIn.isDestroyed()) standIn.destroy();
    standIn = undefined;
  };

  contents.setWindowOpenHandler(({ url }) => {
    const origin = pages().appOrigin;
    if (!origin || !isShellPage(contents.getURL(), pages()))
      return { action: 'deny' };
    if (isBlankPopup(url)) {
      clearStandIn();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          skipTaskbar: true,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        },
      };
    }
    // A page of the app meant for a new tab opens here instead: there is one window.
    if (classifyLink(url, origin) === 'app') void contents.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => {
    standIn = child;
    const timer = setTimeout(clearStandIn, SIGN_IN_WINDOW_MS);
    child.once('closed', () => {
      clearTimeout(timer);
      if (standIn === child) standIn = undefined;
    });
    const hand = (event: Electron.Event, url: string) => {
      if (isBlankPopup(url)) return;
      event.preventDefault();
      openOutside(url);
    };
    child.webContents.on('will-navigate', hand);
    child.webContents.on('will-redirect', hand);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  const stay = (event: Electron.Event, url: string) => {
    if (isShellPage(url, pages())) return;
    event.preventDefault();
    openOutside(url);
  };
  contents.on('will-navigate', stay);
  contents.on('will-redirect', stay);
  // A page from anywhere else never gets a <webview> to load more pages into.
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('closed', clearStandIn);
}

/** The frame that sent an IPC message, when it is the top frame of a page the shell loaded. */
export function senderPage(
  event: { sender: WebContents; senderFrame: Electron.WebFrameMain | null },
  pages: ShellPages,
): 'app' | 'boot' | undefined {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return undefined;
  return isShellPage(frame.url, pages);
}
