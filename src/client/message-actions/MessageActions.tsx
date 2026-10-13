import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  Copy,
  GitBranch,
  Pencil,
  Pin,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import './message-actions.css';

export interface MessageActionsProps {
  /** `user` is the owner's message; anything else is a Dot's reply. */
  role: string;
  pinned: boolean;
  /** Offers Retry: only on the owner's last message. */
  canRetry?: boolean;
  /** Why Retry cannot run right now (a reply is streaming, the Dot is paused, ...). */
  retryBlocked?: string;
  onEdit?(): void;
  onRetry?(): void;
  onBranch(): void;
  onPin(): void;
  onCopy(): Promise<void> | void;
}

interface Action {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  pressed?: boolean;
  blocked?: string;
  run(): void;
}

/**
 * The small toolbar a chat bubble shows on hover or keyboard focus. One tab stop: arrow keys,
 * Home and End move between the buttons (the WAI-ARIA toolbar pattern).
 */
export function MessageActions({
  role,
  pinned,
  canRetry = false,
  retryBlocked,
  onEdit,
  onRetry,
  onBranch,
  onPin,
  onCopy,
}: MessageActionsProps) {
  const [current, setCurrent] = useState(0);
  const [copied, setCopied] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const owner = role === 'user';
  const actions: Action[] = [];
  if (owner && onEdit)
    actions.push({
      id: 'edit',
      label: 'Edit and resend',
      hint: 'Edit in a new branch; this chat stays as it is',
      icon: Pencil,
      run: onEdit,
    });
  if (owner && canRetry && onRetry)
    actions.push({
      id: 'retry',
      label: 'Retry',
      hint:
        retryBlocked ?? 'Send this message again; the answer so far is kept',
      icon: RotateCcw,
      blocked: retryBlocked,
      run: onRetry,
    });
  actions.push(
    {
      id: 'branch',
      label: 'Branch from here',
      hint: 'Start a new chat with the history up to this message',
      icon: GitBranch,
      run: onBranch,
    },
    {
      id: 'pin',
      label: 'Pin message',
      hint: pinned
        ? 'Unpin from the top of the chat'
        : 'Pin to the top of the chat',
      icon: Pin,
      pressed: pinned,
      run: onPin,
    },
    {
      id: 'copy',
      label: copied ? 'Copied' : 'Copy text',
      hint: copied ? 'Copied' : 'Copy the text',
      icon: copied ? Check : Copy,
      run: () =>
        void Promise.resolve(onCopy()).then(
          () => setCopied(true),
          () => {},
        ),
    },
  );
  const focusAt = (index: number) => {
    const next = (index + actions.length) % actions.length;
    setCurrent(next);
    buttons.current[next]?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: actions.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    focusAt(moves[event.key]);
  };
  const active = Math.min(current, actions.length - 1);
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      aria-orientation="horizontal"
      className={`msg-actions ${owner ? 'is-owner' : 'is-dot'}`}
      onKeyDown={keys}
    >
      {actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            className={`msg-action ${action.pressed ? 'is-on' : ''}`}
            aria-label={action.label}
            title={action.hint}
            aria-pressed={action.pressed}
            aria-disabled={action.blocked ? true : undefined}
            data-action={action.id}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setCurrent(index)}
            onClick={() => {
              if (!action.blocked) action.run();
            }}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
