// A teammate's chat, live, inside its lane. Mounted only while the owner has the lane expanded (at
// most MAX_LIVE_LANES at once): each one holds a streaming connection. Per the P0 spike it uses its
// own local agent id, clears before every connect, connects when the teammate's turn starts and
// detaches when it ends, and never calls copilotkit.stopAgent (that would stop the main chat's run;
// lanes stop through the server instead).
import { useCallback, useEffect, useState } from 'react';
import type { Message } from '@ag-ui/core';
import { useAgent, useCopilotKit } from '@copilotkit/react-core/v2';
import type { LaneProgress } from '../../shared/lanes';
import { ChatTranscript, isInternalVoiceReceipt } from '../ChatTranscript';
import { isActivityTool } from '../chat-turns';
import { useLiveEvent } from '../useLiveEvents';
import { isLaneTool } from '../../shared/lanes';
import { LanesContext } from './lanes-context';

/** The local agent id of a lane's live view: unique per teammate chat, never the main chat's. */
export const laneAgentId = (childThreadId: string) => `lane-${childThreadId}`;

/** The messages a lane's transcript shows: the owner-visible text and the tool blocks. */
export function laneMessages(messages: Message[]): Message[] {
  return messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              isActivityTool(call.function.name) ||
              isLaneTool(call.function.name),
          ))),
  );
}

export function LaneTranscript({
  id,
  lane,
  name,
}: {
  id: string;
  lane: LaneProgress;
  name: string;
}) {
  const agentId = laneAgentId(lane.childThreadId);
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: lane.childDotId,
    threadId: lane.childThreadId,
  });
  const { copilotkit } = useCopilotKit();
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const connect = useCallback(() => {
    // A same-thread connect keeps local messages and replays history on top: start empty.
    agent.setMessages([]);
    return copilotkit
      .connectAgent({ agent })
      .then(() => setLoaded(true))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not connect.'),
      );
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    void connect();
    return () => {
      void agent.detachActiveRun().catch(() => {});
    };
  }, [isReady, connect, agent]);
  // The lane's own connect errors stay here (the main chat filters them out by agent id).
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error: reported, context }) => {
        if (context?.agentId === agentId) setError(reported.message);
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, agentId]);
  useLiveEvent('turn.started', (event) => {
    if (event.threadId === lane.childThreadId && isReady) void connect();
  });
  useLiveEvent('turn.finished', (event) => {
    if (event.threadId !== lane.childThreadId || !isReady) return;
    // Let go of the finished run, then show the stored result.
    void agent
      .detachActiveRun()
      .catch(() => {})
      .then(() => connect());
  });
  const visible = laneMessages(agent.messages);
  return (
    <div
      className="fd-lane-transcript"
      id={id}
      role="region"
      aria-label={`${name}’s chat`}
    >
      {error && (
        <p className="fd-lane-transcript-note" role="status">
          The live view is not available ({error}). The lane above still
          updates.
        </p>
      )}
      {!loaded && !error && !visible.length && (
        <p className="fd-lane-transcript-note">Opening {name}’s chat…</p>
      )}
      {loaded && !visible.length && (
        <p className="fd-lane-transcript-note">
          Nothing written yet. {name} starts soon.
        </p>
      )}
      {/* A teammate's own hand-offs show as plain lines here, not as lanes of this chat. */}
      <LanesContext.Provider value={null}>
        <ChatTranscript
          messages={visible}
          calls={[]}
          allMessages={agent.messages}
          running={lane.status === 'working'}
          dotName={name}
        />
      </LanesContext.Provider>
    </div>
  );
}
