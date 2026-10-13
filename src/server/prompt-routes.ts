import { Hono } from 'hono';
import { z } from 'zod';
import {
  PROMPT_BODY_MAX,
  PROMPT_SCOPES,
  PROMPT_TITLE_MAX,
} from '../shared/prompts.js';
import type { PromptInput } from './prompt-store.js';
import type { WorkspaceStore } from './workspace.js';

const fields = {
  title: z
    .string()
    .trim()
    .min(1, `Give the prompt a title of 1 to ${PROMPT_TITLE_MAX} characters.`)
    .max(
      PROMPT_TITLE_MAX,
      `Titles are at most ${PROMPT_TITLE_MAX} characters.`,
    ),
  body: z
    .string()
    .trim()
    .min(1, `Write the prompt text (up to ${PROMPT_BODY_MAX} characters).`)
    .max(PROMPT_BODY_MAX, `Prompts are at most ${PROMPT_BODY_MAX} characters.`),
  scope: z.enum(PROMPT_SCOPES as [string, ...string[]]),
  dotId: z.string().min(1).max(200).nullable(),
  teamId: z.string().min(1).max(200).nullable(),
};
const createSchema = z
  .object({
    title: fields.title,
    body: fields.body,
    scope: fields.scope.optional(),
    dotId: fields.dotId.optional(),
    teamId: fields.teamId.optional(),
  })
  .strict();
const patchSchema = createSchema.partial().strict();

export interface PromptRouteOptions {
  /** Extension point for named teams; until they exist no team id is valid. */
  teamExists?: (id: string) => boolean;
}

/** Saved prompts: list, create, edit and archive. Nothing is hard-deleted. */
export function promptRoutes(
  workspace: WorkspaceStore,
  { teamExists = () => false }: PromptRouteOptions = {},
) {
  const app = new Hono();

  /** The input to store, or the reason it is not allowed. */
  const resolve = (candidate: {
    title: string;
    body: string;
    scope?: string;
    dotId?: string | null;
    teamId?: string | null;
  }): { input: PromptInput } | { error: string } => {
    const dotId = candidate.dotId ?? null;
    const teamId = candidate.teamId ?? null;
    const scope = (candidate.scope ??
      (dotId ? 'dot' : teamId ? 'team' : 'global')) as PromptInput['scope'];
    const { title, body } = candidate;
    if (scope === 'global') {
      if (dotId || teamId)
        return { error: 'A prompt for everyone is not tied to a Dot or team.' };
    } else if (scope === 'dot') {
      if (!dotId || teamId)
        return { error: 'Choose the one Dot this prompt belongs to.' };
      if (!workspace.dot(dotId)) return { error: 'Dot not found.' };
    } else {
      if (!teamId || dotId)
        return { error: 'Choose the one team this prompt belongs to.' };
      if (!teamExists(teamId)) return { error: 'Team not found.' };
    }
    return { input: { title, body, scope, dotId, teamId } };
  };

  app.get('/prompts', (c) => {
    const dotId = c.req.query('dotId');
    return c.json({ prompts: workspace.prompts.list(dotId || undefined) });
  });
  app.get('/prompts/:id', (c) => {
    const prompt = workspace.prompts.get(c.req.param('id'));
    return prompt
      ? c.json(prompt)
      : c.json({ error: 'Prompt not found.' }, 404);
  });
  app.post('/prompts', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid prompt.' },
        400,
      );
    const result = resolve(parsed.data);
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json(workspace.prompts.create(result.input), 201);
  });
  app.patch('/prompts/:id', async (c) => {
    const current = workspace.prompts.get(c.req.param('id'));
    if (!current) return c.json({ error: 'Prompt not found.' }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid prompt.' },
        400,
      );
    const patch = parsed.data;
    // Moving to another scope drops the old owner unless the request names a new one.
    const moved = patch.scope !== undefined && patch.scope !== current.scope;
    const result = resolve({
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      scope: patch.scope ?? current.scope,
      dotId:
        patch.dotId !== undefined ? patch.dotId : moved ? null : current.dotId,
      teamId:
        patch.teamId !== undefined
          ? patch.teamId
          : moved
            ? null
            : current.teamId,
    });
    if ('error' in result) return c.json({ error: result.error }, 400);
    const saved = workspace.prompts.update(current.id, result.input);
    return saved ? c.json(saved) : c.json({ error: 'Prompt not found.' }, 404);
  });
  // The prompt stays in the database, hidden from every list and search.
  app.delete('/prompts/:id', (c) =>
    workspace.prompts.archive(c.req.param('id'))
      ? c.json({ archived: c.req.param('id') })
      : c.json({ error: 'Prompt not found.' }, 404),
  );
  return app;
}
