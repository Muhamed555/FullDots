// The only commands the guided Docker setup can run, per step and per platform. What the owner is
// shown and what runs come from this one table, so they cannot drift apart.
import { join } from 'node:path';
import type { DockerPlan, DockerStep } from '../shared/docker-setup-types.js';

/** One program run without a shell, so no text from a client or a model is ever parsed as a command. */
export interface Command {
  file: string;
  args: readonly string[];
  /** Started and left running (Docker Desktop itself) instead of waited for. */
  detached?: boolean;
}

export const COMPOSE_FILE = 'compose.computers.yml';

export const DOCKER_VERSION: Command = { file: 'docker', args: ['--version'] };
export const DOCKER_INFO: Command = {
  file: 'docker',
  args: ['info', '--format', '{{.ServerVersion}}'],
};
export const COMPOSE_BUILD: Command = {
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
export const COMPOSE_UP: Command = {
  file: 'docker',
  args: ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'computer-supervisor'],
};

export function launchCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): Command | undefined {
  if (platform === 'win32')
    return {
      file: join(
        env.ProgramFiles ?? 'C:\\Program Files',
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

export function installCommand(platform: NodeJS.Platform): Command | undefined {
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

/** A command as the owner would type it. Quoting is for reading only: nothing is passed to a shell. */
export const show = (command: Command): string =>
  [command.file, ...command.args]
    .map((part) => (/[\s{}"]/.test(part) ? `"${part}"` : part))
    .join(' ');

interface StepSpec {
  title: string;
  note: string;
  /** Undefined when this system cannot do the step automatically. */
  commands?: readonly Command[];
}

export function stepSpec(
  step: DockerStep,
  platform: NodeJS.Platform,
): StepSpec {
  switch (step) {
    case 'check':
      return {
        title: 'Check Docker',
        note: 'Looks for Docker and asks whether it is running. Changes nothing.',
        commands: [DOCKER_VERSION, DOCKER_INFO],
      };
    case 'start-docker': {
      const launch = launchCommand(platform);
      return launch
        ? {
            title: 'Start Docker',
            note: 'Opens Docker Desktop, then asks Docker every two seconds until it answers, for up to about 90 seconds.',
            commands: [launch, DOCKER_INFO],
          }
        : {
            title: 'Start Docker',
            note: 'Start the Docker service with your system’s service manager, then check again.',
          };
    }
    case 'install-docker': {
      const install = installCommand(platform);
      return install
        ? {
            title: 'Install Docker Desktop',
            note: 'Downloads and installs Docker Desktop from the official package source. It takes several minutes, your system may ask for permission, and it may need a restart.',
            commands: [install],
          }
        : {
            title: 'Install Docker',
            note: 'Install Docker Engine from docs.docker.com/engine/install, then check again.',
          };
    }
    case 'create-computers':
      return {
        title: 'Create Dot computers',
        note: 'Makes sure Docker is running, builds the computer images from the pinned OpenBot source and starts the supervisor. Then it adds the computer settings and two new random secrets to .env, keeping values you already set. The first build downloads a few hundred megabytes and takes several minutes.',
        commands: [DOCKER_INFO, COMPOSE_BUILD, COMPOSE_UP],
      };
  }
}

export function planFor(
  step: DockerStep,
  platform: NodeJS.Platform,
): DockerPlan {
  const spec = stepSpec(step, platform);
  return {
    step,
    title: spec.title,
    note: spec.note,
    commands: (spec.commands ?? []).map(show),
    supported: !!spec.commands?.length,
  };
}
