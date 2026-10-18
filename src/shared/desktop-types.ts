/** A window on a Dot computer's desktop, as `wmctrl` reports it. Coordinates are screen pixels. */
export interface DesktopWindow {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The window that receives typing. */
  active: boolean;
}

/** What every desktop action returns: the windows afterwards, so the caller sees what changed. */
export interface DesktopState {
  windows: DesktopWindow[];
  /** Set when the action's own command failed; the windows are still current. */
  error?: string;
}

/** The input the Computer panel's Desktop view forwards for the owner. */
export type DesktopOwnerInput =
  | { type: 'click'; x: number; y: number; double?: boolean }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string[] };
