// Rules per Dot: for each kind of action, whether the Dot follows its approval mode (inherit), runs it
// without asking (allow), asks first (ask) or never does it (never). The category ids are stable: they
// are stored in `dot_rules` and in connector "Treat as" choices.
import type { ApprovalMode } from './types.js';

export const RULE_CATEGORIES = [
  'send_messages',
  'spend_money',
  'delete_things',
  'publish',
  'run_shell',
  'write_files',
  'create_pages',
  'edit_pages',
  'risky_clicks',
  'hand_off_work',
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULES = ['inherit', 'allow', 'ask', 'never'] as const;
export type Rule = (typeof RULES)[number];
/** Every category with its rule; a category without a stored row is `inherit`. */
export type DotRules = Record<RuleCategory, Rule>;

/**
 * No setting lets a Dot pay or delete without the owner's click: these never take `allow`, and their
 * `inherit` always resolves to asking (in mode `off` too).
 */
export const LOCKED_CATEGORIES: readonly RuleCategory[] = [
  'spend_money',
  'delete_things',
];
/** `allow` is accepted for these, but the editor warns about it. */
export const WARN_ON_ALLOW: readonly RuleCategory[] = [
  'send_messages',
  'publish',
  'run_shell',
];

export const RULE_LABELS: Record<RuleCategory, string> = {
  send_messages: 'Send messages',
  spend_money: 'Spend money',
  delete_things: 'Delete things',
  publish: 'Publish',
  run_shell: 'Run shell commands',
  write_files: 'Write files',
  create_pages: 'Create pages',
  edit_pages: 'Edit pages',
  risky_clicks: 'Risky clicks',
  hand_off_work: 'Hand work to teammates',
};

export const isRuleCategory = (value: unknown): value is RuleCategory =>
  (RULE_CATEGORIES as readonly unknown[]).includes(value);
export const isRule = (value: unknown): value is Rule =>
  (RULES as readonly unknown[]).includes(value);
export const isLocked = (category: RuleCategory) =>
  LOCKED_CATEGORIES.includes(category);

export function emptyRules(): DotRules {
  return Object.fromEntries(
    RULE_CATEGORIES.map((category) => [category, 'inherit']),
  ) as DotRules;
}

/** What `inherit` means for a category under a mode: always asks, never asks, or asks for the risky ones. */
export type InheritOutcome = 'ask' | 'allow' | 'some';

/** Mirrors `classify()` in src/server/approvals.ts; the editor shows it next to each Inherit choice. */
export function inheritOutcome(
  category: RuleCategory,
  mode: ApprovalMode,
): InheritOutcome {
  if (isLocked(category)) return 'ask';
  // Hand-offs are not gated by any mode, so teams stay fast unless the owner sets a rule.
  if (category === 'hand_off_work' || mode === 'off') return 'allow';
  if (mode === 'writes') return 'ask';
  switch (category) {
    case 'risky_clicks':
      return 'ask';
    case 'write_files':
    case 'create_pages':
    case 'edit_pages':
      return 'allow';
    default:
      // Sensitive mode asks for a Send button or a destructive command, not for every connector tool.
      return 'some';
  }
}
