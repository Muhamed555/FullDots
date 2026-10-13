// The one message composer, for a new chat (with starter chips) and for an open chat (with the
// source link and Stop). Popovers such as @mentions (P2) and /prompts (P8) plug in through `triggers`.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  Link2,
  MessageCircle,
  Square,
  X,
} from 'lucide-react';
import {
  activeTrigger,
  composeMessage,
  composerKeyAction,
  replaceToken,
  COMPOSER_COUNT_FROM,
  COMPOSER_LIMIT,
  type ComposerTriggerMatch,
  type ComposerTriggerSpec,
} from './composer-keys';
import './composer.css';

export interface ComposerTriggerContext extends ComposerTriggerMatch {
  /** Replaces the typed token (trigger character included) with `text`. */
  replace(text: string): void;
  /** Hides the popover until the caret leaves this token. */
  close(): void;
}

export interface ComposerTrigger extends ComposerTriggerSpec {
  /** The popover for the token being typed; null hides it. */
  render(context: ComposerTriggerContext): ReactNode;
  /** Keys while the popover shows (arrows, Enter, Escape). Return true when handled. */
  onKeyDown?(
    event: KeyboardEvent<HTMLTextAreaElement>,
    context: ComposerTriggerContext,
  ): boolean;
}

export interface ComposerProps {
  /** `new` starts a conversation; `chat` writes into the open one. */
  mode: 'new' | 'chat';
  value: string;
  onChange(value: string): void;
  /** Called with the message to send (source line included) when sending is allowed. */
  onSubmit(text: string): void;
  /** Everything but the text is ready (connected, not paused, not running). */
  canSubmit: boolean;
  /** Disables typing altogether (a new chat before setup). */
  disabled?: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  running?: boolean;
  onStop?(): void;
  /** Offers the "source page URL" field. */
  sourceLink?: boolean;
  starters?: readonly string[];
  note?: ReactNode;
  triggers?: readonly ComposerTrigger[];
  textareaRef?: Ref<HTMLTextAreaElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

export function Composer({
  mode,
  value,
  onChange,
  onSubmit,
  canSubmit,
  disabled = false,
  label,
  placeholder,
  submitLabel,
  running = false,
  onStop,
  sourceLink = false,
  starters,
  note,
  triggers,
  textareaRef,
}: ComposerProps) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const countId = useId();
  const popoverId = useId();
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [caret, setCaret] = useState(() => value.length);
  const [dismissed, setDismissed] = useState<string>();
  const ready = canSubmit && !disabled && !!value.trim();

  // Grow with the text; the stylesheet's max-height turns the rest into a scroll.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  const match = triggers?.length
    ? activeTrigger(value, caret, triggers)
    : undefined;
  const matchKey = match ? `${match.char}@${match.start}` : undefined;
  const trigger =
    match && matchKey !== dismissed
      ? triggers?.find((item) => item.char === match.char)
      : undefined;
  const context: ComposerTriggerContext | undefined =
    trigger && match
      ? {
          ...match,
          replace(text) {
            const next = replaceToken(value, match, text);
            onChange(next.value);
            setCaret(next.caret);
            requestAnimationFrame(() => {
              field.current?.focus();
              field.current?.setSelectionRange(next.caret, next.caret);
            });
          },
          close() {
            setDismissed(matchKey);
          },
        }
      : undefined;
  const popover = trigger && context ? trigger.render(context) : null;

  const submit = () => {
    if (!ready) return;
    const text = composeMessage(value, source);
    setSource('');
    setSourceOpen(false);
    onSubmit(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popover && trigger?.onKeyDown && context) {
      if (trigger.onKeyDown(event, context)) return;
    }
    const action = composerKeyAction(event, ready);
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'submit') event.currentTarget.form?.requestSubmit();
  };

  const showCount = value.length >= COMPOSER_COUNT_FROM;
  // A div, not a span: style.css hides every span directly inside .composer-bottom.
  const meta = (
    <div className="fd-composer-meta">
      <span className="fd-composer-hint" aria-hidden="true">
        <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
      </span>
      {showCount && (
        <span
          className="fd-composer-count"
          id={countId}
          data-level={value.length >= COMPOSER_LIMIT ? 'full' : 'near'}
        >
          {value.length} / {COMPOSER_LIMIT}
        </span>
      )}
    </div>
  );
  const textarea = (
    <textarea
      ref={(element) => {
        field.current = element;
        assignRef(textareaRef, element);
      }}
      aria-label={label}
      aria-describedby={showCount ? countId : undefined}
      aria-autocomplete={triggers?.length ? 'list' : undefined}
      aria-controls={popover ? popoverId : undefined}
      placeholder={placeholder}
      rows={mode === 'chat' ? 1 : undefined}
      value={value}
      maxLength={COMPOSER_LIMIT}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value);
        setCaret(event.target.selectionStart ?? event.target.value.length);
      }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
      onKeyDown={onKeyDown}
    />
  );
  const send = (
    <button className="send-button" aria-label={submitLabel} disabled={!ready}>
      <ArrowUp size={19} />
    </button>
  );
  const form = (
    <form
      className={
        mode === 'new'
          ? 'composer fd-composer fd-composer--new'
          : 'chat-composer fd-composer fd-composer--chat'
      }
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {popover && (
        <div className="fd-composer-popover" id={popoverId}>
          {popover}
        </div>
      )}
      {mode === 'new' ? (
        <>
          {textarea}
          <div className="composer-bottom">
            <span>
              <MessageCircle size={14} />
              {note}
            </span>
            {meta}
            {send}
          </div>
        </>
      ) : (
        <>
          {sourceLink && sourceOpen && (
            <div className="source-input">
              <Link2 size={15} />
              <input
                aria-label="Source page URL"
                type="url"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="https://example.com/page"
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Remove source"
                onClick={() => {
                  setSourceOpen(false);
                  setSource('');
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="chat-compose-row">
            {sourceLink && (
              <button
                type="button"
                className="icon-button"
                aria-label="Add source page link"
                aria-expanded={sourceOpen}
                onClick={() => setSourceOpen(!sourceOpen)}
              >
                <Link2 size={19} />
              </button>
            )}
            {textarea}
            {running ? (
              <button
                type="button"
                className="send-button fd-composer-stop"
                aria-label="Stop response"
                onClick={onStop}
              >
                <Square size={16} />
              </button>
            ) : (
              send
            )}
          </div>
          <div className="chat-compose-note">
            {note && <span>{note}</span>}
            {meta}
          </div>
        </>
      )}
    </form>
  );
  if (!starters?.length) return form;
  return (
    <>
      {form}
      <div className="starter-suggestions fd-composer-chips">
        {starters.map((text) => (
          <button
            key={text}
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(text);
              field.current?.focus();
            }}
          >
            {text}
            <ArrowUpRight size={12} />
          </button>
        ))}
      </div>
    </>
  );
}
