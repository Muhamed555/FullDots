// Runs in the window before the page, in a world of its own (context isolation, sandbox). It
// gives the page two small objects and tells the shell which theme the page painted. The page
// gets no Node.js and no Electron: only these functions.
import { contextBridge, ipcRenderer } from 'electron';
import {
  asDesktopUpdate,
  type DesktopBridge,
  type DesktopPlatform,
  type DesktopUpdate,
} from '../../src/shared/desktop-bridge';
import {
  IPC,
  VERSION_ARGUMENT,
  type BootBridge,
  type BootState,
  type ThemeReport,
  type WindowStateReport,
} from './ipc';

const platform = process.platform as DesktopPlatform;
const version =
  process.argv
    .find((argument) => argument.startsWith(VERSION_ARGUMENT))
    ?.slice(VERSION_ARGUMENT.length) ?? '';

function subscribe<T>(
  channel: string,
  read: (payload: unknown) => T | undefined,
  listener: (value: T) => void,
): () => void {
  const handler = (_event: unknown, payload: unknown) => {
    const value = read(payload);
    if (value !== undefined) listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const update = async (channel: string): Promise<DesktopUpdate> =>
  asDesktopUpdate(await ipcRenderer.invoke(channel)) ?? { status: 'idle' };

const desktop: DesktopBridge = {
  platform,
  version,
  getUpdate: () => update(IPC.updateGet),
  checkForUpdates: () => update(IPC.updateCheck),
  installUpdate: async () => {
    await ipcRenderer.invoke(IPC.updateInstall);
  },
  onUpdate: (listener) =>
    subscribe(IPC.updateChanged, asDesktopUpdate, listener),
};

const asBootState = (payload: unknown): BootState | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const state = payload as Partial<Extract<BootState, { phase: 'failed' }>>;
  if (state.phase === 'failed')
    return {
      phase: 'failed',
      message: String(state.message ?? ''),
      log: String(state.log ?? ''),
    };
  return { phase: 'starting' };
};

const boot: BootBridge = {
  getState: async () =>
    asBootState(await ipcRenderer.invoke(IPC.bootGet)) ?? { phase: 'starting' },
  onState: (listener) => subscribe(IPC.bootChanged, asBootState, listener),
  retry: () => ipcRenderer.invoke(IPC.bootRetry),
  openLogs: () => ipcRenderer.invoke(IPC.bootOpenLogs),
  openDataFolder: () => ipcRenderer.invoke(IPC.bootOpenData),
  quit: () => ipcRenderer.invoke(IPC.bootQuit),
};

contextBridge.exposeInMainWorld('fulldotsDesktop', desktop);
contextBridge.exposeInMainWorld('fulldotsBoot', boot);

// ---- The page's <html> element ------------------------------------------------------------------
// `data-desktop` is what the app's desktop.css keys on: it turns the top bar into the title bar
// and keeps the page clear of the window buttons. It is set before the first paint.
function whenRoot(ready: (root: HTMLElement) => void): void {
  if (document.documentElement) {
    ready(document.documentElement);
    return;
  }
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    ready(document.documentElement);
  });
  observer.observe(document, { childList: true });
}

whenRoot((root) => {
  root.dataset.desktop = platform;

  // The window's buttons and background follow the theme the page shows (Settings -> General).
  let last = '';
  const report = () => {
    const theme = root.dataset.theme === 'light' ? 'light' : 'dark';
    const color =
      document
        .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content.trim() ?? '';
    if (`${theme} ${color}` === last) return;
    last = `${theme} ${color}`;
    ipcRenderer.send(IPC.theme, { theme, color } satisfies ThemeReport);
  };
  new MutationObserver(report).observe(root, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  document.addEventListener('DOMContentLoaded', report);
  if (root.dataset.theme) report();
});

subscribe<WindowStateReport>(
  IPC.windowState,
  (payload) =>
    payload && typeof payload === 'object'
      ? { fullscreen: (payload as WindowStateReport).fullscreen === true }
      : undefined,
  ({ fullscreen }) => {
    // macOS hides the traffic lights in full screen, so the sidebar takes its space back.
    if (fullscreen) document.documentElement.dataset.desktopFullscreen = '';
    else delete document.documentElement.dataset.desktopFullscreen;
  },
);
