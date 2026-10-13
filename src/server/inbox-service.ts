// Owns the life of inbox items. A question is asked (and the owner told), then answered or archived;
// either one queues exactly one resume turn in the question's thread (ResumeQueue, kind `question`).
// A result is written once when a background turn finishes. Every change emits `inbox.changed`.
import type { InboxItem } from '../shared/inbox.js';
import type { InboxStore } from './inbox-store.js';
import type { Notify } from './notify.js';
import type { ResumeQueue } from './resume-queue.js';

export interface InboxServiceDeps {
  inbox: InboxStore;
  resumes: Pick<ResumeQueue, 'enqueue'>;
  /** The Dot's display name, for titles. */
  dotName: (dotId: string) => string | undefined;
  notify?: Notify;
  /** Called after every change; the platform emits `inbox.changed`. */
  changed?: () => void;
  /**
   * True while the thread waits for the owner (a pending approval, a waiting handoff, an open
   * question): a turn that ended that way already has its inbox item.
   */
  waitsForOwner?: (threadId: string) => boolean;
  /** Masks provider keys a reply could echo. */
  redact?: (text: string) => string;
  log?: (line: string) => void;
}

/** What kind of background work finished; picks the result's title. */
export type FinishedWork =
  'task' | 'goal' | 'trigger' | 'delegation' | 'question';

const RESULT_TITLES: Record<FinishedWork, string> = {
  task: 'finished a scheduled task',
  goal: 'worked on a standing goal',
  trigger: 'handled a trigger',
  delegation: 'finished with its teammates’ results',
  question: 'continued after your answer',
};

/** How much of the final reply a result keeps. */
export const RESULT_EXCERPT = 600;
export const ANSWER_LIMIT = 4000;

/** The first `max` characters of a reply, on whole characters, with an ellipsis when cut. */
export function excerpt(text: string, max = RESULT_EXCERPT): string {
  const chars = Array.from(text.trim());
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : chars.join('');
}

export class InboxError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

export class InboxService {
  private readonly log: (line: string) => void;

  constructor(private deps: InboxServiceDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
  }

  private name(dotId: string) {
    return this.deps.dotName(dotId) ?? 'A Dot';
  }

  /**
   * Stores a question from `ask_owner`. One open question per thread: while one is open there it is
   * returned unchanged, so a repeated call does not ask twice. Synchronous on purpose: the gate
   * pauses the turn before its first await.
   */
  ask(input: { dotId: string; threadId: string; question: string }): InboxItem {
    const open = this.deps.inbox.openQuestion(input.threadId);
    if (open) return open;
    const item = this.deps.inbox.create({
      kind: 'question',
      dotId: input.dotId,
      threadId: input.threadId,
      title: `${this.name(input.dotId)} has a question`,
      text: input.question,
    });
    this.changed();
    this.tell({ title: item.title, text: item.text, url: '/#/inbox' });
    return item;
  }

  /** Answers an open question and queues the one turn that delivers the answer. */
  answer(id: string, text: string): InboxItem {
    const item = this.require(id);
    if (item.kind !== 'question')
      throw new InboxError('Only a question can be answered.', 409);
    if (!this.deps.inbox.answer(id, text))
      throw new InboxError('This question is no longer open.', 409);
    // Stored first, queued second: a crash in between leaves an answered question and no turn,
    // never a turn without the answer stored.
    this.deps.resumes.enqueue({
      kind: 'question',
      refId: item.id,
      threadId: item.threadId,
      dotId: item.dotId,
      source: 'question',
      prompt: `The owner answered your question ${JSON.stringify(item.text)}: ${JSON.stringify(text)}. Continue from where you stopped, using that answer.`,
    });
    this.changed();
    return this.deps.inbox.get(id) ?? item;
  }

  /**
   * Archives an item. An open question archived without an answer resumes the Dot once, told that
   * no answer is coming; an answered question or a result resumes nothing.
   */
  archive(id: string): InboxItem {
    const before = this.require(id);
    const archived = this.deps.inbox.archive(id);
    if (!archived) return before;
    if (archived.kind === 'question' && archived.answeredAt === null)
      this.deps.resumes.enqueue({
        kind: 'question',
        refId: archived.id,
        threadId: archived.threadId,
        dotId: archived.dotId,
        source: 'question',
        prompt: `The owner archived your question ${JSON.stringify(archived.text)} without answering: there is no answer. Continue without it if you reasonably can, or summarize what is done and what is left, then stop. Do not ask the same question again.`,
      });
    this.changed();
    return this.deps.inbox.get(id) ?? archived;
  }

  read(id: string): InboxItem {
    this.require(id);
    if (this.deps.inbox.markRead(id)) this.changed();
    return this.deps.inbox.get(id)!;
  }

  /**
   * Writes the result of a finished background turn: a short title and an excerpt of the Dot's final
   * reply, nothing else. Skipped when the turn ended waiting for the owner, whose item already
   * stands for it. Never throws: the turn already ran.
   */
  finished(input: {
    dotId: string;
    threadId: string;
    work: FinishedWork;
    text: string;
  }): InboxItem | undefined {
    try {
      if (this.deps.waitsForOwner?.(input.threadId)) return undefined;
      const redact = this.deps.redact ?? ((text: string) => text);
      const text = excerpt(redact(input.text));
      if (!text) return undefined;
      const item = this.deps.inbox.create({
        kind: 'result',
        dotId: input.dotId,
        threadId: input.threadId,
        title: `${this.name(input.dotId)} ${RESULT_TITLES[input.work]}`,
        text,
      });
      this.changed();
      return item;
    } catch (error) {
      this.log(
        `Inbox result could not be stored: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return undefined;
    }
  }

  private require(id: string): InboxItem {
    const item = this.deps.inbox.get(id);
    if (!item) throw new InboxError('Inbox item not found.', 404);
    return item;
  }

  private changed() {
    try {
      this.deps.changed?.();
    } catch (error) {
      this.log(
        `Inbox change hook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private tell(event: { title: string; text: string; url: string }) {
    if (!this.deps.notify) return;
    try {
      Promise.resolve(this.deps.notify(event)).catch((error: unknown) =>
        this.log(
          `Notification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        ),
      );
    } catch (error) {
      this.log(
        `Notification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
