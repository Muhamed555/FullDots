import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { LoaderCircle, MonitorOff, Send } from 'lucide-react';
import { api, authHeaders } from '../api';
import type {
  DesktopOwnerInput,
  DesktopState,
} from '../../shared/desktop-types';

/** The virtual display's size; pictures arrive smaller and clicks are mapped back to it. */
export const DESKTOP_SIZE = { width: 1280, height: 800 } as const;
/** About one picture a second: enough to follow along, cheap for an idle computer. */
const FRAME_MS = 1000;
const KEYS: readonly { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['Return'] },
  { label: 'Tab', keys: ['Tab'] },
  { label: 'Esc', keys: ['Escape'] },
  { label: '⌫', keys: ['BackSpace'] },
  { label: 'Ctrl+S', keys: ['ctrl+s'] },
];

/** A click on the shown picture as a point on the real screen. */
export function toScreenPoint(
  offsetX: number,
  offsetY: number,
  shownWidth: number,
  shownHeight: number,
): { x: number; y: number } {
  const clamp = (value: number, max: number) =>
    Math.min(max - 1, Math.max(0, Math.round(value)));
  return {
    x: clamp((offsetX / shownWidth) * DESKTOP_SIZE.width, DESKTOP_SIZE.width),
    y: clamp(
      (offsetY / shownHeight) * DESKTOP_SIZE.height,
      DESKTOP_SIZE.height,
    ),
  };
}

type Availability = 'checking' | 'yes' | 'no' | 'error';

/**
 * The computer's whole desktop: a picture refreshed about once a second while the tab is shown, with
 * the owner's clicks and typing forwarded. It is slower than the live browser screen by design; the
 * browser view stays the place for smooth takeover of a web page.
 */
export function DesktopStage({
  dotId,
  dotName,
  shellAllowed,
  onOpenSettings,
}: {
  dotId: string;
  dotName: string;
  /** Desktop control runs through the computer's shell, so it needs Terminal access. */
  shellAllowed: boolean;
  onOpenSettings: () => void;
}) {
  const [available, setAvailable] = useState<Availability>('checking');
  const [frame, setFrame] = useState<string>();
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!shellAllowed) return;
    const controller = new AbortController();
    setAvailable('checking');
    api<{ available: boolean }>(
      `/dots/${dotId}/computer/desktop`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => setAvailable(result.available ? 'yes' : 'no'))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAvailable('error');
        setError(
          cause instanceof Error ? cause.message : 'Desktop check failed.',
        );
      });
    return () => controller.abort();
  }, [dotId, shellAllowed]);

  // One picture at a time: the next is asked for only after the last one arrived.
  useEffect(() => {
    if (available !== 'yes') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: string | undefined;
    const next = async () => {
      if (document.visibilityState === 'visible')
        try {
          const response = await fetch(
            `/api/dots/${dotId}/computer/desktop/frame`,
            { headers: authHeaders(), signal: controller.signal },
          );
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? 'The desktop picture failed.');
          }
          const url = URL.createObjectURL(await response.blob());
          if (shown) URL.revokeObjectURL(shown);
          shown = url;
          setFrame(url);
          setError('');
        } catch (cause) {
          if (controller.signal.aborted) return;
          setError(
            cause instanceof Error
              ? cause.message
              : 'The desktop picture failed.',
          );
        }
      if (!controller.signal.aborted) timer = setTimeout(next, FRAME_MS);
    };
    void next();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [available, dotId]);

  const send = useCallback(
    async (input: DesktopOwnerInput) => {
      setSending(true);
      try {
        const result = await api<DesktopState>(
          `/dots/${dotId}/computer/desktop/input`,
          'POST',
          input,
        );
        setError(result.error ?? '');
        return !result.error;
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'Desktop input failed.',
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [dotId],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text && (await send({ type: 'type', text }))) setText('');
  };

  if (!shellAllowed)
    return (
      <div className="cp-empty cp-desktop-empty">
        <MonitorOff size={22} aria-hidden="true" />
        <p>
          The desktop is controlled through the computer’s terminal. Turn on
          Terminal access to use it.
        </p>
        <button type="button" className="cp-btn" onClick={onOpenSettings}>
          Open settings
        </button>
      </div>
    );
  if (available === 'checking')
    return (
      <div className="cp-empty cp-desktop-empty" role="status">
        <LoaderCircle className="cp-spin" size={20} aria-hidden="true" />
        <p>Looking for the desktop…</p>
      </div>
    );
  if (available !== 'yes')
    return (
      <div className="cp-empty cp-desktop-empty">
        <MonitorOff size={22} aria-hidden="true" />
        <p>
          {available === 'no'
            ? `${dotName}’s computer has no desktop. Enable it from the Docker setup, then restart the computer.`
            : error}
        </p>
      </div>
    );

  return (
    <div className="cp-desktop">
      <div className="cp-desktop-screen">
        {frame ? (
          <img
            ref={image}
            src={frame}
            alt={`${dotName}’s desktop`}
            draggable={false}
            onClick={(event) => {
              if (sending || !image.current) return;
              const point = toScreenPoint(
                event.nativeEvent.offsetX,
                event.nativeEvent.offsetY,
                image.current.clientWidth,
                image.current.clientHeight,
              );
              void send({ type: 'click', ...point, double: event.detail > 1 });
            }}
          />
        ) : (
          <div className="cp-empty" role="status">
            <LoaderCircle className="cp-spin" size={20} aria-hidden="true" />
          </div>
        )}
      </div>
      {error && (
        <p className="cp-docker-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="cp-desktop-keys"
        onSubmit={(event) => void submit(event)}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type on the desktop"
          aria-label="Text to type on the desktop"
          maxLength={4000}
        />
        <button
          type="submit"
          className="cp-icon-btn"
          aria-label="Type it"
          disabled={!text || sending}
        >
          <Send size={14} aria-hidden="true" />
        </button>
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="cp-btn cp-btn-small"
            disabled={sending}
            onClick={() => void send({ type: 'key', keys: key.keys })}
          >
            {key.label}
          </button>
        ))}
      </form>
      <p className="cp-desktop-hint">
        Updates about once a second. Click the picture to click on the desktop.
      </p>
    </div>
  );
}
