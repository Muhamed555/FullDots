import { z } from 'zod';
import { Hono } from 'hono';
import type { TurnRegistry } from './turn-registry.js';
import type { WorkspaceStore } from './workspace.js';
export function turnRoutes(
  registry: TurnRegistry,
  workspace: WorkspaceStore,
  /** Called after a Dot is paused, to interrupt its background runs. */
  onPaused?: (dotId: string) => void,
) {
  const app = new Hono();
  app.post('/dots/:id/pause', async (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    const parsed = z
      .object({ paused: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send { paused }.' }, 400);
    const dot = workspace.setDotPaused(id, parsed.data.paused);
    if (parsed.data.paused) {
      registry.stop(id);
      onPaused?.(id);
    }
    return c.json(dot);
  });
  app.post('/dots/:id/turn/stop', (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({ stopped: registry.stop(id) });
  });
  return app;
}
