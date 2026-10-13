// Work lanes (P3): progress of a chat's hand-offs, and the owner's Stop, Stop everything and Try
// again. Owner-only like every /api route; the live feed only carries ids.
import { Hono } from 'hono';
import type { LaneProgressResponse } from '../shared/lanes.js';
import { LaneError, type LaneService } from './lanes.js';
import type { WorkspaceStore } from './workspace.js';

export function laneRoutes(lanes: LaneService, workspace: WorkspaceStore) {
  const app = new Hono();
  const owned = (threadId: string) => {
    try {
      workspace.requireThread(threadId);
      return true;
    } catch {
      return false;
    }
  };
  /** A hand-off made from one of the owner's conversations. */
  const delegation = (id: string) => {
    const row = workspace.team.get(id);
    return row && owned(row.parentThreadId) ? row : undefined;
  };
  app.get('/conversations/:id/delegations/progress', (c) => {
    const id = c.req.param('id');
    if (!owned(id)) return c.json({ error: 'Conversation not found.' }, 404);
    const now = Date.now();
    return c.json({
      lanes: lanes.progress(id, now),
      now,
    } satisfies LaneProgressResponse);
  });
  app.post('/conversations/:id/delegations/stop', (c) => {
    const id = c.req.param('id');
    if (!owned(id)) return c.json({ error: 'Conversation not found.' }, 404);
    return c.json({ stopped: lanes.stopAll(id) });
  });
  app.get('/delegations/:id', (c) => {
    const row = delegation(c.req.param('id'));
    if (!row) return c.json({ error: 'Hand-off not found.' }, 404);
    return c.json({ delegation: row });
  });
  app.post('/delegations/:id/stop', (c) => {
    const row = delegation(c.req.param('id'));
    if (!row) return c.json({ error: 'Hand-off not found.' }, 404);
    const stopped = lanes.stop(row.id);
    return c.json({ stopped, delegation: workspace.team.get(row.id) });
  });
  app.post('/delegations/:id/retry', (c) => {
    const row = delegation(c.req.param('id'));
    if (!row) return c.json({ error: 'Hand-off not found.' }, 404);
    try {
      return c.json({ delegation: lanes.retry(row.id) }, 201);
    } catch (error) {
      if (error instanceof LaneError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  return app;
}
