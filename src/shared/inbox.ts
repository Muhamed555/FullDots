// The owner's inbox and mission control, as the API returns them. Questions come from a Dot's
// `ask_owner` call; results are written once when a background turn finishes. Approvals and
// handoffs keep their own tables and are listed beside them.
import type { Approval, DotColor, Handoff, TurnSource } from './types.js';

export type InboxKind = 'question' | 'result';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  dotId: string;
  threadId: string;
  /** The team run that produced this item (named teams, later); null otherwise. */
  teamRunId: string | null;
  /** Short, written by the server: never the prompt or the result text. */
  title: string;
  /** The question, or an excerpt of the Dot's final reply. */
  text: string;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
  /** The owner's answer to a question. */
  answer: string | null;
  answeredAt: number | null;
}

/** The inbox sections; `#/approvals` opens the first one. */
export type InboxSection = 'approvals' | 'handoffs' | 'questions' | 'results';
export const INBOX_SECTIONS: readonly InboxSection[] = [
  'approvals',
  'handoffs',
  'questions',
  'results',
];

export interface InboxCounts {
  approvals: number;
  handoffs: number;
  questions: number;
  /** Finished work not archived yet. */
  results: number;
  /** Finished work not read yet. */
  unread: number;
  /** What waits for the owner: approvals, handoffs and open questions. */
  needsYou: number;
}

export interface InboxResponse {
  counts: InboxCounts;
  approvals: Approval[];
  handoffs: Handoff[];
  questions: InboxItem[];
  results: InboxItem[];
}

/** What a Dot shows in mission control. */
export type MissionState = 'working' | 'needs-input' | 'paused' | 'idle';

export interface MissionDot {
  id: string;
  name: string;
  color?: DotColor;
  /** Paused on its own (the top bar's "pause all" shows in `state` and `allPaused`). */
  paused: boolean;
  state: MissionState;
  /** The turn it holds right now, if any. */
  activity: {
    threadId: string;
    threadTitle: string;
    source: TurnSource | 'chat';
    startedAt: number;
    /** The latest computer step of this turn, e.g. "navigate · Pricing". */
    step: string | null;
  } | null;
  /** Its conversation to open: the running one, else the latest. */
  threadId: string | null;
  /** Background tasks of this Dot waiting to run. */
  queued: number;
  waiting: {
    approvals: number;
    handoffs: number;
    questions: number;
    total: number;
  };
  usage: { today: number; budget: number | null };
}

/** A group of cards. One group of every Dot for now; named teams (P4) add their own. */
export interface MissionGroup {
  id: string;
  label: string;
  dotIds: string[];
}

export interface MissionResponse {
  dots: MissionDot[];
  groups: MissionGroup[];
  /** Whether every Dot is paused from the top bar. */
  allPaused: boolean;
  generatedAt: number;
}
