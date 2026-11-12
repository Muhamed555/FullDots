// Where the window reopens. Pure, so it is tested without a screen.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  bounds?: Partial<Bounds>;
  maximized?: boolean;
}

export const MIN_WIDTH = 760;
export const MIN_HEIGHT = 560;
export const DEFAULT_SIZE = { width: 1280, height: 832 };

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** How much of the window must still be on a screen for its saved position to be kept. */
const VISIBLE_MARGIN = 80;

function overlaps(a: Bounds, b: Bounds): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width >= VISIBLE_MARGIN && height >= VISIBLE_MARGIN;
}

/**
 * The saved size, fitted to the screens that exist now. The position is kept only while enough of
 * the window is on one of them; a monitor that was unplugged must not leave the window off screen.
 */
export function restoreWindow(
  saved: SavedWindow | undefined,
  workAreas: Bounds[],
): {
  bounds: Partial<Bounds> & { width: number; height: number };
  maximized: boolean;
} {
  const primary = workAreas[0];
  const limit = (size: number, min: number, max?: number) =>
    Math.round(Math.max(min, Math.min(size, max ?? size)));
  const width = limit(
    finite(saved?.bounds?.width) ? saved.bounds.width : DEFAULT_SIZE.width,
    MIN_WIDTH,
    primary?.width,
  );
  const height = limit(
    finite(saved?.bounds?.height) ? saved.bounds.height : DEFAULT_SIZE.height,
    MIN_HEIGHT,
    primary?.height,
  );
  const maximized = saved?.maximized === true;
  const { x, y } = saved?.bounds ?? {};
  if (finite(x) && finite(y)) {
    const placed = { x: Math.round(x), y: Math.round(y), width, height };
    if (workAreas.some((area) => overlaps(placed, area)))
      return { bounds: placed, maximized };
  }
  // No position: the system centres the window.
  return { bounds: { width, height }, maximized };
}
