// The two lookups the live compiler builds that are not a chart (./compile.ts): the answers' case fix and the key
// check — PURE, as ./compile. Moved out of ./compile.ts (its size) unchanged but for the sink each makes itself (so the
// base-filter inventory, scripts/test-liveBaseCompile.ts, scans this file); ./compile re-exports both.

import type { LiveFilter, LiveIR } from './liveSpec';
import { columnOf, isRefusal, refuse } from './liveSpec';
import type { CompileEnv, Compiled } from './compile';
import { prepare, whereOf } from './compile';
import { keyText } from './compileFilter';
import { keyOf } from './profileSql';
import { ParamSink } from './sqlParams';

// ── The answers' case fix (L2.4) ─────────────────────────────────────────────

/**
 * How many stored spellings a case-fix lookup reads back PER ASKED VALUE (plan
 * L2.4's LIMIT 20): one value asked is `LIMIT 20`, and an `in` of 25 values is
 * never cut short at 20 — a value left unfixed would silently drop its category.
 */
export const CASE_FIX_LIMIT = 20;

/**
 * The stored spellings of asked text values — `answers.canonicaliseTextFilters`
 * as one statement: `SELECT DISTINCT col … WHERE key(col) IN (…)`, where
 * `key` is `trim().toLowerCase()` on both sides (the asked keys arrive keyed,
 * each a bound parameter). Over ALL rows, as the extract reads every row.
 * Ordered by the value so the LIMIT is deterministic: where two spellings share
 * a key ("West" and "WEST") the extract keeps the first SEEN and live the first
 * in the warehouse's order — a named divergence (docs/live-data/log.md, L2.4).
 * Bounded at CASE_FIX_LIMIT rows per distinct key.
 */
export function compileCaseMatches(column: string, keys: string[], env: CompileEnv, lock: LiveFilter[] = []): Compiled {
  // `lock`: a row access lock (row-policy D13) — the stored spellings come from the caller's rows only.
  const probe: LiveIR = { kind: 'chart', category: { column, kind: 'text' }, measures: [], filters: lock, order: 'natural', weekCal: null };
  const p = prepare(probe, env, new ParamSink());
  if (isRefusal(p)) return p;
  const col = columnOf(p.c.columns, column)!;
  if (col.type !== 'text') return refuse('categoryType', col.name);
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== 'string')) return refuse('badQuery');
  const c = p.c;
  // The GROUP key's text (L2.8's fold): an import stores '' as null, so '' is
  // never a stored spelling of a copy — nor, folded to NULL, of the warehouse.
  const v = keyText(c, col);
  const distinct = [...new Set(keys)];
  const asked = distinct.map((k) => c.b.bind('text', k)).join(', ');
  const locked = whereOf(p, probe);
  if (isRefusal(locked)) return locked;
  const sql = `SELECT DISTINCT ${c.d.label(v)} AS o_v FROM ${p.from} WHERE ${c.d.caseKey(v, c.b)} IN (${asked})${locked ? ` AND ${locked.slice(' WHERE '.length)}` : ''} ORDER BY o_v LIMIT ${CASE_FIX_LIMIT * distinct.length}`;
  return { ok: true, query: c.b.finish(sql, c.d, ['o_v']) };
}

// ── The key check (spec D2) ──────────────────────────────────────────────────

/**
 * The key check as one statement: a declared key's rows, empty rows and repeated keys —
 * `analysis/keyCheck.keyCheckJs` on the warehouse. The key is the profile's: NULL when empty
 * (`emptyOf`), else a number's finite value or the cell's text. The key is computed in a
 * derived table and grouped by its alias, because a bound value in the expression would not
 * match its twin in a `GROUP BY` (each marker becomes its own parameter). The three counts
 * are `SUM`s, NULL over no rows; `keyCheckFromRow` reads that as 0. `lock`: a row access lock (the Assistant's checked
 * link counts the caller's rows only, ipc/answerLink).
 */
export function compileKeyCheck(column: string, env: CompileEnv, lock: LiveFilter[] = []): Compiled {
  const probe: LiveIR = { kind: 'chart', category: { column, kind: 'text' }, measures: [], filters: lock, order: 'natural', weekCal: null };
  const p = prepare(probe, env, new ParamSink());
  if (isRefusal(p)) return p;
  const { c } = p;
  const col = columnOf(c.columns, column)!;
  // The dataset's base filters (D13): the key is counted over the rows the dataset holds, never more.
  const where = whereOf(p, probe);
  if (isRefusal(where)) return where;
  const sql =
    `SELECT ${c.d.toDouble('SUM(lv_n)')} AS k_rows, ` +
    `${c.d.toDouble('SUM(CASE WHEN lv_k IS NULL THEN lv_n ELSE 0 END)')} AS k_empty, ` +
    `${c.d.toDouble('SUM(CASE WHEN lv_k IS NOT NULL AND lv_n > 1 THEN 1 ELSE 0 END)')} AS k_repeated ` +
    `FROM (SELECT lv_k, COUNT(*) AS lv_n FROM (SELECT ${keyOf(c, col)} AS lv_k FROM ${p.from}${where}) lv_s GROUP BY lv_k) lv_g`;
  return { ok: true, query: c.b.finish(sql, c.d, ['k_rows', 'k_empty', 'k_repeated']) };
}
