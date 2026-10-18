import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DockerSetup,
  dockerSetupEnabled,
  type Runner,
} from '../src/server/docker-setup';
import { planFor } from '../src/server/docker-commands';
import { envValue, upsertEnv } from '../src/server/env-file';
import { dockerSetupRoutes } from '../src/server/docker-setup-routes';
import type { PlatformConfig } from '../src/server/platform-config';
import type { DockerStep } from '../src/shared/docker-setup-types';

const tempDir = () => mkdtempSync(join(tmpdir(), 'fulldots-docker-'));
const baseConfig = (): PlatformConfig => ({
  baseUrl: 'http://x',
  voiceName: 'm',
});

/** Exit codes keyed by a piece of the command text (0 otherwise); records every command that ran. */
function fakeRunner(answers: Record<string, number> = {}) {
  const ran: string[] = [];
  const run: Runner = async (command) => {
    const text = [command.file, ...command.args].join(' ');
    ran.push(text);
    const hit = Object.keys(answers).find((key) => text.includes(key));
    return { code: hit === undefined ? 0 : answers[hit]!, output: 'log\n' };
  };
  return { ran, run };
}

function makeSetup(
  answers: Record<string, number> = {},
  options: {
    platform?: NodeJS.Platform;
    cwd?: string;
    config?: PlatformConfig;
    enabled?: boolean;
  } = {},
) {
  const runner = fakeRunner(answers);
  const config = options.config ?? baseConfig();
  const cwd = options.cwd ?? tempDir();
  const setup = new DockerSetup({
    config,
    enabled: options.enabled ?? true,
    platform: options.platform ?? 'win32',
    cwd,
    run: runner.run,
    sleep: async () => {},
  });
  return { setup, config, cwd, ...runner };
}

const approved = (step: DockerStep, platform: NodeJS.Platform = 'win32') =>
  planFor(step, platform).commands;

async function runStep(setup: DockerSetup, step: DockerStep) {
  const job = setup.start(step, setup.commandsFor(step));
  return (await setup.settled(job.id, 5000))!;
}

describe('Docker setup steps', () => {
  it('runs nothing unless the exact commands are approved', () => {
    const { setup, ran } = makeSetup();
    expect(() => setup.start('check', [])).toThrow(/do not match/);
    expect(() => setup.start('check', ['docker --version'])).toThrow(
      /do not match/,
    );
    expect(() => setup.start('check', ['rm -rf /', 'whoami'])).toThrow(
      /do not match/,
    );
    expect(ran).toEqual([]);
  });

  it('reports Docker as not installed, stopped or running', async () => {
    const missing = makeSetup({ '--version': 1 });
    expect((await runStep(missing.setup, 'check')).message).toMatch(
      /not installed/,
    );
    expect(missing.setup.status().docker).toBe('not_installed');

    const stopped = makeSetup({ info: 1 });
    await runStep(stopped.setup, 'check');
    expect(stopped.setup.status().docker).toBe('stopped');

    const ready = makeSetup();
    await runStep(ready.setup, 'check');
    expect(ready.setup.status().docker).toBe('ready');
  });

  it('opens Docker Desktop and waits until Docker answers', async () => {
    let infoCalls = 0;
    const ran: string[] = [];
    const setup = new DockerSetup({
      config: baseConfig(),
      enabled: true,
      platform: 'darwin',
      cwd: tempDir(),
      sleep: async () => {},
      run: async (command) => {
        ran.push([command.file, ...command.args].join(' '));
        const info = command.args[0] === 'info';
        if (info) infoCalls++;
        return { code: info && infoCalls < 3 ? 1 : 0, output: '' };
      },
    });
    const job = await runStep(setup, 'start-docker');
    expect(job.state).toBe('done');
    expect(ran[0]).toBe('open -a Docker');
    expect(infoCalls).toBe(3);
    expect(setup.status().docker).toBe('ready');
    // The repeated checks stay out of the output.
    expect(job.output).toBe('> open -a Docker\n');
  });

  it('installs with winget on Windows and leaves Linux to the owner', async () => {
    const { setup, ran } = makeSetup();
    expect((await runStep(setup, 'install-docker')).state).toBe('done');
    expect(ran).toEqual([
      'winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements',
    ]);
    expect(planFor('install-docker', 'linux').supported).toBe(false);
    const linux = makeSetup({}, { platform: 'linux' });
    expect(() => linux.setup.start('install-docker', [])).toThrow(
      /cannot be done automatically/,
    );
  });

  it('creates computers: checks Docker, builds, starts, then saves .env and the running config', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'PORT=4310\nCOMPUTER_NAMESPACE="mine"\n');
    const { setup, config, ran } = makeSetup({}, { cwd });
    const job = await runStep(setup, 'create-computers');
    expect(job.state).toBe('done');
    expect(ran).toEqual([
      'docker info --format {{.ServerVersion}}',
      'docker compose -f compose.computers.yml build computer-image computer-supervisor',
      'docker compose -f compose.computers.yml up -d computer-supervisor',
    ]);
    const env = readFileSync(join(cwd, '.env'), 'utf8');
    expect(env).toContain('PORT=4310');
    expect(envValue(env, 'COMPUTER_NAMESPACE')).toBe('mine');
    expect(envValue(env, 'COMPUTER_SUPERVISOR_URL')).toBe(
      'http://127.0.0.1:4312',
    );
    const token = envValue(env, 'COMPUTER_TOKEN')!;
    const supervisor = envValue(env, 'COMPUTER_SUPERVISOR_TOKEN')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(supervisor).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(supervisor);
    expect(config.computerToken).toBe(token);
    expect(config.computerNamespace).toBe('mine');
    expect(job.output).not.toContain(token);
  });

  it('changes nothing when Docker is not running or the build fails', async () => {
    for (const failing of ['info', 'build']) {
      const { setup, config, cwd, ran } = makeSetup({ [failing]: 1 });
      const job = await runStep(setup, 'create-computers');
      expect(job.state).toBe('failed');
      expect(existsSync(join(cwd, '.env'))).toBe(false);
      expect(config.computerToken).toBeUndefined();
      expect(ran.some((command) => command.includes(' up '))).toBe(false);
    }
  });

  it('runs one step at a time and nothing when disabled', async () => {
    const { setup } = makeSetup();
    const job = setup.start('check', approved('check'));
    expect(() => setup.start('check', approved('check'))).toThrow(
      /still running/,
    );
    await setup.settled(job.id, 5000);
    const off = makeSetup({}, { enabled: false });
    expect(() => off.setup.start('check', approved('check'))).toThrow(
      /not available/,
    );
  });

  it('hands out copies, so callers cannot change a job', async () => {
    const { setup } = makeSetup();
    const job = setup.start('check', approved('check'));
    job.state = 'done';
    expect(setup.status().job?.state).toBe('running');
    await setup.settled(job.id, 5000);
  });
});

describe('.env helpers', () => {
  it('sets active lines and leaves comments alone', () => {
    expect(upsertEnv('A=1\n# B=old\nB=\n', { B: '2', C: '3' })).toBe(
      'A=1\n# B=old\nB=2\nC=3\n',
    );
    expect(upsertEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });
  it('reads unquoted values and ignores empty or commented ones', () => {
    expect(envValue('A="x y"\n', 'A')).toBe('x y');
    expect(envValue("A='z'\n", 'A')).toBe('z');
    expect(envValue('A=\n', 'A')).toBeUndefined();
    expect(envValue('# A=1\n', 'A')).toBeUndefined();
  });
});

describe('Where the setup is offered', () => {
  it('only for a local owner outside a container, from a checkout', () => {
    const cwd = tempDir();
    const base = { host: '127.0.0.1', cwd, inContainer: false };
    expect(dockerSetupEnabled(base)).toBe(false);
    writeFileSync(join(cwd, 'compose.computers.yml'), '');
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

  it('lists the plans and starts only an approved, known step', async () => {
    const { setup, ran } = makeSetup();
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
      (await post(app, 'check', { approve: approved('check') })).status,
    ).toBe(200);
  });
});
