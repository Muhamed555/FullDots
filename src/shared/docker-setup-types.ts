import { z } from 'zod';

/** The steps of the guided Docker setup. Each runs a fixed list of commands, never anything typed by a client. */
export const DOCKER_STEPS = [
  'check',
  'start-docker',
  'install-docker',
  'create-computers',
] as const;
export type DockerStep = (typeof DOCKER_STEPS)[number];

/** The arguments of the `docker_setup` tool, also used by the approval gate before it asks the owner. */
export const dockerSetupInput = z
  .object({ step: z.enum(DOCKER_STEPS) })
  .strict();

export type DockerState = 'unknown' | 'not_installed' | 'stopped' | 'ready';

export interface DockerPlan {
  step: DockerStep;
  title: string;
  /** The exact commands FullDots will run, as the owner would type them. */
  commands: string[];
  /** Shown with the commands: what they do and what to expect. */
  note: string;
  /** False when this system cannot do the step automatically. */
  supported: boolean;
}

export interface DockerJob {
  id: string;
  step: DockerStep;
  state: 'running' | 'done' | 'failed';
  /** The last part of the combined command output. */
  output: string;
  /** A short sentence for the owner when the job ends. */
  message: string;
}

export interface DockerSetupStatus {
  /** False when FullDots runs in a container, is bound to the network, or the setup is turned off. */
  enabled: boolean;
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  docker: DockerState;
  plans: DockerPlan[];
  job?: DockerJob;
}
