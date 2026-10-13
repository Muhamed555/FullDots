import { Hono } from 'hono';
import { z } from 'zod';
import {
  isLocked,
  RULE_CATEGORIES,
  RULE_LABELS,
  RULES,
  type RuleCategory,
} from '../shared/rules.js';
import type { WorkspaceStore } from './workspace.js';

const rulesBody = z
  .object({
    rules: z.partialRecord(z.enum(RULE_CATEGORIES), z.enum(RULES)),
  })
  .strict();

/** Rules per Dot: what it may do without asking, must ask about, or never does. */
export function ruleRoutes(workspace: WorkspaceStore) {
  const app = new Hono();
  app.get('/dots/:id/rules', (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({ rules: workspace.rules.get(id) });
  });
  app.put('/dots/:id/rules', async (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    const parsed = rulesBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Send a rule (inherit, allow, ask or never) per category.' },
        400,
      );
    // No setting lets a Dot pay or delete without the owner's click.
    const locked = (Object.keys(parsed.data.rules) as RuleCategory[]).find(
      (category) =>
        isLocked(category) && parsed.data.rules[category] === 'allow',
    );
    if (locked)
      return c.json(
        {
          error: `${RULE_LABELS[locked]} can only be Inherit, Ask me first or Never.`,
        },
        400,
      );
    return c.json({ rules: workspace.rules.set(id, parsed.data.rules) });
  });
  return app;
}
