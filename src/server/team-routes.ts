import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';

/** Who each Dot may hand work to, and the hand-offs a conversation made. */
export function teamRoutes(workspace: WorkspaceStore) {
  const app = new Hono();
  app.get('/dots/:id/team', (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({ delegateIds: workspace.team.delegates(id) });
  });
  app.put('/dots/:id/team', async (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    const parsed = z
      .object({ delegateIds: z.array(z.string().min(1)).max(100) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Send the list of teammates.' }, 400);
    const unknown = parsed.data.delegateIds.find(
      (other) => other === id || !workspace.dot(other),
    );
    if (unknown)
      return c.json({ error: 'Choose other existing Dots as teammates.' }, 400);
    workspace.team.setDelegates(id, parsed.data.delegateIds);
    return c.json({ delegateIds: workspace.team.delegates(id) });
  });
  app.get('/conversations/:id/delegations', (c) => {
    try {
      workspace.requireThread(c.req.param('id'));
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    return c.json({
      delegations: workspace.team.forParent(c.req.param('id')),
      handedBy: workspace.team.byChildThread(c.req.param('id')) ?? null,
    });
  });
  return app;
}
