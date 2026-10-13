import { useId } from 'react';
import {
  CreditCard,
  FilePen,
  FilePlus2,
  Handshake,
  Megaphone,
  MousePointerClick,
  PencilLine,
  Send,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  inheritOutcome,
  isLocked,
  RULE_CATEGORIES,
  RULE_LABELS,
  WARN_ON_ALLOW,
  type DotRules,
  type InheritOutcome,
  type Rule,
  type RuleCategory,
} from '../shared/rules';
import type { ApprovalMode } from '../shared/types';
import './dot-rules.css';

const CATEGORY_INFO: Record<
  RuleCategory,
  { icon: LucideIcon; example: string }
> = {
  send_messages: {
    icon: Send,
    example: 'Reply in a chat, press Send, or message someone.',
  },
  spend_money: {
    icon: CreditCard,
    example: 'Pay, buy, place an order or transfer money.',
  },
  delete_things: {
    icon: Trash2,
    example: 'Delete a file, remove an item, run rm.',
  },
  publish: {
    icon: Megaphone,
    example: 'Post publicly, share, git push or publish a package.',
  },
  run_shell: {
    icon: SquareTerminal,
    example: 'Run a command on its computer, like npm test.',
  },
  write_files: {
    icon: FilePen,
    example: 'Save or overwrite a file on its computer.',
  },
  create_pages: {
    icon: FilePlus2,
    example: 'Add a new page to a Space.',
  },
  edit_pages: {
    icon: PencilLine,
    example: 'Change a page that is already in a Space.',
  },
  risky_clicks: {
    icon: MousePointerClick,
    example: 'Click Confirm or Submit, or a button it cannot identify.',
  },
  hand_off_work: {
    icon: Handshake,
    example: 'Hand part of a task to a teammate Dot.',
  },
};

const RULE_OPTIONS: { value: Rule; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask me first' },
  { value: 'never', label: 'Never' },
];

export const INHERIT_TEXT: Record<InheritOutcome, string> = {
  ask: 'asks you first',
  allow: 'runs without asking',
  some: 'asks for the risky ones',
};

/** The choices a category offers: Allow is never offered for spending money or deleting. */
export const ruleOptions = (category: RuleCategory) =>
  RULE_OPTIONS.filter(
    (option) => !(option.value === 'allow' && isLocked(category)),
  );

/** One row per category: what it covers, and a segmented Inherit / Allow / Ask me first / Never choice. */
export function DotRulesEditor({
  value,
  mode,
  onChange,
}: {
  value: DotRules;
  /** The approval mode chosen in the dialog, so Inherit shows what it resolves to right now. */
  mode: ApprovalMode;
  onChange: (value: DotRules) => void;
}) {
  return (
    <div className="dr-root">
      <p className="dr-intro">
        Rules are more specific than the approval mode. Inherit follows the
        mode. Password, code and human-check steps always come to you.
      </p>
      <ul className="dr-list">
        {RULE_CATEGORIES.map((category) => (
          <RuleRow
            key={category}
            category={category}
            rule={value[category] ?? 'inherit'}
            mode={mode}
            onChange={(rule) => onChange({ ...value, [category]: rule })}
          />
        ))}
      </ul>
    </div>
  );
}

function RuleRow({
  category,
  rule,
  mode,
  onChange,
}: {
  category: RuleCategory;
  rule: Rule;
  mode: ApprovalMode;
  onChange: (rule: Rule) => void;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const exampleId = `${uid}-example`;
  const inheritId = `${uid}-inherit`;
  const { icon: Icon, example } = CATEGORY_INFO[category];
  const label = RULE_LABELS[category];
  const warn = rule === 'allow' && WARN_ON_ALLOW.includes(category);
  return (
    <li className="dr-row" data-category={category} data-rule={rule}>
      <span className="dr-icon" aria-hidden="true">
        <Icon size={17} strokeWidth={1.9} />
      </span>
      <span className="dr-text">
        <span className="dr-label" id={labelId}>
          {label}
        </span>
        <span className="dr-example" id={exampleId}>
          {example}
        </span>
      </span>
      <div
        className="dr-segments"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={`${exampleId} ${inheritId}`}
      >
        {ruleOptions(category).map((option) => (
          <label
            className="dr-segment"
            key={option.value}
            data-value={option.value}
            data-checked={rule === option.value ? 'true' : 'false'}
          >
            <input
              type="radio"
              className="dr-sr"
              name={`${uid}-rule`}
              value={option.value}
              checked={rule === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <span className="dr-inherit" id={inheritId}>
        Inherit {INHERIT_TEXT[inheritOutcome(category, mode)]}
        {isLocked(category) ? ' in every mode' : ' with this approval mode'}.
      </span>
      {warn && (
        <p className="dr-warning">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          <span>
            This Dot will {label.toLowerCase()} without asking you, in every
            mode.
          </span>
        </p>
      )}
    </li>
  );
}
