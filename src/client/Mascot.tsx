import type { Dot, DotColor } from '../shared/types';
import { DOT_PALETTES, DotCharacter, type DotPalette } from './DotCharacter';

// The id hash only ever picks from these four so Dots without a chosen colour keep the look they
// had before the palette grew; the other colours are reached by choosing them on the Dot.
const HASHED_COLORS: readonly DotColor[] = ['indigo', 'mint', 'coral', 'lilac'];

/** Stable identity keeps each specialist recognizable across views and reloads. */
function paletteFor(identity?: string): DotColor {
  if (!identity) return HASHED_COLORS[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return HASHED_COLORS[hash % HASHED_COLORS.length];
}

function isDotColor(value: unknown): value is DotColor {
  return typeof value === 'string' && value in DOT_PALETTES;
}

/** The colour a Dot shows everywhere: its chosen colour, else the one derived from its id. */
export function dotColor(dot: Pick<Dot, 'id' | 'color'>): DotColor {
  return isDotColor(dot.color) ? dot.color : paletteFor(dot.id);
}

/** The full palette for a Dot, for lanes, bubbles and anything else that should match its character. */
export function dotPalette(dot: Pick<Dot, 'id' | 'color'>) {
  return DOT_PALETTES[dotColor(dot)];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  color,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  /** The Dot's chosen colour; without one the colour comes from `identity`. */
  color?: DotColor | null;
  name?: string;
  decorative?: boolean;
}) {
  const palette: DotPalette = isDotColor(color) ? color : paletteFor(identity);
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <DotCharacter
        palette={palette}
        state={state}
        label={decorative ? undefined : `${name} is ${state}`}
      />
    </span>
  );
}
