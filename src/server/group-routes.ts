// Group chat routes: who is in a conversation, the owner's confirm to add a Dot, and a turn of one
// named Dot (the owner's @mention). Mounted under /api behind the owner and origin checks.
import { Hono } from 'hono';
import { z } from 'zod';
import { deriveTitle, hasDefaultTitle } from '../shared/conversation-title.js';
import type { OwnerTurnMetadata } from '../shared/types.js';
import type { Platform } from './platform.js';
import { DotBusyError } from './turn-registry.js';

/** Room for the page context the chat puts in front of the owner's text. */
const MAX_TURN_TEXT = 12_000;

const participantInput = z
  .object({ dotId: z.string().min(1).max(100) })
  .strict();
const turnInput = z
  .object({
    text: z.string().trim().min(1).max(MAX_TURN_TEXT),
    dotId: z.string().min(1).max(100),
  })
  .strict();

/**
 * A chat run (POST /api/copilotkit/agent/:id/run) in a conversation where another turn is running,
 * perhaps another Dot's in a group chat: refused with the Dot's name instead of an empty stream.
 */
export async function runConflict(
  platform: Platform,
  request: Request,
  body: unknown,
): Promise<Response | undefined> {
  if (
    request.method !== 'POST' ||
    !/\/agent\/[^/]+\/run$/.test(new URL(request.url).pathname)
  )
    return undefined;
  const threadId =
    body && typeof body === 'object'
      ? (body as { threadId?: unknown }).threadId
      : undefined;
  if (
    typeof threadId !== 'string' ||
    !(await platform.runner.isRunning({ threadId }))
  )
    return undefined;
  const turn = platform.turns
    .running()
    .find((item) => item.threadId === threadId);
  const name = turn && platform.workspace.dot(turn.dotId)?.name;
  return Response.json(
    {
      error: `Thread already running: ${name || 'another Dot'} is answering in this chat.`,
      code: 'thread_running',
      dotId: turn?.dotId ?? null,
    },
    { status: 409 },
  );
}

export function groupRoutes(platform: Platform) {
  const { workspace, turns, runner } = platform;
  const app = new Hono();
  const owned = (id: string) => {
    try {
      return workspace.requireThread(id);
    } catch {
      return undefined;
    }
  };
  /** The turn running in a thread: its Dot when the turn lock knows it, else null. */
  const runningIn = async (threadId: string) => {
    const turn = turns.running().find((item) => item.threadId === threadId);
    if (turn) return { dotId: turn.dotId };
    return (await runner.isRunning({ threadId })) ? { dotId: null } : null;
  };
  const view = async (threadId: string, hostId: string) => ({
    hostId,
    participants: workspace.participants
      .list(threadId)
      .map(({ dotId, addedAt }) => ({ dotId, addedAt })),
    running: await runningIn(threadId),
  });

  app.get('/conversations/:id/participants', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    return c.json(await view(thread.id, thread.dotId));
  });

  // The owner's confirm ("Add Writer to this chat? It will see the whole conversation.").
  app.post('/conversations/:id/participants', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    const parsed = participantInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: 'Choose a Dot to add.' }, 400);
    const dot = workspace.dot(parsed.data.dotId);
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    if (dot.id === thread.dotId)
      return c.json({ error: `${dot.name} already hosts this chat.` }, 400);
    workspace.participants.add(thread.id, dot.id);
    return c.json(await view(thread.id, thread.dotId), 201);
  });

  app.delete('/conversations/:id/participants/:dotId', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    const dotId = c.req.param('dotId');
    if (!workspace.participants.has(thread.id, dotId))
      return c.json({ error: 'That Dot is not in this chat.' }, 404);
    if (
      turns
        .running()
        .some((turn) => turn.dotId === dotId && turn.threadId === thread.id)
    )
      return c.json(
        {
          error: `${workspace.dot(dotId)?.name ?? 'That Dot'} is answering in this chat. Stop it first.`,
        },
        409,
      );
    workspace.participants.remove(thread.id, dotId);
    return c.json(await view(thread.id, thread.dotId));
  });

  // The owner addressed one Dot (@Name): store the text and run that Dot's turn in this thread.
  // The client follows the turn through turn.started; this answers once it has started.
  app.post('/conversations/:id/turns', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    const parsed = turnInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Send a message and the Dot it is for.' }, 400);
    const { text, dotId } = parsed.data;
    const dot = workspace.dot(dotId);
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    // Mentions never add a Dot by themselves: the owner confirms first (POST participants).
    if (
      dot.id !== thread.dotId &&
      !workspace.participants.has(thread.id, dot.id)
    )
      return c.json(
        {
          error: `${dot.name} is not in this chat. Add it first.`,
          code: 'not_participant',
          dotId: dot.id,
        },
        403,
      );
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    if (platform.store.settings().paused)
      return c.json({ error: 'Everything is paused in Settings.' }, 409);
    if (dot.paused)
      return c.json(
        {
          error: `${dot.name} is paused. Resume it from its menu in the sidebar to continue.`,
          code: 'paused',
          dotId: dot.id,
        },
        409,
      );
    const running = await runningIn(thread.id);
    if (running)
      return c.json(
        {
          error: `Thread already running: ${
            (running.dotId && workspace.dot(running.dotId)?.name) ||
            'another Dot'
          } is answering in this chat.`,
          code: 'thread_running',
          dotId: running.dotId,
        },
        409,
      );
    const busy = turns.running().find((turn) => turn.dotId === dot.id);
    if (busy)
      return c.json(
        {
          error: new DotBusyError(dot.id, busy.source, busy.threadId).message,
          code: 'dot_busy',
          dotId: dot.id,
        },
        409,
      );
    if (hasDefaultTitle(thread.title)) {
      const title = deriveTitle(text, '');
      if (title) workspace.renameThread(thread.id, title);
    }
    // Source 'chat': approvals and rules treat it exactly like a message typed in the chat.
    const metadata: OwnerTurnMetadata & Record<string, unknown> = {
      source: 'chat',
      to: dot.id,
    };
    const turn = platform.turnAs(
      thread.id,
      dot.id,
      text,
      new AbortController().signal, // stopped through POST .../stop like any chat turn
      metadata,
    );
    // A refusal from the runner (another turn took the thread in the meantime) arrives at once.
    const early = await Promise.race([
      turn.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<undefined>((resolve) => setTimeout(resolve, 0)),
    ]);
    if (early instanceof Error && /Thread already running/.test(early.message))
      return c.json(
        {
          error:
            'Thread already running: another Dot is answering in this chat.',
          code: 'thread_running',
          dotId: null,
        },
        409,
      );
    turn.catch((error: unknown) => {
      // Never the owner's text: the reason only, and only its start.
      console.error(
        `Group chat turn of ${dot.id} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      );
    });
    return c.json({ threadId: thread.id, dotId: dot.id }, 202);
  });

  // Stops whatever turn runs in this conversation (the owner's "Stop the other work").
  app.post('/conversations/:id/stop', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    return c.json({ stopped: !!(await runner.stop({ threadId: thread.id })) });
  });
  return app;
}
