import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DockerSetup,
  dockerSetupEnabled,
  planFor,
  upsertEnv,
  type Runner,
} from '../src/server/docker-setup';
import { dockerSetupRoutes } from '../src/server/docker-setup-routes';
import type { PlatformConfig } from '../src/server/platform-config';
import type { DockerStep } from '../src/shared/docker-setup-types';

const config = (): PlatformConfig => ({ baseUrl: 'http://x', voiceName: 'm' });
/** Answers each command from a table keyed by a piece of its text, and records what ran. */
function fake(answers: Record<string, number> = {}) {
  const ran: string[] = [];
  const run: Runner = async (command) => {
    const text = [command.file, ...command.args].join(' ');
    ran.push(text);
    const hit = Object.keys(answers).find((key) => text.includes(key));
    return { code: hit ? answers[hit]! : 0, output: '' };
  };
  return { ran, run };
}
const setupWith = (
  answers: Record<string, number>,
  platform: NodeJS.Platform = 'win32',
  extra: { cwd?: string; config?: PlatformConfig; enabled?: boolean } = {},
) => {
  const runner = fake(answers);
  const setup = new DockerSetup({
    config: extra.config ?? config(),
    enabled: extra.enabled ?? true,
    platform,
    run: runner.run,
    sleep: async () => {},
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
  });
  return { setup, ...runner };
};
const finished = async (setup: DockerSetup) => {
  for (let i = 0; i < 50 && setup.status().job?.state === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  return setup.status().job!;
};
const approve = (step: DockerStep, platform: NodeJS.Platform = 'win32') =>
  planFor(step, platform).commands;

describe('Docker setup', () => {
  it('runs nothing until the exact commands are approved', () => {
    const { setup, ran } = setupWith({});
    expect(() => setup.start('check', [])).toThrow(/do not match/);
    expect(() => setup.start('check', ['docker --version'])).toThrow(
      /do not match/,
    );
    expect(() => setup.start('check', ['rm -rf /', 'x'])).toThrow(
      /do not match/,
    );
    expect(ran).toEqual([]);
  });

  it('reports Docker as missing, stopped or ready', async () => {
    const missing = setupWith({ '--version': 1 });
    missing.setup.start('check', approve('check'));
    expect((await finished(missing.setup)).message).toMatch(/not installed/);
    expect(missing.setup.status().docker).toBe('not_installed');

    const stopped = setupWith({ info: 1 });
    stopped.setup.start('check', approve('check'));
    await finished(stopped.setup);
    expect(stopped.setup.status().docker).toBe('stopped');

    const ready = setupWith({});
    ready.setup.start('check', approve('check'));
    await finished(ready.setup);
    expect(ready.setup.status().docker).toBe('ready');
  });

  it('starts Docker Desktop and waits for it to answer', async () => {
    let infoCalls = 0;
    const ran: string[] = [];
    const setup = new DockerSetup({
      config: config(),
      enabled: true,
      platform: 'darwin',
      sleep: async () => {},
      run: async (command) => {
        ran.push([command.file, ...command.args].join(' '));
        const info = command.args[0] === 'info';
        if (info) infoCalls++;
        return { code: info && infoCalls < 3 ? 1 : 0, output: '' };
      },
    });
    setup.start('start-docker', approve('start-docker', 'darwin'));
    const job = await finished(setup);
    expect(job.state).toBe('done');
    expect(ran[0]).toBe('open -a Docker');
    expect(infoCalls).toBe(3);
    expect(setup.status().docker).toBe('ready');
  });

  it('installs with winget on Windows and not at all on Linux', async () => {
    const { setup, ran } = setupWith({});
    setup.start('install-docker', approve('install-docker'));
    expect((await finished(setup)).state).toBe('done');
    expect(ran).toEqual([
      'winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements',
    ]);
    const linux = setupWith({}, 'linux');
    expect(planFor('install-docker', 'linux').supported).toBe(false);
    expect(() => linux.setup.start('install-docker', [])).toThrow(
      /cannot be done automatically/,
    );
  });

  it('creates the computers: writes .env, keeps owner values, builds and starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-docker-'));
    writeFileSync(join(dir, '.env'), 'PORT=4310\nCOMPUTER_NAMESPACE=mine\n');
    const platformConfig = config();
    const { setup, ran } = setupWith({}, 'win32', {
      cwd: dir,
      config: platformConfig,
    });
    setup.start('check', approve('check'));
    await finished(setup);
    ran.length = 0;
    setup.start('create-computers', approve('create-computers'));
    expect((await finished(setup)).state).toBe('done');
    expect(ran).toEqual([
      'docker compose -f compose.computers.yml build computer-image computer-supervisor',
      'docker compose -f compose.computers.yml up -d computer-supervisor',
    ]);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toContain('PORT=4310');
    expect(env).toContain('COMPUTER_NAMESPACE=mine');
    expect(env).toContain('COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312');
    const token = /^COMPUTER_TOKEN=(\w+)$/m.exec(env)![1]!;
    const supervisor = /^COMPUTER_SUPERVISOR_TOKEN=(\w+)$/m.exec(env)![1]!;
    expect(token).toHaveLength(64);
    expect(supervisor).toHaveLength(64);
    expect(token).not.toBe(supervisor);
    // The running server picks the values up without a restart, and secrets never reach the output.
    expect(platformConfig.computerToken).toBe(token);
    expect(platformConfig.computerNamespace).toBe('mine');
    expect(setup.status().job!.output).not.toContain(token);
  });

  it('writes .env only after the build and start succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-docker-'));
    const { setup } = setupWith({ build: 1 }, 'win32', { cwd: dir });
    setup.start('check', approve('check'));
    await finished(setup);
    setup.start('create-computers', approve('create-computers'));
    expect((await finished(setup)).state).toBe('failed');
    expect(() => readFileSync(join(dir, '.env'), 'utf8')).toThrow();
  });

  it('refuses to create computers while Docker is not known to be running', async () => {
    const { setup, ran } = setupWith({});
    setup.start('create-computers', approve('create-computers'));
    const job = await finished(setup);
    expect(job.state).toBe('failed');
    expect(ran).toEqual([]);
  });

  it('runs one step at a time and does nothing when disabled', () => {
    const { setup } = setupWith({});
    setup.start('check', approve('check'));
    expect(() => setup.start('check', approve('check'))).toThrow(
      /still running/,
    );
    const off = setupWith({}, 'win32', { enabled: false });
    expect(() => off.setup.start('check', approve('check'))).toThrow(
      /not available/,
    );
  });

  it('sets .env lines without touching comments', () => {
    expect(upsertEnv('A=1\n# B=old\nB=\n', { B: '2', C: '3' })).toBe(
      'A=1\n# B=old\nB=2\nC=3\n',
    );
    expect(upsertEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('is only offered to a local owner outside a container', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-docker-'));
    const base = { host: '127.0.0.1', cwd: dir, inContainer: false };
    expect(dockerSetupEnabled(base)).toBe(false);
    writeFileSync(join(dir, 'compose.computers.yml'), '');
    expect(dockerSetupEnabled(base)).toBe(true);
    expect(dockerSetupEnabled({ ...base, host: '0.0.0.0' })).toBe(false);
    expect(dockerSetupEnabled({ ...base, inContainer: true })).toBe(false);
    expect(dockerSetupEnabled({ ...base, env: { DOCKER_SETUP: 'off' } })).toBe(
      false,
    );
  });
});

describe('Docker setup routes', () => {
  const post = (
    app: ReturnType<typeof dockerSetupRoutes>,
    step: string,
    body: unknown,
  ) =>
    app.request(`/docker/setup/${step}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('lists the plans and starts only an approved step', async () => {
    const { setup, ran } = setupWith({});
    const app = dockerSetupRoutes(setup);
    const status = await (await app.request('/docker/setup')).json();
    expect(status.plans.map((plan: { step: string }) => plan.step)).toEqual([
      'check',
      'start-docker',
      'install-docker',
      'create-computers',
    ]);
    expect((await post(app, 'check', { approve: ['nope'] })).status).toBe(409);
    expect((await post(app, 'rm', { approve: [] })).status).toBe(400);
    expect((await post(app, 'check', { approve: [], extra: 1 })).status).toBe(
      400,
    );
    expect(ran).toEqual([]);
    expect(
      (await post(app, 'check', { approve: approve('check') })).status,
    ).toBe(200);
  });
});
