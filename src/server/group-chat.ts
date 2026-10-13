// Group chats: a conversation with a host Dot and participant Dots the owner added. The owner
// addresses one with @Name (POST /api/conversations/:id/turns); a Dot can pass the baton to another
// member with the gated hand_to_dot tool, which queues a resume marker for that Dot in the same
// thread. Only the owner's own mentions and that tool dispatch turns: "@Name" in model, tool or web
// text is plain text. TEAM_RELAY_MAX caps consecutive Dot turns without an owner message.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@copilotkit/runtime/v2';
import type { RunAgentInput } from '@ag-ui/core';
import { z } from 'zod';
import { TURN_SOURCES, type Dot, type TurnSource } from '../shared/types.js';
import type { NewResumeMarker } from './resume-store.js';
import { DELEGATIONS_PER_TURN, type HandOffCounter } from './team-service.js';
import type { WorkspaceStore } from './workspace.js';

export const DEFAULT_RELAY_MAX = 4;

export interface GroupChatDeps {
  workspace: WorkspaceStore;
  /** = resumes.enqueue */
  resume: (marker: NewResumeMarker) => void;
  /** TEAM_RELAY_MAX: consecutive Dot turns in a thread without an owner message. */
  relayMax?: number;
}

type Messages = RunAgentInput['messages'];

const sourceOf = (message: Messages[number]): unknown => {
  const metadata = (message as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === 'object' && 'source' in metadata
    ? (metadata as { source?: unknown }).source
    : undefined;
};

/**
 * How many Dot turns ran in a row up to and including the current one: the turn that followed the
 * owner's last message, plus every baton pass since. Other background turns (an approval resume, a
 * delegation result) neither count nor end the run; only an owner message does.
 */
export function dotTurnsInARow(messages: Messages): number {
  let relays = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const source = sourceOf(message);
    if (source === 'relay') relays++;
    else if (!TURN_SOURCES.includes(source as TurnSource)) break;
  }
  return relays + 1;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 80) ?? '';

export class GroupChat {
  readonly relayMax: number;
  constructor(private deps: GroupChatDeps) {
    this.relayMax = deps.relayMax ?? DEFAULT_RELAY_MAX;
  }

  /** The host and the participants of a thread that still exist, host first. */
  members(threadId: string): Dot[] {
    const { workspace } = this.deps;
    return workspace
      .threadMembers(threadId)
      .map((id) => workspace.dot(id))
      .filter((dot): dot is Dot => !!dot);
  }

  /** The other members a Dot can pass the baton to; none when it is not a member itself. */
  others(threadId: string, dotId: string): Dot[] {
    const members = this.members(threadId);
    if (!members.some((dot) => dot.id === dotId)) return [];
    return members.filter((dot) => dot.id !== dotId);
  }

  /** Baton passes queued in a thread and not yet delivered. */
  pendingRelays(threadId: string): number {
    return this.deps.workspace.resumes
      .all()
      .filter(
        (marker) => marker.kind === 'relay' && marker.threadId === threadId,
      ).length;
  }

  /** Passes the baton: the target Dot takes the next turn in this thread. Throws a model-facing reason. */
  handTo(input: {
    fromDotId: string;
    threadId: string;
    to: string;
    note: string;
    messages: Messages;
  }): Dot {
    const { workspace } = this.deps;
    const from = workspace.dot(input.fromDotId);
    if (!from) throw new Error('Dot not found.');
    const others = this.others(input.threadId, from.id);
    const wanted = input.to.trim().replace(/^@/, '').toLowerCase();
    if (from.id === input.to || from.name.toLowerCase() === wanted)
      throw new Error(
        'You already have the turn. Reply to the owner yourself.',
      );
    const target = others.find(
      (dot) => dot.id === input.to || dot.name.toLowerCase() === wanted,
    );
    if (!target)
      throw new Error(
        others.length
          ? `${input.to} is not in this chat. You can hand to: ${others.map((dot) => dot.name).join(', ')}. Only the owner can add Dots to a chat.`
          : 'There is no other Dot in this chat. Only the owner can add one.',
      );
    // A pass to a paused Dot would hold up every later resume of this thread until it is resumed.
    if (target.paused)
      throw new Error(
        `${target.name} is paused. Do not hand over; tell the owner what ${target.name} should do once it is resumed.`,
      );
    const turns =
      dotTurnsInARow(input.messages) + this.pendingRelays(input.threadId);
    if (turns + 1 > this.relayMax)
      throw new Error(
        `This chat reached the limit of ${this.relayMax} Dot turns in a row without the owner. Do not hand over: finish your reply and let the owner decide what comes next.`,
      );
    this.deps.resume({
      kind: 'relay',
      refId: randomUUID(),
      threadId: input.threadId,
      dotId: target.id,
      source: 'relay',
      prompt: `${from.name} handed to ${target.name}.\n\nNote from ${from.name}: ${input.note}\n\n${target.name}, it is your turn in this group chat. Read the conversation above (earlier replies may come from other Dots), continue from the note and reply to the owner.`,
    });
    return target;
  }
}

export const handToInput = z
  .object({
    dot: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        'The Dot in this chat who should take the next turn: its name.',
      ),
    note: z
      .string()
      .trim()
      .min(3)
      .max(2000)
      .describe('What that Dot should do next, in a sentence or two.'),
  })
  .strict();

/** The baton tool, offered when the thread has other members. */
export function groupTools(
  group: GroupChat,
  context: {
    dotId: string;
    threadId: string;
    messages: Messages;
    /** Shared with delegate_to_dot: both count against DELEGATIONS_PER_TURN. */
    counter: HandOffCounter;
  },
) {
  return [
    defineTool({
      name: 'hand_to_dot',
      description:
        'Pass this group chat to another Dot in it: that Dot takes the next turn here, with the whole conversation. Use it when its role fits the next step better. After handing over, end your turn with one short line for the owner.',
      parameters: handToInput,
      execute: async ({ dot, note }) => {
        if (context.counter.handed >= DELEGATIONS_PER_TURN)
          return {
            handed: false,
            error: `You can hand over at most ${DELEGATIONS_PER_TURN} times per turn.`,
          };
        try {
          const target = group.handTo({
            fromDotId: context.dotId,
            threadId: context.threadId,
            to: dot,
            note,
            messages: context.messages,
          });
          context.counter.handed++;
          return {
            handed: true,
            to: target.name,
            note: `${target.name} takes the next turn in this chat once yours ends. End your turn now.`,
          };
        } catch (error) {
          return {
            handed: false,
            error:
              error instanceof Error ? error.message : 'Could not hand over.',
          };
        }
      },
    }),
  ];
}

/** What a Dot in a group chat is told. */
export function groupPrompt(others: Dot[]): string {
  const list = others
    .map((dot) => `${dot.name} (${firstLine(dot.instructions)})`)
    .join('; ');
  return `This is a group chat. Other Dots in it: ${list}. Earlier assistant replies may be theirs. When another Dot's role fits the next step better, pass the chat with hand_to_dot instead of doing it yourself; do not pass it back and forth. Writing a Dot's name or @name in your reply does not reach it.`;
}
