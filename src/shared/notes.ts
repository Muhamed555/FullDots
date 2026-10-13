// What a Dot remembers about its owner: one note per Dot, written and cleared by the owner. A Dot
// may only propose a line (when the owner switched that on); the owner saves or discards it.

/** Longest note the server stores. */
export const NOTE_MAX = 8000;
/** Longest line a Dot may propose with `remember_preference`. */
export const PROPOSAL_MAX = 300;

/** Why a note's previous text was kept: an edit, a clear, or a saved proposal. */
export type NoteVersionReason = 'edit' | 'clear' | 'proposal';

export interface DotNote {
  dotId: string;
  text: string;
  /** Null until the note is first written. */
  updatedAt: number | null;
}

/** An earlier text of a note. Nothing the owner wrote is lost: edits and clears keep it here. */
export interface DotNoteVersion {
  id: string;
  dotId: string;
  text: string;
  createdAt: number;
  reason: NoteVersionReason;
}
