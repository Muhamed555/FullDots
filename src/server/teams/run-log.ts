// The run log: a page the server writes into a team's own Space when a team run finishes (team
// setting "Keep a run log", on by default; only teams with a Space). It holds the owner's request,
// every deliverable (per member, plus the reviewer's verdict) and links to the chats that made them.
import type { Message } from '@ag-ui/core';
import {
  TEAM_MODE_LABELS,
  TEAM_STYLE_LABELS,
  type Team,
  type TeamRun,
  type TeamStepStatus,
} from '../../shared/teams.js';

/** Pages hold at most 100,000 characters; the log keeps room for its frame. */
const PAGE_MAX = 100_000;
const FRAME_ROOM = 6_000;

export interface RunLogStep {
  name: string;
  dotId: string;
  /** Its role on the team ("finds sources"). */
  role: string;
  status: TeamStepStatus;
  result: string | null;
  childThreadId: string | null;
  /** The chat of its first version, when the reviewer sent it back. */
  firstChildThreadId: string | null;
}

export interface RunLogInput {
  team: Pick<Team, 'name' | 'emoji'>;
  run: Pick<
    TeamRun,
    'threadId' | 'style' | 'mode' | 'status' | 'createdAt' | 'finishedAt'
  > &
    Partial<Pick<TeamRun, 'verdict' | 'sentBack'>>;
  /** The Dot hosting the team chat (its lead). */
  hostDotId: string;
  request: string | null;
  workers: RunLogStep[];
  reviewer?: RunLogStep;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 2026-10-13 14:05 (UTC) */
export function logDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export const runLogTitle = (team: Pick<Team, 'name'>, createdAt: number) =>
  `${team.name} run — ${logDate(createdAt)}`.slice(0, 160);

/** An in-app link that opens a conversation (the same form pages use for page links). */
export const chatLink = (dotId: string, threadId: string) =>
  `/#/dots/${encodeURIComponent(dotId)}/threads/${encodeURIComponent(threadId)}`;

const STATUS: Record<TeamStepStatus, string> = {
  queued: 'did not start',
  running: 'still running',
  done: 'done',
  failed: 'could not finish',
  skipped: 'skipped',
  cancelled: 'stopped',
};

const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n\n…(cut to fit the page)` : text;

function stepSection(
  step: RunLogStep,
  budget: number,
  heading: string,
  reviewer = false,
) {
  const links = [
    step.childThreadId
      ? `[Open ${step.name}’s chat](${chatLink(step.dotId, step.childThreadId)})`
      : '',
    step.firstChildThreadId
      ? `[${reviewer ? 'first check' : 'first version'}](${chatLink(step.dotId, step.firstChildThreadId)})`
      : '',
  ].filter(Boolean);
  const head = `${heading} ${step.name}${step.role ? ` — ${step.role}` : ''}\n\n_${STATUS[step.status]}${step.firstChildThreadId ? (reviewer ? ', checked twice' : ', revised after the review') : ''}_${links.length ? ` · ${links.join(' · ')}` : ''}`;
  const body =
    step.status === 'done' && step.result?.trim()
      ? clip(step.result.trim(), budget)
      : step.result?.trim() && step.status === 'failed'
        ? `What went wrong: ${clip(step.result.trim(), 500)}`
        : '_No deliverable._';
  return `${head}\n\n${body}`;
}

/** The log page's Markdown. */
export function runLogContent(input: RunLogInput): string {
  const { team, run } = input;
  const minutes =
    run.finishedAt === null
      ? null
      : Math.max(1, Math.round((run.finishedAt - run.createdAt) / 60_000));
  const sections = input.workers.length + (input.reviewer ? 2 : 0);
  const request = input.request?.trim() ? clip(input.request.trim(), 4000) : '';
  const budget = Math.max(
    500,
    Math.floor(
      (PAGE_MAX - FRAME_ROOM - request.length) / Math.max(1, sections),
    ),
  );
  const done = input.workers.filter((step) => step.status === 'done').length;
  const parts = [
    `${team.emoji} **${team.name}** · ${TEAM_STYLE_LABELS[run.style]} · ${TEAM_MODE_LABELS[run.mode]} · ${run.status === 'done' ? 'Done' : 'Did not finish'} (${done} of ${input.workers.length} delivered)${minutes ? ` · ${minutes} min` : ''} · started ${logDate(run.createdAt)} UTC`,
    `[Open the team chat](${chatLink(input.hostDotId, run.threadId)})`,
    `## The request\n\n${request ? quote(request) : '_The request was not recorded._'}`,
  ];
  if (input.reviewer) {
    const reviewer = input.reviewer;
    const verdict =
      reviewer.status !== 'done'
        ? `${reviewer.name} could not finish the check, so the deliverables below are unreviewed.`
        : run.verdict === 'changes'
          ? `${reviewer.name} asked for changes${run.sentBack ? ' after the work was sent back once' : ''}.`
          : `Checked by ${reviewer.name}${run.verdict === 'approved' ? ': approved' : ''}${run.sentBack ? ', after one send-back' : ''}.`;
    parts.push(
      `## Reviewer’s verdict\n\n**${verdict}**`,
      stepSection(
        { ...reviewer, role: reviewer.role || 'Reviewed result' },
        budget * 2,
        '### Reviewed by',
        true,
      ),
    );
  }
  parts.push(
    `## Deliverables`,
    ...input.workers.map((step) => stepSection(step, budget, '###')),
  );
  const content = parts.join('\n\n');
  return content.length > PAGE_MAX
    ? `${content.slice(0, PAGE_MAX - 40)}\n\n…(cut to fit the page)`
    : content;
}

const sourceOf = (message: Message) => {
  const metadata: unknown = message.metadata;
  return metadata && typeof metadata === 'object' && 'source' in metadata
    ? metadata.source
    : undefined;
};

/**
 * The owner's message a lead's run answers: the last message the owner typed before the lead's
 * start_team_run call that started `runId`.
 */
export function requestFor(
  messages: Message[],
  runId: string,
): string | undefined {
  const callIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes(runId),
      )
      .map((message) => (message as { toolCallId?: string }).toolCallId),
  );
  const index = messages.findIndex(
    (message) =>
      message.role === 'assistant' &&
      message.toolCalls?.some((call) => callIds.has(call.id)),
  );
  for (let at = index - 1; at >= 0; at--) {
    const message = messages[at]!;
    if (
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.trim() &&
      (sourceOf(message) === undefined || sourceOf(message) === 'chat')
    )
      return message.content;
  }
  return undefined;
}
