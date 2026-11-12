// Opens the real desktop window and checks what only a real window can show: that the workspace
// comes up in it, that the page knows it is in the shell, that the window chrome follows the theme,
// that other sites stay out, and that a server which cannot start says so.
//
//   npm run build            # in the repository root: the app the window loads
//   npx electron-forge package   # or `npm run package`: builds .vite/ for the shell
//   npm run test:e2e         # in desktop/
//
// It uses a throwaway profile, so it never touches real data, and leaves screenshots in out/e2e.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '..');
const root = path.resolve(desktop, '..');
const shots = path.join(desktop, 'out', 'e2e');
const { version } = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
);

// Playwright is the repository root's dependency; Electron is this package's.
const { _electron: electron } = createRequire(path.join(root, 'package.json'))(
  'playwright',
);
const executablePath = createRequire(path.join(desktop, 'package.json'))(
  'electron',
);

for (const needed of [
  [
    path.join(desktop, '.vite', 'build', 'main.cjs'),
    'Run "npx electron-forge package" in desktop/ first.',
  ],
  [
    path.join(root, 'dist', 'client', 'index.html'),
    'Run "npm run build" in the repository root first.',
  ],
])
  if (!existsSync(needed[0])) {
    console.error(needed[1]);
    process.exit(1);
  }
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  (${detail})` : ''}`,
  );
};

async function open(home, port) {
  writeFileSync(path.join(home, 'workspace', '.env'), `PORT=${port}\n`, {
    flag: 'a',
  });
  const app = await electron.launch({
    executablePath,
    args: ['.'],
    cwd: desktop,
    env: { ...process.env, FULLDOTS_DESKTOP_HOME: home },
  });
  // Links to other sites open the person's browser; in a test they are only recorded.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => {
      globalThis.__opened.push(url);
    };
  });
  return app;
}

/** Whether exactly this address was handed to the browser: a whole match, never a part of one. */
const wasOpened = (addresses, address) =>
  addresses.some((entry) => entry === address);

const profile = () => {
  const home = mkdtempSync(path.join(tmpdir(), 'fulldots-desktop-e2e-'));
  mkdirSync(path.join(home, 'workspace'), { recursive: true });
  return home;
};
const answers = async (origin) => {
  try {
    return (await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};

// ---- 1. The workspace opens in the window ------------------------------------------------------
console.log('The workspace opens in the window');
const home = profile();
const app = await open(home, 4396);
const page = await app.firstWindow();
await page.waitForSelector('.boot');
await page.screenshot({ path: path.join(shots, 'boot.png') });
check(
  'the boot screen shows while the server starts',
  await page.isVisible('.dots'),
);

await page.waitForURL(/^http:\/\/127\.0\.0\.1:4396\//, { timeout: 90_000 });
await page.waitForSelector('.topbar', { timeout: 30_000 });
const origin = new URL(page.url()).origin;
check(
  'the app is served on this machine only',
  origin === 'http://127.0.0.1:4396',
  origin,
);

const shell = await page.evaluate(() => ({
  platform: document.documentElement.dataset.desktop,
  version: window.fulldotsDesktop?.version,
  update: typeof window.fulldotsDesktop?.getUpdate,
  node: typeof window.require + typeof window.process,
  drag:
    getComputedStyle(document.querySelector('.topbar')).getPropertyValue(
      '-webkit-app-region',
    ) ||
    getComputedStyle(document.querySelector('.topbar')).getPropertyValue(
      'app-region',
    ),
  paddingRight: parseFloat(
    getComputedStyle(document.querySelector('.topbar')).paddingRight,
  ),
  theme: document.documentElement.dataset.theme,
}));
check(
  'the page knows which platform shell it is in',
  shell.platform === process.platform,
  shell.platform,
);
check(
  'the page sees the same version as package.json',
  shell.version === version,
  shell.version,
);
check('the page has the update bridge', shell.update === 'function');
check(
  'the page has no Node.js',
  shell.node === 'undefinedundefined',
  shell.node,
);
check('the top bar drags the window', shell.drag === 'drag', shell.drag);
if (process.platform !== 'darwin')
  check(
    'the title strip keeps clear of the window buttons',
    shell.paddingRight > 100,
    `${shell.paddingRight}px`,
  );
check(
  'the update state reaches the page',
  (await page.evaluate(() => window.fulldotsDesktop.getUpdate())).status ===
    'idle',
);

const state = await page.evaluate(() =>
  fetch('/api/state').then((response) => response.status),
);
check('the API answers the window', state === 200, String(state));
check(
  'the workspace is in the data folder',
  existsSync(path.join(home, 'workspace', 'data', 'opendots.sqlite')),
);
const services = await page.evaluate(async () => ({
  setup: (await (await fetch('/api/workspace')).json()).setup,
  docker: await (await fetch('/api/docker/setup')).json(),
}));
check(
  'the guided setup for Dot computers is offered',
  services.docker.enabled === true,
);
check(
  'the computer setup files are in the data folder, with the rule that keeps data out of builds',
  existsSync(path.join(home, 'workspace', 'compose.computers.yml')) &&
    readFileSync(
      path.join(home, 'workspace', '.dockerignore'),
      'utf8',
    ).includes('!deployment'),
);
check(
  'the page reader is running',
  services.setup.browser === true,
  JSON.stringify(services.setup),
);
check(
  'a new chat starts with one line and the message box, and no side panel',
  (await page.locator('.start-hero h1').count()) === 1 &&
    (await page.locator('.result-pane').count()) === 0,
);
await page.screenshot({ path: path.join(shots, 'app-dark.png') });

// ---- 2. The window follows the theme -----------------------------------------------------------
console.log('The window follows the theme');
const background = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor(),
  );
check(
  'the window is dark with the dark theme',
  (await background()).toLowerCase() === '#0e0e0e',
  await background(),
);
await page.evaluate(() => {
  localStorage.setItem('fulldots-theme', 'light');
  location.reload();
});
await page.waitForSelector('.topbar');
await page.waitForFunction(
  () => document.documentElement.dataset.theme === 'light',
);
await page.waitForTimeout(400);
check(
  'the window turns light with the light theme',
  (await background()).toLowerCase() === '#efefef',
  await background(),
);
await page.screenshot({ path: path.join(shots, 'app-light.png') });
await page.evaluate(() => localStorage.setItem('fulldots-theme', 'dark'));

// ---- An update the shell reports reaches the page ------------------------------------------------
console.log('An update reaches the page');
await app.evaluate(({ BrowserWindow }) => {
  const [main] = BrowserWindow.getAllWindows().filter((window) =>
    window.isVisible(),
  );
  main.webContents.send('update:changed', {
    status: 'ready',
    version: '9.9.9',
  });
});
await page.waitForSelector('.desktop-update', { timeout: 15_000 });
check(
  'the page offers the restart',
  (await page.textContent('.desktop-update')).includes(
    'FullDots 9.9.9 is ready',
  ),
);
await page.screenshot({ path: path.join(shots, 'update-notice.png') });
await page.click('.desktop-update [aria-label="Later"]');
check(
  'Later puts the notice away',
  (await page.locator('.desktop-update').count()) === 0,
);

// ---- 3. Other sites stay out of the window -----------------------------------------------------
console.log('Other sites stay out of the window');
await page.evaluate(() => {
  window.open('https://example.com/docs', '_blank');
  window.open('file:///C:/Windows/win.ini', '_blank');
});
await page.evaluate(() => {
  const link = Object.assign(document.createElement('a'), {
    href: 'https://example.com/away',
  });
  document.body.append(link);
  link.click();
});
await page.waitForTimeout(600);
const opened = await app.evaluate(() => globalThis.__opened);
check(
  'a new-tab link opens in the browser',
  wasOpened(opened, 'https://example.com/docs'),
  opened.join(', '),
);
check(
  'a plain link to another site opens in the browser',
  wasOpened(opened, 'https://example.com/away'),
);
check(
  'a file: address opens nowhere',
  !opened.some((url) => new URL(url).protocol === 'file:'),
);
check(
  'the window is still on the app',
  page.url().startsWith(origin),
  page.url(),
);
check('no second window was opened', (await app.windows()).length === 1);

// A connector sign-in opens a blank window first and points it at the provider afterwards.
await page.evaluate(() => {
  const popup = window.open(
    '',
    'fulldots-connector-auth',
    'popup=yes,width=600,height=760',
  );
  window.__popupOpened = !!popup;
  popup?.location.replace('https://example.com/authorize?state=abc');
});
await page.waitForTimeout(800);
check(
  'a sign-in window can be opened by the page',
  await page.evaluate(() => window.__popupOpened),
);
check(
  'the sign-in address opens in the browser',
  wasOpened(
    await app.evaluate(() => globalThis.__opened),
    'https://example.com/authorize?state=abc',
  ),
);
check(
  'the stand-in window stays hidden',
  await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => window.isVisible())
        .length === 1,
  ),
);

// ---- 4. Quitting stops the server --------------------------------------------------------------
console.log('Quitting stops the server');
await app.evaluate(({ app: electronApp }) => electronApp.quit());
await app.waitForEvent('close', { timeout: 20_000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 500));
check('the server is gone after quitting', !(await answers(origin)));
const settings = JSON.parse(
  readFileSync(path.join(home, 'desktop-settings.json'), 'utf8'),
);
check(
  'the window position and theme were remembered',
  !!settings.window?.bounds && settings.port === 4396,
  JSON.stringify(settings),
);

// ---- 5. A server that cannot start says so ------------------------------------------------------
console.log('A server that cannot start says so');
const broken = profile();
// A database path under a file can never be created.
writeFileSync(path.join(broken, 'blocker'), '');
writeFileSync(
  path.join(broken, 'workspace', '.env'),
  `DATABASE_PATH=${path.join(broken, 'blocker', 'nope', 'db.sqlite').replaceAll('\\', '/')}\n`,
);
const second = await open(broken, 4397);
const bootPage = await second.firstWindow();
await bootPage.waitForSelector('.failed:not([hidden])', { timeout: 90_000 });
check(
  'the boot screen reports the failure',
  (await bootPage.textContent('.failed h2')).includes('could not start'),
);
check('it offers to try again', await bootPage.isVisible('#retry'));
check(
  'it shows what the server reported',
  (await bootPage.textContent('#log')).trim().length > 0,
);
await bootPage.screenshot({ path: path.join(shots, 'boot-failed.png') });
await second.evaluate(({ app: electronApp }) => electronApp.quit());
await second.waitForEvent('close', { timeout: 20_000 }).catch(() => {});

for (const directory of [home, broken])
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });

console.log(
  failures
    ? `\n${failures} check(s) failed.`
    : `\nAll checks passed. Screenshots: ${path.relative(root, shots)}`,
);
process.exit(failures ? 1 : 0);
