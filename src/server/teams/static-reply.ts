// A reply that needs no model: the server writes a fixed message into a conversation through the
// same runner that stores chat turns, so it is saved, replayed and attributed (thread_authors) like
// any other turn. Used by direct team chats for "Sent to ..." and the Results message. A tool call
// (with its result) can be stored with the reply: the "Sent to ..." line names its team run that way,
// so the chat draws the run's work band there.
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

export interface StaticToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

export class StaticReply extends AbstractAgent {
  constructor(
    private text: string,
    agentId: string,
    private toolCall?: StaticToolCall,
  ) {
    super({ agentId });
  }

  clone() {
    return new StaticReply(this.text, this.agentId ?? '', this.toolCall);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = randomUUID();
      const toolCallId = randomUUID();
      const call = this.toolCall;
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: this.text },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        ...(call
          ? [
              {
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName: call.name,
                parentMessageId: messageId,
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: JSON.stringify(call.args),
              },
              { type: EventType.TOOL_CALL_END, toolCallId },
              {
                type: EventType.TOOL_CALL_RESULT,
                messageId: randomUUID(),
                toolCallId,
                content: JSON.stringify(call.result),
                role: 'tool',
              },
            ]
          : []),
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
