import type { ReactNode } from 'react';
import { History } from 'lucide-react';
import './message-actions.css';

/** The answers a retry replaced, folded under the owner's message. Nothing is removed. */
export function EarlierAttempts({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="earlier-attempts">
      <summary>
        <History size={13} aria-hidden="true" />
        {count === 1 ? 'Earlier attempt' : `${count} earlier attempts`}
      </summary>
      <div className="earlier-attempts-body">{children}</div>
    </details>
  );
}
