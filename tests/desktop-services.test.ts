// What the desktop app sets up beside the server: a browser for the page reader, and the files the
// guided Docker setup for Dot computers needs. (desktop/src/main)
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserCandidates,
  findBrowser,
} from '../desktop/src/main/browser-finder';
import {
  COMPOSE_FILE,
  DOCKERIGNORE,
  syncComputerKit,
} from '../desktop/src/main/computer-kit';
import { serverEnv } from '../desktop/src/main/server-env';
import { COMPOSE_FILE as SERVER_COMPOSE_FILE } from '../src/server/docker-commands';
import { dockerSetupEnabled } from '../src/server/docker-setup';

const temp = () => mkdtempSync(join(tmpdir(), 'fulldots-desktop-'));

describe('A browser for the page reader', () => {
  const windows = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  };

  it('prefers Edge on Windows, where it is always installed', () => {
    const edge =
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(browserCandidates('win32', windows)[0]).toBe(edge);
    expect(findBrowser('win32', windows, (file) => file === edge)).toBe(edge);
  });

  it('falls back to Chrome, also when it is installed for one person only', () => {
    const chrome =
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(findBrowser('win32', windows, (file) => file === chrome)).toBe(
      chrome,
    );
  });

  it('knows where browsers live on macOS and Linux', () => {
    expect(
      findBrowser('darwin', {}, (file) => file.includes('Google Chrome')),
    ).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(
      findBrowser('linux', {}, (file) => file === '/usr/bin/chromium'),
    ).toBe('/usr/bin/chromium');
  });

  it('finds nothing where no browser is installed', () => {
    expect(findBrowser('win32', windows, () => false)).toBeUndefined();
    // No environment to build a path from: nothing to try.
    expect(browserCandidates('win32', {})).toEqual([]);
  });
});

describe('The computer setup files in the data folder', () => {
  const kit = () => {
    const folder = temp();
    writeFileSync(join(folder, COMPOSE_FILE), 'services: {}\n');
    mkdirSync(join(folder, 'deployment', 'computers', 'desktop'), {
      recursive: true,
    });
    writeFileSync(
      join(folder, 'deployment', 'computers', 'computer.Dockerfile'),
      'FROM scratch\n',
    );
    writeFileSync(
      join(folder, 'deployment', 'computers', 'desktop', 'start.sh'),
      '#!/bin/sh\n',
    );
    return folder;
  };

  it('uses the compose file name the server looks for', () => {
    expect(COMPOSE_FILE).toBe(SERVER_COMPOSE_FILE);
  });

  it('copies the kit so the guided setup is offered from the data folder', () => {
    const home = join(temp(), 'workspace');
    expect(dockerSetupEnabled({ host: '127.0.0.1', cwd: home, env: {} })).toBe(
      false,
    );
    expect(syncComputerKit(kit(), home)).toBe(true);
    expect(
      existsSync(join(home, 'deployment', 'computers', 'desktop', 'start.sh')),
    ).toBe(true);
    expect(
      dockerSetupEnabled({
        host: '127.0.0.1',
        cwd: home,
        env: {},
        inContainer: false,
      }),
    ).toBe(true);
  });

  it('never lets a build send the workspace itself to Docker', () => {
    const home = temp();
    mkdirSync(join(home, 'data'));
    writeFileSync(join(home, 'data', 'opendots.sqlite'), 'private');
    writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=secret\n');
    syncComputerKit(kit(), home);
    const ignore = readFileSync(join(home, '.dockerignore'), 'utf8');
    expect(ignore).toBe(DOCKERIGNORE);
    const rules = ignore
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    // Everything is left out, and only the build files are let back in.
    expect(rules).toEqual(['*', '!deployment']);
    // The person's own files are untouched.
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('secret');
  });

  it('brings newer files with a newer app, and reports a build without a kit', () => {
    const home = temp();
    const first = kit();
    syncComputerKit(first, home);
    writeFileSync(join(first, COMPOSE_FILE), 'services: { newer: {} }\n');
    syncComputerKit(first, home);
    expect(readFileSync(join(home, COMPOSE_FILE), 'utf8')).toContain('newer');
    expect(syncComputerKit(temp(), temp())).toBe(false);
  });
});

describe('What the shell provides to the server', () => {
  const options = {
    base: {},
    userEnv: {},
    port: 4390,
    clientDir: '/app/client',
    databasePath: '/data/db.sqlite',
    version: '2.0.0',
  };

  it('points the server at the page reader it started', () => {
    const env = serverEnv({
      ...options,
      provided: { BROWSER_URL: 'http://127.0.0.1:4391', BROWSER_SECRET: 's' },
    });
    expect(env.BROWSER_URL).toBe('http://127.0.0.1:4391');
    expect(env.BROWSER_SECRET).toBe('s');
  });

  it('lets .env name another page reader', () => {
    const env = serverEnv({
      ...options,
      provided: { BROWSER_URL: 'http://127.0.0.1:4391', BROWSER_SECRET: 's' },
      userEnv: {
        BROWSER_URL: 'http://reader.internal',
        BROWSER_SECRET: 'mine',
      },
    });
    expect(env.BROWSER_URL).toBe('http://reader.internal');
    expect(env.BROWSER_SECRET).toBe('mine');
  });

  it('gives its Dot computers a compose project of their own', () => {
    expect(serverEnv(options).COMPOSE_PROJECT_NAME).toBe('fulldots-desktop');
    expect(
      serverEnv({ ...options, userEnv: { COMPOSE_PROJECT_NAME: 'mine' } })
        .COMPOSE_PROJECT_NAME,
    ).toBe('mine');
  });
});
