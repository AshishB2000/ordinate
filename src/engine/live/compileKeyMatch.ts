// A link's full-table key counts across two Live datasets on ONE connection (the Assistant's Approve, ipc/linkLive) —
// PURE, as ./compile: builds one statement, queries nothing.
//
// `joinResident.keyStatsResident` in ONE warehouse statement: FROM's rows, those whose key TO holds, FROM's distinct
// and keyed keys, TO's distinct and keyed keys. Each side is read over its own base filters and the caller's lock
// (`prepare` + `whereOf`, as every statement), and both bind into ONE sink, so the markers are numbered in text order
// across the two sources. The key is `profileSql.keyOf` (NULL when empty), as the key check counts it. TO's keys are
// read twice (the IN list and its own counts): a fragment twice in the text is two parameters (./sqlParams).
//
// No LEFT JOIN: ClickHouse fills an unmatched row with defaults, not NULL, so a match is `IN (…)` over TO's non-NULL keys.

import type { KeyStats } from '../../analysis/joinJs';
import type { LiveColumn, LiveFilter, LiveIR } from './liveSpec';
import { columnOf, isRefusal, refuse } from './liveSpec';
import type { CompileEnv, Compiled } from './compile';
import { prepare, whereOf } from './compile';
import { ParamSink } from './sqlParams';
import { keyOf } from './profileSql';

/** One end of the link: its key column, its dataset's environment, and the caller's lock there as filters. */
export interface KeySide {
  column: string;
  env: CompileEnv;
  lock: LiveFilter[];
}

/** The statement's outputs, in SELECT order (rows are read positionally by `keyStatsFromRow`). */
export const KEY_MATCH_COLUMNS = ['k_rows', 'k_matched', 'k_fkeys', 'k_fkeyed', 'k_tkeys', 'k_tkeyed'];

export function compileKeyMatch(from: KeySide, to: KeySide): Compiled {
  if (from.env.dialect !== to.env.dialect) return refuse('badQuery'); // one statement is one warehouse's
  const b = new ParamSink();
  const read = (s: KeySide) => {
    const probe: LiveIR = { kind: 'chart', category: { column: s.column, kind: 'text' }, measures: [], filters: s.lock, order: 'natural', weekCal: null };
    const p = prepare(probe, s.env, b);
    if (isRefusal(p)) return p;
    const where = whereOf(p, probe);
    return isRefusal(where) ? where : { p, where, col: columnOf(p.c.columns, s.column)! };
  };
  const f = read(from);
  if (isRefusal(f)) return f;
  const t = read(to);
  if (isRefusal(t)) return t;
  // Declared types that differ (the card says "Types differ"): each side's keys are counted as its own type, and MATCHED
  // (`lv_m`) as numbers when one is (text that is no number matches nothing), else as text. shortcut: a text key spelled
  // as a non-canonical number ('1.0', '01') matches here and not in a copy (joinJs.keyOf compares String(n)); upgrade
  // if a mixed-type link is ever approved on Live.
  const kind = f.col.type === t.col.type ? null : f.col.type === 'number' || t.col.type === 'number' ? 'number' : 'text';
  const as = (col: LiveColumn): LiveColumn => (!kind || col.type === kind ? col : { ...col, type: kind, sourceType: 'VARCHAR' });
  const m = kind ? 'lv_m' : 'lv_k';
  const keys = (s: NonNullable<typeof f>): string =>
    `SELECT ${keyOf(s.p.c, s.col)} AS lv_k${kind ? `, ${keyOf(s.p.c, as(s.col))} AS lv_m` : ''} FROM ${s.p.from}${s.where}`;
  const d = f.p.c.d;
  const sql =
    'SELECT lv_a.k_rows, lv_a.k_matched, lv_a.k_fkeys, lv_a.k_fkeyed, lv_b.k_tkeys, lv_b.k_tkeyed FROM ' +
    `(SELECT ${d.toDouble('COUNT(*)')} AS k_rows, ` +
    `${d.toDouble(`SUM(CASE WHEN ${m} IN (SELECT ${m} FROM (${keys(t)}) lv_t WHERE ${m} IS NOT NULL) THEN 1 ELSE 0 END)`)} AS k_matched, ` +
    `${d.toDouble(d.countDistinct('lv_k'))} AS k_fkeys, ${d.toDouble('COUNT(lv_k)')} AS k_fkeyed FROM (${keys(f)}) lv_f) lv_a ` +
    `CROSS JOIN (SELECT ${d.toDouble(d.countDistinct('lv_k'))} AS k_tkeys, ${d.toDouble('COUNT(lv_k)')} AS k_tkeyed FROM (${keys(t)}) lv_t) lv_b`;
  return { ok: true, query: b.finish(sql, d, KEY_MATCH_COLUMNS) };
}

/** The statement's one row as KeyStats; an aggregate over no rows (SQL NULL) reads 0; anything not a whole count is null (a failure). */
export function keyStatsFromRow(row: readonly unknown[] | undefined): KeyStats | null {
  if (!row || row.length < KEY_MATCH_COLUMNS.length) return null;
  const n = row.slice(0, KEY_MATCH_COLUMNS.length).map((v) => (v === null ? 0 : typeof v === 'number' ? v : NaN));
  if (!n.every((v) => Number.isInteger(v) && v >= 0) || n[1] > n[0]) return null;
  const [rows, matched, fromKeys, fromKeyed, toKeys, toKeyed] = n;
  return { matched, unmatchedFrom: rows - matched, fromKeys, fromKeyed, toKeys, toKeyed };
}
