import { Hono } from 'hono';
import { z } from 'zod';
import type { DockerSetup } from './docker-setup.js';
import { DOCKER_STEPS } from '../shared/docker-setup-types.js';

const body = z
  .object({ approve: z.array(z.string().max(500)).max(10) })
  .strict();

export function dockerSetupRoutes(setup: DockerSetup) {
  const app = new Hono();
  app.get('/docker/setup', (c) => c.json(setup.status()));
  app.post('/docker/setup/:step', async (c) => {
    const step = z.enum(DOCKER_STEPS).safeParse(c.req.param('step'));
    const parsed = body.safeParse(await c.req.json().catch(() => undefined));
    if (!step.success || !parsed.success)
      return c.json({ error: 'Invalid setup request.' }, 400);
    try {
      return c.json(setup.start(step.data, parsed.data.approve));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Setup failed.' },
        409,
      );
    }
  });
  return app;
}
