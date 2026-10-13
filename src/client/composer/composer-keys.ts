// Pure keyboard and trigger logic for the Composer, kept apart so it can be tested without a DOM.
import { shouldSubmitComposerOnKeyDown } from '../chat-composer';

export const COMPOSER_LIMIT = 4000;
/** The character count shows from here on. */
export const COMPOSER_COUNT_FROM = COMPOSER_LIMIT - 400;

/**
 * submit: send now; hold: Enter pressed but nothing can be sent, so keep the newline out;
 * none: let the key through (Shift+Enter, IME composition, any other key).
 */
export type ComposerKeyAction = 'submit' | 'hold' | 'none';

export function composerKeyAction(
  event: Parameters<typeof shouldSubmitComposerOnKeyDown>[0],
  canSubmit: boolean,
): ComposerKeyAction {
  if (!shouldSubmitComposerOnKeyDown(event)) return 'none';
  return canSubmit ? 'submit' : 'hold';
}

/** A character that opens a popover while the token it starts is typed (P2 `@`, P8 `/`). */
export interface ComposerTriggerSpec {
  char: string;
  /** Only when the token starts the message, as slash commands do. */
  atStart?: boolean;
}

export interface ComposerTriggerMatch {
  char: string;
  /** What follows the trigger character, up to the caret. */
  query: string;
  /** Where the token (trigger character included) starts and ends in the text. */
  start: number;
  end: number;
}

/** The trigger token the caret is in, if any. A token starts after whitespace or at the start. */
export function activeTrigger(
  value: string,
  caret: number,
  triggers: readonly ComposerTriggerSpec[],
): ComposerTriggerMatch | undefined {
  let start = Math.min(caret, value.length);
  const end = start;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  const token = value.slice(start, end);
  for (const trigger of triggers) {
    if (!trigger.char || !token.startsWith(trigger.char)) continue;
    if (trigger.atStart && start !== 0) continue;
    return {
      char: trigger.char,
      query: token.slice(trigger.char.length),
      start,
      end,
    };
  }
  return undefined;
}

/** The text with the token replaced, and where the caret goes afterwards. */
export function replaceToken(
  value: string,
  match: Pick<ComposerTriggerMatch, 'start' | 'end'>,
  text: string,
) {
  const next = value.slice(0, match.start) + text + value.slice(match.end);
  return { value: next, caret: match.start + text.length };
}

/** The message as sent: the optional source page goes on its own line first. */
export function composeMessage(text: string, source: string) {
  return `${source ? `From ${source}:\n\n` : ''}${text}`;
}
