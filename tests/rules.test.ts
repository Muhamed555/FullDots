import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  categoriesOf,
  classify,
  type ClassifyInput,
  type ElementIdentity,
} from '../src/server/approvals.js';
import {
  approvalGate,
  gateParse,
  type GateDeps,
} from '../src/server/approval-gate.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { ConnectorStore } from '../src/server/connector-store.js';
import type { ConnectorRegistry } from '../src/server/connectors.js';
import { mcpToolInfo } from '../src/server/mcp-tools.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { runThreadTurn } from '../src/server/headless.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { Store } from '../src/server/store.js';
import { TeamService } from '../src/server/team-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { TurnBudget } from '../src/server/turn-budget.js';
import {
  emptyRules,
  inheritOutcome,
  RULE_CATEGORIES,
  type DotRules,
  type Rule,
  type RuleCategory,
} from '../src/shared/rules.js';
import type { ApprovalMode, Handoff } from '../src/shared/types.js';
import { completion } from './fixtures/model-stream.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

const MODES: ApprovalMode[] = ['sensitive', 'writes', 'off'];
const el = (role: string, name: string): ElementIdentity => ({ role, name });
const mcpTool = (connector: string, name: string): ClassifyInput => ({
  tool: `mcp__${connector}__${name}`,
  args: {},
  mcp: { readOnly: false, destructive: false, name },
});
const rulesWith = (rules: Partial<DotRules>): DotRules => ({
  ...emptyRules(),
  ...rules,
});

/** One action per category that falls under that category alone, and whether today's modes ask about it. */
const SAMPLES: Record<
  RuleCategory,
  { input: ClassifyInput; inherit: Record<ApprovalMode, boolean> }
> = {
  send_messages: {
    input: mcpTool('mail', 'send_email'),
    inherit: { sensitive: false, writes: true, off: false },
  },
  spend_money: {
    input: mcpTool('shop', 'create_payment'),
    inherit: { sensitive: true, writes: true, off: true },
  },
  delete_things: {
    input: mcpTool('files', 'delete_file'),
    inherit: { sensitive: true, writes: true, off: true },
  },
  publish: {
    input: mcpTool('blog', 'publish_post'),
    inherit: { sensitive: false, writes: true, off: false },
  },
  run_shell: {
    input: { tool: 'computer_exec', args: { command: 'npm test' } },
    inherit: { sensitive: false, writes: true, off: false },
  },
  write_files: {
    input: { tool: 'computer_files_write', args: { path: 'a.txt' } },
    inherit: { sensitive: false, writes: true, off: false },
  },
  create_pages: {
    input: { tool: 'create_space_page', args: { title: 'T' } },
    inherit: { sensitive: false, writes: true, off: false },
  },
  edit_pages: {
    input: { tool: 'edit_space_page', args: { id: 'p' } },
    inherit: { sensitive: false, writes: true, off: false },
  },
  risky_clicks: {
    input: {
      tool: 'computer_click',
      args: {},
      element: el('button', 'Confirm'),
    },
    inherit: { sensitive: true, writes: true, off: false },
  },
  hand_off_work: {
    input: {
      tool: 'delegate_to_dot',
      args: { dot: 'Scout', brief: 'Research the launch.', deliverable: 'x' },
    },
    inherit: { sensitive: false, writes: false, off: false },
  },
};

describe('categories', () => {
  it.each(RULE_CATEGORIES)(
    'the %s sample falls under that category only',
    (category) => {
      expect(categoriesOf(SAMPLES[category].input)).toEqual([category]);
    },
  );

  it('reads shell commands, page names and connector tool names', () => {
    const exec = (command: string) =>
      categoriesOf({ tool: 'computer_exec', args: { command } }).sort();
    expect(exec('rm -rf build')).toEqual(['delete_things', 'run_shell']);
    expect(exec("sh -c 'git clean -fdx'")).toEqual([
      'delete_things',
      'run_shell',
    ]);
    expect(exec('find . -name "*.log" -delete')).toEqual([
      'delete_things',
      'run_shell',
    ]);
    expect(exec('git push origin main')).toEqual(['publish', 'run_shell']);
    expect(exec('npm publish')).toEqual(['publish', 'run_shell']);
    expect(exec('echo hi | mail -s x a@b.c')).toEqual([
      'run_shell',
      'send_messages',
    ]);
    expect(exec('mv a b')).toEqual(['run_shell']);
    // A wrapped command that cannot be read counts under every family (fail closed).
    expect(exec('sh -c $CMD')).toEqual([
      'delete_things',
      'publish',
      'run_shell',
      'send_messages',
    ]);

    const click = (name: string) =>
      categoriesOf({
        tool: 'computer_click',
        args: {},
        element: el('button', name),
      }).sort();
    expect(click('Send')).toEqual(['risky_clicks', 'send_messages']);
    expect(click('Pay now')).toEqual(['risky_clicks', 'spend_money']);
    expect(click('Place order')).toEqual(['risky_clicks', 'spend_money']);
    expect(click('Delete account')).toEqual(['delete_things', 'risky_clicks']);
    expect(click('Publish')).toEqual(['publish', 'risky_clicks']);
    expect(click('Next')).toEqual([]);
    // Substrings are not words: "Border" is not an order, "Postal code" is not a post.
    expect(click('Border colour')).toEqual(['risky_clicks']);
    expect(
      categoriesOf({
        tool: 'computer_click',
        args: {},
        element: el('textbox', 'Postal code'),
      }),
    ).toEqual(['risky_clicks']);
    // Enter in a plain field can still reach a sensitive button on the page.
    expect(
      categoriesOf({
        tool: 'computer_key',
        args: { key: 'Enter' },
        focus: el('textbox', 'Card holder'),
        latestElements: [el('button', 'Pay now')],
      }).sort(),
    ).toEqual(['risky_clicks', 'spend_money']);
    expect(
      categoriesOf({
        tool: 'computer_type',
        args: { text: 'x' },
        element: el('textbox', 'Message'),
      }),
    ).toEqual([]);

    expect(categoriesOf(mcpTool('gh', 'createIssue'))).toEqual([]);
    expect(categoriesOf(mcpTool('slack', 'postMessage')).sort()).toEqual([
      'publish',
      'send_messages',
    ]);
    // Read-only tools get no category from their name; destructive ones delete.
    expect(
      categoriesOf({
        tool: 'mcp__mail__list_messages',
        args: {},
        mcp: { readOnly: true, destructive: false, name: 'list_messages' },
      }),
    ).toEqual([]);
    expect(
      categoriesOf({
        tool: 'mcp__gh__merge',
        args: {},
        mcp: { readOnly: false, destructive: true, name: 'merge' },
      }),
    ).toEqual(['delete_things']);
    // Unknown annotations (connector reconnecting): the name still counts.
    expect(categoriesOf({ tool: 'mcp__gh__delete_repo', args: {} })).toEqual([
      'delete_things',
    ]);
  });
});

describe('classify with rules: category × rule × mode', () => {
  const cases = RULE_CATEGORIES.flatMap((category) =>
    (['inherit', 'allow', 'ask', 'never'] as Rule[]).flatMap((rule) =>
      MODES.map((mode) => [category, rule, mode] as const),
    ),
  );
  it.each(cases)('%s / %s / %s', (category, rule, mode) => {
    const { input, inherit } = SAMPLES[category];
    const result = classify(input, mode, rulesWith({ [category]: rule }));
    const locked = category === 'spend_money' || category === 'delete_things';
    if (rule === 'never') {
      expect(result).toMatchObject({ gated: true, denied: true, category });
      return;
    }
    expect(result.denied).toBeUndefined();
    if (rule === 'ask') expect(result.gated).toBe(true);
    // A stored `allow` on a locked category is never honoured (the API refuses to store one).
    else if (rule === 'allow') expect(result.gated).toBe(locked);
    else expect(result.gated).toBe(inherit[mode]);
  });

  it('inherit for spending money and deleting asks in mode off', () => {
    for (const category of ['spend_money', 'delete_things'] as const) {
      expect(
        classify(SAMPLES[category].input, 'off', emptyRules()),
      ).toMatchObject({
        gated: true,
        category,
      });
      expect(inheritOutcome(category, 'off')).toBe('ask');
    }
    expect(
      classify(
        { tool: 'computer_click', args: {}, element: el('button', 'Pay now') },
        'off',
      ).gated,
    ).toBe(true);
    // Without rules at all the same holds: the default is inherit.
    expect(classify(SAMPLES.spend_money.input, 'off').gated).toBe(true);
  });

  it('agrees with what the editor says Inherit means', () => {
    for (const category of RULE_CATEGORIES)
      for (const mode of MODES) {
        const outcome = inheritOutcome(category, mode);
        if (outcome === 'some') continue;
        expect(SAMPLES[category].inherit[mode]).toBe(outcome === 'ask');
      }
  });

  it('lets the strictest rule win when an action falls under several categories', () => {
    const exec = (command: string) => ({
      tool: 'computer_exec',
      args: { command },
    });
    // run_shell allow does not let rm through: delete things still asks.
    expect(
      classify(
        exec('rm -rf build'),
        'writes',
        rulesWith({ run_shell: 'allow' }),
      ),
    ).toMatchObject({
      gated: true,
      category: 'delete_things',
    });
    expect(
      classify(
        exec('git push'),
        'off',
        rulesWith({ run_shell: 'allow', publish: 'ask' }),
      ),
    ).toMatchObject({ gated: true, category: 'publish' });
    expect(
      classify(
        exec('git push'),
        'off',
        rulesWith({ run_shell: 'never', publish: 'allow' }),
      ),
    ).toMatchObject({ denied: true, category: 'run_shell' });
    // allow beats inherit: the other category has no opinion.
    expect(
      classify(exec('git push'), 'writes', rulesWith({ run_shell: 'allow' }))
        .gated,
    ).toBe(false);
    expect(
      classify(
        exec('rm x'),
        'writes',
        rulesWith({ delete_things: 'never', run_shell: 'ask' }),
      ),
    ).toMatchObject({ denied: true, category: 'delete_things' });
    const send = {
      tool: 'computer_click',
      args: {},
      element: el('button', 'Send'),
    };
    expect(
      classify(send, 'sensitive', rulesWith({ send_messages: 'allow' })).gated,
    ).toBe(false);
    expect(
      classify(
        send,
        'sensitive',
        rulesWith({ send_messages: 'allow', risky_clicks: 'never' }),
      ),
    ).toMatchObject({ denied: true, category: 'risky_clicks' });
    expect(
      classify(
        send,
        'off',
        rulesWith({ send_messages: 'allow', risky_clicks: 'ask' }),
      ).gated,
    ).toBe(true);
    // Allowing risky clicks never lets a Dot pay.
    const pay = {
      tool: 'computer_click',
      args: {},
      element: el('button', 'Send payment'),
    };
    expect(
      classify(
        pay,
        'sensitive',
        rulesWith({ risky_clicks: 'allow', send_messages: 'allow' }),
      ),
    ).toMatchObject({ gated: true, category: 'spend_money' });
  });

  it('keeps connector per-tool overrides more specific than the rules', () => {
    const tool = (override: 'allow' | 'ask' | 'deny') => ({
      ...mcpTool('mail', 'send_email'),
      mcp: {
        readOnly: false,
        destructive: false,
        name: 'send_email',
        override,
      },
    });
    expect(
      classify(tool('deny'), 'off', rulesWith({ send_messages: 'allow' })),
    ).toEqual({
      level: 'sensitive',
      gated: true,
      reason: 'denied',
    });
    expect(
      classify(tool('allow'), 'writes', rulesWith({ send_messages: 'never' }))
        .gated,
    ).toBe(false);
    expect(
      classify(tool('ask'), 'off', rulesWith({ send_messages: 'allow' })).gated,
    ).toBe(true);
  });

  it('uses the connector "Treat as" category instead of the name heuristics', () => {
    const pinned = (category: RuleCategory, readOnly = false) => ({
      tool: 'mcp__crm__sync',
      args: {},
      mcp: { readOnly, destructive: false, name: 'sync', category },
    });
    expect(categoriesOf(pinned('spend_money'))).toEqual(['spend_money']);
    expect(classify(pinned('spend_money'), 'off').gated).toBe(true);
    expect(
      classify(
        pinned('send_messages', true),
        'sensitive',
        rulesWith({ send_messages: 'never' }),
      ),
    ).toMatchObject({ denied: true });
    // A pin replaces the name words: "delete_file" pinned to write files is not "delete things".
    expect(
      categoriesOf({
        tool: 'mcp__files__delete_file',
        args: {},
        mcp: {
          readOnly: false,
          destructive: false,
          name: 'delete_file',
          category: 'write_files',
        },
      }),
    ).toEqual(['write_files']);
  });
});

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

const handoffs = () => ({
  start: vi.fn(
    async (input: {
      dotId: string;
      threadId: string;
      kind: Handoff['kind'];
      reason: string;
    }) =>
      ({
        ...input,
        id: 'h1',
        status: 'waiting',
        createdAt: 0,
        finishedAt: null,
        controlRequestId: null,
      }) as Handoff,
  ),
});

function approvalService(workspace: WorkspaceStore) {
  return new ApprovalService({
    approvals: workspace.approvals,
    resumes: { enqueue: vi.fn() },
    audit: workspace.computers,
    notify: async () => {},
    ttlMs: 60_000,
    log: () => {},
  });
}

function rig(
  rules: Partial<DotRules>,
  options: {
    mode?: ApprovalMode;
    resume?: string;
    mcp?: GateDeps['mcpInfo'];
  } = {},
) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Rules');
  const current = { rules };
  const service = approvalService(workspace);
  const budget: TurnBudget = {};
  const { middleware, gate } = approvalGate({
    dotId: dot.id,
    dotName: 'Scout',
    threadId: 'thread',
    source: options.resume ? 'approval' : 'chat',
    ...(options.resume ? { ref: options.resume } : {}),
    mode: options.mode ?? 'sensitive',
    budget,
    approvals: service,
    handoffs: handoffs(),
    mcpInfo: options.mcp ?? (() => undefined),
    parse: gateParse,
    rules: () => current.rules,
  });
  let seq = 0;
  const before = (toolName: string, args: unknown) =>
    middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args,
      toolName,
      toolCallId: `call-${++seq}`,
    });
  return { workspace, service, gate, before, current };
}

const skipped = (decision: unknown) => {
  const result = decision as
    { type?: string; result?: Record<string, unknown> } | undefined;
  expect(result?.type).toBe('skip');
  return result?.result ?? {};
};

describe('the approval gate with rules', () => {
  it('refuses a Never action with the denied result, before anything runs or is asked', async () => {
    const r = rig({ run_shell: 'never' }, { mode: 'off' });
    const result = skipped(await r.before('computer_exec', { command: 'ls' }));
    expect(result).toEqual({
      error: expect.stringContaining('Run shell commands: Never'),
    });
    expect(r.workspace.approvals.list({})).toHaveLength(0);
    expect(r.gate.paused).toBeUndefined();
    // request_approval cannot unlock it either.
    const asked = skipped(
      await r.before('request_approval', {
        summary: 'List files',
        intent: { tool: 'computer_exec', args: { command: 'ls' } },
      }),
    );
    expect(asked.error).toContain('Never');
    expect(r.workspace.approvals.list({})).toHaveLength(0);
  });

  it('applies a rule change at once, even over an approval the owner already gave', async () => {
    const first = rig({}, { mode: 'sensitive' });
    const pending = skipped(
      await first.before('computer_exec', { command: 'rm -rf build' }),
    );
    expect(pending.status).toBe('pending_approval');
    const id = String(pending.approvalId);
    first.service.decide(id, 'approve');
    first.current.rules = { delete_things: 'never' };
    const resumed = approvalGate({
      dotId: first.workspace.dots()[0].id,
      dotName: 'Scout',
      threadId: 'thread',
      source: 'approval',
      ref: id,
      mode: 'sensitive',
      budget: {},
      approvals: first.service,
      handoffs: handoffs(),
      mcpInfo: () => undefined,
      parse: gateParse,
      rules: () => first.current.rules,
    });
    const decision = await resumed.middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args: { command: 'rm -rf build' },
      toolName: 'computer_exec',
      toolCallId: 'again',
    });
    expect(skipped(decision).error).toContain('Delete things: Never');
    expect(first.workspace.approvals.get(id)?.status).toBe('approved');
  });

  it('asks before a hand-off under Ask, with the brief as the exact action', async () => {
    const r = rig({ hand_off_work: 'ask' });
    const result = skipped(
      await r.before('delegate_to_dot', {
        dot: 'Writer',
        brief: 'Draft the launch post from these notes.',
        deliverable: 'A 200-word post.',
      }),
    );
    expect(result).toMatchObject({
      status: 'pending_approval',
      summary: 'Scout wants to hand work to Writer',
    });
    expect(result.exact).toBe(
      'hand to Writer: Draft the launch post from these notes.\nDeliverable: A 200-word post.',
    );
    expect(r.gate.paused?.kind).toBe('approval');
  });

  it('still hands passwords to the owner whatever the rules say', async () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(workspace);
    const start = handoffs();
    const computer = {
      identityInTurn: () => el('textbox', 'Password'),
      latestUrl: () => 'https://x.test/login',
      latestElements: () => [
        el('textbox', 'Password'),
        el('button', 'Sign in'),
      ],
      presumedFocus: () => undefined,
    };
    const { middleware } = approvalGate({
      dotId: 'dot',
      dotName: 'Scout',
      threadId: 'thread',
      source: 'chat',
      mode: 'off',
      budget: {},
      approvals: approvalService(workspace),
      handoffs: start,
      computer,
      mcpInfo: () => undefined,
      parse: gateParse,
      rules: () => ({ risky_clicks: 'allow', send_messages: 'allow' }),
    });
    const decision = await middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args: { ref: 'p', snapshotId: 1, text: 'secret', submit: true },
      toolName: 'computer_type',
      toolCallId: 't1',
    });
    expect(skipped(decision).status).toBe('handoff');
    expect(start.start).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------
// Inside a real DotAgent turn: delegate_to_dot goes through the gate
// ---------------------------------------------------------------------------------------------

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};
const BRIEF = {
  dot: 'Scout',
  brief: 'Research the launch and list the key dates.',
  deliverable: 'Five bullets with sources.',
};
const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
const text = (content: string) => completion({ role: 'assistant', content });

function teamTurns(rules: Partial<DotRules>, mode: ApprovalMode = 'sensitive') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const runner = new SqliteAgentRunner(':memory:');
  closers.push(store, workspace, runner);
  const space = workspace.spaces()[0].id;
  const lead = workspace.createDot(
    space,
    'Lead',
    'Leads the launch.',
    true,
    true,
    [space],
    null,
    mode,
  );
  const scout = workspace.createDot(
    space,
    'Scout',
    'Research partner.',
    true,
    true,
  );
  workspace.team.setDelegates(lead.id, [scout.id]);
  workspace.rules.set(lead.id, rules);
  workspace.bindThread('lead-thread', lead.id, 'Launch');
  const team = new TeamService({ workspace, store, resume: () => {} });
  const approvals = approvalService(workspace);
  const queue: Array<() => Response> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (!String(url).startsWith('https://unused.invalid'))
      return new Response('{}');
    const reply = queue.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply();
  });
  const turn = (
    prompt: string,
    metadata?: { source: 'approval'; ref: string },
  ) =>
    runThreadTurn(
      runner,
      new DotAgent(store, workspace, config, lead.id, {
        approvals,
        handoffs: handoffs(),
        team,
      }),
      'lead-thread',
      prompt,
      new AbortController().signal,
      metadata,
    );
  const toolMessages = () =>
    runner
      .getThreadMessages('lead-thread')
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
  return { workspace, store, queue, turn, toolMessages, lead };
}

describe('delegate_to_dot through the gate', () => {
  it('hands work over without asking by default, so teams stay fast', async () => {
    const f = teamTurns({});
    f.queue.push(
      () => toolCall('d1', 'delegate_to_dot', BRIEF),
      () => text('Handed over.'),
    );
    expect(await f.turn('Plan the launch.')).toBe('Handed over.');
    expect(f.workspace.team.forParent('lead-thread')).toHaveLength(1);
    expect(f.workspace.approvals.list({})).toHaveLength(0);
  });

  it('under Ask, yields a pending approval and creates the delegation only once approved', async () => {
    const f = teamTurns({ hand_off_work: 'ask' });
    f.queue.push(
      () => toolCall('d1', 'delegate_to_dot', BRIEF),
      () => text('Waiting for you.'),
    );
    await f.turn('Plan the launch.');
    expect(f.workspace.team.forParent('lead-thread')).toHaveLength(0);
    expect(f.store.tasks()).toHaveLength(0);
    expect(f.toolMessages()[0]).toContain('pending_approval');
    const [row] = f.workspace.approvals.list({ status: 'pending' });
    expect(row).toMatchObject({
      tool: 'delegate_to_dot',
      summary: `${f.lead.name} wants to hand work to Scout`,
    });
    expect(row.argsRedacted).toContain(BRIEF.brief);

    // A different brief in a later turn is not covered by the approval.
    f.workspace.approvals.decide(row.id, 'approve');
    f.queue.push(
      () =>
        toolCall('d2', 'delegate_to_dot', {
          ...BRIEF,
          brief: 'Something else entirely, please.',
        }),
      () => text('Asked again.'),
    );
    await f.turn('Go', { source: 'approval', ref: row.id });
    expect(f.workspace.team.forParent('lead-thread')).toHaveLength(0);

    // The exact approved brief runs once on the turn the approval resumed.
    const second = f.workspace.approvals.list({ status: 'pending' })[0];
    f.workspace.approvals.decide(second.id, 'approve');
    f.queue.push(
      () =>
        toolCall('d3', 'delegate_to_dot', {
          ...BRIEF,
          brief: 'Something else entirely, please.',
        }),
      () => text('Handed over.'),
    );
    await f.turn('Go', { source: 'approval', ref: second.id });
    expect(f.workspace.team.forParent('lead-thread')).toHaveLength(1);
    expect(f.workspace.approvals.get(second.id)?.status).toBe('consumed');
  });

  it('under Never, refuses and never runs the tool', async () => {
    const f = teamTurns({ hand_off_work: 'never' }, 'off');
    f.queue.push(
      () => toolCall('d1', 'delegate_to_dot', BRIEF),
      () => text('I could not.'),
    );
    expect(await f.turn('Plan the launch.')).toBe('I could not.');
    expect(f.toolMessages()[0]).toContain('Hand work to teammates: Never');
    expect(f.workspace.team.forParent('lead-thread')).toHaveLength(0);
    expect(f.store.tasks()).toHaveLength(0);
    expect(f.workspace.approvals.list({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Storage and API
// ---------------------------------------------------------------------------------------------

describe('rule storage', () => {
  it('stores only non-inherit rules, refuses allow on locked categories, and forgets a deleted Dot', () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(workspace);
    const [dot] = workspace.dots();
    const other = workspace.createDot(
      dot.spaceId,
      'Other',
      'Other.',
      true,
      true,
    );
    expect(workspace.rules.get(dot.id)).toEqual(emptyRules());
    workspace.rules.set(dot.id, {
      run_shell: 'allow',
      spend_money: 'never',
      publish: 'inherit',
    });
    workspace.rules.set(other.id, { publish: 'ask' });
    expect(workspace.rules.get(dot.id)).toEqual(
      rulesWith({ run_shell: 'allow', spend_money: 'never' }),
    );
    expect(() =>
      workspace.rules.set(dot.id, { delete_things: 'allow' }),
    ).toThrow('Delete things can only be Inherit, Ask me first or Never.');
    // The refused write changed nothing.
    expect(workspace.rules.get(dot.id).run_shell).toBe('allow');
    workspace.rules.deleteDot(dot.id);
    expect(workspace.rules.get(dot.id)).toEqual(emptyRules());
    expect(workspace.rules.get(other.id).publish).toBe('ask');
  });

  it('keeps existing connector grants when it adds the "Treat as" column', () => {
    const db = new DatabaseSync(':memory:');
    closers.push(db);
    db.exec(`CREATE TABLE dot_connectors(dotId TEXT NOT NULL, connectorId TEXT NOT NULL,
      tools TEXT NOT NULL DEFAULT '"*"', overrides TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(dotId, connectorId));
      INSERT INTO dot_connectors VALUES ('dot', 'c1', '["send_email"]', '{"send_email":"ask"}');`);
    const store = new ConnectorStore(db);
    expect(store.grants('dot')).toEqual([
      {
        dotId: 'dot',
        connectorId: 'c1',
        tools: ['send_email'],
        overrides: { send_email: 'ask' },
      },
    ]);
    store.setGrant('dot', 'c1', ['send_email'], {}, { send_email: 'publish' });
    expect(store.grant('dot', 'c1')?.categories).toEqual({
      send_email: 'publish',
    });
    const registry = {
      toolsCached: () => [
        {
          name: 'send_email',
          toolName: 'mcp__mail__send_email',
          description: '',
          readOnly: false,
          destructive: false,
          inputSchema: {},
        },
      ],
    } as unknown as ConnectorRegistry;
    expect(
      mcpToolInfo(registry, store, 'dot', 'mcp__mail__send_email'),
    ).toEqual({
      readOnly: false,
      destructive: false,
      override: undefined,
      name: 'send_email',
      category: 'publish',
    });
  });
});

describe('rules API', () => {
  function app() {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(store, workspace);
    const platform = new Platform(store, workspace, config);
    const created = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      platform,
    });
    return { app: created, workspace, dot: workspace.dots()[0] };
  }
  const put = (
    target: ReturnType<typeof app>['app'],
    id: string,
    body: unknown,
  ) =>
    target.request(`/api/dots/${id}/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it("reads and replaces a Dot's rules", async () => {
    const { app: target, dot } = app();
    expect(
      await (await target.request(`/api/dots/${dot.id}/rules`)).json(),
    ).toEqual({
      rules: emptyRules(),
    });
    const saved = await put(target, dot.id, {
      rules: { send_messages: 'ask', hand_off_work: 'never' },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      rules: rulesWith({ send_messages: 'ask', hand_off_work: 'never' }),
    });
    // PUT replaces: what is left out goes back to inherit.
    await put(target, dot.id, { rules: { publish: 'allow' } });
    expect(
      await (await target.request(`/api/dots/${dot.id}/rules`)).json(),
    ).toEqual({
      rules: rulesWith({ publish: 'allow' }),
    });
  });

  it('refuses allow for spending money and deleting, and unknown input', async () => {
    const { app: target, dot, workspace } = app();
    for (const category of ['spend_money', 'delete_things']) {
      const refused = await put(target, dot.id, {
        rules: { [category]: 'allow' },
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain(
        'can only be Inherit, Ask me first or Never',
      );
    }
    expect(
      (await put(target, dot.id, { rules: { spend_money: 'never' } })).status,
    ).toBe(200);
    expect(
      (await put(target, dot.id, { rules: { pay_bills: 'ask' } })).status,
    ).toBe(400);
    expect(
      (await put(target, dot.id, { rules: { publish: 'sometimes' } })).status,
    ).toBe(400);
    expect((await put(target, dot.id, { rules: {}, extra: true })).status).toBe(
      400,
    );
    expect((await put(target, 'missing', { rules: {} })).status).toBe(404);
    expect((await target.request('/api/dots/missing/rules')).status).toBe(404);
    expect(workspace.rules.get(dot.id).spend_money).toBe('never');
  });

  it('saves a connector tool\'s "Treat as" category with its grant', async () => {
    const { app: target, dot, workspace } = app();
    const connector = workspace.connectors.create({
      name: 'mail',
      transport: 'http',
      url: 'https://mail.example/mcp',
    });
    const grants = (body: unknown) =>
      target.request(`/api/dots/${dot.id}/connectors`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const saved = await grants({
      grants: [
        {
          connectorId: connector.id,
          tools: ['send_email'],
          categories: { send_email: 'spend_money' },
        },
      ],
    });
    expect(saved.status).toBe(200);
    expect(
      workspace.connectors.grant(dot.id, connector.id)?.categories,
    ).toEqual({
      send_email: 'spend_money',
    });
    expect(
      (
        await grants({
          grants: [
            {
              connectorId: connector.id,
              tools: '*',
              categories: { x: 'buy_things' },
            },
          ],
        })
      ).status,
    ).toBe(400);
  });
});
