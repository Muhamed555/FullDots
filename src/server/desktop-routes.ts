import { Hono } from 'hono';
import { z } from 'zod';
import type { DesktopService } from './desktop-service.js';
import { SCREEN } from './desktop-commands.js';

const ownerInput = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      x: z
        .number()
        .int()
        .min(0)
        .max(SCREEN.width - 1),
      y: z
        .number()
        .int()
        .min(0)
        .max(SCREEN.height - 1),
      double: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('type'), text: z.string().min(1).max(4000) })
    .strict(),
  z
    .object({
      type: z.literal('key'),
      keys: z.array(z.string()).min(1).max(20),
    })
    .strict(),
]);

/** The Computer panel's Desktop view: whether there is a desktop, its picture, and the owner's input. */
export function desktopRoutes(desktop: DesktopService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid desktop request.'
            : error.message,
      },
      400,
    ),
  );
  app.get('/dots/:id/computer/desktop', async (c) =>
    c.json({
      available: await desktop.available(c.req.param('id'), c.req.raw.signal),
    }),
  );
  app.get('/dots/:id/computer/desktop/frame', async (c) => {
    const image = await desktop.frame(c.req.param('id'), c.req.raw.signal);
    return c.body(new Uint8Array(image), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
    });
  });
  app.post('/dots/:id/computer/desktop/input', async (c) =>
    c.json(
      await desktop.owner(
        c.req.param('id'),
        ownerInput.parse(await c.req.json()),
        c.req.raw.signal,
      ),
    ),
  );
  return app;
}
