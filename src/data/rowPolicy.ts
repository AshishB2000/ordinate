// A dataset's row access rules: their shape, their sanitizer, who is entitled
// to which values, and the steps that write the rule column — PURE.
// docs/row-policy/00-design.md D2, D5, D18.
//
// The rules live on the dataset RECORD (`rowPolicy`, no migration) and are read
// raw where they are needed (./rowAccess.ts, the admin channels): never part of
// the in-memory Dataset or DatasetMeta, so no reply that spreads a record can
// carry another person's entitlement.
//
// FAIL CLOSED. A stored `rowPolicy` that does not sanitize is not "no rules": it
// becomes CLOSED_POLICY, which names no column — every restricted reader is
// refused (`column`) until an admin saves valid rules.

import { isValidId } from '../app/ids';
import { paramRefs } from '../analysis/params';
import { pipelineHash } from '../engine/queryCache';
import type { TransformStep } from './transforms';
import { sanitizeSteps } from './transforms';
import { stepsUseParams } from '../analysis/params';
import { storesCrossRow } from './rowLock';

export interface RowRule {
  readonly userId?: string;
  readonly teamId?: string;
  /** The rule column's values this member may see, matched exactly. Never empty. */
  readonly values: readonly string[];
}

export interface RowPolicy {
  /** A declared text column of the dataset. '' only in CLOSED_POLICY. */
  readonly column: string;
  readonly rules: readonly RowRule[];
  /** `writersHash(steps, column)` when an admin saved the rules (D18). */
  readonly stepsHash: string;
}

export const MAX_RULES = 500;
export const MAX_VALUES = 1000;
export const MAX_VALUE_CHARS = 1000;
export const MAX_COLUMN_CHARS = 256;

/** What a corrupt stored policy reads as: it names no column, so it refuses every restricted reader. */
export const CLOSED_POLICY: RowPolicy = Object.freeze({ column: '', rules: Object.freeze([]), stepsHash: '' });

export type RuleInput = { userId?: unknown; teamId?: unknown; values?: unknown };

/** Why rules from a request cannot be stored — a field path, never a value. */
export type PolicyProblem = 'column' | 'rules' | 'member' | 'values' | 'value';

/**
 * Rules from an admin's request, checked strictly: a problem names the field and
 * nothing is stored. Blank values are dropped first (a blank `=` would match
 * every empty cell); a rule left with none is a problem, never an empty `in`.
 */
export function parseRules(column: unknown, rules: unknown): { ok: true; column: string; rules: RowRule[] } | { ok: false; problem: PolicyProblem } {
  if (typeof column !== 'string' || column.trim() === '' || column.length > MAX_COLUMN_CHARS) return { ok: false, problem: 'column' };
  if (!Array.isArray(rules) || rules.length > MAX_RULES) return { ok: false, problem: 'rules' };
  const out: RowRule[] = [];
  for (const raw of rules as RuleInput[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, problem: 'rules' };
    const user = isValidId(raw.userId) ? raw.userId.toLowerCase() : null;
    const team = isValidId(raw.teamId) ? raw.teamId.toLowerCase() : null;
    if ((user === null) === (team === null)) return { ok: false, problem: 'member' }; // exactly one
    if (!Array.isArray(raw.values) || raw.values.length > MAX_VALUES) return { ok: false, problem: 'values' };
    const values: string[] = [];
    for (const v of raw.values) {
      if (typeof v !== 'string' || v.length > MAX_VALUE_CHARS || paramRefs(v).length > 0) return { ok: false, problem: 'value' };
      if (v.trim() !== '' && !values.includes(v)) values.push(v);
    }
    if (!values.length) return { ok: false, problem: 'values' };
    out.push(user ? { userId: user, values } : { teamId: team as string, values });
  }
  return { ok: true, column, rules: out };
}

/**
 * The policy a stored record carries: null when it has none (the key is absent),
 * CLOSED_POLICY when it has one that does not sanitize — never "none" for a
 * policy that is merely broken.
 */
export function policyFromRecord(raw: unknown): RowPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as { rowPolicy?: unknown };
  if (!Object.prototype.hasOwnProperty.call(rec, 'rowPolicy') || rec.rowPolicy === undefined || rec.rowPolicy === null) return null;
  const p = rec.rowPolicy as { column?: unknown; rules?: unknown; stepsHash?: unknown };
  if (typeof p !== 'object') return CLOSED_POLICY;
  const parsed = parseRules(p.column, p.rules);
  if (!parsed.ok || typeof p.stepsHash !== 'string') return CLOSED_POLICY;
  return { column: parsed.column, rules: parsed.rules, stepsHash: p.stepsHash };
}

/**
 * What a caller may see under `policy` (D5): 'all' when there is no policy, the
 * de-duplicated union of every rule naming the user or one of their teams (in
 * rule order), or 'none'.
 */
export function entitlement(policy: RowPolicy | null, userId: string | null, teamIds: readonly string[]): 'all' | string[] | 'none' {
  if (!policy) return 'all';
  const user = userId ? userId.toLowerCase() : null;
  const teams = new Set(teamIds.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const r of policy.rules) {
    const mine = (r.userId !== undefined && r.userId === user) || (r.teamId !== undefined && teams.has(r.teamId));
    if (!mine) continue;
    for (const v of r.values) if (v.trim() !== '' && !out.includes(v)) out.push(v);
  }
  return out.length ? out : 'none';
}

/** Steps that may READ the rule column but never write it. */
const NON_WRITERS: ReadonlySet<string> = new Set(['filter', 'dedupe', 'dedupe_key']);
/** Steps that can write columns they do not name (`<col>_1`, a union's rows, a pivot's headers, a lookup's columns). */
const UNNAMED_WRITERS: ReadonlySet<string> = new Set(['union', 'unpivot', 'pivot', 'split_column', 'lookup_join', 'text_terms', 'spatial_join', 'group_aggregate']);

function mentions(v: unknown, column: string): boolean {
  if (v === column) return true;
  if (Array.isArray(v)) return v.some((x) => mentions(x, column));
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => mentions(x, column));
  return false;
}

/**
 * The prepare steps that can WRITE `column` (D18), conservatively: every step
 * that names it (a calculated or conditional column, a find-and-replace, a fill,
 * a mask, a rename onto or off it, a drop), every step that writes columns it
 * does not name, a `trim` of all text columns — anything but a step that only
 * reads it to keep or drop rows.
 */
export function columnWriters(steps: readonly TransformStep[] | undefined, column: string): TransformStep[] {
  return (Array.isArray(steps) ? steps : []).filter((step) => {
    const s = step as unknown as Record<string, unknown>;
    const t = s && typeof s.type === 'string' ? s.type : '';
    if (NON_WRITERS.has(t)) return false;
    if (UNNAMED_WRITERS.has(t)) return true;
    if (t === 'trim' && (s.column === undefined || s.column === null || s.column === '')) return true;
    return mentions(s, column);
  });
}

/** The hash an admin's save pins: a later change to any writer of the column refuses until they save again. */
export function writersHash(steps: readonly TransformStep[] | undefined, column: string): string {
  return pipelineHash(columnWriters(steps, column));
}

/** Why saved rules do not hold on a record as it is now — what refuses a viewer, and what the tab warns of — or 'ok'. */
export type RuleState = 'ok' | 'column' | 'pipeline' | 'writers';

type Col = { name?: unknown; type?: unknown };
/** Is `column` a declared text column of the raw record? */
export function textColumn(raw: Record<string, unknown>, column: string): boolean {
  return (Array.isArray(raw.columns) ? (raw.columns as Col[]) : []).some((c) => !!c && c.name === column && c.type === 'text');
}

/**
 * Do the stored rules hold (D6, D16, D18)? `column`: the rule column is missing, not text, or gone
 * from the warehouse; `pipeline`: the steps or the origin store a cross-row value, or the steps read a
 * dashboard parameter; `writers`: a step that writes the rule column changed since the rules were saved.
 */
export function ruleState(raw: Record<string, unknown>, policy: RowPolicy): RuleState {
  const live = raw.mode === 'live' ? (raw.live as { missingColumns?: unknown } | undefined) : undefined;
  const missing = live && Array.isArray(live.missingColumns) ? (live.missingColumns as unknown[]) : [];
  if (!policy.column || !textColumn(raw, policy.column) || missing.includes(policy.column)) return 'column';
  const steps = sanitizeSteps(raw.steps);
  const origin = raw.origin && typeof raw.origin === 'object' ? (raw.origin as { kind?: unknown }) : null;
  if (storesCrossRow(steps, [policy.column], origin) || stepsUseParams(steps)) return 'pipeline';
  return writersHash(steps, policy.column) === policy.stepsHash ? 'ok' : 'writers';
}
