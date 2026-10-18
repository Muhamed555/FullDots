// Lets a Dot set up Dot computers itself. `docker_setup` is always gated by the approval gate (see
// `classify` in approvals.ts): the owner approves each step on a card that lists its exact commands,
// whatever the Dot's approval mode. The tools answer in a sentence and never return command output,
// which stays behind "Technical details" in the Computer panel.
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  dockerSetupInput,
  type DockerJob,
} from '../shared/docker-setup-types.js';
import type { DockerSetup, SupervisorState } from './docker-setup.js';

/** How long one call waits for its step. A first build takes minutes, longer than a turn, so the Dot reports back and checks later. */
const WAIT_MS = 45_000;

const STEPS_GUIDE =
  'Call docker_setup one step at a time: check, then start-docker or install-docker if the check asks for it, then create-computers. The owner approves each step on a card that shows its commands, so call the tool directly: do not ask for permission in text first and do not repeat the commands. Tell the owner in plain words what each step does and what it found. If a step is still running, say so and call docker_status later instead of starting it again. Never say Docker is missing or stopped unless a docker_setup check reported it.';

/** What the Dot is told about setting up computers, depending on whether they are configured at all. */
export function dockerPrompt(computersConfigured: boolean): string {
  return computersConfigured
    ? `If a computer tool reports that the computer service is unavailable, call docker_status and follow its hint; when it says the service is running, do not set anything up. ${STEPS_GUIDE}`
    : `Dot computers are not set up yet, so you have no computer tools. When the owner asks for something that needs a computer (a browser, files or a terminal), offer to set computers up and, if they agree or asked for it, start with docker_setup. ${STEPS_GUIDE}`;
}

const HINTS: Record<SupervisorState, string> = {
  reachable:
    'The computer service is running. Use the computer tools; if one says the computer is stopped, ask the owner to press Start in the Computer panel. Do not set anything up.',
  not_set_up:
    'Dot computers are not set up. Offer to set them up with docker_setup, starting with the check step.',
  unreachable:
    'Computers are set up but the service does not answer, usually because Docker is not running. Offer docker_setup starting with the check step.',
};

const jobSummary = (job: DockerJob) => ({
  step: job.step,
  state: job.state,
  message: job.message,
});

export function dockerTools(setup: DockerSetup, check: () => void) {
  return [
    defineTool({
      name: 'docker_status',
      description:
        'Whether the computer service answers, what is known about Docker on the owner’s machine, and the last setup step. Runs nothing on the machine. Use it before docker_setup and to follow a step that was still running.',
      parameters: z.object({}).strict(),
      execute: async () => {
        check();
        const { docker, job } = setup.status();
        const computerService = await setup.supervisor();
        return {
          computerService,
          hint: HINTS[computerService],
          docker:
            docker === 'unknown'
              ? 'not checked yet (this does not mean it is missing)'
              : docker,
          ...(job ? { lastStep: jobSummary(job) } : {}),
        };
      },
    }),
    defineTool({
      name: 'docker_setup',
      description:
        'Run one step of setting up Dot computers with Docker on the owner’s machine; the owner approves it first. Steps: check (is Docker installed and running), start-docker (open Docker Desktop and wait for it), install-docker (install Docker Desktop), create-computers (build and start the computers; Docker must be running), enable-desktop (give the computers a desktop with windows and apps; only when the owner asks for it). A long step can still be running when this returns: tell the owner and use docker_status later.',
      parameters: dockerSetupInput,
      execute: async ({ step }) => {
        check();
        let started: DockerJob;
        try {
          started = setup.start(step, setup.commandsFor(step));
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Setup failed.',
          };
        }
        const job = (await setup.settled(started.id, WAIT_MS)) ?? started;
        return {
          ...jobSummary(job),
          ...(job.state === 'running'
            ? {
                message: `${job.message} Still working; check again with docker_status in a minute.`,
              }
            : {}),
          docker: setup.status().docker,
        };
      },
    }),
  ];
}
