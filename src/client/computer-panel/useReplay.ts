import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { CopilotKitContext } from '@copilotkit/react-core/v2/context';
import type { ComputerReplay } from '../../shared/computer-types';
import { api, authHeaders } from '../api';
import {
  mergeReplay,
  transcriptReplaySteps,
  type ReplayEntry,
} from './replay-model';

const REFRESH_MS = 5000;

/**
 * The chat's messages for a conversation, when its chat is open in this window. Chat registers its
 * agent as `chat-<threadId>` (see Chat.tsx); reading it here keeps the transcript in one place.
 * Outside a CopilotKit provider, or before the chat has loaded, there is simply no transcript.
 */
function useTranscript(threadId: string | undefined): readonly Message[] {
  const context = useContext(CopilotKitContext);
  const copilotkit = context?.copilotkit;
  const [, update] = useReducer((count: number) => count + 1, 0);
  const agentId = threadId ? `chat-${threadId}` : undefined;
  const agents = copilotkit?.agents as
    Record<string, AbstractAgent | undefined> | undefined;
  const agent = agentId ? agents?.[agentId] : undefined;
  useEffect(() => {
    if (!copilotkit) return;
    const subscription = copilotkit.subscribe({ onAgentsChanged: update });
    return () => subscription.unsubscribe();
  }, [copilotkit]);
  useEffect(() => {
    if (!agent) return;
    const subscription = agent.subscribe({ onMessagesChanged: update });
    return () => subscription.unsubscribe();
  }, [agent]);
  return agent?.messages ?? [];
}

export interface ReplayData {
  entries: ReplayEntry[];
  /** Whether new pictures are being kept, as the server last said. */
  replayOn?: boolean;
  loading: boolean;
  error: string;
  /** An object URL for a kept picture, once it has been fetched. */
  frameUrl: (frameId: string) => string | undefined;
  /** Fetches a picture if it is not here yet. */
  loadFrame: (frameId: string) => void;
}

/** The Replay tab's data: the transcript's steps, the server's steps, and their pictures. */
export function useReplay(
  dotId: string,
  threadId: string | undefined,
  active: boolean,
): ReplayData {
  const messages = useTranscript(threadId);
  const [server, setServer] = useState<ComputerReplay>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [frames, setFrames] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    setServer(undefined);
    setError('');
    if (!active || !threadId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      try {
        const next = await api<ComputerReplay>(
          `/dots/${encodeURIComponent(dotId)}/computer/replay?threadId=${encodeURIComponent(threadId)}`,
          'GET',
          undefined,
          controller.signal,
        );
        setServer(next);
        setError('');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error ? cause.message : 'Could not load the replay.',
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void load(), REFRESH_MS);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [dotId, threadId, active]);

  // Pictures belong to this Dot; switching Dots starts afresh.
  useEffect(() => {
    const owned = urls.current;
    const asked = requested.current;
    return () => {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.length = 0;
      asked.clear();
      setFrames({});
    };
  }, [dotId]);

  const entries = useMemo(
    () => mergeReplay(transcriptReplaySteps(messages), server?.steps ?? []),
    [messages, server],
  );
  const frameUrl = useCallback((frameId: string) => frames[frameId], [frames]);
  const loadFrame = useCallback(
    (frameId: string) => {
      if (requested.current.has(frameId)) return;
      requested.current.add(frameId);
      // An <img> cannot send the owner token, so the picture is fetched and shown from memory.
      void fetch(
        `/api/dots/${encodeURIComponent(dotId)}/computer/frames/${encodeURIComponent(frameId)}`,
        { headers: authHeaders() },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          const url = URL.createObjectURL(await response.blob());
          urls.current.push(url);
          setFrames((before) => ({ ...before, [frameId]: url }));
        })
        .catch(() => {
          // Shown as a step without a picture; asking again later is allowed.
          requested.current.delete(frameId);
        });
    },
    [dotId],
  );
  return {
    entries,
    replayOn: server?.replay,
    loading: loading && !server,
    error,
    frameUrl,
    loadFrame,
  };
}
