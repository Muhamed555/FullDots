// The application menu. On macOS it is the menu bar; on Windows and Linux the window has no menu
// bar, and the menu is there for its keyboard shortcuts (zoom, reload, full screen, quit).
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  checkForUpdates(): void;
  openDataFolder(): void;
  openLogs(): void;
}

const REPOSITORY = 'https://github.com/asasemahmed/FullDots';

export function installMenu(actions: MenuActions, version: string): void {
  const mac = process.platform === 'darwin';
  const updates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: actions.checkForUpdates,
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              updates,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Data Folder', click: actions.openDataFolder },
        { label: 'Open Logs', click: actions.openLogs },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // Ctrl and = is how most keyboards write Ctrl and +, without Shift.
        {
          role: 'zoomIn',
          accelerator: 'CommandOrControl+=',
          visible: false,
          acceleratorWorksWhenHidden: true,
        },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'FullDots Documentation',
          click: () => void shell.openExternal(`${REPOSITORY}#readme`),
        },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal(`${REPOSITORY}/issues`),
        },
        ...(mac ? [] : [{ type: 'separator' } as const, updates]),
        { type: 'separator' },
        { label: `Version ${version}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
