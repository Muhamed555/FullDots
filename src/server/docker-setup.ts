// Guided Docker setup for Dot computers: check, start or install Docker, then build and start the
// computer supervisor. Used by the Computer panel (docker-setup-routes.ts) and by Dots through the
// approval gate (docker-tools.ts). Every step runs only the commands listed for it in
// docker-commands.ts, and only after the caller repeats exactly those commands as approved.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformConfig } from './platform-config.js';
import {
  COMPOSE_BUILD,
  COMPOSE_FILE,
  COMPOSE_UP,
  DOCKER_INFO,
  DOCKER_VERSION,
  installCommand,
  launchCommand,
  planFor,
  show,
  type Command,
} from './docker-commands.js';
import { envValue, upsertEnv } from './env-file.js';
import {
  DOCKER_STEPS,
  type DockerJob,
  type DockerSetupStatus,
  type DockerState,
  type DockerStep,
} from '../shared/docker-setup-types.js';

export interface RunResult {
  /** The exit code; null when the program could not be started. */
  code: number | null;
  output: string;
}
export type Runner = (
  command: Command,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onData: (text: string) => void;
  },
) => Promise<RunResult>;

export type SupervisorState = 'not_set_up' | 'reachable' | 'unreachable';

const OUTPUT_TAIL = 4000;
const READY_POLLS = 45;
const READY_POLL_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:4312';
const DETAILS = 'See Technical details for what Docker reported.';

/** A step that stopped for a reason the owner can act on; its message is shown as is. */
class StepFailed extends Error {}

/** Offered only where FullDots runs on the owner's own machine, from a checkout that has the compose file. */
export function dockerSetupEnabled(options: {
  host: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  inContainer?: boolean;
}): boolean {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  return (
    (env.DOCKER_SETUP ?? 'auto').toLowerCase() !== 'off' &&
    ['127.0.0.1', '::1', 'localhost'].includes(options.host) &&
    !(options.inContainer ?? existsSync('/.dockerenv')) &&
    existsSync(join(cwd, COMPOSE_FILE))
  );
}

export const spawnRunner: Runner = (command, { cwd, env, onData }) =>
  new Promise((resolve) => {
    let output = '';
    try {
      const child = spawn(command.file, [...command.args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: !!command.detached,
        stdio: command.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output += text;
        onData(text);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) =>
        resolve({ code: null, output: error.message }),
      );
      if (command.detached) {
        child.once('spawn', () => {
          child.unref();
          resolve({ code: 0, output: '' });
        });
      } else child.once('close', (code) => resolve({ code, output }));
    } catch (error) {
      resolve({
        code: null,
        output: error instanceof Error ? error.message : 'Could not start.',
      });
    }
  });

export interface DockerSetupOptions {
  /** The running server's config: updated in place once computers are created, so no restart is needed. */
  config: PlatformConfig;
  enabled: boolean;
  cwd?: string;
  platform?: NodeJS.Platform;
  run?: Runner;
  /** The pause between "is Docker up yet" checks while starting it. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DockerSetup {
  private docker: DockerState = 'unknown';
  private job?: DockerJob;
  private current?: Promise<void>;
  private readonly cwd: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: Runner;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DockerSetupOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? spawnRunner;
    this.sleep = options.sleep ?? delay;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  status(): DockerSetupStatus {
    return {
      enabled: this.enabled,
      platform:
        (['win32', 'darwin', 'linux'] as const).find(
          (name) => name === this.platform,
        ) ?? 'other',
      docker: this.docker,
      plans: DOCKER_STEPS.map((step) => planFor(step, this.platform)),
      ...(this.job ? { job: { ...this.job } } : {}),
    };
  }

  /** The commands a step runs here: what the owner approves, in the panel or on an approval card. */
  commandsFor(step: DockerStep): string[] {
    return planFor(step, this.platform).commands;
  }

  /** Whether the computer service is configured and answering. Runs no command. */
  async supervisor(): Promise<SupervisorState> {
    const { computerSupervisorUrl, computerSupervisorToken, computerToken } =
      this.options.config;
    const url = computerSupervisorUrl?.trim();
    if (!url || !computerSupervisorToken?.trim() || !computerToken?.trim())
      return 'not_set_up';
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${url.replace(/\/$/, '')}/health`,
        { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
      );
      return response.ok ? 'reachable' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  /** Starts a step once `approved` repeats the commands it runs. Returns at once; follow it with `status()` or `settled()`. */
  start(step: DockerStep, approved: readonly string[]): DockerJob {
    if (!this.enabled)
      throw new Error('Guided Docker setup is not available here.');
    if (this.job?.state === 'running')
      throw new Error('Another setup step is still running.');
    const plan = planFor(step, this.platform);
    if (!plan.supported)
      throw new Error('This step cannot be done automatically on this system.');
    if (
      approved.length !== plan.commands.length ||
      approved.some((command, index) => command !== plan.commands[index])
    )
      throw new Error('The approved commands do not match this step.');
    const job: DockerJob = {
      id: randomUUID(),
      step,
      state: 'running',
      output: '',
      message: `${plan.title}…`,
    };
    this.job = job;
    this.current = this.execute(job);
    return { ...job };
  }

  /** Waits up to `ms` for the job with this id to end; returns the job as it is then. */
  async settled(id: string, ms: number): Promise<DockerJob | undefined> {
    if (this.job?.id === id && this.job.state === 'running' && this.current) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.current,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.job?.id === id ? { ...this.job } : undefined;
  }

  private async execute(job: DockerJob): Promise<void> {
    try {
      job.message = await this.steps[job.step](job);
      job.state = 'done';
    } catch (error) {
      job.message =
        error instanceof StepFailed
          ? error.message
          : `The step stopped unexpectedly. ${DETAILS}`;
      if (!(error instanceof StepFailed))
        this.append(job, error instanceof Error ? error.message : '');
      job.state = 'failed';
    }
  }

  private readonly steps: Record<
    DockerStep,
    (job: DockerJob) => Promise<string>
  > = {
    check: async (job) => {
      const state = await this.probe(job);
      if (state === 'ready') return 'Docker is installed and running.';
      if (state === 'stopped') return 'Docker is installed but not running.';
      return 'Docker is not installed.';
    },
    'start-docker': async (job) => {
      const launch = launchCommand(this.platform)!;
      const started = await this.exec(job, launch);
      if (started.code !== 0) {
        this.docker = 'unknown';
        throw new StepFailed(
          'Docker Desktop could not be opened. Is it installed?',
        );
      }
      // Docker Desktop takes a while to come up; these repeats of `docker info` stay out of the output.
      for (let attempt = 0; attempt < READY_POLLS; attempt++) {
        await this.sleep(READY_POLL_MS);
        if ((await this.quiet(DOCKER_INFO)).code === 0) {
          this.docker = 'ready';
          return 'Docker is running.';
        }
      }
      this.docker = 'stopped';
      throw new StepFailed(
        'Docker did not answer in time. Finish Docker Desktop’s start-up window, then check again.',
      );
    },
    'install-docker': async (job) => {
      const result = await this.exec(job, installCommand(this.platform)!);
      this.docker = 'unknown';
      if (result.code !== 0)
        throw new StepFailed(`The installer did not finish. ${DETAILS}`);
      return 'Docker Desktop is installed. Restart your computer if it asks you to, then start Docker.';
    },
    'create-computers': async (job) => {
      if ((await this.exec(job, DOCKER_INFO)).code !== 0) {
        this.docker = 'stopped';
        throw new StepFailed('Docker is not running. Start it first.');
      }
      this.docker = 'ready';
      const values = this.computerSettings();
      // Given to Compose through the environment, so the secrets never appear in a command or its
      // output. Compose's bake builder reads the pinned OpenBot git URL as a local path on Windows.
      const env = { ...process.env, ...values, COMPOSE_BAKE: 'false' };
      for (const command of [COMPOSE_BUILD, COMPOSE_UP])
        if ((await this.exec(job, command, env)).code !== 0)
          throw new StepFailed(`Docker could not finish. ${DETAILS}`);
      // Last: `npm run dev` restarts the server when .env changes, which would end a running step.
      this.adopt(values);
      return 'Dot computers are ready. Turn one on from its Computer panel.';
    },
  };

  private async probe(job: DockerJob): Promise<DockerState> {
    if ((await this.exec(job, DOCKER_VERSION)).code !== 0)
      return (this.docker = 'not_installed');
    const running = (await this.exec(job, DOCKER_INFO)).code === 0;
    return (this.docker = running ? 'ready' : 'stopped');
  }

  private append(job: DockerJob, text: string) {
    job.output = (job.output + text).slice(-OUTPUT_TAIL);
  }
  private exec(job: DockerJob, command: Command, env = process.env) {
    this.append(job, `> ${show(command)}\n`);
    return this.run(command, {
      cwd: this.cwd,
      env,
      onData: (text) => this.append(job, text),
    });
  }
  private quiet(command: Command) {
    return this.run(command, {
      cwd: this.cwd,
      env: process.env,
      onData: () => {},
    });
  }

  private envPath() {
    return join(this.cwd, '.env');
  }
  private readEnv() {
    const file = this.envPath();
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  /** The COMPUTER_* values to use: the running server's, else those already in .env, else new ones. */
  private computerSettings(): Record<string, string> {
    const { config } = this.options;
    const file = this.readEnv();
    const pick = (
      key: string,
      current: string | undefined,
      make: () => string,
    ) => current?.trim() || envValue(file, key) || make();
    const secret = () => randomBytes(32).toString('hex');
    return {
      COMPUTER_SUPERVISOR_URL: pick(
        'COMPUTER_SUPERVISOR_URL',
        config.computerSupervisorUrl,
        () => DEFAULT_SUPERVISOR_URL,
      ),
      COMPUTER_SUPERVISOR_TOKEN: pick(
        'COMPUTER_SUPERVISOR_TOKEN',
        config.computerSupervisorToken,
        secret,
      ),
      COMPUTER_TOKEN: pick('COMPUTER_TOKEN', config.computerToken, secret),
      COMPUTER_NAMESPACE: pick(
        'COMPUTER_NAMESPACE',
        config.computerNamespace,
        () => 'opendots',
      ),
    };
  }

  /** Saves the values to .env, keeping every other line, and gives them to the running server. */
  private adopt(values: Record<string, string>) {
    writeFileSync(this.envPath(), upsertEnv(this.readEnv(), values));
    Object.assign(this.options.config, {
      computerSupervisorUrl: values.COMPUTER_SUPERVISOR_URL,
      computerSupervisorToken: values.COMPUTER_SUPERVISOR_TOKEN,
      computerToken: values.COMPUTER_TOKEN,
      computerNamespace: values.COMPUTER_NAMESPACE,
    });
  }
}
