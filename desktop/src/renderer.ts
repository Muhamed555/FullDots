// The boot screen: what the window shows while the workspace starts, and when it could not.
// Everything after that is the web app itself, loaded from the server this shell started.
import './index.css';
import type { BootBridge, BootState } from './ipc';

const bridge = (window as { fulldotsBoot?: BootBridge }).fulldotsBoot;
const root = document.documentElement;

// The shell passes the theme the app last used, so this screen matches what comes after it.
const theme =
  new URLSearchParams(location.search).get('theme') === 'light'
    ? 'light'
    : 'dark';
const themeColor = document.querySelector<HTMLMetaElement>(
  'meta[name="theme-color"]',
);
// The colour first: the shell reads it when the theme attribute changes.
if (themeColor) themeColor.content = theme === 'light' ? '#efefef' : '#0e0e0e';
root.dataset.theme = theme;
root.style.colorScheme = theme;

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const main = document.querySelector<HTMLElement>('.boot')!;
const starting = document.querySelector<HTMLElement>('.starting')!;
const failed = document.querySelector<HTMLElement>('.failed')!;
const status = element('status');

// A slow first start (a large workspace, a busy disk) should not look stuck.
const PATIENCE = [
  [6_000, 'Still starting. The first launch takes a little longer'],
  [20_000, 'Almost there'],
] as const;
let timers: ReturnType<typeof setTimeout>[] = [];

function render(state: BootState): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  main.dataset.phase = state.phase;
  starting.hidden = state.phase !== 'starting';
  failed.hidden = state.phase !== 'failed';
  if (state.phase === 'starting') {
    status.textContent = 'Waking up your workspace';
    timers = PATIENCE.map(([after, text]) =>
      setTimeout(() => (status.textContent = text), after),
    );
    return;
  }
  element('reason').textContent = state.message;
  element('log').textContent = state.log;
  element('details').hidden = !state.log.trim();
  element<HTMLButtonElement>('retry').focus();
}

element('retry').addEventListener('click', () => {
  render({ phase: 'starting' });
  void bridge?.retry();
});
element('logs').addEventListener('click', () => void bridge?.openLogs());
element('data').addEventListener('click', () => void bridge?.openDataFolder());
element('quit').addEventListener('click', () => void bridge?.quit());

bridge?.onState(render);
void bridge?.getState().then(render);
