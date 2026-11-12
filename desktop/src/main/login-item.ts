// Opening FullDots when the person signs in to their computer, started in the tray.
import { app } from 'electron';
import path from 'node:path';

/** Passed at sign-in so the app starts without putting a window in front of the person. */
export const HIDDEN_ARGUMENT = '--hidden';

/** Linux has no login items of its own; a development run must not register itself either. */
export function loginItemSupported(): boolean {
  return app.isPackaged && process.platform !== 'linux';
}

function target(): Electron.LoginItemSettingsOptions {
  if (process.platform !== 'win32') return {};
  // An installed Windows app is started through Squirrel's Update.exe, which finds the current
  // version's folder; the path of this executable changes with every update.
  const executable = path.basename(process.execPath);
  return {
    path: path.resolve(path.dirname(process.execPath), '..', 'Update.exe'),
    args: [
      '--processStart',
      `"${executable}"`,
      '--process-start-args',
      `"${HIDDEN_ARGUMENT}"`,
    ],
  };
}

export function opensAtLogin(): boolean {
  return loginItemSupported() && app.getLoginItemSettings(target()).openAtLogin;
}

export function setOpensAtLogin(open: boolean): void {
  if (loginItemSupported())
    app.setLoginItemSettings({ ...target(), openAtLogin: open });
}
