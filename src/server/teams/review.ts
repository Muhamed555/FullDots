// The reviewer of a "With a reviewer" team run: what it is asked, how its verdict is read, and who
// a send-back goes to. Pure helpers; TeamRunService does the running.
import type { ReviewVerdict } from '../../shared/teams.js';

/** How much of each member's result the reviewer gets. */
export const REVIEW_CHARS = 8000;
/** The reviewer's step sits after every member's. */
export const REVIEWER_POSITION = 99;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** A line without Markdown markers, for reading the verdict. */
const plain = (line: string) =>
  line
    .trim()
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^_+|_+$/g, '')
    .trim();

const VERDICT_LINE = /^(?:verdict\s*[:\-–—]\s*)?(APPROVED|CHANGES)\b/i;

/**
 * The reviewer's verdict: the last line that starts with APPROVED or CHANGES (optionally after
 * "Verdict:"), and the notes from that line on. Neither found reads as 'unclear', which is
 * treated like approved: nothing is sent back on a guess.
 */
export function readVerdict(text: string): {
  verdict: ReviewVerdict;
  notes: string;
} {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = plain(lines[index]!).match(VERDICT_LINE);
    if (match)
      return {
        verdict:
          match[1]!.toUpperCase() === 'APPROVED' ? 'approved' : 'changes',
        notes: lines.slice(index).join('\n').trim(),
      };
  }
  return { verdict: 'unclear', notes: '' };
}

/**
 * Who a send-back goes to: the members the notes name (whole-word, ignoring case), or every
 * member when the notes name none of them.
 */
export function sentBackTo<T extends { name: string }>(
  notes: string,
  workers: T[],
): T[] {
  const named = workers.filter((worker) => {
    const name = worker.name.trim();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`,
      'iu',
    ).test(notes);
  });
  return named.length ? named : workers;
}

/** The results the reviewer checks, a section per member that finished. */
export function reviewMaterial(
  results: { name: string; role: string; result: string }[],
): string {
  return results
    .map(
      (item) =>
        `## ${item.name}${item.role ? ` (${item.role})` : ''}\n\n${clip(item.result, REVIEW_CHARS)}`,
    )
    .join('\n\n');
}

export const REVIEW_DELIVERABLE =
  'The improved combined deliverable, ready for the owner. Then, as the last paragraph, a one-paragraph verdict that starts with APPROVED (ready as it is) or CHANGES (name who should fix what).';

/** The reviewer's brief for its first check, or its second (and last) one after a send-back. */
export function reviewBrief(input: {
  names: string[];
  request: string | null;
  second: boolean;
}): string {
  const who = input.names.join(', ');
  const request = input.request
    ? ` The owner asked: "${clip(input.request.trim(), 1500)}".`
    : '';
  return input.second
    ? `${who} revised their work after your notes. Check it again and improve it: reply with the improved combined deliverable and a one-paragraph verdict starting with APPROVED or CHANGES. This is the last check: nothing is sent back after it.${request}`
    : `Check and improve the combined work of ${who}: reply with the improved combined deliverable and a one-paragraph verdict starting with APPROVED or CHANGES. Use CHANGES only for real problems a member must fix, and name them.${request}`;
}

/** What a member the reviewer sent back is asked. */
export function revisionContext(input: {
  reviewer: string;
  first: string;
  notes: string;
}): string {
  return `You already did this once. Your first version:\n\n${clip(input.first, REVIEW_CHARS)}\n\n${input.reviewer} reviewed the team's work and sent it back with these notes:\n\n${clip(input.notes, 4000)}\n\nRevise your part to address the notes. Reply with your whole revised deliverable.`;
}
