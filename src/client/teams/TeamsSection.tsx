// The sidebar's Teams rows: emoji, name, the members' characters stacked (lead first, a little
// larger) and a live pulse while any of them works. The Section around it lives in Sidebar.tsx.
import { Archive, MessageSquarePlus, Pencil, Sparkles } from 'lucide-react';
import type { Team } from '../../shared/teams';
import type { Dot } from '../../shared/types';
import { RowMenu } from '../sidebar/RowMenu';
import { TeamStack } from './TeamCharacters';
import { teamIsWorking } from './team-helpers';
import './teams.css';

export interface SidebarTeams {
  teams: Team[];
  /** Dots holding a turn right now. */
  working: ReadonlySet<string>;
  /** The team whose page is open. */
  activeTeamId?: string;
  onOpen: (team: Team) => void;
  onStartChat: (team: Team) => void;
  onEdit: (team: Team) => void;
  onArchive: (team: Team) => void;
  onCreate: () => void;
}

export function TeamRows({
  teams,
  working,
  activeTeamId,
  dots,
  collapsed,
  onOpen,
  onStartChat,
  onEdit,
  onArchive,
  onCreate,
}: SidebarTeams & { dots: Dot[]; collapsed: boolean }) {
  if (!teams.length)
    return collapsed ? null : (
      <button type="button" className="sb-row sb-team-empty" onClick={onCreate}>
        <Sparkles size={15} aria-hidden />
        <span className="sb-text">Make your first team</span>
      </button>
    );
  return (
    <nav aria-label="Teams" className="sb-list sb-teams">
      {teams.map((team) => {
        const active = team.id === activeTeamId;
        const busy = teamIsWorking(team, working);
        const label = `${team.name}${busy ? ' (working)' : ''}`;
        return (
          <div className="sb-row-wrap" key={team.id}>
            <button
              type="button"
              className={[
                'sb-row',
                'sb-team',
                active && 'active',
                busy && 'working',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={active ? 'page' : undefined}
              {...(collapsed ? { 'aria-label': label, title: label } : {})}
              style={
                { '--team-color': `var(--dot-${team.color}-base)` } as never
              }
              onClick={() => onOpen(team)}
            >
              <span className="sb-team-emoji" aria-hidden>
                {team.emoji}
                {busy && <span className="sb-team-pulse" />}
              </span>
              <span className="sb-text sb-team-name">{team.name}</span>
              {busy && <span className="sb-sr">working</span>}
              <TeamStack
                leadDotId={team.leadDotId}
                memberIds={team.members.map((member) => member.dotId)}
                dots={dots}
                max={4}
                working={busy}
              />
            </button>
            <RowMenu
              label={`${team.name} options`}
              className="sb-row-more"
              items={[
                {
                  id: 'chat',
                  label: 'Start team chat',
                  icon: <MessageSquarePlus size={14} aria-hidden />,
                  onSelect: () => onStartChat(team),
                },
                {
                  id: 'edit',
                  label: 'Edit team',
                  icon: <Pencil size={14} aria-hidden />,
                  onSelect: () => onEdit(team),
                },
                {
                  id: 'archive',
                  label: 'Archive team',
                  icon: <Archive size={14} aria-hidden />,
                  danger: true,
                  onSelect: () => onArchive(team),
                },
              ]}
            />
          </div>
        );
      })}
    </nav>
  );
}
