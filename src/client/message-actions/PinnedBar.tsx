import { useId, useState } from 'react';
import { ChevronDown, Pin, X } from 'lucide-react';
import './message-actions.css';

export interface PinnedItem {
  messageId: string;
  /** One line of the message, as shown in the bar. */
  text: string;
  /** `user` for the owner's message. */
  role: string;
}

/**
 * The pinned messages of a chat, at its top. Collapsed it shows the newest pin; open it lists
 * every pin. Choosing one scrolls the transcript to that message.
 */
export function PinnedBar({
  pins,
  dotName = 'Your Dot',
  onJump,
  onUnpin,
  defaultOpen = false,
}: {
  pins: PinnedItem[];
  dotName?: string;
  onJump(messageId: string): void;
  onUnpin(messageId: string): void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  if (!pins.length) return null;
  const newest = pins[pins.length - 1];
  const who = (pin: PinnedItem) => (pin.role === 'user' ? 'You' : dotName);
  return (
    <section className="pinned-bar" aria-label="Pinned messages">
      <div className="pinned-row">
        <button
          type="button"
          className="pinned-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          <Pin size={13} aria-hidden="true" />
          <span>{pins.length} pinned</span>
          <ChevronDown
            size={13}
            aria-hidden="true"
            className={open ? 'is-open' : undefined}
          />
        </button>
        {!open && (
          <button
            type="button"
            className="pinned-preview"
            title="Show this message"
            onClick={() => onJump(newest.messageId)}
          >
            <strong>{who(newest)}:</strong> {newest.text}
          </button>
        )}
      </div>
      <ul className="pinned-list" id={listId} hidden={!open}>
        {pins.map((pin) => (
          <li key={pin.messageId}>
            <button
              type="button"
              className="pinned-item"
              title="Show this message"
              onClick={() => onJump(pin.messageId)}
            >
              <strong>{who(pin)}:</strong> {pin.text}
            </button>
            <button
              type="button"
              className="pinned-unpin"
              aria-label={`Unpin: ${pin.text}`}
              title="Unpin"
              onClick={() => onUnpin(pin.messageId)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
