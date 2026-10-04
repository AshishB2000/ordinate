// What an input table's cells MEAN, and what is wrong with them — MAIN, pure.
//
// The grid sends what was typed; this decides what is stored. Three layers,
// each reusing an existing definition rather than restating it:
//
//   TYPE      `coerceInput` — parse.ts's own strict rules (`isFiniteNumber`,
//             `looksLikeDate`): `007`, a zip or a 16-digit id is NOT a number,
//             exactly as it would not be on import.
//   COLUMN    `required`, and a lookup's membership — evaluated as the
//             `references` data-quality rule it is (qualityRules.failingPredicateJs
//             over ./lookup.ts's RefTable), so a lookup and a references rule can
//             never disagree about the same value.
//   RULES     the dataset's own quality rules (#176), through the same
//             evaluator the Quality tab's counts come from.
//
// THE STORAGE RULE. A value the column's TYPE refuses is stored as NULL — the
// Parquet never holds text in a number column — and the text itself is kept in
// the record's overlay (./columns.ts) so the grid shows it, flagged, until it is
// fixed. Every other finding (required, lookup, rules) is about a value that IS
// storable, so the value is stored as typed and flagged. Nothing here ever
// blocks a save: an invalid cell never costs the user the valid ones around it.
//
// Quality rules name columns of the dataset's OUTPUT; the grid edits its base.
// A rule whose column is not in the base (a calculated field, a renamed
// column) is skipped here and still runs on the output after every save.

import type { ColumnType } from '../parse';
import { isFiniteNumber, looksLikeDate } from '../parse';
import type { Cell } from './edits';
import type { InputBlock, InputColumn } from './columns';
import { failingPredicateJs, rowCountResult, ruleSignature } from '../../analysis/qualityRules';
import type { QualityRule, RefTable } from '../../analysis/qualityRules';
import type { RegexMemo } from '../regexMemo';

export type IssueKind = 'type' | 'required' | 'lookup' | 'rule';

export interface Issue {
  r: number;
  c: number;
  kind: IssueKind;
  severity: 'fail' | 'warn';
  message: string;
  /** Set on a quality-rule finding, so the grid can word the rule its own way. */
  ruleId?: string;
}

export interface Checked {
  /** What the Parquet gets: every cell of its column's type, or null. */
  stored: Cell[][];
  /** The typed text the types refused, positionally. */
  block: InputBlock | undefined;
  /** Capped at MAX_ISSUES; the counts below are not. */
  issues: Issue[];
  /** Findings about the table rather than a cell (row count, a lookup that cannot run). */
  notes: string[];
  /** Distinct cells with a finding, by severity. */
  failCells: number;
  warnCells: number;
}

export interface CheckContext {
  /** Column index → its lookup's RefTable (null when that dataset is gone). */
  lookups: Map<number, RefTable | null>;
  /** Display names of lookup datasets, for the message. */
  lookupNames: Map<string, string>;
  rules: QualityRule[];
  /** A references rule's dataset id → its RefTable. */
  refs: Map<string, RefTable | null>;
  /** Server: a regex rule's id → the regex worker's answers, or why it could not run (src/data/regexOffThread.ts). */
  regexMemos?: Map<string, RegexMemo | string>;
}

const MAX_ISSUES = 5000;
/** A fixed id for the transient references rule a lookup is checked as. */
const LOOKUP_RULE_ID = '00000000-0000-4000-8000-000000000000';

/** Why parse.ts's strict rule refused a number, in the words that fix it. */
function numberReason(t: string): string {
  const digitsOnly = /^[+-]?[\d.]+$/.test(t);
  if (digitsOnly && /^[+-]?0\d/.test(t)) return 'Leading zeros would be lost as a number — make this a text column to keep them';
  if (digitsOnly && t.replace(/[^\d]/g, '').length > 15) return 'More than 15 digits cannot be stored exactly as a number — use a text column';
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return 'Remove the thousands separators — 1200, not 1,200';
  if (/^[+-]?[$€£¥]|[$€£¥%]$/.test(t)) return 'Type the number without a currency sign or %';
  return 'Not a number';
}

/**
 * One typed value against its column's type. `error` means the type refuses it
 * and `value` is then null. Empty (null, '' or whitespace) is always a valid
 * null. A date keeps the text as typed, trimmed — lossless, like an import.
 */
export function coerceInput(v: Cell, type: ColumnType): { value: Cell; error?: string } {
  if (v === null || v === undefined) return { value: null };
  if (type === 'number') {
    if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { value: null, error: 'Not a number' };
    const t = String(v).trim();
    if (!t) return { value: null };
    return isFiniteNumber(t) ? { value: Number(t) } : { value: null, error: numberReason(t) };
  }
  const s = String(v);
  if (s.trim() === '') return { value: null };
  if (type === 'date') {
    const t = s.trim();
    return looksLikeDate(t) ? { value: t } : { value: null, error: 'Not a date — type it like 2026-03-31' };
  }
  return { value: s };
}

/**
 * The grid's view of a table: each cell as it will be stored, or — where the
 * type refuses it — the text as typed. Two tables that normalise equal are the
 * same save, which is what keeps "12" and 12 from reading as an edit.
 */
export function normalizeRows(columns: InputColumn[], rows: Cell[][]): Cell[][] {
  return rows.map((row) => columns.map((col, c) => {
    const v = Array.isArray(row) ? row[c] ?? null : null;
    const res = coerceInput(v, col.type);
    return res.error ? String(v) : res.value;
  }));
}

/** Coerce, then check every column rule, lookup and quality rule. */
export function checkTable(columns: InputColumn[], rows: Cell[][], ctx: CheckContext): Checked {
  const width = columns.length;
  const stored: Cell[][] = [];
  const invalid: Array<[number, number, string]> = [];
  const issues: Issue[] = [];
  const notes: string[] = [];
  const fail = new Set<number>();
  const warn = new Set<number>();
  const add = (i: Issue): void => {
    (i.severity === 'fail' ? fail : warn).add(i.r * width + i.c);
    if (issues.length < MAX_ISSUES) issues.push(i);
  };

  rows.forEach((row, r) => {
    const out: Cell[] = new Array(width);
    for (let c = 0; c < width; c++) {
      const v = Array.isArray(row) ? row[c] ?? null : null;
      const res = coerceInput(v, columns[c].type);
      out[c] = res.value;
      if (res.error) {
        invalid.push([r, c, String(v)]);
        add({ r, c, kind: 'type', severity: 'fail', message: res.error });
      }
    }
    stored.push(out);
  });
  const typeBad = new Set(invalid.map(([r, c]) => r * width + c));

  columns.forEach((col, c) => {
    if (!col.required) return;
    stored.forEach((row, r) => {
      if (row[c] === null && !typeBad.has(r * width + c)) {
        add({ r, c, kind: 'required', severity: 'fail', message: `${col.name} is required` });
      }
    });
  });

  columns.forEach((col, c) => {
    if (!col.lookup) return;
    const rule: QualityRule = {
      id: LOOKUP_RULE_ID, kind: 'references', column: col.name,
      args: { datasetId: col.lookup.datasetId, column: col.lookup.column }, severity: 'fail',
    };
    const p = failingPredicateJs(rule, columns, stored, ctx.lookups.get(c) ?? null);
    if ('error' in p) { notes.push(`Lookup ${col.name}: ${p.error}`); return; }
    const where = `${ctx.lookupNames.get(col.lookup.datasetId) || 'the lookup dataset'} · ${col.lookup.column}`;
    stored.forEach((row, r) => {
      if (p.test(row)) add({ r, c, kind: 'lookup', severity: 'fail', message: `Not a value of ${where}` });
    });
  });

  for (const rule of ctx.rules) {
    if (rule.kind === 'row_count') {
      if (!rowCountResult(rule, stored.length).passed) notes.push(`Row count is outside the rule ${ruleSignature(rule)}`);
      continue;
    }
    const c = columns.findIndex((x) => x.name === rule.column);
    if (c < 0) continue;
    const ref = rule.kind === 'references' ? ctx.refs.get(rule.args.datasetId ?? '') ?? null : undefined;
    const memo = ctx.regexMemos?.get(rule.id);
    const p = typeof memo === 'string' ? { error: memo } : failingPredicateJs(rule, columns, stored, ref, memo);
    if ('error' in p) { notes.push(`Rule ${ruleSignature(rule)} cannot run: ${p.error}`); continue; }
    stored.forEach((row, r) => {
      if (p.test(row)) add({ r, c, kind: 'rule', severity: rule.severity, message: ruleSignature(rule), ruleId: rule.id });
    });
  }

  return {
    stored,
    block: invalid.length ? { invalid } : undefined,
    issues,
    notes,
    failCells: fail.size,
    warnCells: [...warn].filter((k) => !fail.has(k)).length,
  };
}
