// Small keyboard-friendly pickers for the team builder: a radio group with a roving tab stop
// (arrow keys move and select, like DotColorPicker), the team colour swatches and a switch.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { DOT_COLORS, type DotColor } from '../../shared/types';
import '../dot-color-picker.css';

/** The index an arrow, Home or End key moves to in a list of `count`, or -1 for other keys. */
export function rovingIndex(key: string, from: number, count: number): number {
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return from === last ? 0 : from + 1;
    case 'ArrowLeft':
    case 'ArrowUp':
      return from === 0 ? last : from - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return -1;
  }
}

export interface Choice<T extends string> {
  value: T;
  /** The radio's accessible name. */
  label: string;
  content: ReactNode;
}

export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
  optionClassName = '',
  describedBy,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
  className?: string;
  optionClassName?: string;
  describedBy?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const keys = (event: KeyboardEvent, from: number) => {
    const next = rovingIndex(event.key, from, options.length);
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      className={className}
      role="radiogroup"
      aria-label={label}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={index === selected && option.value === value}
          aria-label={option.label}
          tabIndex={index === selected ? 0 : -1}
          className={`${optionClassName} ${option.value === value ? 'on' : ''}`}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => keys(event, index)}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

const colorLabel = (color: DotColor) =>
  color[0]!.toUpperCase() + color.slice(1);

/** The team's colour: one of the eight Dot palettes (no "Automatic": a team always has one). */
export function TeamColorPicker({
  value,
  onChange,
}: {
  value: DotColor;
  onChange: (color: DotColor) => void;
}) {
  return (
    <ChoiceGroup
      label="Team colour"
      value={value}
      onChange={onChange}
      className="dcp-group tb-colors"
      optionClassName="dcp-option dcp-swatch"
      options={DOT_COLORS.map((color) => ({
        value: color,
        label: colorLabel(color),
        content: (
          <span
            className="tb-swatch"
            title={colorLabel(color)}
            style={{
              background: `radial-gradient(circle at 35% 30%, var(--dot-${color}-light), var(--dot-${color}-base) 60%, var(--dot-${color}-dark))`,
            }}
          />
        ),
      }))}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`tb-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="tb-switch-track" aria-hidden>
        <span className="tb-switch-thumb" />
      </span>
      <span className="tb-switch-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}
