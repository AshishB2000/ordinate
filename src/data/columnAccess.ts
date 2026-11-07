// A dataset's column access rules (semantic layer part 4, D12–D16) — PURE.
// docs/semantic-layer/04-governance.md.
//
// A rule is an ALLOW-LIST: `{ column, visibleTo }` hides the column's values, and
// every figure computed from it, from every restricted caller it does not name.
// Names are not secret; values and figures are. The rules live RAW on the dataset
// record (`columnAccess`, beside `rowPolicy`) and are read where they are needed
// (./columnGate.ts), never through Dataset or DatasetMeta.
//
// FAIL CLOSED. A stored value that does not sanitize is 'closed' (every restricted
// caller is refused), never "no rules". The columns computed from a hidden one
// (carriers: a formula over it, a rename of it, a step writing columns it does not
// name) are found conservatively and hidden too; `readersHash` pins every step
// that reads a hidden column, so a changed one refuses until an admin saves again.

import { isValidId } from '../app/ids';
import { pipelineHash } from '../engine/queryCache';
import { compile } from '../formula/formula';
import { sanitizeLiveCalcs } from './liveCalcs';
import { MAX_COLUMN_CHARS, MAX_RULES, NON_WRITERS, UNNAMED_WRITERS, mentions } from './rowPolicy';
import { STEP_TYPES, applyPipeline, sanitizeSteps, type Cell, type TableData, type TransformStep } from './transforms';
import type { ParsedColumn } from './parse';

export type Member = { userId: string } | { teamId: string };
/** `from`: a carrier's hidden source column (server-set by `buildColumnAccess`). */
export interface ColumnRule { column: string; visibleTo: Member[]; from?: string }
export interface ColumnAccess { columns: ColumnRule[]; readersHash: string; updatedBy: string; updatedAt: string }

export const MAX_RULED_COLUMNS = 256;

// ── The stored rules ────────────────────────────────────────────────────────

function memberOf(m: unknown): Member | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const { userId, teamId, ...rest } = m as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (userId !== undefined && teamId === undefined && isValidId(userId)) return { userId: userId.toLowerCase() };
  if (teamId !== undefined && userId === undefined && isValidId(teamId)) return { teamId: teamId.toLowerCase() };
  return null;
}

function sanitizeAccess(a: unknown): ColumnAccess | null {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const { columns, readersHash, updatedBy, updatedAt } = a as Record<string, unknown>;
  if (!Array.isArray(columns) || columns.length > MAX_RULED_COLUMNS) return null;
  if (typeof readersHash !== 'string' || typeof updatedBy !== 'string' || typeof updatedAt !== 'string') return null;
  const out: ColumnRule[] = [];
  for (const c of columns as unknown[]) {
    if (!c || typeof c !== 'object') return null;
    const { column, visibleTo, from } = c as Record<string, unknown>;
    if (typeof column !== 'string' || !column.trim() || column.length > MAX_COLUMN_CHARS) return null;
    if (!Array.isArray(visibleTo) || visibleTo.length > MAX_RULES) return null;
    const members = visibleTo.map(memberOf);
    if (members.some((m) => !m)) return null;
    if (from !== undefined && (typeof from !== 'string' || !from)) return null;
    out.push(from === undefined ? { column, visibleTo: members as Member[] } : { column, visibleTo: members as Member[], from });
  }
  return { columns: out, readersHash, updatedBy, updatedAt };
}

/** The rules a stored record carries: null when it has none (no key), 'closed' when they do not sanitize (null included). */
export function columnAccessFromRecord(raw: unknown): ColumnAccess | 'closed' | null {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'columnAccess')) return null;
  const a = (raw as { columnAccess?: unknown }).columnAccess;
  if (a === undefined) return null;
  return sanitizeAccess(a) ?? 'closed';
}

/** The ruled columns a caller is not named on (by user or by one of their teams). */
export function hiddenFor(access: ColumnAccess, userId: string | null, teamIds: readonly string[]): Set<string> {
  const user = userId ? userId.toLowerCase() : null;
  const teams = new Set(teamIds.map((t) => t.toLowerCase()));
  const out = new Set<string>();
  for (const r of access.columns) {
    if (!r.visibleTo.some((m) => ('userId' in m ? m.userId === user : teams.has(m.teamId)))) out.add(r.column);
  }
  return out;
}

/** Every ruled column: what the least-entitled audience (a fan-out) is hidden from. */
export function everyRuled(access: ColumnAccess): Set<string> {
  return new Set(access.columns.map((r) => r.column));
}

// ── Carriers ────────────────────────────────────────────────────────────────

/** The column names a step's formulas refer to; an expression that does not compile names every hidden name it contains. */
function formulaReads(v: unknown, hidden: ReadonlySet<string>, out: Set<string>): Set<string> {
  if (Array.isArray(v)) for (const x of v) formulaReads(x, hidden, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k !== 'expression' || typeof x !== 'string') { formulaReads(x, hidden, out); continue; }
      const c = compile(x);
      if (c.ok) for (const r of c.fn.refs) out.add(r);
      else for (const h of hidden) if (mentionsHidden(x, new Set([h]))) out.add(h);
    }
  }
  return out;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/**
 * The columns computed from a hidden one (D14), conservatively, and the steps that read one.
 * - A `rename_column` onto a hidden name hides its `from` too: the same values under an earlier name.
 * - Then each step, with the column lists before and after it (an empty fold, so names only):
 *   an unknown step sets `unknown`; `filter`/`dedupe`/`dedupe_key` naming a hidden column are readers;
 *   a step writing columns it does not name (UNNAMED_WRITERS) is a reader, and every column new after it
 *   (or in `finalColumns` and not before it) its carrier; any other step naming a hidden column, or
 *   referring to one in a formula, is a reader, and every column after it that it names or makes, its carrier.
 * A carrier's `from` is the first hidden source it read; `roots` lists them all. Carriers count as hidden after.
 */
export function carriersOf(steps: readonly TransformStep[], sourceColumns: readonly string[], finalColumns: readonly string[], hidden: readonly string[]):
  { carriers: Map<string, string>; roots: Map<string, string[]>; readers: TransformStep[]; unknown: boolean } {
  const H = new Set(hidden);
  const rootOf = new Map<string, string[]>(hidden.map((h) => [h, [h]]));
  const known = steps.map((s) => (s && STEP_TYPES.has((s as { type?: unknown }).type as string) ? sanitizeSteps([s])[0] ?? null : null));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of known) {
      if (s && s.type === 'rename_column' && H.has(s.to) && !H.has(s.from)) {
        H.add(s.from);
        rootOf.set(s.from, rootOf.get(s.to) ?? [s.to]);
        grew = true;
      }
    }
  }
  const carriers = new Map<string, string>();
  const roots = new Map<string, string[]>();
  const readers: TransformStep[] = [];
  let unknown = false;
  let table: TableData = { columns: sourceColumns.map((name) => ({ name, type: 'text' })), rows: [] };
  for (const s of known) {
    if (!s) { if (H.size) unknown = true; continue; }
    const before = new Set(table.columns.map((c) => c.name));
    try {
      const r = applyPipeline(table, [s]);
      table = { columns: r.columns, rows: r.rows };
    } catch {
      unknown = true;
      continue;
    }
    const after = table.columns.map((c) => c.name);
    const isNew = (c: string): boolean => !before.has(c);
    let read: string[];
    let made: string[] = [];
    if (NON_WRITERS.has(s.type)) {
      const all = s.type === 'dedupe' && !(s.columns && s.columns.length); // which rows survive depends on every column
      read = [...H].filter((h) => mentions(s, h) || (all && before.has(h)));
    } else if (UNNAMED_WRITERS.has(s.type)) {
      read = H.size ? [...H] : [];
      made = uniq([...after.filter(isNew), ...finalColumns.filter(isNew)]);
    } else {
      const refs = formulaReads(s, H, new Set());
      read = [...H].filter((h) => mentions(s, h) || refs.has(h));
      made = after.filter((c) => isNew(c) || mentions(s, c));
    }
    if (!read.length) continue;
    readers.push(s);
    const from = uniq(read.flatMap((h) => rootOf.get(h) ?? [h]));
    for (const c of made) {
      if (H.has(c)) continue;
      H.add(c);
      rootOf.set(c, from);
      carriers.set(c, from[0]);
      roots.set(c, from);
    }
  }
  return { carriers, roots, readers, unknown };
}

const namesOf = (cols: unknown): string[] =>
  (Array.isArray(cols) ? cols : []).flatMap((c) => (c && typeof (c as { name?: unknown }).name === 'string' ? [(c as { name: string }).name] : []));

/** What a record's figures are computed through: its Prepare steps, then a Live record's base filters and calculated fields. Unreadable is an unknown step. */
function shapeOf(raw: Record<string, unknown>): { steps: TransformStep[]; source: string[]; final: string[] } {
  const UNREADABLE = { type: '\u0000unreadable' } as unknown as TransformStep;
  const list = (v: unknown): TransformStep[] => (v === undefined || v === null ? [] : Array.isArray(v) ? (v as TransformStep[]) : [UNREADABLE]);
  const calcs = sanitizeLiveCalcs(raw.calculated);
  const calcsRead = raw.calculated === undefined || (Array.isArray(raw.calculated) && calcs.length === raw.calculated.length);
  const steps = [
    ...list(raw.steps), ...list(raw.baseFilters),
    ...calcs.map((c) => ({ type: 'calculated_field', name: c.name, expression: c.expression }) as TransformStep),
    ...(calcsRead ? [] : [UNREADABLE]),
  ];
  const final = namesOf(raw.columns);
  const src = raw.source && typeof raw.source === 'object' ? (raw.source as { columns?: unknown }).columns : undefined;
  return { steps, source: Array.isArray(src) ? namesOf(src) : final, final };
}

/** Intersect allow-lists: a carrier of several hidden columns is visible to the members every one of them names. */
function intersect(lists: Member[][]): Member[] {
  const key = (m: Member): string => ('userId' in m ? `u:${m.userId}` : `t:${m.teamId}`);
  const [first = [], ...rest] = lists;
  return first.filter((m) => rest.every((l) => l.some((x) => key(x) === key(m))));
}

/** The rules to store: the admin's, plus a rule per carrier (visible to whom all its sources are), and the readers' hash. */
export function buildColumnAccess(raw: Record<string, unknown>, rules: Array<{ column: string; visibleTo: Member[] }>, by: string, at: string): ColumnAccess {
  const { steps, source, final } = shapeOf(raw);
  const columns: ColumnRule[] = rules.map((r) => ({ column: r.column, visibleTo: r.visibleTo.map((m) => memberOf(m)).filter((m): m is Member => !!m) }));
  const ruled = new Map(columns.map((r) => [r.column, r.visibleTo]));
  const res = carriersOf(steps, source, final, columns.map((r) => r.column));
  for (const [c, from] of res.roots) {
    if (!ruled.has(c)) columns.push({ column: c, visibleTo: intersect(from.map((f) => ruled.get(f) ?? [])), from: from[0] });
  }
  return { columns, readersHash: pipelineHash(res.readers), updatedBy: by, updatedAt: at };
}

/**
 * An admin's rule on a column computed from another ruled one that names someone its sources do not: a carrier
 * typed WIDER would hand out what the source hides (D14). The first such rule and its source, or null. Narrower
 * is kept as typed: hiding more is safe.
 */
export function widerCarrier(raw: Record<string, unknown>, rules: ReadonlyArray<{ column: string; visibleTo: Member[] }>): { column: string; from: string } | null {
  const { steps, source, final } = shapeOf(raw);
  if (!steps.length) return null;
  const key = (m: Member): string => ('userId' in m ? `u:${m.userId}` : `t:${m.teamId}`);
  const ruled = new Map(rules.map((r) => [r.column, r.visibleTo]));
  for (const r of rules) {
    const from = carriersOf(steps, source, final, rules.filter((x) => x.column !== r.column).map((x) => x.column)).roots.get(r.column);
    if (!from) continue;
    const allowed = new Set(intersect(from.map((f) => ruled.get(f) ?? [])).map(key));
    if (r.visibleTo.some((m) => !allowed.has(key(m)))) return { column: r.column, from: from[0] };
  }
  return null;
}

/** Do the rules hold on the record as it is now? `gone`: a rule column it no longer has; `pipeline`: a reader changed, an unknown step, or a carrier no rule names. */
export type AccessState = 'ok' | 'pipeline' | 'gone';

export function accessState(raw: Record<string, unknown>, access: ColumnAccess): AccessState {
  const { steps, source, final } = shapeOf(raw);
  const live = raw.mode === 'live' && raw.live && typeof raw.live === 'object' ? (raw.live as { missingColumns?: unknown }).missingColumns : undefined;
  const missing = new Set(Array.isArray(live) ? live : []);
  const own = access.columns.filter((r) => r.from === undefined).map((r) => r.column);
  const has = new Set(final);
  if (own.some((c) => !has.has(c) || missing.has(c))) return 'gone';
  const res = carriersOf(steps, source, final, own);
  if (res.unknown || pipelineHash(res.readers) !== access.readersHash) return 'pipeline';
  const ruled = everyRuled(access);
  return [...res.carriers.keys()].every((c) => ruled.has(c)) ? 'ok' : 'pipeline';
}

// ── The question, and the row readers ───────────────────────────────────────

const WORD = /[\p{L}\p{N}_]/u;

/** Does `s` (lowercased) contain `n` (lowercased) bounded by characters that are not letters, digits or `_`? */
function bounded(s: string, n: string): boolean {
  for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + 1)) {
    if (!WORD.test(i > 0 ? s[i - 1] : '') && !WORD.test(s[i + n.length] ?? '')) return true;
  }
  return false;
}

/**
 * Does any string in the question name a hidden column? Conservative (a false match refuses, never leaks): a
 * string equal to it, or containing it bounded by non-word characters, case-insensitive — `sum(salary)`,
 * `[Salary]`, `{FIXED dept: sum(salary)}`. Object keys are field names, not columns, and are not read.
 */
export function mentionsHidden(question: unknown, hidden: ReadonlySet<string>): boolean {
  if (!hidden.size) return false;
  const names = [...hidden].map((h) => h.toLowerCase()).filter((h) => h.length > 0);
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') { const s = v.toLowerCase(); return names.some((n) => bounded(s, n)); }
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(walk);
    return false;
  };
  return walk(question);
}

/** Hidden cells as null IN PLACE: the row keeps its length, so any grid stays aligned. The same rows when nothing is hidden. */
export function nullHidden(rows: Cell[][], columns: readonly { name: string }[], hidden: ReadonlySet<string>): Cell[][] {
  const at = columns.flatMap((c, i) => (hidden.has(c.name) ? [i] : []));
  if (!at.length) return rows;
  return rows.map((r) => {
    const out = r.slice();
    for (const i of at) if (i < out.length) out[i] = null;
    return out;
  });
}

/** A table without the hidden columns and their cells (a reader that must not see them at all). The same table when nothing is hidden. */
export function withoutColumns<T extends { columns: ParsedColumn[]; rows: Cell[][] }>(t: T, hidden: ReadonlySet<string>): T {
  const keep = t.columns.flatMap((c, i) => (hidden.has(c.name) ? [] : [i]));
  if (keep.length === t.columns.length) return t;
  return { ...t, columns: keep.map((i) => t.columns[i]), rows: t.rows.map((r) => keep.map((i) => r[i])) };
}

/** Column entries with `hidden: true` on the hidden ones (MARK: names are not secret). The same entries when nothing is hidden. */
export function markHidden<T extends { name: string }>(cols: T[], hidden: ReadonlySet<string>): Array<T & { hidden?: true }> {
  return hidden.size ? cols.map((c) => (hidden.has(c.name) ? { ...c, hidden: true as const } : c)) : cols;
}
