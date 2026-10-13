/** True when the server refused the turn because the Dot was busy with other work. */
export const isBusyMessage = (text: string) => /busy with /i.test(text);

/** True when another turn (in a group chat, perhaps another Dot's) is running in this conversation. */
export const isThreadRunningMessage = (text: string) =>
  /thread already running|is answering in this chat/i.test(text);

/**
 * dot: the Dot is busy elsewhere (stop its other work); thread: a turn runs in this very chat (stop
 * that turn); undefined: not a busy refusal.
 */
export function busyKind(text: string): 'dot' | 'thread' | undefined {
  if (isThreadRunningMessage(text)) return 'thread';
  if (isBusyMessage(text)) return 'dot';
  return undefined;
}

/** What the chat says when a turn already runs here, naming the Dot whose turn it is when known. */
export function threadRunningMessage(name?: string): string {
  return `${name ?? 'Another Dot'} is answering in this chat right now. Your message is kept: send it again when it is done, or stop the other work.`;
}

/**
 * What the chat says when a turn produced no reply. A busy refusal is shown as it is, because the
 * message was kept and can be sent again once the Dot is free; other reasons keep their prefix.
 */
export function turnErrorMessage(
  runError: string,
  runningName?: string,
): string {
  if (isThreadRunningMessage(runError))
    return threadRunningMessage(runningName);
  if (isBusyMessage(runError))
    return `${runError} Your message is kept: send it again when the Dot is free.`;
  return runError
    ? `The model could not answer: ${runError}`
    : 'The current turn returned no response. Check the runtime connection and retry.';
}
