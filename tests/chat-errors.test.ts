import { expect, it } from 'vitest';
import {
  busyKind,
  isBusyMessage,
  isThreadRunningMessage,
  threadRunningMessage,
  turnErrorMessage,
} from '../src/client/chat-errors';

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

it('handles "Thread already running" like the busy case and names the Dot', () => {
  const raw =
    'HTTP 409: {"error":"Thread already running: Writer is answering in this chat.","code":"thread_running"}';
  expect(isThreadRunningMessage(raw)).toBe(true);
  expect(busyKind(raw)).toBe('thread');
  expect(busyKind('This Dot is busy with another conversation.')).toBe('dot');
  expect(busyKind('The model could not answer: timeout')).toBeUndefined();
  expect(threadRunningMessage('Writer')).toBe(
    'Writer is answering in this chat right now. Your message is kept: send it again when it is done, or stop the other work.',
  );
  expect(turnErrorMessage('Thread already running', 'Scout')).toBe(
    threadRunningMessage('Scout'),
  );
  // The shown message is still recognised, so its buttons stay.
  expect(busyKind(threadRunningMessage())).toBe('thread');
  expect(threadRunningMessage()).toMatch(/^Another Dot is answering/);
});
