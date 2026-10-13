// The team builder: name, emoji and colour, then a stage where the lead sits in the centre ring and
// members orbit it. Dots join by drag from the tray, or by the Add buttons (keyboard and phones);
// members are ordered with their handle (arrow keys) for step-by-step work. Then the work style
// (three option cards with tiny animated diagrams) and who plans: the lead (default) or Direct.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Crown,
  GripVertical,
  Plus,
  X,
} from 'lucide-react';
import {
  MAX_TEAM_MEMBERS,
  TEAM_EMOJI,
  TEAM_ROLE_MAX,
  type Team,
  type TeamMode,
  type TeamStyle,
} from '../../shared/teams';
import type { Dot } from '../../shared/types';
import { api } from '../api';
import { Mascot } from '../Mascot';
import {
  addToTeam,
  draftFromTeam,
  draftPayload,
  emptyDraft,
  hasErrors,
  makeLead,
  moveMember,
  movedMessage,
  onTeam,
  orderKey,
  removeFromTeam,
  setRole,
  teamIsFull,
  validateDraft,
  type DraftErrors,
  type TeamDraft,
} from './builder-model';
import { ChoiceGroup, Switch, TeamColorPicker } from './controls';
import { StyleDiagram } from './StyleDiagram';
import { TeamOrbit } from './TeamCharacters';
import '../dialog.css';
import './teams.css';

const DRAG_TYPE = 'application/x-fulldots-dot';

const STYLE_TEXT: Record<TeamStyle, { title: string; text: string }> = {
  parallel: {
    title: 'All at once',
    text: 'Every member gets a brief and works at the same time.',
  },
  sequential: {
    title: 'Step by step',
    text: 'Members work in order, each building on the one before.',
  },
  review: {
    title: 'With a reviewer',
    text: 'Members work, then one checks it all. Runs all at once for now.',
  },
};

const MODE_TEXT: Record<TeamMode, { title: string; text: string }> = {
  lead: {
    title: 'Lead plans (recommended)',
    text: 'You talk to the lead; it writes each member a brief and combines their results.',
  },
  direct: {
    title: 'Direct',
    text: 'Your message goes straight to every member; their answers come back side by side.',
  },
};

export interface TeamBuilderProps {
  dots: Dot[];
  teams: Team[];
  /** Editing an existing team; otherwise a new one, optionally pre-filled. */
  team?: Team;
  seed?: Partial<TeamDraft>;
  onClose: () => void;
  onSaved: (team: Team) => void;
  /** Starting state (tests). */
  initial?: TeamDraft;
}

export function TeamBuilder({
  dots,
  teams,
  team,
  seed,
  onClose,
  onSaved,
  initial,
}: TeamBuilderProps) {
  const [draft, setDraft] = useState<TeamDraft>(
    () => initial ?? (team ? draftFromTeam(team) : emptyDraft(seed)),
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [dropping, setDropping] = useState(false);
  const container = useRef<HTMLElement>(null);
  const handles = useRef(new Map<string, HTMLButtonElement | null>());
  const errors: DraftErrors = useMemo(
    () => (touched ? validateDraft(draft, teams) : {}),
    [draft, teams, touched],
  );
  const dotName = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'A removed Dot';
  const bench = dots.filter((dot) => !onTeam(draft, dot.id));
  const full = teamIsFull(draft);

  // Focus the name, keep Tab inside, close on Escape; give focus back when closed.
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current?.querySelector<HTMLElement>('input')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      if (event.key !== 'Tab') return;
      const items = [
        ...(container.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]),input,textarea,select,a[href]',
        ) ?? []),
      ];
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);

  const add = (dotId: string) => {
    const next = addToTeam(draft, dotId);
    if (next === draft) return;
    setDraft(next);
    setAnnouncement(
      next.leadDotId === dotId && draft.leadDotId !== dotId
        ? `${dotName(dotId)} leads the team.`
        : `${dotName(dotId)} joined the team.`,
    );
  };
  const remove = (dotId: string) => {
    const next = removeFromTeam(draft, dotId);
    setDraft(next);
    setAnnouncement(
      draft.leadDotId === dotId && next.leadDotId
        ? `${dotName(dotId)} left. ${dotName(next.leadDotId)} leads now.`
        : `${dotName(dotId)} left the team.`,
    );
  };
  const move = (from: number, to: number) => {
    const next = moveMember(draft, from, to);
    if (next === draft) return;
    setDraft(next);
    const moved = draft.members[from]!.dotId;
    setAnnouncement(
      movedMessage(
        dotName(moved),
        next.members.findIndex((m) => m.dotId === moved),
        next.members.length,
      ),
    );
    requestAnimationFrame(() => handles.current.get(moved)?.focus());
  };
  const promote = (dotId: string) => {
    setDraft(makeLead(draft, dotId));
    setAnnouncement(`${dotName(dotId)} leads the team.`);
  };

  const dragStart = (event: DragEvent, dotId: string) => {
    event.dataTransfer.setData(DRAG_TYPE, dotId);
    event.dataTransfer.setData('text/plain', dotName(dotId));
    event.dataTransfer.effectAllowed = 'move';
  };
  const dropOn = (target: 'stage' | 'tray') => ({
    onDragOver: (event: DragEvent) => {
      if (![...event.dataTransfer.types].includes(DRAG_TYPE)) return;
      event.preventDefault();
      if (target === 'stage') setDropping(true);
    },
    onDragLeave: () => target === 'stage' && setDropping(false),
    onDrop: (event: DragEvent) => {
      const dotId = event.dataTransfer.getData(DRAG_TYPE);
      setDropping(false);
      if (!dotId) return;
      event.preventDefault();
      if (target === 'stage') add(dotId);
      else if (onTeam(draft, dotId)) remove(dotId);
    },
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setError('');
    if (hasErrors(validateDraft(draft, teams))) return;
    setBusy(true);
    try {
      const body = draftPayload(draft);
      const saved = draft.id
        ? await api<Team>(`/teams/${draft.id}`, 'PATCH', body)
        : await api<Team>('/teams', 'POST', body);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the team.');
    } finally {
      setBusy(false);
    }
  };

  const lead = draft.leadDotId;
  const orbitLabel = lead
    ? `${draft.name.trim() || 'Your team'}: ${dotName(lead)} leads${
        draft.members.length
          ? ` with ${draft.members.map((member) => dotName(member.dotId)).join(', ')}`
          : ''
      }.`
    : 'An empty stage: add a Dot to lead the team.';

  return (
    <div className="modal-backdrop dlg-backdrop" onClick={onClose}>
      <section
        className="modal dlg team-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-builder-title"
        ref={container}
        onClick={(event) => event.stopPropagation()}
        style={{ '--team-color': `var(--dot-${draft.color}-base)` } as never}
      >
        <header className="dlg-header">
          <div className="dlg-heading">
            <span className="eyebrow">FULLDOTS · TEAMS</span>
            <h2 id="team-builder-title">
              {draft.id ? 'Tune your team.' : 'Assemble a team.'}
            </h2>
          </div>
          <button
            type="button"
            className="dlg-close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form className="dlg-form" onSubmit={save} noValidate>
          <div className="dlg-body tb-body">
            <div className="tb-identity">
              <span className="tb-badge" aria-hidden>
                {draft.emoji || '✨'}
              </span>
              <div className="tb-field tb-name">
                <label htmlFor="tb-name">Team name</label>
                <input
                  id="tb-name"
                  className="dlg-input dlg-input-lg"
                  value={draft.name}
                  maxLength={60}
                  placeholder="Launch crew"
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? 'tb-name-error' : undefined}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
                {errors.name && (
                  <p className="tb-invalid" id="tb-name-error" role="alert">
                    {errors.name}
                  </p>
                )}
              </div>
            </div>
            <div className="tb-field">
              <span className="tb-label" id="tb-emoji-label">
                Emoji
              </span>
              <div className="tb-emoji-row">
                <ChoiceGroup
                  label="Team emoji"
                  value={
                    (TEAM_EMOJI as readonly string[]).includes(draft.emoji)
                      ? draft.emoji
                      : ''
                  }
                  onChange={(emoji) => setDraft({ ...draft, emoji })}
                  className="tb-emoji-grid"
                  optionClassName="tb-emoji"
                  options={TEAM_EMOJI.map((emoji) => ({
                    value: emoji,
                    label: emoji,
                    content: <span aria-hidden>{emoji}</span>,
                  }))}
                />
                <label className="tb-emoji-own">
                  <span>Or your own</span>
                  <input
                    className="dlg-input tb-emoji-input"
                    value={draft.emoji}
                    maxLength={16}
                    aria-label="Type your own emoji"
                    aria-invalid={!!errors.emoji}
                    aria-describedby={
                      errors.emoji ? 'tb-emoji-error' : undefined
                    }
                    onChange={(event) =>
                      setDraft({ ...draft, emoji: event.target.value.trim() })
                    }
                  />
                </label>
              </div>
              {errors.emoji && (
                <p className="tb-invalid" id="tb-emoji-error" role="alert">
                  {errors.emoji}
                </p>
              )}
            </div>
            <div className="tb-field">
              <span className="tb-label">Colour</span>
              <div className="dot-color-picker">
                <TeamColorPicker
                  value={draft.color}
                  onChange={(color) => setDraft({ ...draft, color })}
                />
              </div>
            </div>
            <div className="tb-field">
              <label htmlFor="tb-description">
                What is this team for? <small>(optional)</small>
              </label>
              <textarea
                id="tb-description"
                className="dlg-input dlg-textarea tb-desc"
                rows={2}
                maxLength={500}
                value={draft.description}
                placeholder="Plans and ships our product launches."
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </div>

            <section className="tb-cast" aria-labelledby="tb-cast-title">
              <div className="tb-cast-head">
                <h3 id="tb-cast-title">Who is on the team</h3>
                <p>
                  Drag Dots onto the stage or press Add. The first one leads; up
                  to {MAX_TEAM_MEMBERS} more orbit around it.
                </p>
              </div>
              <div className="tb-cast-grid">
                <div
                  className={`tb-stage ${dropping ? 'dropping' : ''}`}
                  data-testid="team-stage"
                  {...dropOn('stage')}
                >
                  <TeamOrbit
                    leadDotId={lead}
                    memberIds={draft.members.map((member) => member.dotId)}
                    dots={dots}
                    size="lg"
                    label={orbitLabel}
                    center={
                      <span className="tb-stage-empty">
                        <Plus size={18} aria-hidden />
                        Drop a lead here
                      </span>
                    }
                    renderMember={(dot) => (
                      <span className="tb-orbit-name">{dot?.name}</span>
                    )}
                  />
                </div>
                <div className="tb-tray" {...dropOn('tray')}>
                  <h4 id="tb-tray-title">Your Dots</h4>
                  {bench.length ? (
                    <ul aria-labelledby="tb-tray-title">
                      {bench.map((dot) => (
                        <li key={dot.id}>
                          <button
                            type="button"
                            className="tb-tray-dot"
                            draggable={!full}
                            disabled={full}
                            aria-label={
                              lead
                                ? `Add ${dot.name} to the team`
                                : `Add ${dot.name} as the lead`
                            }
                            onDragStart={(event) => dragStart(event, dot.id)}
                            onClick={() => add(dot.id)}
                          >
                            <span className="tb-tray-face">
                              <Mascot
                                identity={dot.id}
                                color={dot.color}
                                name={dot.name}
                                small
                                decorative
                              />
                            </span>
                            <span className="tb-tray-name">{dot.name}</span>
                            <Plus size={14} aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="tb-hint">
                      Every Dot is on this team. Create more Dots to grow it.
                    </p>
                  )}
                  {full && (
                    <p className="tb-hint">
                      The team is full: {MAX_TEAM_MEMBERS} members and a lead.
                    </p>
                  )}
                </div>
              </div>

              {lead && (
                <div className="tb-lead-row">
                  <span className="tb-row-face">
                    <Mascot
                      identity={lead}
                      color={dots.find((dot) => dot.id === lead)?.color}
                      name={dotName(lead)}
                      small
                      decorative
                    />
                  </span>
                  <span className="tb-row-name">
                    <Crown size={13} aria-hidden /> {dotName(lead)}
                    <small>Lead: talks with you and plans the work</small>
                  </span>
                  <button
                    type="button"
                    className="tb-icon-btn"
                    aria-label={`Remove ${dotName(lead)} from the team`}
                    title="Remove"
                    onClick={() => remove(lead)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {draft.members.length > 0 && (
                <ol
                  className="tb-members"
                  aria-label="Members, in working order"
                >
                  {draft.members.map((member, index) => {
                    const name = dotName(member.dotId);
                    const dot = dots.find((item) => item.id === member.dotId);
                    return (
                      <li
                        key={member.dotId}
                        className="tb-member"
                        draggable
                        onDragStart={(event) => dragStart(event, member.dotId)}
                      >
                        <button
                          type="button"
                          className="tb-handle"
                          ref={(node) => {
                            handles.current.set(member.dotId, node);
                          }}
                          aria-label={`${name}, place ${index + 1} of ${draft.members.length}. Arrow keys move it.`}
                          aria-keyshortcuts="ArrowUp ArrowDown Home End"
                          onKeyDown={(event) => {
                            const to = orderKey(
                              event.key,
                              index,
                              draft.members.length,
                            );
                            if (to === undefined) return;
                            event.preventDefault();
                            move(index, to);
                          }}
                        >
                          <GripVertical size={14} aria-hidden />
                          <span>{index + 1}</span>
                        </button>
                        <span className="tb-row-face">
                          <Mascot
                            identity={member.dotId}
                            color={dot?.color}
                            name={name}
                            small
                            decorative
                          />
                        </span>
                        <span className="tb-row-name">{name}</span>
                        <input
                          className="dlg-input tb-role"
                          value={member.role}
                          maxLength={TEAM_ROLE_MAX}
                          placeholder="Role, e.g. finds sources"
                          aria-label={`${name}'s role on the team`}
                          onChange={(event) =>
                            setDraft(
                              setRole(draft, member.dotId, event.target.value),
                            )
                          }
                        />
                        <span className="tb-row-actions">
                          <button
                            type="button"
                            className="tb-icon-btn"
                            aria-label={`Move ${name} up`}
                            title="Move up"
                            disabled={index === 0}
                            onClick={() => move(index, index - 1)}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="tb-icon-btn"
                            aria-label={`Move ${name} down`}
                            title="Move down"
                            disabled={index === draft.members.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className="tb-icon-btn"
                            aria-label={`Make ${name} the lead`}
                            title="Make lead"
                            onClick={() => promote(member.dotId)}
                          >
                            <Crown size={14} />
                          </button>
                          <button
                            type="button"
                            className="tb-icon-btn"
                            aria-label={`Remove ${name} from the team`}
                            title="Remove"
                            onClick={() => remove(member.dotId)}
                          >
                            <X size={14} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="tb-sr" aria-live="polite">
                {announcement}
              </p>
              {(errors.lead || errors.members) && (
                <p className="tb-invalid" role="alert">
                  {errors.lead ?? errors.members}
                </p>
              )}
            </section>

            <div className="tb-field">
              <span className="tb-label" id="tb-style-label">
                How they work
              </span>
              <ChoiceGroup
                label="Work style"
                value={draft.style}
                onChange={(style) => setDraft({ ...draft, style })}
                className="tb-cards tb-styles"
                optionClassName="tb-card"
                options={(['parallel', 'sequential', 'review'] as const).map(
                  (style) => ({
                    value: style,
                    label: STYLE_TEXT[style].title,
                    content: (
                      <>
                        <StyleDiagram style={style} color={draft.color} />
                        <strong>{STYLE_TEXT[style].title}</strong>
                        <small>{STYLE_TEXT[style].text}</small>
                      </>
                    ),
                  }),
                )}
              />
            </div>
            <div className="tb-field">
              <span className="tb-label" id="tb-mode-label">
                Who plans the work
              </span>
              <ChoiceGroup
                label="Who plans the work"
                value={draft.mode}
                onChange={(mode) => setDraft({ ...draft, mode })}
                className="tb-cards tb-modes"
                optionClassName="tb-card tb-mode"
                options={(['lead', 'direct'] as const).map((mode) => ({
                  value: mode,
                  label: MODE_TEXT[mode].title,
                  content: (
                    <>
                      <strong>{MODE_TEXT[mode].title}</strong>
                      <small>{MODE_TEXT[mode].text}</small>
                    </>
                  ),
                }))}
              />
              {draft.mode === 'direct' && (
                <Switch
                  checked={draft.summarize}
                  onChange={(summarize) => setDraft({ ...draft, summarize })}
                  label="Lead summarises"
                  hint="After the answers arrive, the lead adds one short summary."
                />
              )}
            </div>
          </div>
          <footer className="dlg-footer">
            {error && (
              <p className="dlg-error" role="alert">
                <AlertCircle size={16} aria-hidden />
                {error}
              </p>
            )}
            <div className="dlg-actions">
              <button type="button" className="dlg-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="dlg-btn dlg-primary"
                disabled={busy}
              >
                {busy ? 'Saving…' : draft.id ? 'Save team' : 'Create team'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
