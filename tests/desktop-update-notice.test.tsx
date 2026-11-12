// The web app's side of FullDots Desktop: the bridge contract and the update notice.
// @vitest-environment node
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopUpdateNotice,
  updateNotice,
} from '../src/client/desktop/DesktopUpdateNotice';
import {
  asDesktopUpdate,
  desktopBridge,
  DESKTOP_UPDATE_STATUSES,
  type DesktopBridge,
  type DesktopUpdate,
} from '../src/shared/desktop-bridge';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function fakeBridge(initial: DesktopUpdate) {
  let listener: ((update: DesktopUpdate) => void) | undefined;
  const bridge: DesktopBridge = {
    platform: 'win32',
    version: '2.0.0',
    getUpdate: vi.fn(async () => initial),
    checkForUpdates: vi.fn(async () => initial),
    installUpdate: vi.fn(async () => {}),
    onUpdate: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return { bridge, push: (update: DesktopUpdate) => listener?.(update) };
}

async function render(bridge?: DesktopBridge) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DesktopUpdateNotice bridge={bridge} />);
  });
  return renderer;
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe('Update notice', () => {
  it('renders nothing in a browser', async () => {
    expect(desktopBridge()).toBeUndefined();
    expect((await render()).toJSON()).toBeNull();
  });

  it('stays out of the way until there is something to do', async () => {
    for (const status of [
      'idle',
      'checking',
      'current',
      'downloading',
    ] as const)
      expect((await render(fakeBridge({ status }).bridge)).toJSON()).toBeNull();
    const failed = fakeBridge({ status: 'error', message: 'offline' });
    expect((await render(failed.bridge)).toJSON()).toBeNull();
  });

  it('offers a restart when an update has been downloaded', async () => {
    const { bridge } = fakeBridge({ status: 'ready', version: '2.1.0' });
    const renderer = await render(bridge);
    expect(text(renderer)).toContain('FullDots 2.1.0 is ready');
    const restart = renderer.root.findByProps({ className: 'primary' });
    expect(restart.props.children).toBe('Restart');
    await act(async () => restart.props.onClick());
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });

  it('offers the download page where the app cannot install for itself', async () => {
    const { bridge } = fakeBridge({
      status: 'available',
      version: '2.1.0',
      url: 'https://github.com/asasemahmed/FullDots/releases/tag/v2.1.0',
    });
    const renderer = await render(bridge);
    expect(text(renderer)).toContain('FullDots 2.1.0 is available');
    expect(
      renderer.root.findByProps({ className: 'primary' }).props.children,
    ).toBe('Download');
  });

  it('appears when the shell reports an update while the app is open', async () => {
    const { bridge, push } = fakeBridge({ status: 'checking' });
    const renderer = await render(bridge);
    expect(renderer.toJSON()).toBeNull();
    await act(async () => push({ status: 'ready', version: '2.1.0' }));
    expect(text(renderer)).toContain('FullDots 2.1.0 is ready');
  });

  it('hides with Later, and returns for a newer version', async () => {
    const { bridge, push } = fakeBridge({ status: 'ready', version: '2.1.0' });
    const renderer = await render(bridge);
    await act(async () =>
      renderer.root.findByProps({ 'aria-label': 'Later' }).props.onClick(),
    );
    expect(renderer.toJSON()).toBeNull();
    await act(async () => push({ status: 'ready', version: '2.2.0' }));
    expect(text(renderer)).toContain('FullDots 2.2.0 is ready');
  });

  it('still makes sense when the updater gives no version number', () => {
    expect(updateNotice({ status: 'ready', version: '' })?.title).toBe(
      'A new version of FullDots is ready',
    );
  });
});

describe('Desktop bridge contract', () => {
  it('accepts every update state the shell can send', () => {
    const samples: Record<DesktopUpdate['status'], DesktopUpdate> = {
      idle: { status: 'idle' },
      checking: { status: 'checking' },
      current: { status: 'current' },
      downloading: { status: 'downloading' },
      ready: { status: 'ready', version: '2.1.0' },
      available: {
        status: 'available',
        version: '2.1.0',
        url: 'https://x.test/',
      },
      error: { status: 'error', message: 'offline' },
    };
    for (const status of DESKTOP_UPDATE_STATUSES)
      expect(asDesktopUpdate(samples[status])).toEqual(samples[status]);
  });

  it('drops anything malformed instead of showing it', () => {
    for (const value of [
      null,
      'ready',
      { status: 'unknown' },
      { status: 'available', version: '2.1.0' },
      { status: 'available', url: 'https://x.test/' },
    ])
      expect(asDesktopUpdate(value)).toBeUndefined();
    // Extra fields do not travel.
    expect(asDesktopUpdate({ status: 'current', html: '<b>x</b>' })).toEqual({
      status: 'current',
    });
  });
});
