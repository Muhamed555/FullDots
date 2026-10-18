// The shell commands behind desktop control. Each is built from validated, structured input and
// quoted for a POSIX shell, so text a Dot types or a window it names never becomes shell syntax.
// They run through the computer's ordinary `exec` call, which has DISPLAY set in the desktop image.
import { z } from 'zod';
import type { DesktopWindow } from '../shared/desktop-types.js';

/** The size of the virtual display OpenBot starts (Xvfb 1280x800). */
export const SCREEN = { width: 1280, height: 800 } as const;

/** Desktop apps a Dot may open, by role. Installed by deployment/computers/desktop.Dockerfile. */
export const DESKTOP_APPS = {
  editor: 'mousepad',
  terminal: 'xterm',
} as const;
export type DesktopApp = keyof typeof DESKTOP_APPS;

const TYPE_MAX_CHARS = 4000;
/** xdotool's per-character delay: fast, but slow enough for GTK apps not to drop keys. */
const TYPE_DELAY_MS = 8;

/** A string as one POSIX shell word. */
export const shellQuote = (value: string) =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** A path inside the computer's workspace: relative, no `..`, no option-looking first character. */
const workspacePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.startsWith('-') &&
      !path.split('/').includes('..') &&
      !/[\0\n\r]/.test(path),
    'Use a path relative to the workspace, without "..".',
  );

export const desktopInputs = {
  windows: z.object({}).strict(),
  open: z
    .object({
      app: z.enum(Object.keys(DESKTOP_APPS) as [DesktopApp, ...DesktopApp[]]),
      file: workspacePath.optional(),
    })
    .strict(),
  focus: z
    .object({ windowId: z.string().regex(/^0x[0-9a-f]{1,10}$/i) })
    .strict(),
  type: z.object({ text: z.string().min(1).max(TYPE_MAX_CHARS) }).strict(),
  key: z
    .object({
      keys: z
        .array(
          z
            .string()
            .regex(
              /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/,
              'Use X key names such as ctrl+s, Return, Tab or alt+F4.',
            ),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  click: z
    .object({
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
      button: z.enum(['left', 'middle', 'right']).default('left'),
      double: z.boolean().default(false),
    })
    .strict(),
};
export type DesktopAction = keyof typeof desktopInputs;
type Input<A extends DesktopAction> = z.output<(typeof desktopInputs)[A]>;

const WINDOWS =
  'wmctrl -lG; echo "--active--"; xdotool getactivewindow 2>/dev/null || true';
const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

/** One shell command and how long it may take. Every action ends by listing the windows. */
export function desktopCommand<A extends DesktopAction>(
  action: A,
  input: Input<A>,
): { command: string; timeoutMs: number } {
  // The action's own exit status is kept, so a failed action is reported even though the window
  // list after it still prints.
  const then = (command: string, timeoutMs = 10_000) => ({
    command: `${command}; status=$?; sleep 0.4; ${WINDOWS}; exit $status`,
    timeoutMs,
  });
  switch (action) {
    case 'windows':
      return { command: WINDOWS, timeoutMs: 10_000 };
    case 'open': {
      const { app, file } = input as Input<'open'>;
      const args = file ? ` -- ${shellQuote(file)}` : '';
      // Detached from the exec call, so the command returns while the app keeps running.
      return then(
        `setsid -f ${DESKTOP_APPS[app]}${args} >/dev/null 2>&1 </dev/null; sleep 1.5; true`,
      );
    }
    case 'focus':
      return then(
        `wmctrl -i -a ${(input as Input<'focus'>).windowId.toLowerCase()}`,
      );
    case 'type': {
      const { text } = input as Input<'type'>;
      return then(
        `xdotool type --clearmodifiers --delay ${TYPE_DELAY_MS} -- ${shellQuote(text)}`,
        10_000 + text.length * TYPE_DELAY_MS * 2,
      );
    }
    case 'key':
      return then(
        `xdotool key --clearmodifiers --delay 80 ${(input as Input<'key'>).keys.join(' ')}`,
      );
    case 'click': {
      const { x, y, button, double } = input as Input<'click'>;
      return then(
        `xdotool mousemove --sync ${x} ${y} click${double ? ' --repeat 2' : ''} ${BUTTONS[button]}`,
      );
    }
  }
  throw new Error('Unknown desktop action.');
}

/**
 * A picture of the whole desktop as base64 JPEG. The computer returns at most 64 KB of output, so
 * `small` is the fallback when a busy screen does not fit at the normal size.
 */
export function frameCommand(small = false) {
  const [size, quality] = small ? ['800x500', 35] : ['1024x640', 50];
  return {
    command: `import -window root -resize ${size} -quality ${quality} jpeg:- | base64 -w0`,
    timeoutMs: 10_000,
  };
}

/** Whether this computer has a desktop: a display, the window tools and the screen grabber. */
export const PROBE_COMMAND =
  'test -n "$DISPLAY" && command -v xdotool >/dev/null && command -v wmctrl >/dev/null && command -v import >/dev/null';

/**
 * Reads `wmctrl -lG` and the active window id (decimal, from xdotool).
 *
 * A line is: id desktop x y width height host title…, and desktop -1 is a sticky window such as a
 * panel. The title is everything after the host and can contain spaces.
 */
export function parseWindows(stdout: string): DesktopWindow[] {
  const [list = '', active = ''] = stdout.split('--active--');
  const activeId = Number.parseInt(active.trim(), 10);
  const windows: DesktopWindow[] = [];
  for (const line of list.split('\n')) {
    const match =
      /^(0x[0-9a-f]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i.exec(
        line.trim(),
      );
    if (!match) continue;
    const [, id, , x, y, width, height, title] = match;
    windows.push({
      id: id!.toLowerCase(),
      title: title!.trim(),
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: Number.parseInt(id!, 16) === activeId,
    });
  }
  return windows;
}
