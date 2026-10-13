// Connects named teams to the app with a few hook lines in App.tsx: the sidebar section's data and
// actions, the team page, the builder dialog, and "Start team chat".
import { useCallback, useState } from 'react';
import type { Team } from '../../shared/teams';
import type { Conversation, Dot } from '../../shared/types';
import { api } from '../api';
import type { TeamDraft } from './builder-model';
import { TeamBuilder } from './TeamBuilder';
import { TeamPage } from './TeamPage';
import type { SidebarTeams } from './TeamsSection';
import { useTeams } from './useTeams';

/** Focuses the open chat's composer once it has rendered (a few frames at most). */
function focusComposer(tries = 30) {
  if (typeof document === 'undefined') return;
  const box = document.querySelector<HTMLTextAreaElement>(
    '.live-chat textarea',
  );
  if (box) box.focus();
  else if (tries > 0) requestAnimationFrame(() => focusComposer(tries - 1));
}

export function useTeamsHost({
  dots,
  view,
  teamId,
  onOpenThread,
  onRefresh,
  onError,
}: {
  dots: Dot[];
  view: string;
  /** The team whose page is open (from `#/team/<id>`). */
  teamId?: string;
  /** Opens a conversation in the chat view; `dotId` is its host when the app may not know it yet. */
  onOpenThread: (threadId: string, dotId?: string) => void;
  /** Refetches the workspace (so a new team chat is known before it opens). */
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { teams, working, refresh } = useTeams();
  const [builder, setBuilder] = useState<{
    team?: Team;
    seed?: Partial<TeamDraft>;
  }>();

  const open = useCallback((id: string) => {
    location.hash = `#/team/${encodeURIComponent(id)}`;
  }, []);
  const startChat = useCallback(
    async (team: Pick<Team, 'id'>) => {
      try {
        const chat = await api<Conversation>(
          `/teams/${team.id}/conversations`,
          'POST',
          {},
        );
        await onRefresh();
        onOpenThread(chat.id, chat.dotId);
        requestAnimationFrame(() => focusComposer());
      } catch (e) {
        onError(
          e instanceof Error ? e.message : 'Could not start the team chat.',
        );
      }
    },
    [onOpenThread, onRefresh, onError],
  );
  const archive = useCallback(
    async (team: Team) => {
      if (
        !window.confirm(
          `Archive ${team.name}? Its Dots and chats stay; ${team.name} leaves the sidebar.`,
        )
      )
        return;
      try {
        await api(`/teams/${team.id}/archive`, 'POST', {});
        await refresh();
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Could not archive the team.');
      }
    },
    [refresh, onError],
  );
  const create = useCallback(
    (seed?: Partial<TeamDraft>) => setBuilder({ ...(seed ? { seed } : {}) }),
    [],
  );
  const edit = useCallback((team: Team) => setBuilder({ team }), []);

  const sidebar: SidebarTeams = {
    teams,
    working,
    ...(view === 'team' && teamId ? { activeTeamId: teamId } : {}),
    onOpen: (team) => open(team.id),
    onStartChat: (team) => void startChat(team),
    onEdit: edit,
    onArchive: (team) => void archive(team),
    onCreate: () => create(),
  };

  return {
    teams,
    working,
    sidebar,
    open,
    startChat,
    create,
    page: teamId ? (
      <TeamPage
        key={teamId}
        teamId={teamId}
        dots={dots}
        working={working}
        onStartChat={(team) => void startChat(team)}
        onEdit={edit}
        onArchive={(team) => void archive(team)}
        onOpenThread={(id) => onOpenThread(id)}
      />
    ) : null,
    dialog: builder ? (
      <TeamBuilder
        dots={dots}
        teams={teams}
        {...(builder.team ? { team: builder.team } : {})}
        {...(builder.seed ? { seed: builder.seed } : {})}
        onClose={() => setBuilder(undefined)}
        onSaved={(team) => {
          setBuilder(undefined);
          void refresh();
          // A template made Dots, and a team space may be new: the workspace refetches too.
          void onRefresh();
          open(team.id);
        }}
      />
    ) : null,
  };
}
