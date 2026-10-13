import { api } from '../api';

/** Tells an open computer panel to look again now instead of at its next poll. */
export const COMPUTER_CHANGED_EVENT = 'fulldots:computer-changed';

/** Asks for the wheel of a Dot's computer, the same request as the panel's Take control. */
export const requestControl = (dotId: string) =>
  api<unknown>(`/dots/${encodeURIComponent(dotId)}/computer/take`, 'POST', {});

/**
 * "Take over here" on a handoff card: opens the computer panel first, so the owner sees the screen
 * while the Dot pauses, then takes control. One click for both.
 */
export async function takeOverHere({
  dotId,
  open,
  take = requestControl,
}: {
  dotId: string;
  open: () => void;
  take?: (dotId: string) => Promise<unknown>;
}): Promise<void> {
  open();
  await take(dotId);
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent(COMPUTER_CHANGED_EVENT, { detail: { dotId } }),
    );
}
