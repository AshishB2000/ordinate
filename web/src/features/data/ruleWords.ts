// The data-quality vocabulary the Rules list and the editor share
// (dsRuleEditor.ts): kind labels, presets, and a rule in words — "order_date is
// never empty", "discount is between 0 and 1", "email matches Email".

import { formatNumber } from './format';
import type { ColumnType, RuleDraft, RuleKind } from './api';

export const KINDS: { kind: RuleKind; label: string; hint: string }[] = [
  { kind: 'not_null', label: 'Not empty', hint: 'Every row has a value' },
  { kind: 'unique', label: 'Unique', hint: 'No value appears twice' },
  { kind: 'range', label: 'Range', hint: 'Numbers or dates stay in bounds' },
  { kind: 'regex', label: 'Pattern', hint: 'Text matches a format' },
  { kind: 'in_set', label: 'Allowed values', hint: 'Only values from a list' },
  { kind: 'row_count', label: 'Row count', hint: 'The table stays a sensible size' },
  { kind: 'references', label: 'Reference', hint: 'Values exist in another dataset' },
];

export const PRESETS: { value: string; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'zip', label: 'ZIP code' },
  { value: 'date', label: 'ISO date' },
];

export const kindLabel = (kind: string): string => KINDS.find((k) => k.kind === kind)?.label ?? kind;

const bound = (v: unknown): string => (typeof v === 'number' ? formatNumber(v, { maxDecimals: 6 }) : String(v));
const has = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

function between(subject: string, a: Record<string, unknown>): string {
  if (has(a.min) && has(a.max)) return `${subject} is between ${bound(a.min)} and ${bound(a.max)}`;
  if (has(a.min)) return `${subject} is at least ${bound(a.min)}`;
  return `${subject} is at most ${bound(a.max)}`;
}

/** A rule in words. `names` names the other dataset of a references rule. */
export function ruleWords(rule: RuleDraft, names?: ReadonlyMap<string, string>): string {
  const a = rule.args ?? {};
  const col = rule.column ?? '';
  switch (rule.kind) {
    case 'not_null':
      return `${col} is never empty`;
    case 'unique':
      return `${col} is unique`;
    case 'range':
      return between(col, a);
    case 'regex': {
      const preset = PRESETS.find((p) => p.value === a.preset);
      return preset ? `${col} matches ${preset.label}` : `${col} matches ${String(a.pattern ?? '')}`;
    }
    case 'in_set': {
      const vals = Array.isArray(a.values) ? (a.values as string[]) : [];
      const more = vals.length > 3 ? ` and ${formatNumber(vals.length - 3)} more` : '';
      return `${col} is one of ${vals.slice(0, 3).join(', ')}${more}`;
    }
    case 'row_count':
      return between('Row count', a);
    case 'references':
      return `${col} exists in ${names?.get(String(a.datasetId)) ?? 'another dataset'}.${String(a.column ?? '')}`;
    default:
      return String(rule.kind);
  }
}

/** The columns a kind can run on — the server refuses the rest with a message. */
export function columnsFor<T extends { type: ColumnType }>(kind: RuleKind, cols: readonly T[]): T[] {
  if (kind === 'range') return cols.filter((c) => c.type === 'number' || c.type === 'date');
  if (kind === 'regex') return cols.filter((c) => c.type !== 'number');
  return [...cols];
}
