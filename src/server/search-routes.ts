import { Hono } from 'hono';
import { SEARCH_QUERY_MAX } from '../shared/search.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';
import type { WorkspaceStore } from './workspace.js';
import { clampLimit, parseTypes, searchWorkspace } from './search.js';

/** `GET /api/search?q=&types=&limit=` over chats, messages, pages, Dots and saved prompts. */
export function searchRoutes(
  workspace: WorkspaceStore,
  runner: Pick<SqliteAgentRunner, 'listThreads' | 'getThreadMessages'>,
) {
  const app = new Hono();
  app.get('/search', (c) => {
    const query = (c.req.query('q') ?? '').trim();
    if (query.length > SEARCH_QUERY_MAX)
      return c.json(
        { error: `Search for at most ${SEARCH_QUERY_MAX} characters.` },
        400,
      );
    const types = parseTypes(c.req.query('types'));
    if (!types) return c.json({ error: 'Unknown search type.' }, 400);
    const results = searchWorkspace(
      {
        query,
        limit: clampLimit(c.req.query('limit')),
        store: workspace.search,
        conversations: () => workspace.conversations(),
        threads: () =>
          runner.listThreads().map((thread) => ({
            id: thread.id,
            updatedAt: Date.parse(thread.updatedAt),
          })),
        linkedThreadIds: () => workspace.linkedThreadIds(),
        messages: (threadId) => runner.getThreadMessages(threadId),
      },
      types,
    );
    return c.json({ results });
  });
  return app;
}
