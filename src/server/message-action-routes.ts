// Message actions: pins and branches. Retry needs no route (it is an ordinary turn whose owner
// message carries `retryOf` metadata), and edit-and-resend is a branch plus an ordinary turn.
import { Hono } from 'hono';
import { z } from 'zod';
import { MESSAGE_ID_MAX } from '../shared/message-actions.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';
import { BranchPointError, branchConversation } from './thread-branch.js';
import type { WorkspaceStore } from './workspace.js';

const branchBody = z
  .object({
    /** The last message the branch keeps; null starts an empty branch (editing the first message). */
    atMessageId: z.string().min(1).max(MESSAGE_ID_MAX).nullable(),
  })
  .strict();

/** Mounted under /api, behind the owner and origin checks like every other route. */
export function messageActionRoutes(deps: {
  workspace: WorkspaceStore;
  runner: SqliteAgentRunner;
}) {
  const { workspace, runner } = deps;
  const app = new Hono();
  const owned = (id: string) => {
    try {
      return workspace.requireThread(id);
    } catch {
      return undefined;
    }
  };
  const notFound = { error: 'Conversation not found.' };
  app.get('/conversations/:id/pins', (c) => {
    const id = c.req.param('id');
    if (!owned(id)) return c.json(notFound, 404);
    return c.json({ pins: workspace.pins.list(id) });
  });
  app.post('/conversations/:id/pins/:messageId', (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    if (!owned(id)) return c.json(notFound, 404);
    // Only a stored message can be pinned: the pin must point at something the chat can show.
    if (
      messageId.length > MESSAGE_ID_MAX ||
      !runner.getThreadMessages(id).some((message) => message.id === messageId)
    )
      return c.json({ error: 'Message not found.' }, 404);
    return c.json({ pins: workspace.pins.pin(id, messageId) }, 201);
  });
  app.delete('/conversations/:id/pins/:messageId', (c) => {
    const id = c.req.param('id');
    if (!owned(id)) return c.json(notFound, 404);
    return c.json({ pins: workspace.pins.unpin(id, c.req.param('messageId')) });
  });
  app.post('/conversations/:id/branch', async (c) => {
    const id = c.req.param('id');
    if (!owned(id)) return c.json(notFound, 404);
    const body = branchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: 'Name the message to branch from (atMessageId).' },
        400,
      );
    try {
      return c.json(branchConversation(deps, id, body.data.atMessageId), 201);
    } catch (error) {
      if (error instanceof BranchPointError)
        return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  return app;
}
