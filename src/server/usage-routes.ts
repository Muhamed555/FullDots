import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';

/** Usage per Dot and the optional daily token budget that pauses its background work. */
export function usageRoutes(deps: {
  workspace: WorkspaceStore;
  warnAt: number;
}) {
  const app = new Hono();
  app.get('/usage', (c) =>
    c.json({
      warnAt: deps.warnAt,
      dots: deps.workspace
        .dots()
        .map((dot) => deps.workspace.usage.summary(dot.id)),
    }),
  );
  app.put('/usage/:dotId/budget', async (c) => {
    const dotId = c.req.param('dotId');
    if (!deps.workspace.dot(dotId))
      return c.json({ error: 'Dot not found.' }, 404);
    const parsed = z
      .object({
        dailyTokens: z.number().int().min(1000).max(1_000_000_000).nullable(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a daily budget between 1,000 and 1,000,000,000 tokens, or none.',
        },
        400,
      );
    deps.workspace.usage.setBudget(dotId, parsed.data.dailyTokens);
    return c.json(deps.workspace.usage.summary(dotId));
  });
  return app;
}
