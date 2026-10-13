import { Hono } from 'hono';
import type { WorkspaceStore } from './workspace.js';
import {
  replayEnabled,
  type ComputerReplay,
} from '../shared/computer-types.js';

/**
 * The replay of a Dot's browser steps. Mounted behind the owner checks like every other `/api`
 * route; every lookup is by Dot as well as by id, so one Dot's address never shows another's screen.
 */
export function computerReplayRoutes(workspace: WorkspaceStore) {
  const app = new Hono();
  app.get('/dots/:id/computer/replay', (c) => {
    const dotId = c.req.param('id');
    if (!workspace.dot(dotId)) return c.json({ error: 'Dot not found.' }, 404);
    const threadId = c.req.query('threadId')?.trim();
    if (!threadId || threadId.length > 200)
      return c.json({ error: 'Choose a conversation.' }, 400);
    const replay: ComputerReplay = {
      replay: replayEnabled(workspace.computers.permissions(dotId)),
      steps: workspace.frames.steps(dotId, threadId),
    };
    return c.json(replay);
  });
  app.get('/dots/:id/computer/frames/:frameId', (c) => {
    const dotId = c.req.param('id');
    const jpeg = workspace.dot(dotId)
      ? workspace.frames.frame(dotId, c.req.param('frameId'))
      : undefined;
    if (!jpeg) return c.json({ error: 'Frame not found.' }, 404);
    return c.body(new Uint8Array(jpeg), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  return app;
}
