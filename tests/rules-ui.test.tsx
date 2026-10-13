import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import { DotRulesEditor, ruleOptions } from '../src/client/DotRulesEditor';
import {
  DotConnectorGrants,
  setTreatAs,
  type GrantInput,
} from '../src/client/DotConnectorGrants';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import {
  emptyRules,
  RULE_CATEGORIES,
  type DotRules,
} from '../src/shared/rules';
import type {
  ApprovalMode,
  ConnectorView,
  Dot,
  State,
  WorkspaceState,
} from '../src/shared/types';

const render = (value: DotRules, mode: ApprovalMode = 'sensitive') =>
  renderToStaticMarkup(
    <DotRulesEditor value={value} mode={mode} onChange={() => {}} />,
  );
/** The markup of one category's row. */
const row = (html: string, category: string) => {
  const start = html.indexOf(`data-category="${category}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</li>', start));
};

describe('DotRulesEditor', () => {
  it('renders one labelled radiogroup per category, with Inherit chosen by default', () => {
    const html = render(emptyRules());
    expect(html.match(/role="radiogroup"/g)).toHaveLength(
      RULE_CATEGORIES.length,
    );
    for (const category of RULE_CATEGORIES) {
      const markup = row(html, category);
      expect(markup).toMatch(/role="radiogroup" aria-labelledby="[^"]+"/);
      expect(markup).toMatch(/checked="" value="inherit"/);
      expect(markup).toContain('Ask me first');
      expect(markup).toContain('Never');
    }
    expect(html).toContain('Hand work to teammates');
  });

  it('offers no Allow on spending money and deleting things', () => {
    const html = render(emptyRules());
    for (const category of ['spend_money', 'delete_things']) {
      const markup = row(html, category);
      expect(markup).not.toContain('value="allow"');
      expect(markup.match(/type="radio"/g)).toHaveLength(3);
    }
    for (const category of ['send_messages', 'run_shell', 'hand_off_work'])
      expect(row(html, category)).toContain('value="allow"');
    expect(ruleOptions('spend_money').map((option) => option.value)).toEqual([
      'inherit',
      'ask',
      'never',
    ]);
  });

  it('shows what Inherit resolves to under the current mode', () => {
    const off = render(emptyRules(), 'off');
    expect(row(off, 'spend_money')).toContain(
      'Inherit asks you first in every mode.',
    );
    expect(row(off, 'run_shell')).toContain(
      'Inherit runs without asking with this approval mode.',
    );
    const writes = render(emptyRules(), 'writes');
    expect(row(writes, 'run_shell')).toContain('Inherit asks you first');
    expect(row(writes, 'hand_off_work')).toContain(
      'Inherit runs without asking',
    );
    const sensitive = render(emptyRules(), 'sensitive');
    expect(row(sensitive, 'send_messages')).toContain(
      'Inherit asks for the risky ones',
    );
    expect(row(sensitive, 'write_files')).toContain(
      'Inherit runs without asking',
    );
  });

  it('warns in red when Allow is chosen for sending, publishing or shell commands', () => {
    const html = render({
      ...emptyRules(),
      send_messages: 'allow',
      run_shell: 'allow',
      write_files: 'allow',
    });
    expect(row(html, 'send_messages')).toContain('class="dr-warning"');
    expect(row(html, 'send_messages')).toContain(
      'This Dot will send messages without asking you',
    );
    expect(row(html, 'run_shell')).toContain('class="dr-warning"');
    expect(row(html, 'write_files')).not.toContain('dr-warning');
    expect(row(html, 'publish')).not.toContain('dr-warning');
    expect(row(html, 'send_messages')).toMatch(/checked="" value="allow"/);
  });
});

describe('Rules in the Dot dialog', () => {
  it('shows a Rules section in the Dot form', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        dialog={{
          type: 'dot',
          spaceId: 's1',
          dot: {
            id: 'd1',
            name: 'Scout',
            instructions: 'Find things.',
            spaceId: 's1',
            spaceIds: ['s1'],
            researchAllowed: true,
            memoryAllowed: true,
            approvalMode: 'off',
          } as Dot,
        }}
        state={
          {
            settings: { researchAllowed: true, memoryAllowed: true },
          } as unknown as State
        }
        workspace={
          {
            spaces: [{ id: 's1', name: 'Everyday' }],
            dots: [],
            setup: { missing: [], search: false, browser: false, voice: false },
          } as unknown as WorkspaceState
        }
        onClose={() => {}}
        mutate={async () => true}
      />,
    );
    expect(html).toContain('id="dot-sec-rules"');
    expect(html).toContain('class="dr-root"');
    // The editor follows the mode chosen in the same dialog.
    expect(row(html, 'run_shell')).toContain('Inherit runs without asking');
  });
});

describe('connector "Treat as"', () => {
  const github: ConnectorView = {
    id: 'gh',
    name: 'github',
    transport: 'http',
    url: 'https://example.com/mcp',
    command: null,
    args: [],
    cwd: null,
    headers: {},
    env: {},
    callTimeoutMs: 30_000,
    enabled: true,
    presetId: null,
    auth: 'none',
    createdAt: 1,
    updatedAt: 1,
    status: {
      state: 'connected',
      tools: [
        {
          name: 'get_issue',
          toolName: 'mcp__github__get_issue',
          description: '',
          readOnly: true,
          destructive: false,
          inputSchema: {},
        },
        {
          name: 'create_issue',
          toolName: 'mcp__github__create_issue',
          description: '',
          readOnly: false,
          destructive: false,
          inputSchema: {},
        },
      ],
    },
  };

  it('offers a Treat as choice for each granted tool and keeps the pinned one', () => {
    const grant: GrantInput = {
      connectorId: 'gh',
      tools: ['create_issue'],
      categories: { create_issue: 'publish' },
    };
    const html = renderToStaticMarkup(
      <DotConnectorGrants
        connectors={[github]}
        value={[grant]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Treat create_issue as"');
    // Not granted: no choice.
    expect(html).not.toContain('aria-label="Treat get_issue as"');
    expect(html).toContain('<option value="">Automatic</option>');
    expect(html).toMatch(
      /<option value="publish" selected="">Publish<\/option>/,
    );
  });

  it('pins and unpins a tool', () => {
    const grant: GrantInput = { connectorId: 'gh', tools: ['create_issue'] };
    const pinned = setTreatAs(grant, 'create_issue', 'spend_money');
    expect(pinned.categories).toEqual({ create_issue: 'spend_money' });
    expect(setTreatAs(pinned, 'create_issue', '')).toEqual(grant);
    expect(setTreatAs(grant, 'create_issue', 'not_a_category')).toEqual(grant);
  });
});
