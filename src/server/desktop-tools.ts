// The tools a Dot uses on its computer's desktop. Each returns the windows afterwards (ids, titles,
// positions and which one is active), so the Dot can see what changed without a picture: screenshots
// are never sent to the model. Keyboard-first: window titles and keys are reliable, blind clicks are not.
import { defineTool } from '@copilotkit/runtime/v2';
import type { DesktopService } from './desktop-service.js';
import {
  DESKTOP_APPS,
  SCREEN,
  desktopInputs,
  type DesktopAction,
} from './desktop-commands.js';

const APP_LIST = Object.entries(DESKTOP_APPS)
  .map(([role, app]) => `${role}: ${app}`)
  .join(', ');

export const desktopPrompt = `Your computer also has a desktop (${SCREEN.width}x${SCREEN.height}) with windows besides the browser. Use the browser tools for websites and the desktop tools for desktop apps (${APP_LIST}). Work with the keyboard: open or focus a window, check in the result that it is active, then type and press keys (for example ctrl+s to save, Return to confirm a dialog). Window titles show the file name and an asterisk for unsaved changes. You cannot see the screen, so click only at coordinates you know from window positions. Check files you saved with the computer file tools.`;

const descriptions: Record<DesktopAction, string> = {
  windows:
    'List the windows on the desktop: id, title, position, size and which one is active.',
  open: `Open a desktop app: editor (${DESKTOP_APPS.editor}, a text editor) or terminal (${DESKTOP_APPS.terminal}). For the editor, pass a file path relative to the workspace to open or create it. Returns the windows; the new one is usually active.`,
  focus:
    'Bring a window to the front and give it the keyboard, by its id from the window list.',
  type: 'Type text into the active window, as if on a keyboard. Use \\n for new lines in an editor; in a terminal, press Return with desktop_key to run a line.',
  key: 'Press keys or shortcuts in the active window, in order, using X key names: Return, Tab, Escape, BackSpace, ctrl+s, ctrl+a, alt+F4, shift+Tab.',
  click: `Click at a screen position (x 0-${SCREEN.width - 1}, y 0-${SCREEN.height - 1}). Only use positions you know, for example inside a window from the window list.`,
};

export function desktopTools(
  desktop: DesktopService,
  dotId: string,
  check: () => void,
  signal: AbortSignal,
) {
  return (Object.keys(descriptions) as DesktopAction[]).map((action) =>
    defineTool({
      name: `desktop_${action}`,
      description: descriptions[action],
      parameters: desktopInputs[action],
      execute: async (input: unknown) => {
        check();
        try {
          return await desktop.act(dotId, action, input, 'agent', signal);
        } catch (error) {
          return {
            error:
              error instanceof Error ? error.message : 'Desktop action failed.',
          };
        }
      },
    }),
  );
}
