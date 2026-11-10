// The tray icon on Windows and Linux: FullDots keeps running there when its window is closed, so
// scheduled work and connected channels carry on. macOS keeps an app running in the Dock already.
import { Menu, nativeImage, Tray } from 'electron';
import {
  loginItemSupported,
  opensAtLogin,
  setOpensAtLogin,
} from './login-item';
import tray16 from '../../assets/icons/tray-16.png?inline';
import tray32 from '../../assets/icons/tray-32.png?inline';

export interface TrayActions {
  open(): void;
  openInBrowser(): void;
  checkForUpdates(): void;
  openDataFolder(): void;
  quit(): void;
  keepRunning(): boolean;
  setKeepRunning(keep: boolean): void;
}

export function createTray(actions: TrayActions): Tray | undefined {
  if (process.platform === 'darwin') return undefined;
  const icon = nativeImage.createFromDataURL(tray16);
  icon.addRepresentation({ scaleFactor: 2, dataURL: tray32 });
  let tray: Tray;
  try {
    tray = new Tray(icon);
  } catch {
    // Some Linux desktops have no tray; the window then simply closes the app.
    return undefined;
  }
  const build = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open FullDots', click: actions.open },
        { label: 'Open in Browser', click: actions.openInBrowser },
        { type: 'separator' },
        {
          label: 'Keep Running When the Window Is Closed',
          type: 'checkbox',
          checked: actions.keepRunning(),
          click: (item) => {
            actions.setKeepRunning(item.checked);
            build();
          },
        },
        ...(loginItemSupported()
          ? [
              {
                label: 'Open at Login',
                type: 'checkbox' as const,
                checked: opensAtLogin(),
                click: (item: Electron.MenuItem) => {
                  setOpensAtLogin(item.checked);
                  build();
                },
              },
            ]
          : []),
        { type: 'separator' },
        { label: 'Check for Updates…', click: actions.checkForUpdates },
        { label: 'Open Data Folder', click: actions.openDataFolder },
        { type: 'separator' },
        { label: 'Quit FullDots', click: actions.quit },
      ]),
    );
  tray.setToolTip('FullDots');
  tray.on('click', actions.open);
  build();
  return tray;
}
