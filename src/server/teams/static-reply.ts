// A reply that needs no model: the server writes a fixed message into a conversation through the
// same runner that stores chat turns, so it is saved, replayed and attributed (thread_authors) like
// any other turn. Used by direct team chats for "Sent to ..." and the Results message.
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

export class StaticReply extends AbstractAgent {
  constructor(
    private text: string,
    agentId: string,
  ) {
    super({ agentId });
  }

  clone() {
    return new StaticReply(this.text, this.agentId ?? '');
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = randomUUID();
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: this.text },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}
