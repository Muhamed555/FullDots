// A team chat inside Chat.tsx: a banner naming the team and how it works, and, for a "Direct"
// team, the send path that dispatches the owner's message to every member (no lead model call).
// Results arrive as a stored run, which the chat picks up from its turn.finished.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  TEAM_MODE_LABELS,
  TEAM_STYLE_LABELS,
  type Team,
} from '../../shared/teams';
import type { Conversation, Dot } from '../../shared/types';
import { api } from '../api';
import { useLiveEvent } from '../useLiveEvents';
import { TeamStack } from './TeamCharacters';
import './teams.css';

export interface TeamChat {
  team?: Team;
  /** Sends go to /api/teams/:id/dispatch instead of the lead's agent. */
  direct: boolean;
  banner: ReactNode;
  placeholder?: string;
  /** Direct mode: true when the message was taken. */
  dispatch: (text: string) => Promise<boolean>;
}

export function TeamChatBanner({
  team,
  dots,
  error,
  onDismiss,
}: {
  team: Team;
  dots: Dot[];
  error?: string;
  onDismiss?: () => void;
}) {
  const direct = team.mode === 'direct';
  return (
    <div
      className="team-chat-banner"
      style={{ '--team-color': `var(--dot-${team.color}-base)` } as never}
      role="note"
      aria-label={`Team chat with ${team.name}`}
    >
      <span className="tcb-emoji" aria-hidden>
        {team.emoji}
      </span>
      <span className="tcb-text">
        <a href={`#/team/${team.id}`} className="tcb-name">
          {team.name}
        </a>
        <small>
          {direct
            ? `Direct: your message goes to all ${team.members.length} members`
            : `${TEAM_MODE_LABELS.lead}: the lead briefs the team`}
          {' · '}
          {TEAM_STYLE_LABELS[team.style]}
        </small>
      </span>
      <TeamStack
        leadDotId={team.leadDotId}
        memberIds={team.members.map((member) => member.dotId)}
        dots={dots}
        max={5}
      />
      {error && (
        <span className="tcb-error" role="alert">
          {error}
          {onDismiss && (
            <button type="button" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function useTeamChat({
  thread,
  dots,
}: {
  thread: Conversation;
  dots: Dot[];
}): TeamChat {
  const [team, setTeam] = useState<Team>();
  const [error, setError] = useState('');
  const teamId = thread.teamId;
  const load = useCallback(() => {
    if (!teamId) return;
    void api<Team>(`/teams/${teamId}`)
      .then(setTeam)
      .catch(() => {});
  }, [teamId]);
  useEffect(() => {
    setTeam(undefined);
    load();
  }, [load]);
  useLiveEvent('workspace.changed', () => load());
  const direct = !!team && team.mode === 'direct' && !team.archivedAt;
  const dispatch = useCallback(
    async (text: string) => {
      if (!team) return false;
      setError('');
      try {
        await api(`/teams/${team.id}/dispatch`, 'POST', {
          threadId: thread.id,
          text,
        });
        return true;
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Could not send to the team.',
        );
        return false;
      }
    },
    [team, thread.id],
  );
  return {
    ...(team ? { team } : {}),
    direct,
    banner: team ? (
      <TeamChatBanner
        team={team}
        dots={dots}
        error={error}
        onDismiss={() => setError('')}
      />
    ) : null,
    ...(direct && team
      ? { placeholder: `Message everyone on ${team.name}…` }
      : {}),
    dispatch,
  };
}
