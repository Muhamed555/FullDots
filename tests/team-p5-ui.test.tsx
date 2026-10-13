// P5 in the client: a team run's band (step-by-step order, the reviewer collapse and its badges, a
// direct chat's dispatch line), the transcript builder for start_team_run, template cards, the
// reviewer picker, the team page's space and run log links, and team results as cards.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class extends Error {},
}));
import { buildTranscriptItems, toolResults } from '../src/client/chat-turns';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { BandItem } from '../src/client/lanes/BandItem';
import { DelegatedWork } from '../src/client/lanes/DelegatedResults';
import {
  LanesContext,
  type LanesValue,
} from '../src/client/lanes/lanes-context';
import {
  reviewBadge,
  runCall,
  runPhase,
  runResultLanes,
} from '../src/client/lanes/team-run-model';
import {
  addToTeam,
  draftPayload,
  emptyDraft,
  reviewerChoices,
  validateDraft,
} from '../src/client/teams/builder-model';
import { TeamBuilder } from '../src/client/teams/TeamBuilder';
import { TeamPage } from '../src/client/teams/TeamPage';
import { TemplatePicker } from '../src/client/teams/TemplatePicker';
import type { LaneProgress } from '../src/shared/lanes';
import type { Team, TeamDetail, TeamRunBand } from '../src/shared/teams';
import type { Dot } from '../src/shared/types';

const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
  id,
  spaceId: 'space',
  spaceIds: ['space'],
  name,
  instructions: `${name} role.`,
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  ...extra,
});
const lead = dot('lead', 'Lead', { color: 'indigo' });
const scout = dot('scout', 'Scout', { color: 'mint' });
const writer = dot('writer', 'Writer', { color: 'coral' });
const critic = dot('critic', 'Critic', { color: 'rose' });
const dots = [lead, scout, writer, critic];

const lane = (
  id: string,
  childDotId: string,
  extra: Partial<LaneProgress> = {},
): LaneProgress => ({
  id,
  parentThreadId: 'chat',
  parentDotId: 'lead',
  childThreadId: `child-${id}`,
  childDotId,
  batchKey: 'team:run-1',
  retryOf: null,
  attempt: 1,
  brief: `Brief for ${id}.`,
  deliverable: 'Your part.',
  status: 'working',
  wait: null,
  step: 'Thinking',
  createdAt: 1000,
  startedAt: 2000,
  finishedAt: null,
  deliveredAt: null,
  elapsedMs: 5_000,
  tokens: null,
  preview: [],
  result: null,
  resultLength: 0,
  runId: null,
  ...extra,
});

const step = (
  dotId: string,
  position: number,
  extra: Partial<TeamRunBand['steps'][number]> = {},
): TeamRunBand['steps'][number] => ({
  runId: 'run-1',
  delegationId: null,
  dotId,
  position,
  status: 'queued',
  role: 'worker',
  firstDelegationId: null,
  brief: `Brief for ${dotId}.`,
  ...extra,
});

const runBand = (extra: Partial<TeamRunBand> = {}): TeamRunBand => ({
  id: 'run-1',
  teamId: 'team-1',
  threadId: 'chat',
  style: 'parallel',
  mode: 'lead',
  status: 'running',
  createdAt: 1,
  finishedAt: null,
  cancelledAt: null,
  reviewerDotId: null,
  verdict: null,
  sentBack: false,
  log: null,
  teamName: 'Desk',
  teamEmoji: '🔬',
  leadDotId: 'lead',
  steps: [],
  ...extra,
});

const lanesValue = (
  lanes: LaneProgress[],
  runs: TeamRunBand[],
): LanesValue => ({
  threadId: 'chat',
  hostDot: lead,
  lanes,
  runs,
  receivedAt: Date.now(),
  loaded: true,
  dot: (id) => dots.find((item) => item.id === id),
  skipped: new Set(),
  skip: () => {},
  stop: async () => {},
  stopAll: async () => {},
  retry: async () => {},
  expanded: [],
  toggle: () => {},
  decide: async () => {},
  onOpenThread: () => {},
  takeOver: async () => {},
  fresh: new Set(),
  played: () => {},
  pending: new Set(),
  error: '',
  clearError: () => {},
  loadResult: async () => '',
});

const startCall = {
  id: 'c1',
  type: 'function' as const,
  function: {
    name: 'start_team_run',
    arguments: JSON.stringify({ shared: 'Compare note apps.' }),
  },
};
const started = new Map([
  [
    'c1',
    JSON.stringify({
      started: true,
      runId: 'run-1',
      members: ['Scout', 'Writer'],
    }),
  ],
]);

const band = (lanes: LaneProgress[], runs: TeamRunBand[], results = started) =>
  renderToStaticMarkup(
    <LanesContext.Provider value={lanesValue(lanes, runs)}>
      <BandItem calls={[startCall]} results={results} />
    </LanesContext.Provider>,
  );

describe('the transcript builder', () => {
  it('draws a band for start_team_run, after the lead’s reply', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Compare note apps' },
      {
        id: 'a',
        role: 'assistant',
        content: 'Scout and Writer are on it.',
        toolCalls: [startCall],
      },
    ];
    expect(
      buildTranscriptItems(messages, [], started).map((item) => item.kind),
    ).toEqual(['bubble', 'bubble', 'band']);
  });

  it('draws a direct chat’s band below its "Sent to ..." line', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Which app?' },
      {
        id: 'a',
        role: 'assistant',
        content: 'Sent to Scout, Writer.',
        toolCalls: [
          {
            id: 'd1',
            type: 'function',
            function: {
              name: 'team_dispatch',
              arguments: JSON.stringify({ runId: 'run-1' }),
            },
          },
        ],
      },
      {
        id: 't',
        role: 'tool',
        toolCallId: 'd1',
        content: JSON.stringify({ started: true, runId: 'run-1' }),
      },
    ];
    // The chat shows owner and Dot messages; tool results only feed the bands.
    const visible = messages.filter((message) => message.role !== 'tool');
    const items = buildTranscriptItems(visible, [], toolResults(messages));
    expect(items.map((item) => item.kind)).toEqual([
      'bubble',
      'bubble',
      'band',
    ]);
    const html = renderToStaticMarkup(
      <LanesContext.Provider
        value={lanesValue(
          [lane('d-scout', 'scout')],
          [
            runBand({
              mode: 'direct',
              steps: [
                step('scout', 0, {
                  delegationId: 'd-scout',
                  status: 'running',
                }),
              ],
            }),
          ],
        )}
      >
        <ChatTranscript
          messages={visible}
          allMessages={messages}
          calls={[]}
          dotName="Lead"
        />
      </LanesContext.Provider>,
    );
    expect(html).toContain('Sent to <strong>🔬 Desk</strong>');
    expect(html).toContain('data-lane="d-scout"');
  });
});

describe('a team run’s band', () => {
  it('shows step by step in member order, later steps waiting, with connectors', () => {
    const html = band(
      [lane('d-scout', 'scout')],
      [
        runBand({
          style: 'sequential',
          steps: [
            step('writer', 1),
            step('scout', 0, { delegationId: 'd-scout', status: 'running' }),
            step('critic', 2),
          ],
        }),
      ],
    );
    expect(html).toContain(
      '<strong>Lead</strong> put <strong>🔬 Desk</strong> to work',
    );
    expect(html).toContain('step by step');
    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(3);
    expect(html.match(/class="fd-run-connector"/g)).toHaveLength(2);
    // Member order: Scout (working), then Writer waits for Scout, Critic for Writer.
    const at = (text: string) => html.indexOf(text);
    expect(at('data-lane="d-scout"')).toBeGreaterThan(-1);
    expect(at('data-lane="d-scout"')).toBeLessThan(at('Waits for Scout'));
    expect(at('Waits for Scout')).toBeLessThan(at('Waits for Writer'));
    expect(html).toContain('Step 1');
    expect(html).toContain('aria-label="Writer: Waits for Scout"');
    expect(html).toContain('1 working · 2 waiting');
    expect(html).not.toContain('data:image');
  });

  it('folds the members under the reviewer while it checks, then shows the verdict', () => {
    const steps = (reviewer: Partial<TeamRunBand['steps'][number]>) => [
      step('scout', 0, { delegationId: 'd-scout', status: 'done' }),
      step('writer', 1, { delegationId: 'd-writer', status: 'done' }),
      step('critic', 99, { role: 'reviewer', ...reviewer }),
    ];
    const done = (id: string, dotId: string) =>
      lane(id, dotId, { status: 'done', finishedAt: 9000, result: 'Done.' });
    const reviewing = band(
      [
        done('d-scout', 'scout'),
        done('d-writer', 'writer'),
        lane('d-critic', 'critic'),
      ],
      [
        runBand({
          style: 'review',
          reviewerDotId: 'critic',
          steps: steps({ delegationId: 'd-critic', status: 'running' }),
        }),
      ],
    );
    expect(reviewing).toContain(
      '2 results, under review by <strong>Critic</strong>',
    );
    expect(reviewing).toContain(
      'aria-label="2 results, under review by Critic"',
    );
    expect(reviewing).toContain('Under review by Critic');
    // The members fold into chips; only the reviewer has a full lane, reviewing.
    expect(reviewing).not.toContain('data-lane="d-scout"');
    expect(reviewing).toContain('data-lane="d-critic"');
    expect(reviewing).toContain('mascot reviewing');
    expect(reviewing).toContain('Reviewer');
    expect(reviewing).not.toContain('fd-run-badge');

    const sentBack = band(
      [
        done('d-scout', 'scout'),
        lane('d-writer-2', 'writer'),
        done('d-critic', 'critic'),
      ],
      [
        runBand({
          style: 'review',
          reviewerDotId: 'critic',
          verdict: 'changes',
          sentBack: true,
          steps: [
            step('scout', 0, { delegationId: 'd-scout', status: 'done' }),
            step('writer', 1, {
              delegationId: 'd-writer-2',
              firstDelegationId: 'd-writer',
              status: 'running',
            }),
            step('critic', 99, {
              role: 'reviewer',
              delegationId: 'd-critic',
              firstDelegationId: 'd-critic',
              status: 'queued',
            }),
          ],
        }),
      ],
    );
    expect(sentBack).toContain('is-sent-back');
    expect(sentBack).toContain('Sent back');
    expect(sentBack).toContain('data-lane="d-writer-2"');
    expect(sentBack).toContain('Revised');
    expect(sentBack).toContain('Checks again when the revisions are in');

    const checked = band(
      [
        done('d-scout', 'scout'),
        done('d-writer', 'writer'),
        done('d-critic', 'critic'),
      ],
      [
        runBand({
          style: 'review',
          status: 'done',
          finishedAt: 10,
          reviewerDotId: 'critic',
          verdict: 'approved',
          steps: steps({ delegationId: 'd-critic', status: 'done' }),
        }),
      ],
    );
    expect(checked).toContain('is-checked');
    expect(checked).toContain('Checked by Critic');
    expect(checked).toContain('2 of 2 done');
    expect(checked).toContain('Show the work');
    expect(checked).toContain('>Checked<');
  });

  it('says when the run is starting, refused, or outside a chat with lanes', () => {
    expect(band([], [], new Map())).toContain('Putting the team to work');
    expect(
      band(
        [],
        [],
        new Map([
          ['c1', JSON.stringify({ started: false, error: 'Too deep.' })],
        ]),
      ),
    ).toContain('The team run did not start: Too deep.');
    expect(
      renderToStaticMarkup(<BandItem calls={[startCall]} results={started} />),
    ).toContain('Put the team to work: Scout and Writer');
  });

  it('reads its call, phase and badge', () => {
    expect(runCall(startCall, started.get('c1'))).toEqual({
      pending: false,
      runId: 'run-1',
      members: ['Scout', 'Writer'],
    });
    const run = runBand({
      reviewerDotId: 'critic',
      steps: [step('critic', 99, { role: 'reviewer', status: 'running' })],
    });
    expect(runPhase(run)).toBe('reviewing');
    expect(reviewBadge(run, 'Critic')).toBeUndefined();
    expect(
      reviewBadge(
        {
          ...run,
          status: 'done',
          verdict: 'approved',
          steps: [step('critic', 99, { role: 'reviewer', status: 'done' })],
        },
        'Critic',
      ),
    ).toEqual({ text: 'Checked by Critic', tone: 'checked' });
  });

  it('shows a team run’s results as cards, the reviewer’s last', () => {
    const runs = [
      runBand({
        status: 'done',
        steps: [
          step('scout', 0, { delegationId: 'd-scout', status: 'done' }),
          step('critic', 99, {
            role: 'reviewer',
            delegationId: 'd-critic',
            status: 'done',
          }),
        ],
      }),
    ];
    const lanes = [
      lane('d-scout', 'scout', { status: 'done', result: 'Scout result.' }),
      lane('d-critic', 'critic', { status: 'done', result: 'Checked.' }),
    ];
    expect(
      runResultLanes('run-1', runs, lanes)?.map((item) => item.id),
    ).toEqual(['d-scout', 'd-critic']);
    const html = renderToStaticMarkup(
      <LanesContext.Provider value={lanesValue(lanes, runs)}>
        <DelegatedWork refId="run-1" fallback={<p>fallback</p>} />
      </LanesContext.Provider>,
    );
    expect(html).toContain('2 teammates reported back');
    expect(html).not.toContain('fallback');
  });
});

describe('builder: templates and the reviewer', () => {
  it('offers four template cards, and shows what one creates', () => {
    const html = renderToStaticMarkup(
      <TemplatePicker teams={[]} onCreated={() => {}} initial="research" />,
    );
    expect(html).toContain('Start from a template');
    expect(html.match(/class="tb-template( chosen)?"/g)).toHaveLength(4);
    for (const name of [
      'Launch crew',
      'Research desk',
      'Content studio',
      'Support desk',
    ])
      expect(html).toContain(name);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(
      'Creates 4 new Dots (Research Lead, Scout, Analyst, Critic)',
    );
    expect(html).toContain('Critic reviews');
    expect(html).toContain('no computer, no connectors');
    expect(html).toContain('Create a team space');
    expect(html).toContain('aria-checked="true"');
    const builder = renderToStaticMarkup(
      <TeamBuilder
        dots={dots}
        teams={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(builder).toContain('Start from a template');
    expect(builder).toContain('Create a team space');
  });

  it('picks a reviewer that is not on the team, and requires one for the review style', () => {
    const draft = {
      ...['lead', 'scout'].reduce(addToTeam, emptyDraft()),
      name: 'Desk',
      style: 'review' as const,
    };
    expect(reviewerChoices(draft, dots).map((item) => item.id)).toEqual([
      'writer',
      'critic',
    ]);
    expect(validateDraft(draft).reviewer).toContain('Choose who reviews');
    const chosen = { ...draft, reviewerDotId: 'critic' };
    expect(validateDraft(chosen)).toEqual({});
    expect(draftPayload(chosen)).toMatchObject({ reviewerDotId: 'critic' });
    expect(draftPayload({ ...chosen, style: 'parallel' })).toMatchObject({
      reviewerDotId: null,
    });
    expect(draftPayload({ ...chosen, space: true })).toMatchObject({
      space: true,
      runLog: true,
    });
    // Adding the reviewer to the team takes it off reviewing.
    expect(addToTeam(chosen, 'critic').reviewerDotId).toBeNull();
    const html = renderToStaticMarkup(
      <TeamBuilder
        dots={dots}
        teams={[]}
        onClose={() => {}}
        onSaved={() => {}}
        initial={chosen}
      />,
    );
    expect(html).toContain(
      'role="radiogroup" aria-label="Who reviews the members’ work"',
    );
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Critic reviews"/);
    expect(html).not.toContain('aria-label="Scout reviews"');
  });
});

describe('team page', () => {
  const team: Team = {
    id: 'team-1',
    name: 'Desk',
    emoji: '🔬',
    color: 'mint',
    description: '',
    leadDotId: 'lead',
    style: 'review',
    mode: 'lead',
    summarize: false,
    reviewerDotId: 'critic',
    spaceId: null,
    runLog: true,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    members: [{ dotId: 'scout', role: 'Finds', position: 0 }],
  };
  const page = (detail: TeamDetail) =>
    renderToStaticMarkup(
      <TeamPage
        teamId="team-1"
        dots={dots}
        initial={detail}
        onStartChat={() => {}}
        onEdit={() => {}}
        onArchive={() => {}}
        onOpenThread={() => {}}
      />,
    );
  it('offers to create the team space, or opens it, and links each run to its log', () => {
    const run = {
      id: 'run-1',
      teamId: 'team-1',
      threadId: 'chat',
      style: 'review' as const,
      mode: 'lead' as const,
      status: 'done' as const,
      createdAt: 1,
      finishedAt: 61_001,
      cancelledAt: null,
      reviewerDotId: 'critic',
      verdict: 'approved' as const,
      sentBack: true,
      log: { spaceId: 'space-9', pageId: 'page-9' },
    };
    const without = page({ ...team, conversations: [], runs: [run] });
    expect(without).toContain('Create space');
    expect(without).toContain('Critic reviews');
    expect(without).toContain('Checked by Critic after one send-back');
    expect(without).toContain('Run log');
    const withSpace = page({
      ...team,
      spaceId: 'space-9',
      conversations: [],
      runs: [{ ...run, log: null }],
    });
    expect(withSpace).toContain('Team space');
    expect(withSpace).not.toContain('Create space');
    expect(withSpace).not.toContain('Run log');
  });
});
