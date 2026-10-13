// GET /api/inbox and the item actions. The inbox lists what waits for the owner (pending approvals,
// waiting handoffs, open questions) and the finished work of background turns.
import { Hono } from 'hono';
import { z } from 'zod';
import type { InboxResponse } from '../shared/inbox.js';
import {
  ANSWER_LIMIT,
  InboxError,
  type InboxService,
} from './inbox-service.js';
import type { WorkspaceStore } from './workspace.js';

/** How many decided items of a kind the inbox shows at most. */
const LIST_LIMIT = 100;

const answerBody = z
  .object({ text: z.string().trim().min(1).max(ANSWER_LIMIT) })
  .strict();

/** Everything the inbox shows, with its counts. */
export function inboxSnapshot(workspace: WorkspaceStore): InboxResponse {
  const approvals = workspace.approvals.list({ status: 'pending' });
  const handoffs = workspace.handoffs.list({
    status: 'waiting',
    limit: LIST_LIMIT,
  });
  const questions = workspace.inbox.list('question', LIST_LIMIT);
  const memory = workspace.inbox.list('memory', LIST_LIMIT);
  const results = workspace.inbox.list('result', LIST_LIMIT);
  const counts = workspace.inbox.counts();
  return {
    counts: {
      approvals: approvals.length,
      handoffs: handoffs.length,
      questions: counts.questions,
      results: counts.results,
      unread: counts.unread,
      needsYou: approvals.length + handoffs.length + counts.questions,
    },
    approvals,
    handoffs,
    questions,
    memory,
    results,
  };
}

export function inboxRoutes(deps: {
  workspace: WorkspaceStore;
  inbox: Pick<InboxService, 'answer' | 'archive' | 'read'>;
}) {
  const app = new Hono();
  const act = (run: () => unknown) => {
    try {
      return { ok: true as const, value: run() };
    } catch (error) {
      if (error instanceof InboxError)
        return { ok: false as const, status: error.status, error };
      throw error;
    }
  };

  app.get('/inbox', (c) => c.json(inboxSnapshot(deps.workspace)));

  app.post('/inbox/:id/read', (c) => {
    const done = act(() => deps.inbox.read(c.req.param('id')));
    return done.ok
      ? c.json(done.value)
      : c.json({ error: done.error.message }, done.status);
  });

  app.post('/inbox/:id/archive', (c) => {
    const done = act(() => deps.inbox.archive(c.req.param('id')));
    return done.ok
      ? c.json(done.value)
      : c.json({ error: done.error.message }, done.status);
  });

  app.post('/inbox/:id/answer', async (c) => {
    const body = answerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        {
          error: `Write an answer of 1 to ${ANSWER_LIMIT.toLocaleString('en-US')} characters.`,
        },
        400,
      );
    const done = act(() =>
      deps.inbox.answer(c.req.param('id'), body.data.text),
    );
    return done.ok
      ? c.json(done.value)
      : c.json({ error: done.error.message }, done.status);
  });

  return app;
}
