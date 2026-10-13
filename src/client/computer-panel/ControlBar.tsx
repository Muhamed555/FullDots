import { Hand, LoaderCircle } from 'lucide-react';
import type { Working } from './PanelHeader';

/** What the owner is asked to do on the screen, by the kind of thing the Dot got stuck on. */
const HANDOFF_HINTS: Record<string, string> = {
  credential:
    'Sign in on the screen yourself; the Dot never sees what you type.',
  two_factor: 'Enter the code on the screen yourself.',
  captcha: 'Complete the check on the screen.',
};

/**
 * The one control that matters while watching: who is driving.
 *
 * Handing control over takes a moment, because the Dot finishes what it is doing first, so the
 * waiting state is its own line rather than a disabled button.
 *
 * When the Dot has asked for help (`handoff`), the bar says so and offers Dismiss next to Take
 * control. Once the owner holds control the bar steps aside for the take-over banner.
 */
export function ControlBar({
  dotName,
  human,
  waiting,
  disabled,
  handoff,
  onTake,
  onDismiss,
}: {
  dotName: string;
  /** The owner holds control. */
  human: boolean;
  waiting?: Extract<Working, 'take' | 'release'>;
  disabled: boolean;
  /** A request for the owner's help that has not been answered yet. */
  handoff?: { id: string; reason: string; kind: string };
  onTake: () => void;
  onDismiss?: () => void;
}) {
  if (waiting)
    return (
      <div className="cp-control cp-control-waiting" role="status">
        <LoaderCircle className="cp-spin" size={15} aria-hidden="true" />
        <span>
          {waiting === 'take'
            ? `Waiting for ${dotName} to pause…`
            : `Handing control back to ${dotName}…`}
        </span>
      </div>
    );
  // While the owner drives, the take-over banner at the top of the panel holds the way back.
  if (human) return null;
  if (handoff) {
    const hint = HANDOFF_HINTS[handoff.kind];
    return (
      <div className="cp-control cp-control-handoff" role="status">
        <p className="cp-handoff-text">
          <strong>Your turn:</strong> {handoff.reason}
        </p>
        {hint && <p className="cp-hint">{hint}</p>}
        <div className="cp-handoff-actions">
          <button
            type="button"
            className="cp-btn cp-btn-primary"
            onClick={onTake}
            disabled={disabled}
          >
            <Hand size={14} aria-hidden="true" />
            Take control
          </button>
          <button
            type="button"
            className="cp-btn cp-btn-quiet"
            onClick={onDismiss}
            disabled={disabled || !onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="cp-control cp-control-bot">
      <span className="cp-control-who">{dotName} is in control</span>
      <button
        type="button"
        className="cp-btn"
        onClick={onTake}
        disabled={disabled}
      >
        <Hand size={14} aria-hidden="true" />
        Take control
      </button>
    </div>
  );
}
