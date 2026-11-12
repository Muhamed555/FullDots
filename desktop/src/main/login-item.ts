// Opening FullDots when the person signs in to their computer, started in the tray.
import { app } from 'electron';

/** Passed at sign-in so the app starts without putting a window in front of the person. */
export const HIDDEN_ARGUMENT = '--hidden';

/** Linux has no login items of its own; a development run must not register itself either. */
export function loginItemSupported(): boolean {
  return app.isPackaged && process.platform !== 'linux';
}

function target(): Electron.LoginItemSettingsOptions {
  // Windows: the installed fulldots.exe itself. The setup wizard installs into one folder and
  // updates in place, so this path stays the same from version to version.
  if (process.platform !== 'win32') return {};
  return { path: process.execPath, args: [HIDDEN_ARGUMENT] };
}

export function opensAtLogin(): boolean {
  return loginItemSupported() && app.getLoginItemSettings(target()).openAtLogin;
}

export function setOpensAtLogin(open: boolean): void {
  if (loginItemSupported())
    app.setLoginItemSettings({ ...target(), openAtLogin: open });
}
