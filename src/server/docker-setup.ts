import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformConfig } from './platform-config.js';
import type {
  DockerJob,
  DockerPlan,
  DockerSetupStatus,
  DockerState,
  DockerStep,
} from '../shared/docker-setup-types.js';

/** One program run without a shell, so nothing the owner or a client sends is ever parsed as a command. */
interface Command {
  file: string;
  args: string[];
  /** Started and left running (Docker Desktop itself) instead of waited for. */
  detached?: boolean;
}
export interface RunResult {
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

const OUTPUT_TAIL = 4000;
const READY_POLLS = 45;
const READY_POLL_MS = 2000;
const SUPERVISOR_URL = 'http://127.0.0.1:4312';
const COMPOSE_FILE = 'compose.computers.yml';

const DOCKER_VERSION: Command = { file: 'docker', args: ['--version'] };
const DOCKER_INFO: Command = {
  file: 'docker',
  args: ['info', '--format', '{{.ServerVersion}}'],
};
const COMPOSE_BUILD: Command = {
  file: 'docker',
  args: [
    'compose',
    '-f',
    COMPOSE_FILE,
    'build',
    'computer-image',
    'computer-supervisor',
  ],
};
const COMPOSE_UP: Command = {
  file: 'docker',
  args: ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'computer-supervisor'],
};

/** What the setup is allowed to run on this system. Fixed lists: the route only picks a step. */
function launchCommand(platform: NodeJS.Platform): Command | undefined {
  if (platform === 'win32')
    return {
      file: join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'Docker',
        'Docker',
        'Docker Desktop.exe',
      ),
      args: [],
      detached: true,
    };
  if (platform === 'darwin')
    return { file: 'open', args: ['-a', 'Docker'], detached: true };
  return undefined;
}
function installCommand(platform: NodeJS.Platform): Command | undefined {
  if (platform === 'win32')
    return {
      file: 'winget',
      args: [
        'install',
        '-e',
        '--id',
        'Docker.DockerDesktop',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
    };
  if (platform === 'darwin')
    return { file: 'brew', args: ['install', '--cask', 'docker'] };
  return undefined;
}

const quote = (part: string) => (/[\s{}]/.test(part) ? `"${part}"` : part);
export const show = (command: Command) =>
  [command.file, ...command.args].map(quote).join(' ');

export function planFor(
  step: DockerStep,
  platform: NodeJS.Platform,
): DockerPlan {
  const plan = (
    title: string,
    commands: Command[] | undefined,
    note: string,
  ): DockerPlan => ({
    step,
    title,
    commands: (commands ?? []).map(show),
    note,
    supported: !!commands?.length,
  });
  switch (step) {
    case 'check':
      return plan(
        'Check Docker',
        [DOCKER_VERSION, DOCKER_INFO],
        'Looks for Docker and asks it whether it is running. Changes nothing.',
      );
    case 'start-docker': {
      const launch = launchCommand(platform);
      return plan(
        'Start Docker',
        launch && [launch, DOCKER_INFO],
        launch
          ? 'Opens Docker Desktop, then asks Docker every couple of seconds until it answers (up to about 90 seconds).'
          : 'Start the Docker service yourself, for example with your system’s service manager.',
      );
    }
    case 'install-docker': {
      const install = installCommand(platform);
      return plan(
        'Install Docker Desktop',
        install && [install],
        install
          ? 'Downloads and installs Docker Desktop from the official package source. It can take several minutes, may ask Windows or macOS for permission, and may need a restart.'
          : 'Install Docker Engine from docs.docker.com/engine/install, then check again.',
      );
    }
    case 'create-computers':
      return plan(
        'Create Dot computers',
        [COMPOSE_BUILD, COMPOSE_UP],
        'Adds the computer settings and two new random secrets to your .env file (existing values are kept), builds the computer images from the pinned OpenBot source, and starts the supervisor. The first build downloads a few hundred megabytes.',
      );
  }
}

/** The value of an active KEY=value line, or nothing when it is missing, empty or commented out. */
export function envValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^[ \t]*${key}[ \t]*=(.*)$`, 'm').exec(text);
  return match?.[1]?.trim() || undefined;
}

/** Sets or appends KEY=value lines. A line that is commented out is left alone and the key is appended. */
export function upsertEnv(
  text: string,
  values: Record<string, string>,
): string {
  let next = text;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
    if (line.test(next)) next = next.replace(line, () => `${key}=${value}`);
    else next += `${next && !next.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
  }
  return next;
}

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

const defaultRunner: Runner = (command, { cwd, env, onData }) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command.file, command.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: !!command.detached,
        stdio: command.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
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
        child.unref();
        child.once('spawn', () => resolve({ code: 0, output: '' }));
      } else child.once('close', (code) => resolve({ code, output }));
    } catch (error) {
      resolve({
        code: null,
        output: error instanceof Error ? error.message : 'Could not start.',
      });
    }
  });

export interface DockerSetupOptions {
  config: PlatformConfig;
  enabled: boolean;
  cwd?: string;
  platform?: NodeJS.Platform;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Guided Docker setup for Dot computers. It runs only the fixed command lists above, one job at a
 * time, and only after the caller repeats the exact commands the owner was shown.
 */
export class DockerSetup {
  private docker: DockerState = 'unknown';
  private job?: DockerJob;
  private readonly cwd: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: Runner;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private options: DockerSetupOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? defaultRunner;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): DockerSetupStatus {
    const platform = ['win32', 'darwin', 'linux'].includes(this.platform)
      ? (this.platform as 'win32' | 'darwin' | 'linux')
      : 'other';
    return {
      enabled: this.options.enabled,
      platform,
      docker: this.docker,
      plans: (
        ['check', 'start-docker', 'install-docker', 'create-computers'] as const
      ).map((step) => planFor(step, this.platform)),
      ...(this.job ? { job: this.job } : {}),
    };
  }

  /** The commands a step runs here: what the owner approves, in the app or through the approval gate. */
  commandsFor(step: DockerStep): string[] {
    return planFor(step, this.platform).commands;
  }

  /** Waits for a job to end, for at most `ms`; returns whether it ended. */
  async settled(job: DockerJob, ms: number): Promise<boolean> {
    for (let waited = 0; job.state === 'running' && waited < ms; waited += 500)
      await this.sleep(500);
    return job.state !== 'running';
  }

  /** Starts a step once `approved` matches the commands that step will run. Returns at once; poll `status()`. */
  start(step: DockerStep, approved: readonly string[]): DockerJob {
    if (!this.options.enabled)
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
    void this.execute(job).catch((error) =>
      this.finish(
        job,
        'failed',
        error instanceof Error ? error.message : 'Setup failed.',
      ),
    );
    return job;
  }

  private finish(job: DockerJob, state: 'done' | 'failed', message: string) {
    job.state = state;
    job.message = message;
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

  private async probe(job: DockerJob): Promise<DockerState> {
    const version = await this.exec(job, DOCKER_VERSION);
    if (version.code !== 0) return (this.docker = 'not_installed');
    const info = await this.exec(job, DOCKER_INFO);
    return (this.docker = info.code === 0 ? 'ready' : 'stopped');
  }

  private async execute(job: DockerJob) {
    switch (job.step) {
      case 'check': {
        const state = await this.probe(job);
        return this.finish(
          job,
          'done',
          state === 'ready'
            ? 'Docker is installed and running.'
            : state === 'stopped'
              ? 'Docker is installed but not running.'
              : 'Docker is not installed.',
        );
      }
      case 'start-docker': {
        if (this.docker === 'not_installed')
          return this.finish(
            job,
            'failed',
            'Docker is not installed. Install it first.',
          );
        const launch = launchCommand(this.platform)!;
        const started = await this.exec(job, launch);
        if (started.code !== 0)
          return this.finish(
            job,
            'failed',
            'Docker Desktop could not be opened.',
          );
        for (let attempt = 0; attempt < READY_POLLS; attempt++) {
          await this.sleep(READY_POLL_MS);
          const info = await this.run(DOCKER_INFO, {
            cwd: this.cwd,
            env: process.env,
            onData: () => {},
          });
          if (info.code === 0) {
            this.docker = 'ready';
            return this.finish(job, 'done', 'Docker is running.');
          }
        }
        return this.finish(
          job,
          'failed',
          'Docker did not answer in time. Finish its start-up window, then check again.',
        );
      }
      case 'install-docker': {
        const result = await this.exec(job, installCommand(this.platform)!);
        this.docker = 'unknown';
        return result.code === 0
          ? this.finish(
              job,
              'done',
              'Docker Desktop is installed. Restart if it asks you to, then use Start Docker.',
            )
          : this.finish(
              job,
              'failed',
              'The installer did not finish. Read the output below.',
            );
      }
      case 'create-computers': {
        if (this.docker !== 'ready')
          return this.finish(
            job,
            'failed',
            'Docker is not running. Check or start it first.',
          );
        const env = this.chooseEnv();
        for (const command of [COMPOSE_BUILD, COMPOSE_UP]) {
          const result = await this.exec(job, command, {
            ...process.env,
            ...env,
            // Compose's bake builder reads the OpenBot git URL as a local path on Windows.
            COMPOSE_BAKE: 'false',
          });
          if (result.code !== 0)
            return this.finish(
              job,
              'failed',
              'Docker could not finish. Read the output below.',
            );
        }
        // Last, because `npm run dev` restarts the server when .env changes and would end this job.
        this.saveEnv(env);
        return this.finish(
          job,
          'done',
          'Dot computers are ready. Turn one on from its Computer panel.',
        );
      }
    }
  }

  /** Picks the COMPUTER_* values (the owner's, else those already in .env, else new) and gives them to the running server. */
  private chooseEnv(): Record<string, string> {
    const { config } = this.options;
    const file = join(this.cwd, '.env');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const pick = (
      key: string,
      fromConfig: string | undefined,
      fallback: string,
    ) => fromConfig?.trim() || envValue(current, key) || fallback;
    const values: Record<string, string> = {
      COMPUTER_SUPERVISOR_URL: pick(
        'COMPUTER_SUPERVISOR_URL',
        config.computerSupervisorUrl,
        SUPERVISOR_URL,
      ),
      COMPUTER_SUPERVISOR_TOKEN: pick(
        'COMPUTER_SUPERVISOR_TOKEN',
        config.computerSupervisorToken,
        randomBytes(32).toString('hex'),
      ),
      COMPUTER_TOKEN: pick(
        'COMPUTER_TOKEN',
        config.computerToken,
        randomBytes(32).toString('hex'),
      ),
      COMPUTER_NAMESPACE: pick(
        'COMPUTER_NAMESPACE',
        config.computerNamespace,
        'opendots',
      ),
    };
    Object.assign(config, {
      computerSupervisorUrl: values.COMPUTER_SUPERVISOR_URL,
      computerSupervisorToken: values.COMPUTER_SUPERVISOR_TOKEN,
      computerToken: values.COMPUTER_TOKEN,
      computerNamespace: values.COMPUTER_NAMESPACE,
    });
    return values;
  }

  /** Adds the chosen values to .env, keeping every line the owner wrote. */
  private saveEnv(values: Record<string, string>) {
    const file = join(this.cwd, '.env');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, upsertEnv(current, values));
  }
}
