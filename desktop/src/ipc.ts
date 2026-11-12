// Channel names and payloads shared by the main process and the preload script.

export const IPC = {
  /** Page -> shell: the theme the page just painted, so the window chrome can match it. */
  theme: 'shell:theme',
  /** Shell -> page: the window entered or left full screen. */
  windowState: 'shell:window-state',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  /** Shell -> page: the update state changed. */
  updateChanged: 'update:changed',
  bootGet: 'boot:get',
  bootRetry: 'boot:retry',
  bootOpenLogs: 'boot:open-logs',
  bootOpenData: 'boot:open-data',
  bootQuit: 'boot:quit',
  /** Shell -> boot screen: starting, or failed with the reason. */
  bootChanged: 'boot:changed',
} as const;

export type ShellTheme = 'light' | 'dark';

export interface ThemeReport {
  theme: ShellTheme;
  /** The page's `theme-color`: the colour of its top bar. */
  color: string;
}

export interface WindowStateReport {
  fullscreen: boolean;
}

/** What the boot screen shows while the workspace starts, and when it could not. */
export type BootState =
  { phase: 'starting' } | { phase: 'failed'; message: string; log: string };

/** The boot screen's own bridge; only that page's requests are answered. */
export interface BootBridge {
  getState(): Promise<BootState>;
  onState(listener: (state: BootState) => void): () => void;
  retry(): Promise<void>;
  openLogs(): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
}

/** Passed to the preload script on its command line (`webPreferences.additionalArguments`). */
export const VERSION_ARGUMENT = '--fulldots-version=';
