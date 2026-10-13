import type { DatabaseSync } from 'node:sqlite';
import {
  emptyRules,
  isLocked,
  isRule,
  isRuleCategory,
  RULE_LABELS,
  type DotRules,
  type Rule,
  type RuleCategory,
} from '../shared/rules.js';

/** Rules per Dot: one row per category that is not `inherit`. */
export class RuleStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS dot_rules(dotId TEXT NOT NULL, category TEXT NOT NULL,
      rule TEXT NOT NULL, PRIMARY KEY(dotId, category));`);
  }

  /** Every category with its rule; a missing row, or one this version does not know, is `inherit`. */
  get(dotId: string): DotRules {
    const rules = emptyRules();
    for (const row of this.db
      .prepare('SELECT category, rule FROM dot_rules WHERE dotId=?')
      .all(dotId)) {
      if (isRuleCategory(row.category) && isRule(row.rule))
        rules[row.category] = row.rule;
    }
    return rules;
  }

  /** Replaces the Dot's rules; categories left out become `inherit`. */
  set(dotId: string, rules: Partial<Record<RuleCategory, Rule>>): DotRules {
    for (const [category, rule] of Object.entries(rules))
      if (isRuleCategory(category) && isLocked(category) && rule === 'allow')
        throw new Error(
          `${RULE_LABELS[category]} can only be Inherit, Ask me first or Never.`,
        );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM dot_rules WHERE dotId=?').run(dotId);
      const insert = this.db.prepare('INSERT INTO dot_rules VALUES (?, ?, ?)');
      for (const [category, rule] of Object.entries(rules))
        if (isRuleCategory(category) && isRule(rule) && rule !== 'inherit')
          insert.run(dotId, category, rule);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(dotId);
  }

  /** Removes the Dot's rules: call it when the Dot itself is deleted. */
  deleteDot(dotId: string) {
    this.db.prepare('DELETE FROM dot_rules WHERE dotId=?').run(dotId);
  }
}
