// Message actions (pin, retry, branch, edit and resend): shapes the server and the chat share.
import { MAX_CONVERSATION_TITLE_LENGTH } from './conversation-title.js';

/** A message the owner pinned to the top of its conversation. */
export interface PinnedMessage {
  messageId: string;
  createdAt: number;
}

/** Message ids are client-made UUIDs; anything longer is not one of ours. */
export const MESSAGE_ID_MAX = 200;

/** "Branch of <title>", kept within the conversation title limit. */
export function branchTitle(title: string): string {
  const full = `Branch of ${title}`;
  return full.length <= MAX_CONVERSATION_TITLE_LENGTH
    ? full
    : `${full.slice(0, MAX_CONVERSATION_TITLE_LENGTH - 1)}…`;
}
