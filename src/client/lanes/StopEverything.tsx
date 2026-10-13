import { Square } from 'lucide-react';
import type { LanesValue } from './lanes-context';
import './lanes.css';

/** "Stop everything" in the chat header while any teammate still works on this chat's hand-offs. */
export function StopEverything({
  lanes,
  running,
}: {
  lanes: LanesValue;
  running: boolean;
}) {
  if (!running) return null;
  const count = lanes.lanes.filter((lane) =>
    ['queued', 'working', 'waiting'].includes(lane.status),
  ).length;
  return (
    <button
      type="button"
      className="fd-stop-all"
      disabled={lanes.pending.has('*')}
      title="Stop every teammate working on this chat's hand-offs"
      onClick={() => void lanes.stopAll()}
    >
      <Square size={12} aria-hidden />
      Stop everything
      <span className="fd-stop-all-count">
        {count} {count === 1 ? 'teammate' : 'teammates'}
      </span>
    </button>
  );
}
