// The one window, and the chrome around the page: on Windows and Linux the page runs to the top
// edge with the system's window buttons drawn over its top bar; on macOS the traffic lights sit
// over the sidebar. The page's own top bar is the title bar (src/client/desktop/desktop.css).
import { BrowserWindow, nativeImage, screen } from 'electron';
import { VERSION_ARGUMENT, type ShellTheme, type ThemeReport } from '../ipc';
import type { SettingsStore } from './settings';
import { MIN_HEIGHT, MIN_WIDTH, restoreWindow } from './window-state';
import iconPng from '../../assets/icons/icon.png?inline';

/** The window's frame colour: --desk-frame in src/client/desktop/desktop.css. */
export const THEME_COLORS: Record<ShellTheme, string> = {
  dark: '#0e0e0e',
  light: '#efefef',
};
const SYMBOL_COLORS: Record<ShellTheme, string> = {
  dark: '#e6e6e6',
  light: '#3a3a3a',
};
/** The height of the system's window buttons: --desk-bar in src/client/desktop/desktop.css. */
export const TITLE_BAR_HEIGHT = 48;

const mac = process.platform === 'darwin';

export function appIcon(): Electron.NativeImage {
  return nativeImage.createFromDataURL(iconPng);
}

// See-through, so the buttons sit on whatever the page's top bar looks like; only the symbols
// are coloured for the theme.
const overlay = (theme: ShellTheme) => ({
  color: '#00000000',
  symbolColor: SYMBOL_COLORS[theme],
  height: TITLE_BAR_HEIGHT,
});

export function savedChrome(settings: SettingsStore): ThemeReport {
  const theme = settings.value.theme === 'light' ? 'light' : 'dark';
  return { theme, color: THEME_COLORS[theme] };
}

export function createMainWindow(options: {
  settings: SettingsStore;
  preload: string;
  version: string;
}): BrowserWindow {
  const { settings } = options;
  const chrome = savedChrome(settings);
  const restored = restoreWindow(
    settings.value.window,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'FullDots',
    backgroundColor: chrome.color,
    // Windows and macOS take the icon from the executable; Linux needs it on the window.
    ...(process.platform === 'linux' ? { icon: appIcon() } : {}),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: overlay(chrome.theme) }),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Chromium's own PDF viewer, for files a Dot saves or the owner uploads.
      plugins: true,
      additionalArguments: [`${VERSION_ARGUMENT}${options.version}`],
    },
  });
  if (restored.maximized) window.maximize();

  // Shown once there is something to look at, so the window never opens as a white rectangle.
  window.once('ready-to-show', () => window.show());

  const remember = () => {
    if (window.isDestroyed()) return;
    settings.update({
      window: {
        // The size to come back to after un-maximising, not the maximised size itself.
        bounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
      },
    });
  };
  window.on('resized', remember);
  window.on('moved', remember);
  window.on('maximize', remember);
  window.on('unmaximize', remember);
  window.on('close', remember);
  return window;
}

/** Repaints the window buttons and background to match the page's theme, and remembers it. */
export function applyChrome(
  window: BrowserWindow,
  settings: SettingsStore,
  report: ThemeReport,
): void {
  if (window.isDestroyed()) return;
  window.setBackgroundColor(report.color);
  if (!mac) window.setTitleBarOverlay(overlay(report.theme));
  if (
    settings.value.theme !== report.theme ||
    settings.value.themeColor !== report.color
  )
    settings.update({ theme: report.theme, themeColor: report.color });
}

/** A theme report from a page, kept only when it is well formed. The frame colour is the shell's own. */
export function asThemeReport(value: unknown): ThemeReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { theme } = value as Record<string, unknown>;
  if (theme !== 'light' && theme !== 'dark') return undefined;
  return { theme, color: THEME_COLORS[theme] };
}
