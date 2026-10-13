// /api/teams: named teams (list, create, get, update, archive, members), their chats, direct
// dispatch, and team runs with their timings. Mounted behind the owner and origin checks.
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_CONVERSATION_TITLE } from '../../shared/conversation-title.js';
import {
  isSingleEmoji,
  MAX_TEAM_MEMBERS,
  TEAM_DESCRIPTION_MAX,
  TEAM_MODES,
  TEAM_NAME_MAX,
  TEAM_ROLE_MAX,
  TEAM_STYLES,
  type Team,
  type TeamDetail,
} from '../../shared/teams.js';
import { teamTemplate } from '../../shared/team-templates.js';
import { DOT_COLORS } from '../../shared/types.js';
import type { TurnRegistry } from '../turn-registry.js';
import type { WorkspaceStore } from '../workspace.js';
import { TeamRunError, type TeamRunService } from './team-runs.js';
import { createFromTemplate, createTeamSpace } from './templates.js';

export interface TeamRouteDeps {
  workspace: WorkspaceStore;
  runs: TeamRunService;
  turns: Pick<TurnRegistry, 'running'>;
}

const member = z
  .object({
    dotId: z.string().min(1).max(200),
    role: z
      .string()
      .trim()
      .max(TEAM_ROLE_MAX, `Roles are at most ${TEAM_ROLE_MAX} characters.`)
      .optional(),
  })
  .strict();
const members = z
  .array(member)
  .min(1, 'Add at least one member besides the lead.')
  .max(
    MAX_TEAM_MEMBERS,
    `A team has at most ${MAX_TEAM_MEMBERS} members besides its lead.`,
  );
const fields = {
  name: z
    .string()
    .trim()
    .min(1, 'Give the team a name.')
    .max(TEAM_NAME_MAX, `Team names are at most ${TEAM_NAME_MAX} characters.`),
  emoji: z
    .string()
    .trim()
    .refine(isSingleEmoji, 'Choose one emoji for the team.'),
  color: z.enum(DOT_COLORS, { message: 'Choose one of the Dot colours.' }),
  description: z
    .string()
    .trim()
    .max(
      TEAM_DESCRIPTION_MAX,
      `Descriptions are at most ${TEAM_DESCRIPTION_MAX} characters.`,
    ),
  leadDotId: z.string().min(1, 'Choose the lead Dot.').max(200),
  style: z.enum(TEAM_STYLES as [string, ...string[]]),
  mode: z.enum(TEAM_MODES as [string, ...string[]]),
  summarize: z.boolean(),
  reviewerDotId: z.string().min(1).max(200).nullable(),
  runLog: z.boolean(),
  /** Create the team's home Space (when it has none yet). */
  space: z.boolean(),
};
const createSchema = z
  .object({
    ...fields,
    description: fields.description.optional(),
    style: fields.style.optional(),
    mode: fields.mode.optional(),
    summarize: fields.summarize.optional(),
    reviewerDotId: fields.reviewerDotId.optional(),
    runLog: fields.runLog.optional(),
    space: fields.space.optional(),
    members,
  })
  .strict();
const patchSchema = z
  .object({
    name: fields.name.optional(),
    emoji: fields.emoji.optional(),
    color: fields.color.optional(),
    description: fields.description.optional(),
    leadDotId: fields.leadDotId.optional(),
    style: fields.style.optional(),
    mode: fields.mode.optional(),
    summarize: fields.summarize.optional(),
    reviewerDotId: fields.reviewerDotId.optional(),
    runLog: fields.runLog.optional(),
    space: fields.space.optional(),
    members: members.optional(),
  })
  .strict();

const firstIssue = (error: z.ZodError) =>
  error.issues[0]?.message ?? 'Invalid team.';

/**
 * Why this lead, these members and this reviewer cannot form a team, or undefined when they can:
 * every Dot exists, the lead is not also a member, no member is listed twice, and the reviewer is
 * neither the lead nor a member (each Dot takes part in a run once).
 */
export function teamProblem(
  workspace: Pick<WorkspaceStore, 'dot'>,
  leadDotId: string,
  list: { dotId: string }[],
  reviewerDotId: string | null = null,
): string | undefined {
  if (!workspace.dot(leadDotId)) return 'The lead Dot was not found.';
  const seen = new Set<string>();
  for (const item of list) {
    if (item.dotId === leadDotId)
      return 'The lead leads the team; it cannot also be a member.';
    if (seen.has(item.dotId)) return 'Each Dot can be on the team once.';
    if (!workspace.dot(item.dotId)) return 'A member Dot was not found.';
    seen.add(item.dotId);
  }
  if (seen.size > MAX_TEAM_MEMBERS)
    return `A team has at most ${MAX_TEAM_MEMBERS} members besides its lead.`;
  if (reviewerDotId) {
    if (!workspace.dot(reviewerDotId)) return 'The reviewer Dot was not found.';
    if (reviewerDotId === leadDotId)
      return 'The lead cannot also review: choose another Dot.';
    if (seen.has(reviewerDotId))
      return 'The reviewer checks the members’ work, so it cannot also be a member.';
  }
  return undefined;
}

export function namedTeamRoutes({ workspace, runs, turns }: TeamRouteDeps) {
  const app = new Hono();
  const { teams } = workspace;
  const nameTaken = (name: string, except?: string) => {
    const other = teams.activeNamed(name);
    return !!other && other.id !== except;
  };
  const active = (id: string): Team | undefined => {
    const team = teams.get(id);
    return team && !team.archivedAt ? team : undefined;
  };

  app.get('/teams', (c) =>
    c.json({
      teams: teams.list({ archived: c.req.query('archived') === '1' }),
      // For the sidebar's live pulse: who holds a turn right now.
      workingDotIds: [...new Set(turns.running().map((turn) => turn.dotId))],
    }),
  );

  app.post('/teams', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: firstIssue(parsed.error) }, 400);
    const { space, ...input } = parsed.data;
    const problem = teamProblem(
      workspace,
      input.leadDotId,
      input.members,
      input.reviewerDotId ?? null,
    );
    if (problem) return c.json({ error: problem }, 400);
    if (nameTaken(input.name))
      return c.json(
        { error: `A team named ${input.name} already exists.` },
        409,
      );
    const team = teams.create({
      ...input,
      style: input.style as Team['style'] | undefined,
      mode: input.mode as Team['mode'] | undefined,
    });
    return c.json(space ? createTeamSpace(workspace, team) : team, 201);
  });

  // A team from a template: its Dots (careful defaults, no grants), the team, and optionally its
  // Space. Registered before /teams/:id routes.
  app.post('/teams/from-template', async (c) => {
    const parsed = z
      .object({
        templateId: z.string().min(1).max(40),
        name: fields.name.optional(),
        space: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: firstIssue(parsed.error) }, 400);
    const template = teamTemplate(parsed.data.templateId);
    if (!template) return c.json({ error: 'Template not found.' }, 404);
    const made = createFromTemplate(workspace, template, {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      space: parsed.data.space ?? false,
    });
    return c.json(made, 201);
  });

  // Registered before /teams/:id so "runs" is never read as a team id.
  app.get('/teams/runs/:id', (c) => {
    const detail = runs.detail(c.req.param('id'));
    return detail
      ? c.json(detail)
      : c.json({ error: 'Team run not found.' }, 404);
  });
  app.post('/teams/runs/:id/cancel', (c) => {
    const run = runs.cancel(c.req.param('id'));
    return run
      ? c.json(runs.detail(run.id))
      : c.json({ error: 'Team run not found.' }, 404);
  });

  app.get('/teams/:id', (c) => {
    const team = teams.get(c.req.param('id'));
    if (!team) return c.json({ error: 'Team not found.' }, 404);
    const detail: TeamDetail = {
      ...team,
      conversations: teams.conversations(team.id),
      runs: teams.runs(team.id),
    };
    return c.json(detail);
  });

  app.patch('/teams/:id', async (c) => {
    const current = active(c.req.param('id'));
    if (!current) return c.json({ error: 'Team not found.' }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: firstIssue(parsed.error) }, 400);
    const { members: list, space, ...patch } = parsed.data;
    const lead = patch.leadDotId ?? current.leadDotId;
    const nextMembers = list ?? current.members;
    const problem = teamProblem(
      workspace,
      lead,
      nextMembers,
      patch.reviewerDotId !== undefined
        ? patch.reviewerDotId
        : current.reviewerDotId,
    );
    if (problem) return c.json({ error: problem }, 400);
    if (patch.name && nameTaken(patch.name, current.id))
      return c.json(
        { error: `A team named ${patch.name} already exists.` },
        409,
      );
    teams.update(current.id, {
      ...patch,
      style: patch.style as Team['style'] | undefined,
      mode: patch.mode as Team['mode'] | undefined,
    });
    if (list) teams.setMembers(current.id, list);
    if (space) createTeamSpace(workspace, teams.get(current.id)!);
    return c.json(teams.get(current.id));
  });

  // The team's home Space: created once, named after the team; every Dot on the team gets access.
  app.post('/teams/:id/space', (c) => {
    const current = active(c.req.param('id'));
    if (!current) return c.json({ error: 'Team not found.' }, 404);
    return c.json(createTeamSpace(workspace, current), 201);
  });

  // Sets the members and their order (the order of the list) in one go.
  app.put('/teams/:id/members', async (c) => {
    const current = active(c.req.param('id'));
    if (!current) return c.json({ error: 'Team not found.' }, 404);
    const parsed = z
      .object({ members })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: firstIssue(parsed.error) }, 400);
    const problem = teamProblem(
      workspace,
      current.leadDotId,
      parsed.data.members,
      current.reviewerDotId,
    );
    if (problem) return c.json({ error: problem }, 400);
    return c.json(teams.setMembers(current.id, parsed.data.members));
  });

  // Archiving keeps the team's Dots, chats and runs; only the lead's team-given hand-offs end.
  app.post('/teams/:id/archive', (c) => {
    const team = teams.get(c.req.param('id'));
    if (!team) return c.json({ error: 'Team not found.' }, 404);
    return c.json(teams.archive(team.id));
  });

  // A new team chat: a conversation hosted by the lead and bound to the team.
  app.post('/teams/:id/conversations', (c) => {
    const team = active(c.req.param('id'));
    if (!team) return c.json({ error: 'Team not found.' }, 404);
    const conversation = workspace.bindThread(
      randomUUID(),
      team.leadDotId,
      DEFAULT_CONVERSATION_TITLE,
    );
    teams.bindThread(conversation.id, team.id);
    return c.json({ ...conversation, teamId: team.id }, 201);
  });

  app.post('/teams/:id/dispatch', async (c) => {
    const parsed = z
      .object({
        threadId: z.string().min(1).max(200),
        text: z
          .string()
          .trim()
          .min(1, 'Write a message for the team.')
          .max(8000, 'Messages are at most 8,000 characters.'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: firstIssue(parsed.error) }, 400);
    try {
      const run = await runs.dispatch(
        c.req.param('id'),
        parsed.data.threadId,
        parsed.data.text,
      );
      return c.json(runs.detail(run.id), 201);
    } catch (error) {
      if (error instanceof TeamRunError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  return app;
}
