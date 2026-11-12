// The contract between the web app and FullDots Desktop (the Electron shell in desktop/).
//
// The desktop window loads the same client as a browser does. The shell's preload script adds
// `window.fulldotsDesktop`; in a browser it is undefined, and everything that reads it does nothing.
// Both sides import these types, so a change here is checked against the client and the shell.

export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

/** Where the app update stands. `ready` restarts into it; `available` needs a manual download. */
export type DesktopUpdate =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current' }
  | { status: 'downloading' }
  | { status: 'ready'; version: string }
  | { status: 'available'; version: string; url: string }
  | { status: 'error'; message: string };

export const DESKTOP_UPDATE_STATUSES = [
  'idle',
  'checking',
  'current',
  'downloading',
  'ready',
  'available',
  'error',
] as const satisfies readonly DesktopUpdate['status'][];

export interface DesktopBridge {
  readonly platform: DesktopPlatform;
  /** The installed version, the same number as the web app's package.json. */
  readonly version: string;
  getUpdate(): Promise<DesktopUpdate>;
  checkForUpdates(): Promise<DesktopUpdate>;
  /** `ready`: quit, install and reopen. `available`: open the download page in the browser. */
  installUpdate(): Promise<void>;
  /** Calls the listener on every change; returns the function that stops it. */
  onUpdate(listener: (update: DesktopUpdate) => void): () => void;
}

/** The shell this page runs in, or undefined in a browser (and in tests without a window). */
export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as { fulldotsDesktop?: Partial<DesktopBridge> })
    .fulldotsDesktop;
  return typeof bridge?.getUpdate === 'function' &&
    typeof bridge.onUpdate === 'function'
    ? (bridge as DesktopBridge)
    : undefined;
}

/** A value from the other side of the bridge, kept only when it is a well-formed update. */
export function asDesktopUpdate(value: unknown): DesktopUpdate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === 'string' && record[key] ? record[key] : undefined;
  switch (record.status) {
    case 'idle':
    case 'checking':
    case 'current':
    case 'downloading':
      return { status: record.status };
    case 'ready':
      // The version can be unknown (an updater that names its release in words): still ready.
      return { status: 'ready', version: text('version') ?? '' };
    case 'available': {
      const version = text('version');
      const url = text('url');
      return version && url ? { status: 'available', version, url } : undefined;
    }
    case 'error':
      return { status: 'error', message: text('message') ?? 'Update failed.' };
    default:
      return undefined;
  }
}
