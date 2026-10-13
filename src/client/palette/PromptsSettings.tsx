import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, Pencil, Plus } from 'lucide-react';
import {
  PROMPT_BODY_MAX,
  PROMPT_TITLE_MAX,
  type Prompt,
} from '../../shared/prompts';
import type { Dot } from '../../shared/types';
import { api } from '../api';
import './palette.css';

interface Draft {
  /** Missing for a new prompt. */
  id?: string;
  title: string;
  body: string;
  /** Empty means every Dot. */
  dotId: string;
}
const blank: Draft = { title: '', body: '', dotId: '' };

/** Settings > Prompts: write, edit and archive the prompts offered across the app. */
export function PromptsSettings({
  dots,
  initial,
}: {
  dots: Dot[];
  /** Prompts for the first render (tests, or a parent that already fetched them). */
  initial?: Prompt[];
}) {
  const [prompts, setPrompts] = useState<Prompt[] | undefined>(initial);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPrompts((await api<{ prompts: Prompt[] }>('/prompts')).prompts);
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load prompts.');
    }
  }, []);
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  const dotName = (id: string | null) =>
    id ? (dots.find((dot) => dot.id === id)?.name ?? 'A removed Dot') : '';
  const edit = (next: Draft | undefined) => {
    setDraft(next);
    setError('');
    setNote('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        title: draft.title,
        body: draft.body,
        scope: draft.dotId ? 'dot' : 'global',
        dotId: draft.dotId || null,
      };
      if (draft.id) await api(`/prompts/${draft.id}`, 'PATCH', body);
      else await api('/prompts', 'POST', body);
      setDraft(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the prompt.');
    } finally {
      setBusy(false);
    }
  };
  const archive = async (prompt: Prompt) => {
    setError('');
    try {
      await api(`/prompts/${prompt.id}`, 'DELETE', {});
      setNote(`Archived “${prompt.title}”. It no longer shows up anywhere.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not archive it.');
    }
  };

  return (
    <div className="pr">
      <div className="pr-head">
        <div>
          <h3>Saved prompts</h3>
          <p>
            Messages you reuse. Find them with Ctrl+K and start a chat from one.
          </p>
        </div>
        {!draft && (
          <button type="button" className="pr-add" onClick={() => edit(blank)}>
            <Plus size={15} aria-hidden="true" />
            New prompt
          </button>
        )}
      </div>

      {draft && (
        <form className="pr-form" onSubmit={save} aria-label="Prompt">
          <label>
            Title
            <input
              value={draft.title}
              maxLength={PROMPT_TITLE_MAX}
              placeholder="Weekly review"
              autoComplete="off"
              required
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <span className="pr-count">
              {draft.title.length}/{PROMPT_TITLE_MAX}
            </span>
          </label>
          <label>
            Prompt
            <textarea
              value={draft.body}
              maxLength={PROMPT_BODY_MAX}
              placeholder="Summarise what changed this week and what is next."
              required
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <span className="pr-count">
              {draft.body.length}/{PROMPT_BODY_MAX}
            </span>
          </label>
          <label>
            Offered to
            <select
              value={draft.dotId}
              onChange={(e) => setDraft({ ...draft, dotId: e.target.value })}
            >
              <option value="">Every Dot</option>
              {dots.map((dot) => (
                <option key={dot.id} value={dot.id}>
                  Only {dot.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="pr-error" role="alert">
              {error}
            </p>
          )}
          <div className="pr-form-actions">
            <button type="button" onClick={() => edit(undefined)}>
              Cancel
            </button>
            <button
              type="submit"
              className="pr-add"
              disabled={busy || !draft.title.trim() || !draft.body.trim()}
            >
              {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save prompt'}
            </button>
          </div>
        </form>
      )}

      {!draft && error && (
        <p className="pr-error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="pr-hint" role="status">
          {note}
        </p>
      )}
      {loadError && (
        <p className="pr-error" role="alert">
          {loadError}
        </p>
      )}

      {prompts && prompts.length > 0 && (
        <ul className="pr-list" aria-label="Saved prompts">
          {prompts.map((prompt) => (
            <li className="pr-row" key={prompt.id}>
              <div className="pr-row-main">
                <span className="pr-row-title">
                  {prompt.title}
                  <span className="pr-scope">
                    {prompt.dotId ? dotName(prompt.dotId) : 'Every Dot'}
                  </span>
                </span>
                <span className="pr-body">{prompt.body}</span>
              </div>
              <div className="pr-row-actions">
                <button
                  type="button"
                  className="pr-icon"
                  aria-label={`Edit ${prompt.title}`}
                  title="Edit"
                  onClick={() =>
                    edit({
                      id: prompt.id,
                      title: prompt.title,
                      body: prompt.body,
                      dotId: prompt.dotId ?? '',
                    })
                  }
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pr-icon"
                  aria-label={`Archive ${prompt.title}`}
                  title="Archive"
                  onClick={() => void archive(prompt)}
                >
                  <Archive size={15} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {prompts && !prompts.length && !draft && (
        <div className="pr-empty">
          <strong>No saved prompts yet.</strong>
          Save the messages you keep retyping, and find them in a keystroke.
        </div>
      )}
    </div>
  );
}
