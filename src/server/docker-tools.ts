// Lets a Dot set up its own computer: check, start or install Docker and create the Dot computers.
// `docker_setup` is always gated by the approval gate (see `classify`), so the owner approves each
// step in the chat before anything runs. The tools return one short sentence and never the command
// output, which stays in the app's setup card for anyone who wants it.
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { DOCKER_STEPS } from '../shared/docker-setup-types.js';
import type { DockerSetup } from './docker-setup.js';

/** How long a call waits for its step. A build takes longer than a turn may, so the Dot reports back and checks later. */
const WAIT_MS = 45_000;

export const dockerPrompt =
  'Try the computer tools first. Only when one fails because the computer service is unavailable or not set up, call docker_status and follow its hint; if it says the computers are already running, do not set anything up. Never tell the owner that Docker is missing or not running unless a docker_setup check reported it. To set up, call docker_setup one step at a time (check, then start-docker or install-docker, then create-computers): the owner approves each step with a button, so just call the tool; do not ask permission in text first and do not show commands. Say in plain words what each step does. If a step is still running, say so and call docker_status later instead of repeating it.';

const HINTS = {
  reachable:
    'The computer service is running. Use the computer tools. If one says the computer is stopped, ask the owner to press Start in the Computer panel. Do not set anything up.',
  not_set_up:
    'Dot computers are not set up. Offer to set them up with docker_setup, starting with the check step.',
  unreachable:
    'Computers are set up but the service does not answer. Offer docker_setup with the check step, then start-docker or create-computers as it finds.',
};

export function dockerTools(setup: DockerSetup, check: () => void) {
  return [
    defineTool({
      name: 'docker_status',
      description:
        'What is known about Docker on the owner’s machine and the last setup step, without running anything. Use it before docker_setup and to follow a step that was still running.',
      parameters: z.object({}).strict(),
      execute: async () => {
        check();
        const { docker, job } = setup.status();
        const supervisor = await setup.supervisor();
        return {
          computerService: supervisor,
          hint: HINTS[supervisor],
          docker:
            docker === 'unknown'
              ? 'not checked yet (this does not mean it is missing)'
              : docker,
          ...(job
            ? { lastStep: job.step, state: job.state, message: job.message }
            : {}),
        };
      },
    }),
    defineTool({
      name: 'docker_setup',
      description:
        'Run one step of setting up Dot computers with Docker on the owner’s machine, after the owner approves it. Steps: check (is Docker installed and running), start-docker (open Docker Desktop), install-docker (install Docker Desktop), create-computers (build and start the computers; needs Docker running). A long step may still be running when this returns: then tell the owner and use docker_status later.',
      parameters: z.object({ step: z.enum(DOCKER_STEPS) }).strict(),
      execute: async ({ step }) => {
        check();
        try {
          const job = setup.start(step, setup.commandsFor(step));
          const ended = await setup.settled(job, WAIT_MS);
          return {
            state: ended ? job.state : 'running',
            message: ended
              ? job.message
              : `${job.message} It is still working; check again in a minute.`,
            docker: setup.status().docker,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Setup failed.',
          };
        }
      },
    }),
  ];
}
