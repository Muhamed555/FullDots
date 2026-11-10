// The desktop shell's decisions that need no window: where a link goes, what the server starts
// with, where the window reopens and which release is newer. (desktop/src/main)
import { describe, expect, it } from 'vitest';
import {
  classifyLink,
  isBlankPopup,
  isShellPage,
} from '../desktop/src/main/links';
import {
  DEFAULT_PORT,
  parseEnvFile,
  preferredPort,
  serverEnv,
} from '../desktop/src/main/server-env';
import {
  isNewerVersion,
  newerRelease,
  versionInName,
} from '../desktop/src/main/update-feed';
import {
  DEFAULT_SIZE,
  MIN_HEIGHT,
  MIN_WIDTH,
  restoreWindow,
} from '../desktop/src/main/window-state';

const APP = 'http://127.0.0.1:4390';

describe('Where a link goes from the desktop window', () => {
  it('keeps the app in the window and sends other sites to the browser', () => {
    expect(classifyLink(`${APP}/#/space/s1`, APP)).toBe('app');
    expect(classifyLink(`${APP}/api/files/f1`, APP)).toBe('app-api');
    expect(classifyLink('https://example.com/docs', APP)).toBe('external');
    expect(classifyLink('mailto:someone@example.com', APP)).toBe('external');
  });

  it('treats another port or host on this machine as another site', () => {
    expect(classifyLink('http://127.0.0.1:4310/', APP)).toBe('external');
    expect(classifyLink('http://localhost:4390/', APP)).toBe('external');
  });

  it('refuses anything that is not a web page or an email address', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'https://user:secret@example.com/',
      'not a url',
      '',
    ])
      expect(classifyLink(url, APP)).toBe('blocked');
  });

  it('knows the blank window a connector sign-in opens first', () => {
    expect(isBlankPopup('')).toBe(true);
    expect(isBlankPopup('about:blank')).toBe(true);
    expect(isBlankPopup('https://example.com/')).toBe(false);
  });
});

describe('Which pages the shell answers', () => {
  const bootUrl =
    'file:///C:/app/resources/app.asar/.vite/renderer/main_window/index.html';
  const pages = { appOrigin: APP, bootUrl };

  it('answers the app and its own boot screen', () => {
    expect(isShellPage(`${APP}/`, pages)).toBe('app');
    expect(isShellPage(`${bootUrl}?theme=dark`, pages)).toBe('boot');
    expect(
      isShellPage('http://localhost:5173/?theme=light', {
        bootUrl: 'http://localhost:5173/',
      }),
    ).toBe('boot');
  });

  it('answers no other page, on disk or on the web', () => {
    for (const url of [
      'https://example.com/',
      'file:///C:/Users/someone/Downloads/page.html',
      'http://127.0.0.1:4391/',
      'about:blank',
      undefined,
    ])
      expect(isShellPage(url, pages)).toBeUndefined();
    // Before the server is up there is no app origin to match.
    expect(isShellPage(`${APP}/`, { bootUrl })).toBeUndefined();
  });
});

describe('The environment the bundled server starts with', () => {
  const options = {
    base: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'from-shell',
      NODE_OPTIONS: '--inspect',
    },
    userEnv: {},
    port: 4390,
    clientDir: '/app/server/dist/client',
    databasePath: '/data/opendots.sqlite',
    version: '2.0.0',
  };

  it('always listens on this machine only, on the port the window opens', () => {
    const env = serverEnv({
      ...options,
      userEnv: {
        HOST: '0.0.0.0',
        PORT: '80',
        APP_ORIGIN: 'https://example.com',
        NODE_ENV: 'development',
        CLIENT_DIR: '/somewhere/else',
      },
    });
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe('4390');
    expect(env.NODE_ENV).toBe('production');
    expect(env.CLIENT_DIR).toBe('/app/server/dist/client');
    expect(env.APP_ORIGIN).toBeUndefined();
  });

  it('lets the data folder’s .env win over the shell’s environment', () => {
    const env = serverEnv({
      ...options,
      userEnv: { OPENAI_API_KEY: 'from-file', OPENAI_MODEL: 'acme/model-1' },
    });
    expect(env.OPENAI_API_KEY).toBe('from-file');
    expect(env.OPENAI_MODEL).toBe('acme/model-1');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps the database in the data folder unless .env moves it', () => {
    expect(serverEnv(options).DATABASE_PATH).toBe('/data/opendots.sqlite');
    expect(
      serverEnv({ ...options, userEnv: { DATABASE_PATH: 'elsewhere.sqlite' } })
        .DATABASE_PATH,
    ).toBe('elsewhere.sqlite');
  });

  it('never hands down options that change how the runtime starts', () => {
    const env = serverEnv({
      ...options,
      userEnv: { NODE_OPTIONS: '--require ./x.js', ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('reads .env the way the web app does', () => {
    expect(
      parseEnvFile(
        '# comment\nOPENAI_MODEL="acme/model-1"\nEMPTY=\nPORT=4500\n',
      ),
    ).toEqual({ OPENAI_MODEL: 'acme/model-1', PORT: '4500' });
  });

  it('prefers the port from .env, then the last one used, then its own', () => {
    expect(preferredPort({ PORT: '4500' }, 4391)).toBe(4500);
    expect(preferredPort({}, 4391)).toBe(4391);
    expect(preferredPort({})).toBe(DEFAULT_PORT);
    // A privileged or nonsense port falls through.
    expect(preferredPort({ PORT: '80' }, 4391)).toBe(4391);
    expect(preferredPort({ PORT: 'abc' })).toBe(DEFAULT_PORT);
    // Not the web app's default: a checkout running beside the desktop app keeps 4310.
    expect(DEFAULT_PORT).not.toBe(4310);
  });
});

describe('Where the window reopens', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };

  it('opens at the default size, centred, the first time', () => {
    expect(restoreWindow(undefined, [screen])).toEqual({
      bounds: DEFAULT_SIZE,
      maximized: false,
    });
  });

  it('comes back where it was', () => {
    const bounds = { x: 200, y: 120, width: 1400, height: 900 };
    expect(restoreWindow({ bounds, maximized: true }, [screen])).toEqual({
      bounds,
      maximized: true,
    });
  });

  it('forgets a position on a screen that is gone, but keeps the size', () => {
    const restored = restoreWindow(
      { bounds: { x: 2600, y: 100, width: 1200, height: 800 } },
      [screen],
    );
    expect(restored.bounds).toEqual({ width: 1200, height: 800 });
  });

  it('never opens smaller than the layout or larger than the screen', () => {
    const small = restoreWindow({ bounds: { width: 200, height: 100 } }, [
      screen,
    ]);
    expect(small.bounds).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
    const huge = restoreWindow({ bounds: { width: 9000, height: 9000 } }, [
      screen,
    ]);
    expect(huge.bounds).toEqual({ width: 1920, height: 1040 });
  });

  it('ignores a damaged settings file', () => {
    const restored = restoreWindow(
      { bounds: { x: Number.NaN, width: 'wide' as unknown as number } },
      [screen],
    );
    expect(restored.bounds).toEqual(DEFAULT_SIZE);
  });
});

describe('Which release is newer', () => {
  it('orders versions as semantic versions', () => {
    expect(isNewerVersion('2.1.0', '2.0.0')).toBe(true);
    expect(isNewerVersion('2.0.10', '2.0.9')).toBe(true);
    expect(isNewerVersion('v3.0.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '2.0.0')).toBe(false);
    expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false);
  });

  it('puts a release after its own pre-releases', () => {
    expect(isNewerVersion('2.1.0', '2.1.0-rc.1')).toBe(true);
    expect(isNewerVersion('2.1.0-rc.1', '2.1.0')).toBe(false);
    expect(isNewerVersion('2.1.0-rc.2', '2.1.0-rc.1')).toBe(true);
    expect(isNewerVersion('2.1.0-rc.10', '2.1.0-rc.9')).toBe(true);
  });

  it('never calls something it cannot read newer', () => {
    expect(isNewerVersion('latest', '2.0.0')).toBe(false);
    expect(isNewerVersion('2.1', '2.0.0')).toBe(false);
  });

  it('offers a newer GitHub release, on its own repository’s page', () => {
    expect(
      newerRelease(
        {
          tag_name: 'v2.1.0',
          html_url:
            'https://github.com/asasemahmed/FullDots/releases/tag/v2.1.0',
        },
        '2.0.0',
      ),
    ).toEqual({
      version: '2.1.0',
      url: 'https://github.com/asasemahmed/FullDots/releases/tag/v2.1.0',
    });
  });

  it('offers nothing for the same version, a draft or a pre-release', () => {
    expect(newerRelease({ tag_name: 'v2.0.0' }, '2.0.0')).toBeUndefined();
    expect(
      newerRelease({ tag_name: 'v2.1.0', prerelease: true }, '2.0.0'),
    ).toBeUndefined();
    expect(
      newerRelease({ tag_name: 'v2.1.0', draft: true }, '2.0.0'),
    ).toBeUndefined();
    expect(newerRelease(null, '2.0.0')).toBeUndefined();
  });

  it('never opens a page outside the repository’s releases', () => {
    expect(
      newerRelease(
        { tag_name: 'v2.1.0', html_url: 'https://example.com/installer.exe' },
        '2.0.0',
      )?.url,
    ).toBe('https://github.com/asasemahmed/FullDots/releases/latest');
  });

  it('finds the version in an updater’s release name', () => {
    expect(versionInName('2.1.0')).toBe('2.1.0');
    expect(versionInName('FullDots 2.1.0 — the flock')).toBe('2.1.0');
    expect(versionInName('The flock')).toBe('');
    expect(versionInName(undefined)).toBe('');
  });
});
