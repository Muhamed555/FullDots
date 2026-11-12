// The "an update is ready" notice in FullDots Desktop. In a browser there is no shell, and this
// renders nothing: the web app is updated by whoever deploys it.
import { useEffect, useState } from 'react';
import { ArrowDownToLine, X } from 'lucide-react';
import {
  desktopBridge,
  type DesktopBridge,
  type DesktopUpdate,
} from '../../shared/desktop-bridge';
import './desktop.css';

/** What the notice says for an update; nothing while there is nothing for the person to do. */
export function updateNotice(
  update: DesktopUpdate,
): { title: string; detail: string; action: string } | undefined {
  if (update.status !== 'ready' && update.status !== 'available')
    return undefined;
  // An updater can name a release in words; then there is no number to show.
  const named = /^\d/.test(update.version)
    ? `FullDots ${update.version}`
    : 'A new version of FullDots';
  return update.status === 'ready'
    ? {
        title: `${named} is ready`,
        detail:
          'Restart to finish updating. Your Dots pick up where they left off.',
        action: 'Restart',
      }
    : {
        title: `${named} is available`,
        detail: 'Download it from the releases page.',
        action: 'Download',
      };
}

export function DesktopUpdateNotice({
  bridge = desktopBridge(),
}: {
  bridge?: DesktopBridge;
}) {
  const [update, setUpdate] = useState<DesktopUpdate>({ status: 'idle' });
  // "Later" hides this version's notice until the app is opened again or a newer one arrives.
  const [dismissed, setDismissed] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge
      .getUpdate()
      .then((current) => {
        if (live) setUpdate(current);
      })
      .catch(() => {});
    const stop = bridge.onUpdate((next) => {
      setUpdate(next);
      setBusy(false);
    });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  const notice = bridge ? updateNotice(update) : undefined;
  if (!bridge || !notice) return null;
  const key =
    'version' in update ? `${update.status} ${update.version}` : update.status;
  if (dismissed === key) return null;

  return (
    <aside className="desktop-update" role="status" aria-live="polite">
      <span className="desktop-update-mark" aria-hidden="true">
        <ArrowDownToLine size={16} />
      </span>
      <span className="desktop-update-text">
        <strong>{notice.title}</strong>
        <span>{notice.detail}</span>
      </span>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(update.status === 'ready');
          void bridge.installUpdate().catch(() => setBusy(false));
        }}
      >
        {notice.action}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Later"
        title="Later"
        onClick={() => setDismissed(key)}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
