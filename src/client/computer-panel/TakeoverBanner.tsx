import { useId } from 'react';
import { Undo2 } from 'lucide-react';
import { Mascot } from '../Mascot';
import '../computer-replay.css';

/**
 * Shown across the top of the panel while the owner holds the computer: who is driving, that the Dot
 * is paused and blind to what is typed, and one large way back.
 */
export function TakeoverBanner({
  dotId,
  dotName,
  reason,
  disabled,
  onRelease,
}: {
  dotId: string;
  dotName: string;
  /** Why the Dot asked for help, when it did. */
  reason?: string;
  disabled: boolean;
  onRelease: () => void;
}) {
  const id = useId();
  return (
    <section className="cp-takeover" aria-labelledby={`${id}-title`}>
      <div className="cp-takeover-text">
        <Mascot
          identity={dotId}
          name={dotName}
          state="paused"
          small
          decorative
        />
        <div>
          <p id={`${id}-title`} className="cp-takeover-title" role="status">
            <strong>You are in control.</strong> {dotName} is paused and sees
            nothing you type.
          </p>
          {reason && (
            <p className="cp-takeover-reason">
              {dotName} asked: {reason}
            </p>
          )}
          <p className="cp-hint">
            Click the screen to type there. Shift+Esc stops typing.
          </p>
        </div>
      </div>
      <button
        type="button"
        className="cp-btn cp-btn-primary cp-btn-block"
        onClick={onRelease}
        disabled={disabled}
      >
        <Undo2 size={16} aria-hidden="true" />
        Hand back to {dotName}
      </button>
    </section>
  );
}
