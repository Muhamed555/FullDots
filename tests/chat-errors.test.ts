import { expect, it } from 'vitest';
import { isBusyMessage, turnErrorMessage } from '../src/client/chat-errors';

it('shows a busy refusal as it is and says the message is kept', () => {
  const busy =
    'This Dot is busy with background work (task). Stop it or wait for it to finish.';
  expect(isBusyMessage(busy)).toBe(true);
  expect(turnErrorMessage(busy)).toBe(
    `${busy} Your message is kept: send it again when the Dot is free.`,
  );
});

it('keeps the model prefix for other reasons and a generic line without one', () => {
  expect(turnErrorMessage('401 API key expired.')).toBe(
    'The model could not answer: 401 API key expired.',
  );
  expect(turnErrorMessage('')).toMatch(
    /^The current turn returned no response/,
  );
  expect(isBusyMessage('The model could not answer: timeout')).toBe(false);
});
