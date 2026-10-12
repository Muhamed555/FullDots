/** True when the server refused the turn because the Dot was busy with other work. */
export const isBusyMessage = (text: string) => /busy with /i.test(text);

/**
 * What the chat says when a turn produced no reply. A busy refusal is shown as it is, because the
 * message was kept and can be sent again once the Dot is free; other reasons keep their prefix.
 */
export function turnErrorMessage(runError: string): string {
  if (isBusyMessage(runError))
    return `${runError} Your message is kept: send it again when the Dot is free.`;
  return runError
    ? `The model could not answer: ${runError}`
    : 'The current turn returned no response. Check the runtime connection and retry.';
}
