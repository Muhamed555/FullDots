import { useRef, type KeyboardEvent } from 'react';
import { DOT_COLORS, type DotColor } from '../shared/types';
import { Mascot } from './Mascot';
import './dot-color-picker.css';

const OPTIONS: readonly (DotColor | null)[] = [null, ...DOT_COLORS];

const label = (color: DotColor | null) =>
  color ? color[0].toUpperCase() + color.slice(1) : 'Automatic';

/**
 * Choose a Dot's colour: eight round swatches plus Automatic (null, the colour derived from the
 * Dot's id). A radio group with a roving tab stop; arrow keys move and select.
 */
export function DotColorPicker({
  value,
  onChange,
  identity,
  name,
}: {
  value: DotColor | null;
  onChange: (color: DotColor | null) => void;
  /** The Dot's id, so the Automatic preview shows the colour it would get. */
  identity?: string;
  name?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, OPTIONS.indexOf(value));

  const move = (event: KeyboardEvent, from: number) => {
    const last = OPTIONS.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? from === last
          ? 0
          : from + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? from === 0
            ? last
            : from - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(OPTIONS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="dot-color-picker">
      <span className="dcp-preview">
        <Mascot
          identity={identity}
          color={value}
          name={name ?? 'Dot'}
          small
          decorative
        />
      </span>
      <div className="dcp-group" role="radiogroup" aria-label="Dot colour">
        {OPTIONS.map((color, index) => (
          <button
            key={color ?? 'auto'}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={index === selected}
            aria-label={label(color)}
            title={label(color)}
            tabIndex={index === selected ? 0 : -1}
            className={`dcp-option ${color ? 'dcp-swatch' : 'dcp-auto'}`}
            style={
              color
                ? {
                    background: `radial-gradient(circle at 35% 30%, var(--dot-${color}-light), var(--dot-${color}-base) 60%, var(--dot-${color}-dark))`,
                  }
                : undefined
            }
            onClick={() => onChange(color)}
            onKeyDown={(event) => move(event, index)}
          >
            {color ? null : 'Automatic'}
          </button>
        ))}
      </div>
    </div>
  );
}
