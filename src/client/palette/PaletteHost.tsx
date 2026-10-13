import { useEffect, useState } from 'react';
import type { Prompt } from '../../shared/prompts';
import type { Dot, WorkspaceState } from '../../shared/types';
import { api } from '../api';
import type { Dialog } from '../WorkspaceDialog';
import { CommandPalette } from './CommandPalette';
import type { PaletteAction, PaletteHandlers } from './palette-model';
import { readRecents, recordRecent } from './recents';
import type { CommandPaletteControl } from './useCommandPalette';

export interface PaletteHostProps {
  palette: CommandPaletteControl;
  workspace: WorkspaceState;
  /** The Dot the owner is working with. */
  dot: Dot;
  configured: boolean;
  view: 'chat' | 'tasks' | 'memories' | 'space' | 'approvals';
  selectedThread?: string;
  spaceId: string;
  pageId?: string;
  onSelectThread: (id: string) => void;
  onOpenPage: (spaceId: string, pageId?: string) => void;
  onChooseDot: (dot: Dot) => void;
  /** Starts a fresh chat with a Dot, optionally with text already in the composer. */
  onNewChat: (dot: Dot, text?: string) => void;
  onTogglePause: (dot: Dot) => void;
  onView: (view: 'tasks' | 'approvals') => void;
  onDialog: (dialog: Dialog) => void;
  onError: (message: string) => void;
}

/** Connects the palette to the app: what each result opens, and which chats and pages count as recent. */
export function PaletteHost(props: PaletteHostProps) {
  const { palette, workspace, dot, view, selectedThread, spaceId, pageId } =
    props;
  const [recents, setRecents] = useState(readRecents);

  // Whatever is on screen is the newest recent item.
  useEffect(() => {
    if (view === 'chat' && selectedThread)
      setRecents(recordRecent({ kind: 'chat', id: selectedThread }));
    else if (view === 'space' && pageId)
      setRecents(recordRecent({ kind: 'page', id: pageId, spaceId }));
  }, [view, selectedThread, spaceId, pageId]);

  const dotById = (id?: string) =>
    workspace.dots.find((item) => item.id === id);
  const runAction = (action: PaletteAction) => {
    const target = 'dotId' in action ? dotById(action.dotId) : undefined;
    switch (action.type) {
      case 'new-chat':
        if (target) props.onNewChat(target);
        break;
      case 'create-dot':
        props.onDialog({ type: 'dot', spaceId: workspace.spaces[0]!.id });
        break;
      case 'create-space':
        props.onDialog({ type: 'space' });
        break;
      case 'settings':
        props.onDialog({ type: 'settings' });
        break;
      case 'prompts':
        props.onDialog({ type: 'settings', tab: 'prompts' });
        break;
      case 'approvals':
        props.onView('approvals');
        break;
      case 'scheduled':
        props.onView('tasks');
        break;
      case 'pause-dot':
      case 'resume-dot':
        if (target && !!target.paused === (action.type === 'resume-dot'))
          props.onTogglePause(target);
        break;
    }
  };
  const handlers: PaletteHandlers = {
    openThread: (threadId) => props.onSelectThread(threadId),
    openPage: (page, id) => props.onOpenPage(page, id),
    openDot: (dotId) => {
      const target = dotById(dotId);
      if (target) props.onChooseDot(target);
    },
    // A prompt starts a new chat with its text in the composer; the owner still presses send.
    usePrompt: (promptId, dotId) => {
      void api<Prompt>(`/prompts/${promptId}`)
        .then((prompt) =>
          props.onNewChat(
            dotById(dotId ?? prompt.dotId ?? undefined) ?? dot,
            prompt.body,
          ),
        )
        .catch((e) =>
          props.onError(
            e instanceof Error ? e.message : 'Could not open the prompt.',
          ),
        );
    },
    runAction,
  };

  return (
    <CommandPalette
      open={palette.open}
      onClose={palette.hide}
      initialQuery={palette.initialQuery}
      workspace={workspace}
      currentDotId={dot.id}
      configured={props.configured}
      recents={recents}
      handlers={handlers}
    />
  );
}
