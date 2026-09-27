// Whitelisting for the ten power steps — MAIN PROCESS, PURE. The same gate for
// renderer input, stored records and the Assistant's suggestions: a step is
// rebuilt from known fields only, and anything malformed is REFUSED with a
// reason (a regex outside the common subset, a date format off the allow-list,
// a dataset id that is not a UUID) rather than repaired.
//
// Column EXISTENCE is not checked here — that is data-dependent and belongs to
// the fold, which skips with a warning. This checks shape.

import { isValidId } from '../app/ids';
import type { AggFn } from './transforms';
import type {
  ConditionalRule, DedupeKeyStep, LookupJoinStep, ParseDateStep, PowerStep, ReplaceRule, ReplaceValuesStep,
  RuleOp, SplitColumnStep, UnionStep, UnpivotStep, WindowFn, WindowStep,
} from './stepTypes';
import { MAX_RULES, MAX_SPLIT_PARTS, MAX_WINDOW_OFFSET, POWER_STEP_TYPES } from './stepTypes';
import { checkRegex } from './regexSubset';
import { isDateFormat } from './stepsClean';

const AGG: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const RULE_OPS: ReadonlySet<string> = new Set(['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty']);
const WINDOW_FNS: ReadonlySet<string> = new Set(['row_number', 'lag', 'lead', 'running_sum', 'running_avg']);
const MAX_NAME = 500;

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= MAX_NAME ? v : undefined;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= MAX_NAME) : [];
}
function asText(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** A clean step, or the reason the raw one was refused. */
export function checkPowerStep(o: Raw): PowerStep | string {
  const type = String(o.type);
  if (!POWER_STEP_TYPES.has(type)) return `unknown step type "${type}"`;
  switch (type) {
    case 'split_column': {
      const column = str(o.column);
      const mode = o.mode;
      const into = o.into === 'rows' ? 'rows' : 'columns';
      if (!column) return 'split: no column';
      if (mode === 'delimiter') {
        if (typeof o.delimiter !== 'string' || o.delimiter === '' || o.delimiter.length > 50) return 'split: the delimiter is empty';
      } else if (mode === 'position') {
        const p = Array.isArray(o.positions) ? o.positions : [];
        const ok = p.length > 0 && p.length < MAX_SPLIT_PARTS
          && p.every((x, k) => Number.isInteger(x) && (x as number) > 0 && (k === 0 || (x as number) > (p[k - 1] as number)));
        if (!ok) return 'split: positions must be whole numbers above 0, in increasing order';
      } else if (mode === 'regex') {
        const r = checkRegex(o.pattern);
        if (!r.ok) return `split: ${r.error}`;
      } else {
        return 'split: unknown mode';
      }
      const step: SplitColumnStep = { type, column, mode, into };
      if (mode === 'delimiter') step.delimiter = o.delimiter as string;
      if (mode === 'position') step.positions = (o.positions as number[]).slice();
      if (mode === 'regex') {
        step.pattern = o.pattern as string;
        if (o.ignoreCase === true) step.ignoreCase = true;
      }
      if (into === 'columns' && mode !== 'position') {
        const n = o.count === undefined ? 2 : Number(o.count);
        if (!Number.isInteger(n) || n < 1 || n > MAX_SPLIT_PARTS) return `split: the column count must be 1–${MAX_SPLIT_PARTS}`;
        step.count = n;
      }
      return step;
    }
    case 'unpivot': {
      const columns = strList(o.columns);
      if (!columns.length) return 'unpivot: no columns';
      const step: UnpivotStep = { type, columns };
      const attribute = str(o.attribute);
      const value = str(o.value);
      if (attribute) step.attribute = attribute;
      if (value) step.value = value;
      return step;
    }
    case 'pivot': {
      const key = str(o.key);
      const value = str(o.value);
      if (!key || !value) return 'pivot: needs a key and a value column';
      if (typeof o.fn !== 'string' || !AGG.has(o.fn)) return 'pivot: unknown aggregation';
      return { type, key, value, fn: o.fn as AggFn, groupBy: strList(o.groupBy) };
    }
    case 'parse_date': {
      const column = str(o.column);
      if (!column) return 'parse dates: no column';
      if (!isDateFormat(o.format)) return `parse dates: unsupported format "${String(o.format)}"`;
      const step: ParseDateStep = { type, column, format: o.format };
      const as = str(o.as);
      if (as && as.trim()) step.as = as.trim();
      return step;
    }
    case 'dedupe_key': {
      const columns = strList(o.columns);
      if (!columns.length) return 'dedupe: no key columns';
      const keep = o.keep === 'last' || o.keep === 'max' || o.keep === 'min' ? o.keep : 'first';
      const step: DedupeKeyStep = { type, columns, keep };
      if (keep === 'max' || keep === 'min') {
        const by = str(o.by);
        if (!by) return 'dedupe: keeping the max/min needs a column to rank by';
        step.by = by;
      }
      return step;
    }
    case 'replace_values': {
      const column = str(o.column);
      const mode = o.mode === 'contains' || o.mode === 'regex' ? o.mode : o.mode === 'exact' ? 'exact' : null;
      if (!column || !mode) return 'replace: needs a column and a mode';
      const rules: ReplaceRule[] = [];
      for (const r of Array.isArray(o.rules) ? o.rules.slice(0, MAX_RULES) : []) {
        const rr = (r || {}) as Raw;
        const from = asText(rr.from);
        const to = asText(rr.to);
        if (typeof from !== 'string') continue;
        if (mode === 'contains' && from === '') return 'replace: a "contains" rule needs text to find';
        if (mode === 'regex') {
          const chk = checkRegex(from);
          if (!chk.ok) return `replace: ${chk.error}`;
        }
        rules.push({ from, to: typeof to === 'string' ? to : '' });
      }
      if (!rules.length) return 'replace: no rules';
      const step: ReplaceValuesStep = { type, column, mode, rules };
      if (mode === 'regex' && o.ignoreCase === true) step.ignoreCase = true;
      return step;
    }
    case 'conditional_column': {
      const name = str(o.name);
      if (!name || !name.trim()) return 'conditional column: no name';
      const rules: ConditionalRule[] = [];
      for (const r of Array.isArray(o.rules) ? o.rules.slice(0, MAX_RULES) : []) {
        const rr = (r || {}) as Raw;
        const when = (rr.when || {}) as Raw;
        const column = str(when.column);
        if (!column || typeof when.op !== 'string' || !RULE_OPS.has(when.op)) return 'conditional column: a rule needs a column and a known operator';
        const then = asText(rr.then);
        const rule: ConditionalRule = { when: { column, op: when.op as RuleOp }, then: then === undefined ? null : then };
        if (typeof when.value === 'string' || (typeof when.value === 'number' && Number.isFinite(when.value))) rule.when.value = when.value;
        rules.push(rule);
      }
      if (!rules.length) return 'conditional column: no rules';
      const els = asText(o.else);
      return { type, name: name.trim(), rules, else: els === undefined ? null : els };
    }
    case 'union': {
      if (!isValidId(o.datasetId)) return 'union: no dataset';
      const mapping = (Array.isArray(o.mapping) ? o.mapping : [])
        .map((m) => (m || {}) as Raw)
        .filter((m) => str(m.from) !== undefined && str(m.to) !== undefined)
        .map((m) => ({ from: m.from as string, to: m.to as string }));
      const step: UnionStep = { type, datasetId: o.datasetId };
      if (mapping.length) step.mapping = mapping;
      return step;
    }
    case 'lookup_join': {
      if (!isValidId(o.datasetId)) return 'lookup: no dataset';
      const leftKey = str(o.leftKey);
      const rightKey = str(o.rightKey);
      if (!leftKey || !rightKey) return 'lookup: needs a key on each side';
      const columns = strList(o.columns);
      if (!columns.length) return 'lookup: no columns to bring across';
      const step: LookupJoinStep = { type, datasetId: o.datasetId, leftKey, rightKey, columns };
      const prefix = str(o.prefix);
      if (prefix) step.prefix = prefix;
      return step;
    }
    case 'window': {
      const as = str(o.as);
      if (typeof o.fn !== 'string' || !WINDOW_FNS.has(o.fn)) return 'window: unknown function';
      if (!as || !as.trim()) return 'window: no output column name';
      const fn = o.fn as WindowFn;
      const step: WindowStep = { type, fn, as: as.trim() };
      if (fn !== 'row_number') {
        const column = str(o.column);
        if (!column) return 'window: no value column';
        step.column = column;
      }
      if (fn === 'lag' || fn === 'lead') {
        const off = o.offset === undefined ? 1 : Math.floor(Number(o.offset));
        step.offset = Number.isFinite(off) ? Math.min(MAX_WINDOW_OFFSET, Math.max(1, off)) : 1;
      }
      const partitionBy = strList(o.partitionBy);
      if (partitionBy.length) step.partitionBy = partitionBy;
      const orderBy = str(o.orderBy);
      if (orderBy) step.orderBy = orderBy;
      if (o.desc === true) step.desc = true;
      return step;
    }
    default:
      return `unknown step type "${type}"`;
  }
}

export function sanitizePowerStep(o: Raw): PowerStep | null {
  const r = checkPowerStep(o);
  return typeof r === 'string' ? null : r;
}
