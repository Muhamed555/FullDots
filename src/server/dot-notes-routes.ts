// What a Dot remembers about the owner: read, edit, clear, history and restore of one note per Dot,
// and the owner's "Save" on a proposal in the inbox. The switch that lets a Dot propose lines is the
// Dot's own settings (PUT /api/dots/:id, `notesProposals`).
import { Hono } from 'hono';
import { z } from 'zod';
import { NOTE_MAX } from '../shared/notes.js';
import { NotesError, type DotNotesService } from './dot-notes-service.js';
import { NoteTooLongError } from './dot-notes-store.js';
import type { WorkspaceStore } from './workspace.js';

const noteBody = z
  .object({
    text: z
      .string()
      .max(NOTE_MAX)
      .transform((text) => text.trim()),
  })
  .strict();

export function dotNotesRoutes(deps: {
  workspace: WorkspaceStore;
  notes: Pick<DotNotesService, 'save'>;
}) {
  const app = new Hono();
  const { workspace } = deps;
  const known = (id: string) => !!workspace.dot(id);
  const notFound = { error: 'Dot not found.' };

  app.get('/dots/:id/notes', (c) => {
    const id = c.req.param('id');
    return known(id) ? c.json(workspace.notes.get(id)) : c.json(notFound, 404);
  });

  app.put('/dots/:id/notes', async (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.json(notFound, 404);
    const body = noteBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        {
          error: `A note holds up to ${NOTE_MAX.toLocaleString('en-US')} characters.`,
        },
        400,
      );
    try {
      return c.json(workspace.notes.put(id, body.data.text, 'edit'));
    } catch (error) {
      if (error instanceof NoteTooLongError)
        return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post('/dots/:id/notes/clear', (c) => {
    const id = c.req.param('id');
    return known(id)
      ? c.json(workspace.notes.clear(id))
      : c.json(notFound, 404);
  });

  app.get('/dots/:id/notes/versions', (c) => {
    const id = c.req.param('id');
    return known(id)
      ? c.json({ versions: workspace.notes.versions(id) })
      : c.json(notFound, 404);
  });

  app.post('/dots/:id/notes/restore/:versionId', (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.json(notFound, 404);
    const restored = workspace.notes.restore(id, c.req.param('versionId'));
    return restored
      ? c.json(restored)
      : c.json({ error: 'Version not found.' }, 404);
  });

  // The owner's "Save" on a proposal. "Discard" is the inbox's ordinary archive.
  app.post('/inbox/:id/save-note', (c) => {
    try {
      return c.json(deps.notes.save(c.req.param('id')));
    } catch (error) {
      if (error instanceof NotesError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  return app;
}
