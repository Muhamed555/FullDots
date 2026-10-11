import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';
import type { TriggerService } from './trigger-service.js';
import { WEBHOOK_BODY_MAX } from './trigger-service.js';
import type { NewTrigger } from './trigger-store.js';

/**
 * The public webhook endpoint. It is mounted before the owner-token and JSON middleware because the
 * caller is another service: each trigger has its own secret, body limit and rate limit instead.
 */
export function hookRoutes(deps: {
  triggers: TriggerService;
  ownerToken?: string;
  origin?: string;
}) {
  const app = new Hono();
  app.post('/hooks/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    // Same host rule as the rest of the API: without an owner token only local and APP_ORIGIN hosts.
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(deps.origin ? [new URL(deps.origin).hostname] : []),
    ]);
    if (!deps.ownerToken && !allowedHosts.has(url.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > WEBHOOK_BODY_MAX)
      return c.json({ error: 'The request is too large.' }, 413);
    const body = new Uint8Array(await c.req.arrayBuffer());
    const result = deps.triggers.receive(c.req.param('id'), {
      headers: c.req.raw.headers,
      body,
      query: url.searchParams,
    });
    return c.json(result.body, result.status);
  });
  return app;
}

const name = z.string().trim().min(1).max(80);
const prompt = z.string().trim().min(3).max(4000);
const interval = z.number().int().min(60).max(86_400);
const createSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('webhook'),
      threadId: z.string().min(1),
      name,
      prompt,
      auth: z.enum(['bearer', 'query', 'hmac']).default('bearer'),
      hmacHeader: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{1,80}$/)
        .optional(),
      hmacPrefix: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('poll'),
      threadId: z.string().min(1),
      name,
      prompt,
      connectorId: z.string().min(1),
      tool: z.string().min(1).max(200),
      args: z.record(z.string(), z.unknown()).default({}),
      intervalSeconds: interval.default(300),
      dedupePath: z
        .string()
        .trim()
        .max(200)
        .regex(/^[A-Za-z0-9_.-]*$/)
        .optional(),
    })
    .strict(),
]);

/** Owner routes for triggers (behind the usual owner checks). */
export function triggerRoutes(deps: {
  triggers: TriggerService;
  workspace: WorkspaceStore;
  publicOrigin: string;
  /** Read-only tools of a connector the Dot is granted, or an error message. */
  pollTool: (
    dotId: string,
    connectorId: string,
    tool: string,
  ) => string | undefined;
}) {
  const app = new Hono();
  const hookUrl = (id: string) =>
    new URL(`/api/hooks/${id}`, deps.publicOrigin).toString();
  app.get('/triggers', (c) =>
    c.json({
      triggers: deps.triggers.views().map((trigger) => ({
        ...trigger,
        url: trigger.kind === 'webhook' ? hookUrl(trigger.id) : null,
      })),
    }),
  );
  app.post('/triggers', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Give the trigger a name and instructions (3 to 4,000 characters). A poll trigger needs a connector, a tool and an interval of 1 minute to 1 day.',
        },
        400,
      );
    const data = parsed.data;
    let thread;
    try {
      thread = deps.workspace.requireThread(data.threadId);
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    if (data.kind === 'poll') {
      const problem = deps.pollTool(thread.dotId, data.connectorId, data.tool);
      if (problem) return c.json({ error: problem }, 400);
    }
    const input: NewTrigger = { ...data, dotId: thread.dotId };
    const { trigger, secret } = deps.triggers.create(input);
    return c.json(
      {
        trigger,
        secret,
        url: trigger.kind === 'webhook' ? hookUrl(trigger.id) : null,
      },
      201,
    );
  });
  app.patch('/triggers/:id', async (c) => {
    const parsed = z
      .object({
        name: name.optional(),
        prompt: prompt.optional(),
        enabled: z.boolean().optional(),
        intervalSeconds: interval.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Check the trigger fields.' }, 400);
    const updated = deps.triggers.update(c.req.param('id'), parsed.data);
    return updated
      ? c.json(updated)
      : c.json({ error: 'Trigger not found.' }, 404);
  });
  app.delete('/triggers/:id', (c) =>
    deps.triggers.remove(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Trigger not found.' }, 404),
  );
  app.post('/triggers/:id/rotate', (c) => {
    const secret = deps.triggers.rotate(c.req.param('id'));
    return secret
      ? c.json({ secret, url: hookUrl(c.req.param('id')) })
      : c.json({ error: 'Webhook trigger not found.' }, 404);
  });
  return app;
}
