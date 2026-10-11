import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  KeyRound,
  Radar,
  Trash2,
  Webhook,
  Zap,
} from 'lucide-react';
import { api } from './api';
import { relative } from './TaskPresentation';
import type { Conversation, Dot, DotUsage, Trigger } from '../shared/types';
import './automations.css';

type ListedTrigger = Trigger & { url: string | null };

const tokens = (value: number) =>
  value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);

function BudgetEditor({
  usage,
  onSaved,
}: {
  usage: DotUsage;
  onSaved: (next: DotUsage) => void;
}) {
  const [value, setValue] = useState(usage.budget ? String(usage.budget) : '');
  const [error, setError] = useState('');
  const save = (dailyTokens: number | null) =>
    api<DotUsage>(`/usage/${usage.dotId}/budget`, 'PUT', { dailyTokens })
      .then((next) => {
        setError('');
        onSaved(next);
      })
      .catch((e) => setError(e.message));
  return (
    <form
      className="usage-budget"
      onSubmit={(e) => {
        e.preventDefault();
        void save(value.trim() ? Number(value) : null);
      }}
    >
      <label>
        <span className="usage-vh">Daily token budget</span>
        <input
          type="number"
          min={1000}
          step={1000}
          inputMode="numeric"
          placeholder="No budget"
          title="Daily token budget"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit" className="ghost-button">
        Save
      </button>
      {error && (
        <span className="usage-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** Triggers and token usage, shown above the task list in "Scheduled and activity". */
export function AutomationsPanel({
  dots,
  conversations,
  version,
  onOpenThread,
}: {
  dots: Dot[];
  conversations: Conversation[];
  /** Bumped when a trigger was created elsewhere, to reload. */
  version: number;
  onOpenThread: (threadId: string) => void;
}) {
  const [triggers, setTriggers] = useState<ListedTrigger[]>([]);
  const [usage, setUsage] = useState<DotUsage[]>([]);
  const [warnAt, setWarnAt] = useState(2_000_000);
  const [secret, setSecret] = useState<{ id: string; text: string }>();
  const [error, setError] = useState('');

  const load = useCallback(() => {
    void Promise.all([
      api<{ triggers: ListedTrigger[] }>('/triggers'),
      api<{ warnAt: number; dots: DotUsage[] }>('/usage'),
    ])
      .then(([listed, used]) => {
        setTriggers(listed.triggers);
        setUsage(used.dots);
        setWarnAt(used.warnAt);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load, version]);

  const act = (promise: Promise<unknown>) =>
    void promise.then(load).catch((e) => setError(e.message));
  const threadTitle = (id: string) =>
    conversations.find((thread) => thread.id === id)?.title ?? 'Conversation';
  const dotName = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'Dot';
  const used = usage;

  return (
    <div className="automations">
      {error && (
        <p className="automations-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" /> {error}
        </p>
      )}
      <section
        className="automations-section"
        aria-labelledby="triggers-heading"
      >
        <h2 id="triggers-heading">
          <Zap size={16} aria-hidden="true" /> Triggers
        </h2>
        {!triggers.length ? (
          <p className="automations-empty">
            Open a conversation and use the lightning button to start a
            Dot&apos;s work from a webhook or a connector.
          </p>
        ) : (
          <ul className="trigger-list">
            {triggers.map((trigger) => (
              <li
                key={trigger.id}
                className="trigger-row"
                data-enabled={trigger.enabled}
              >
                <span className="trigger-icon" aria-hidden="true">
                  {trigger.kind === 'webhook' ? (
                    <Webhook size={17} />
                  ) : (
                    <Radar size={17} />
                  )}
                </span>
                <div className="trigger-main">
                  <strong>{trigger.name}</strong>
                  <span>
                    {dotName(trigger.dotId)} ·{' '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenThread(trigger.threadId)}
                    >
                      {threadTitle(trigger.threadId)}
                    </button>{' '}
                    ·{' '}
                    {trigger.kind === 'poll'
                      ? `checks ${trigger.tool} every ${Math.round((trigger.intervalSeconds ?? 300) / 60)} min`
                      : 'webhook'}
                    {' · '}
                    {trigger.lastFiredAt
                      ? `fired ${relative(trigger.lastFiredAt)} (${trigger.eventCount})`
                      : 'not fired yet'}
                  </span>
                  {trigger.lastError && (
                    <span className="trigger-error">{trigger.lastError}</span>
                  )}
                  {secret?.id === trigger.id && (
                    <span className="trigger-secret">
                      New secret, shown once: <code>{secret.text}</code>
                    </span>
                  )}
                </div>
                <label className="trigger-toggle">
                  <input
                    type="checkbox"
                    checked={trigger.enabled}
                    onChange={(e) =>
                      act(
                        api(`/triggers/${trigger.id}`, 'PATCH', {
                          enabled: e.target.checked,
                        }),
                      )
                    }
                  />
                  <span>{trigger.enabled ? 'On' : 'Off'}</span>
                </label>
                {trigger.kind === 'webhook' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Rotate the secret of ${trigger.name}`}
                    title="Rotate secret"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Make a new secret for "${trigger.name}"? The old one stops working at once.`,
                        )
                      )
                        return;
                      act(
                        api<{ secret: string }>(
                          `/triggers/${trigger.id}/rotate`,
                          'POST',
                          {},
                        ).then((result) =>
                          setSecret({ id: trigger.id, text: result.secret }),
                        ),
                      );
                    }}
                  >
                    <KeyRound size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Delete ${trigger.name}`}
                  onClick={() => {
                    if (
                      !window.confirm(`Delete the trigger "${trigger.name}"?`)
                    )
                      return;
                    act(api(`/triggers/${trigger.id}`, 'DELETE', {}));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="automations-section" aria-labelledby="usage-heading">
        <h2 id="usage-heading">Token use (UTC days) and daily budgets</h2>
        {!used.length ? (
          <p className="automations-empty">
            No model use recorded yet. Each Dot&apos;s tokens appear here after
            its first turn.
          </p>
        ) : (
          <ul className="usage-list">
            {used.map((item) => {
              const limit = item.budget ?? warnAt;
              const share = Math.min(1, item.today / limit);
              const unreported = item.days.some((day) => day.unreportedTurns);
              return (
                <li key={item.dotId} className="usage-row">
                  <strong className="usage-name">{dotName(item.dotId)}</strong>
                  <div
                    className="usage-bar"
                    role="meter"
                    aria-label={`${dotName(item.dotId)} tokens today`}
                    aria-valuemin={0}
                    aria-valuemax={limit}
                    aria-valuenow={item.today}
                    data-over={item.today >= limit}
                  >
                    <span style={{ width: `${share * 100}%` }} />
                  </div>
                  <span className="usage-numbers">
                    {tokens(item.today)} today · {tokens(item.month)} month
                  </span>
                  {unreported && (
                    <span className="usage-note">
                      Some turns used a provider that reports no usage; they are
                      not counted.
                    </span>
                  )}
                  <BudgetEditor
                    usage={item}
                    onSaved={(next) =>
                      setUsage((list) =>
                        list.map((entry) =>
                          entry.dotId === next.dotId ? next : entry,
                        ),
                      )
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        <p className="automations-hint">
          The owner is warned once a day when a Dot passes {tokens(warnAt)}{' '}
          tokens. Over its budget, a Dot&apos;s background work waits until
          tomorrow; chat still works.
        </p>
      </section>
    </div>
  );
}
