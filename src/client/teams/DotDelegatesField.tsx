// "Can hand work to" in the Dot dialog: the teammates the owner ticks for this Dot, plus the members
// of the teams it leads, shown locked ("via <team>") because the team grants them. A Dot with two
// or more ticked teammates can turn them into a named team it leads; nothing moves by itself.
import { useEffect, useState } from 'react';
import { Lock, Users } from 'lucide-react';
import type { Team } from '../../shared/teams';
import type { Dot, DotColor } from '../../shared/types';
import { api } from '../api';
import './teams.css';

export interface ImpliedDelegate {
  dotId: string;
  teams: { id: string; name: string; emoji: string }[];
}

/** The name of a team made from a Dot's teammates, avoiding names already taken. */
export const madeTeamName = (dotName: string, attempt: number) =>
  `${dotName}'s team${attempt ? ` ${attempt + 1}` : ''}`.slice(0, 40);

export function DotDelegatesField({
  dotId,
  dotName,
  dotColor,
  dots,
  value,
  onChange,
  initialImplied,
}: {
  /** Undefined while the Dot is being created. */
  dotId?: string;
  dotName: string;
  dotColor?: DotColor | null;
  dots: Dot[];
  value: string[];
  onChange: (ids: string[]) => void;
  initialImplied?: ImpliedDelegate[];
}) {
  const [implied, setImplied] = useState<ImpliedDelegate[]>(
    initialImplied ?? [],
  );
  const [made, setMade] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dotId || initialImplied) return;
    let active = true;
    void api<{ implied?: ImpliedDelegate[] }>(`/dots/${dotId}/team`)
      .then((data) => active && setImplied(data.implied ?? []))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dotId, initialImplied]);
  const others = dots.filter((item) => item.id !== dotId);
  if (!others.length)
    return (
      <p className="dlg-hint">
        Create another Dot first; then this one can hand it work.
      </p>
    );
  const makeTeam = async () => {
    if (!dotId) return;
    setBusy(true);
    setError('');
    for (let attempt = 0; attempt < 6; attempt++)
      try {
        const team = await api<Team>('/teams', 'POST', {
          name: madeTeamName(dotName, attempt),
          emoji: '✨',
          color: dotColor ?? 'coral',
          leadDotId: dotId,
          members: value.map((id) => ({ dotId: id })),
        });
        setMade(`${team.emoji} ${team.name}`);
        setBusy(false);
        return;
      } catch (e) {
        // 409: the name is taken; try the next one.
        if ((e as { status?: number }).status === 409) continue;
        setError(e instanceof Error ? e.message : 'Could not make the team.');
        break;
      }
    setBusy(false);
  };
  return (
    <>
      <div className="dlg-list" role="group" aria-label="Can hand work to">
        {others.map((item) => {
          const via = implied.find((entry) => entry.dotId === item.id);
          return (
            <label
              className={`dlg-check-row ${via ? 'dd-locked' : ''}`}
              key={item.id}
            >
              <input
                type="checkbox"
                checked={!!via || value.includes(item.id)}
                disabled={!!via}
                aria-describedby={via ? `dd-via-${item.id}` : undefined}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, item.id]
                      : value.filter((id) => id !== item.id),
                  )
                }
              />
              <span className="dlg-team-text">
                <strong>{item.name}</strong>
                <small>{item.instructions.split('\n')[0]!.slice(0, 90)}</small>
              </span>
              {via && (
                <span className="dd-via" id={`dd-via-${item.id}`}>
                  <Lock size={11} aria-hidden />
                  {`via ${via.teams
                    .map((team) => `${team.emoji} ${team.name}`)
                    .join(', ')}`}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {implied.length > 0 && (
        <p className="dlg-hint">
          Locked rows come from teams this Dot leads. Change them on the team.
        </p>
      )}
      {dotId && value.length >= 2 && (
        <div className="dd-make">
          <button
            type="button"
            className="dd-make-btn"
            disabled={busy}
            onClick={() => void makeTeam()}
          >
            <Users size={14} aria-hidden />
            Make a team from these teammates
          </button>
          <span className="dlg-hint">
            {dotName} leads it; your ticks stay as they are.
          </span>
        </div>
      )}
      {made && (
        <p className="dd-made" role="status">
          Made {made}. Find it under Teams in the sidebar.
        </p>
      )}
      {error && (
        <p className="tb-invalid" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
