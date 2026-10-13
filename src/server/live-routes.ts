import { Hono, type MiddlewareHandler } from 'hono';
import type { Platform } from './platform.js';

/** Mutating requests under these paths change Spaces, Dots, teams or conversations. */
const WORKSPACE_PATH = /^\/api\/(spaces|dots|teams|conversations)(\/|$)/;

/** Mounted under /api, behind the owner and origin checks like every other route. */
export function liveRoutes(platform: Platform) {
  const app = new Hono();
  app.get('/events', (c) => platform.events.stream(c));
  app.get('/conversations/:id/authors', (c) => {
    const id = c.req.param('id');
    try {
      platform.workspace.requireThread(id);
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    return c.json({ authors: platform.runner.authors(id) });
  });
  return app;
}

/** Emits `workspace.changed` after a successful write to Spaces, Dots or conversations. */
export function workspaceChanges(platform: Platform): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.res.status < 400 &&
      WORKSPACE_PATH.test(new URL(c.req.url).pathname)
    )
      platform.events.emit('workspace.changed', {});
  };
}
