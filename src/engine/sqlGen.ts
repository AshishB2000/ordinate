// SQL generator for the prepare pipeline — MAIN PROCESS, PURE + SYNCHRONOUS.
//
// Translates a `TransformStep[]` (src/transforms.ts) into ONE DuckDB query over a
// physical relation whose columns are positional (`c0..cN`) plus a hidden
// monotonic `__ord BIGINT`. It executes nothing, opens nothing, and imports no
// DuckDB binding — it is a string builder, so it is testable by a plain node
// self-check (scripts/test-sqlGen.ts).
//
// Design (docs/phase-0/03-transforms.md §6-§7, measured against DuckDB 1.5.5 in
// docs/phase-0/06-duckdb-verification.md):
//
//   1. CTE CHAIN, regenerated from (schema, steps) on every call — `s0` is the
//      source, `sN` the relation after step N-1. Nothing is stored, so removing a
//      step is exactly "never having added it" (the reversibility invariant).
//   2. POSITIONAL PHYSICAL IDENTIFIERS. User-facing names live only in the
//      returned `columns` metadata. This removes identifier quoting, duplicate-name
//      ambiguity and column-name injection in one move, and makes `rename_column`
//      a pure metadata edit that emits NO SQL at all.
//   3. HIDDEN `__ord`, carried through every step (`min(__ord)` through an
//      aggregate, `ORDER BY __ord` at the OUTERMOST select only so intermediate
//      CTEs stay parallelisable). DuckDB group order is provably nondeterministic
//      across runs (06 §3); this is the only defence.
//   4. EVERY GUARD RUNS IN TS BEFORE ANY SQL IS EMITTED (unknown column, unknown
//      step type, blank/duplicate calculated-field name). A guard that fires emits
//      NO CTE for that step and pushes the warning verbatim from transforms.ts —
//      the chain simply continues from the previous CTE, reproducing today's
//      skip-with-warning behaviour exactly.
//   5. VALUES ARE BOUND PARAMETERS (`?`), never interpolated. Security boundary.
//   6. `sql: null` RATHER THAN A GUESS. `calculated_field` needs formula→SQL
//      (owned elsewhere) and the zero-column projection is a DuckDB parser error
//      (06 §4 G7) — both return null with `unsupported` set so the caller falls
//      back to the working JS fold in transforms.applyPipeline.
//
// Physical-storage contract assumed by this generator: every column is stored as
// VARCHAR holding `String(coerceValue(cell, column.type))` (the all-VARCHAR ingest
// of 06 §2), so `TRY_CAST(cN AS DOUBLE)` round-trips a `number` column exactly and
// a `007`/zip/long-id `text` column is never touched by a cast.

import type { ColumnType } from '../data/parse';
import { coerceValue } from '../data/parse';
import type { Aggregation, AggFn, Cell, TransformStep } from '../data/transforms';
import type { FilterOp } from '../data/filterOps';
import { FILTER_OPS, COMPARE_OPS, LIST_OPS, PERIOD_OP, emptyListWarning, periodSkipWarning } from '../data/filterOps';
import { resolvePeriodNow } from '../analysis/dateIntel';
import { sqlPeriodPredicate } from './periodSql';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface SqlColumn {
  physical: string; // c0/c1/... — the identifier that exists in the relation
  name: string; // the user-facing column name (transforms.ts `ParsedColumn.name`)
  type: ColumnType; // Ordinate's declared type; the relation itself is VARCHAR
}

export interface GenResult {
  // null => this pipeline cannot be faithfully expressed; the caller must use the
  // JS fold. `warnings` is then incomplete by construction (the fold re-derives
  // them) and should be ignored.
  sql: string | null;
  params: (string | number | null)[];
  columns: SqlColumn[]; // the virtual schema AFTER all steps
  warnings: string[]; // byte-identical to what transforms.ts would emit
  retypeColumns: string[]; // physical names whose type must be re-derived in TS
  unsupported?: string; // why sql is null
}

// The hidden ordinal. Never appears in `columns`; stripped at the outer SELECT.
export const ORD = '__ord';

// ── The emptiness predicate ──────────────────────────────────────────────────
//
// transforms.isEmptyCell = `cell == null || String(cell).trim() === ''`, i.e. JS
// whitespace. Neither DuckDB primitive covers that class (06 §1): `trim()` strips
// NBSP but NOT tab, while RE2's `\s` matches tab but NOT NBSP. So both the
// emptiness test and the `trim` step spell the class out explicitly. `\x{...}`
// escapes are verified to work in DuckDB's RE2.
//
//   space, \t(09), \n(0a), \v(0b), \f(0c), \r(0d), NBSP(a0), BOM(feff)
const WS = ' \\x{0009}\\x{000a}\\x{000b}\\x{000c}\\x{000d}\\x{00a0}\\x{feff}';
export const WS_CLASS = WS;

// Never NULL: `x IS NULL` short-circuits, and regexp_full_match over a non-null
// VARCHAR is always boolean — so `NOT sqlEmpty(x)` is a safe negation.
export function sqlEmpty(phys: string): string {
  return `(${phys} IS NULL OR regexp_full_match(CAST(${phys} AS VARCHAR), '[${WS}]*'))`;
}

// JS String.prototype.trim() equivalent. NULL in → NULL out (transforms only
// touches `typeof v === 'string'` cells, so a null is left alone).
export function sqlTrim(phys: string): string {
  return `regexp_replace(CAST(${phys} AS VARCHAR), '^[${WS}]+|[${WS}]+$', '', 'g')`;
}

// A finite JS number or NULL. transforms' aggregate/filter paths accept a cell
// only when `typeof v === 'number' && Number.isFinite(v)`, so `inf`/`nan` must
// degrade to NULL rather than sorting to the top of a max() (06 §4 D6).
function sqlNum(phys: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${phys} AS DOUBLE)) THEN TRY_CAST(${phys} AS DOUBLE) END`;
}

function sqlStr(phys: string): string {
  return `coalesce(CAST(${phys} AS VARCHAR), '')`;
}

// ── Small helpers mirroring transforms.ts ────────────────────────────────────

const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const SQL_OP: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };
const PHYS_RE = /^c\d+$/;

// The SAME first-match resolution transforms.colIndex uses.
function colIndex(cols: SqlColumn[], name: string): number {
  return cols.findIndex((c) => c.name === name);
}

function cellToString(cell: Cell | undefined): string {
  return cell == null ? '' : String(cell);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `in` / `not in` as ONE never-NULL boolean, so `NOT` is a safe negation.
 *
 * Three things this has to get right:
 *
 *  1. EVERY value is a bound `?`. A value list is untrusted renderer/AI input
 *     and is the one place in this generator where the operand count is
 *     attacker-influenced — interpolating it would be the injection hole the
 *     positional-identifier design exists to avoid everywhere else.
 *  2. CAST ON THE DECLARED TYPE. Only a `number` column is read through
 *     `sqlNum`; a `text`/`date` column stays VARCHAR, so `'007' in ('7')` is
 *     false rather than true.
 *  3. COALESCE, because SQL `IN` is three-valued: `NULL IN (1,2)` is NULL, so a
 *     bare `NOT (x IN …)` would DROP null rows instead of keeping them. The JS
 *     side defines `not in` as the exact complement of `in`, and a null cell is
 *     not in the list — so it must survive. Folding NULL to FALSE first makes
 *     `NOT` exact. (The text branch can't produce a NULL, since `sqlStr`
 *     coalesces and every param is stringified; it is wrapped anyway so both
 *     branches negate by the same rule.)
 *
 * Values are de-duplicated to mirror the JS `Set` and to bound the parameter
 * count — a list of 10,000 identical values binds one `?`, not 10,000.
 */
function sqlInPredicate(col: SqlColumn, values: Cell[], negate: boolean, params: (string | number | null)[]): string {
  let inner: string;
  if (col.type === 'number') {
    // The SAME strict gate as transforms (coerceValue → isFiniteNumber): an
    // entry that isn't a finite number can never equal a finite cell, so it is
    // dropped. All entries dropped → matches nothing, exactly as `= 'abc'` on a
    // number column keeps zero rows.
    const targets = new Set<number>();
    for (const v of values) {
      const n = coerceValue(v ?? null, 'number');
      if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
    }
    if (targets.size === 0) {
      inner = 'FALSE';
    } else {
      const holes: string[] = [];
      for (const n of targets) {
        holes.push('CAST(? AS DOUBLE)');
        params.push(n);
      }
      inner = `coalesce(${sqlNum(col.physical)} IN (${holes.join(', ')}), FALSE)`;
    }
  } else {
    const targets = new Set<string>(values.map((v) => cellToString(v)));
    const holes: string[] = [];
    for (const t of targets) {
      holes.push('CAST(? AS VARCHAR)');
      params.push(t);
    }
    inner = `coalesce(${sqlStr(col.physical)} IN (${holes.join(', ')}), FALSE)`;
  }
  return negate ? `NOT ${inner}` : inner;
}

// ── generateSql ──────────────────────────────────────────────────────────────

export function generateSql(relation: string, columns: SqlColumn[], steps: TransformStep[]): GenResult {
  let cols: SqlColumn[] = columns.map((c) => ({ ...c }));
  const warnings: string[] = [];
  const params: (string | number | null)[] = [];
  const retype: string[] = [];
  // Columns whose declared type is no longer knowable statically (a `fill_empty`
  // output is retyped from the DATA in TS). Any later step that branches on the
  // declared type of one of these is not faithfully expressible → sql: null.
  const retyped = new Set<string>();
  const ctes: string[] = [];

  const bail = (reason: string): GenResult => ({
    sql: null,
    params: [],
    columns: cols,
    warnings,
    retypeColumns: retype.slice(),
    unsupported: reason,
  });

  if (typeof relation !== 'string' || !relation) return bail('missing relation name');
  for (const c of cols) {
    if (!PHYS_RE.test(c.physical)) return bail(`invalid physical column identifier "${c.physical}"`);
  }

  // Physical-name allocator: strictly monotonic, never reuses a retired name.
  let nextPhys = 0;
  for (const c of cols) {
    const n = Number(c.physical.slice(1));
    if (n >= nextPhys) nextPhys = n + 1;
  }
  const newPhys = (): string => `c${nextPhys++}`;

  const projList = (list: SqlColumn[], override?: Map<string, string>): string => {
    const parts = [ORD];
    for (const c of list) {
      const ex = override && override.get(c.physical);
      parts.push(ex ? `${ex} AS ${c.physical}` : c.physical);
    }
    return parts.join(', ');
  };

  let cur = 's0';
  ctes.push(`s0 AS (SELECT ${projList(cols)} FROM ${quoteIdent(relation)})`);

  const list = Array.isArray(steps) ? steps : [];

  for (let i = 0; i < list.length; i += 1) {
    const step = list[i];
    const next = `s${i + 1}`;
    // The chain only advances when a step actually emits a CTE — a skipped step
    // leaves `cur` where it was (R-TRANS-17/18).
    const emit = (body: string): void => {
      ctes.push(`${next} AS (${body})`);
      cur = next;
    };

    if (!step || typeof step !== 'object' || typeof (step as { type?: unknown }).type !== 'string') {
      return bail('malformed step');
    }

    switch (step.type) {
      // ── calculated_field ──────────────────────────────────────────────────
      // Guards first (they are pure TS and reproduce exactly), then bail: the
      // formula→SQL mapping is a separate project.
      case 'calculated_field': {
        const name = typeof step.name === 'string' ? step.name.trim() : '';
        if (!name) {
          warnings.push('Calculated field skipped: blank column name');
          break;
        }
        if (colIndex(cols, name) >= 0) {
          warnings.push(`Calculated field skipped: column "${name}" already exists`);
          break;
        }
        return bail('calculated_field requires formula→SQL translation');
      }

      // ── filter ────────────────────────────────────────────────────────────
      case 'filter': {
        const ci = colIndex(cols, step.column);
        if (ci < 0) {
          warnings.push(`Filter skipped: unknown column "${step.column}"`);
          break;
        }
        if (!FILTER_OPS.has(step.op)) {
          warnings.push(`Filter skipped: unknown operator "${step.op}"`);
          break;
        }
        const col = cols[ci];
        const op: FilterOp = step.op;
        let where: string;

        if (op === 'is_empty') {
          where = sqlEmpty(col.physical);
        } else if (op === 'not_empty') {
          where = `NOT ${sqlEmpty(col.physical)}`;
        } else if (op === 'contains') {
          // Always string-based regardless of the column type. A null cell becomes
          // '' (so it can only match an empty needle) and an omitted value is an
          // empty needle that matches EVERY row — coalesce reproduces both.
          where = `contains(${sqlStr(col.physical)}, CAST(? AS VARCHAR))`;
          params.push(cellToString(step.value));
        } else if (op === PERIOD_OP) {
          if (retyped.has(col.physical)) {
            return bail(`filter on "${step.column}" needs a data-derived type (retyped by an earlier fill_empty)`);
          }
          const r = step.period ? resolvePeriodNow(step.period) : null;
          if (!r) {
            warnings.push(periodSkipWarning(step.column));
            break;
          }
          where = sqlPeriodPredicate(col.physical, r, params);
        } else if (LIST_OPS.has(op)) {
          if (retyped.has(col.physical)) {
            return bail(`filter on "${step.column}" needs a data-derived type (retyped by an earlier fill_empty)`);
          }
          const values = Array.isArray(step.values) ? step.values : [];
          if (values.length === 0) {
            // Skip with the SAME warning text the JS fold emits — the pipeline
            // differential test compares warning arrays, not just rows. No CTE,
            // so the chain continues from the previous one (R-TRANS-17/18).
            warnings.push(emptyListWarning(step.column, op));
            break;
          }
          where = sqlInPredicate(col, values, op === 'not in', params);
        } else if (COMPARE_OPS.has(op)) {
          if (retyped.has(col.physical)) {
            return bail(`filter on "${step.column}" needs a data-derived type (retyped by an earlier fill_empty)`);
          }
          if (col.type === 'number') {
            // The target goes through the SAME strict gate as transforms
            // (coerceValue → isFiniteNumber), so '007'/'1,200'/'abc' all become
            // null and the step keeps zero rows for EVERY operator, `!=` included.
            const t = coerceValue(step.value ?? null, 'number');
            const tn = typeof t === 'number' && Number.isFinite(t) ? t : null;
            if (tn === null) {
              where = 'FALSE';
            } else {
              // NULL <op> x is NULL in SQL → the row is dropped for every
              // operator, matching the `cn === null → false` branch exactly.
              where = `${sqlNum(col.physical)} ${SQL_OP[op]} CAST(? AS DOUBLE)`;
              params.push(tn);
            }
          } else {
            where = `${sqlStr(col.physical)} ${SQL_OP[op]} CAST(? AS VARCHAR)`;
            params.push(cellToString(step.value));
          }
        } else {
          where = 'FALSE';
        }

        emit(`SELECT ${projList(cols)} FROM ${cur} WHERE ${where}`);
        break;
      }

      // ── group_aggregate ───────────────────────────────────────────────────
      case 'group_aggregate': {
        const groupBy = Array.isArray(step.groupBy) ? step.groupBy : [];
        const aggregations: Aggregation[] = Array.isArray(step.aggregations) ? step.aggregations : [];
        const groupIdx = groupBy.map((n) => colIndex(cols, n));
        const missing = groupBy.filter((_, k) => groupIdx[k] < 0);
        if (missing.length > 0) {
          warnings.push(`Group/aggregate skipped: unknown group column(s): ${missing.join(', ')}`);
          break;
        }

        const outCols: SqlColumn[] = [];
        const select: string[] = [];
        const keys: string[] = [];

        for (const gi of groupIdx) {
          const src = cols[gi];
          // A fresh physical name per OUTPUT column: `groupBy: ['city','city']`
          // legitimately produces two columns, and reusing `c0` twice would make
          // every later reference ambiguous.
          const phys = newPhys();
          select.push(`${src.physical} AS ${phys}`);
          if (!keys.includes(src.physical)) keys.push(src.physical);
          outCols.push({ physical: phys, name: src.name, type: src.type });
          if (retyped.has(src.physical)) retyped.add(phys);
        }

        for (const agg of aggregations) {
          const phys = newPhys();
          const ci = colIndex(cols, agg.column);
          // Unknown aggregation fn falls back to `count` with NO warning —
          // transforms.aggregate:368 does exactly that (sanitizeSteps normally
          // blocks it, but direct callers can reach it).
          const fn: AggFn = AGG_FNS.has(agg.fn) ? agg.fn : 'count';
          let expr: string;
          if (ci < 0) {
            // transforms pushes this warning ONCE PER GROUP. See the divergence
            // note in the header of scripts/test-sqlGen.ts — emitted once here.
            warnings.push(`Aggregation "${agg.as}" references unknown column "${agg.column}"`);
            expr = 'CAST(NULL AS DOUBLE)';
          } else if (fn === 'count') {
            // NOT count(col): the step counts NON-EMPTY cells, and '' / '   ' are
            // empty to us but counted by SQL (06 §4 E8).
            expr = `CAST(count(*) FILTER (WHERE NOT ${sqlEmpty(cols[ci].physical)}) AS DOUBLE)`;
          } else if (retyped.has(cols[ci].physical)) {
            return bail(`aggregation over "${agg.column}" needs a data-derived type (retyped by an earlier fill_empty)`);
          } else if (cols[ci].type !== 'number') {
            // Gate on the DECLARED type: transforms only accepts runtime numbers,
            // so a text column aggregates to null. sum(VARCHAR) is a DuckDB binder
            // error (06 §1), so this both matches and avoids a hard failure.
            expr = 'CAST(NULL AS DOUBLE)';
          } else if (fn === 'avg') {
            // NOT bare avg(): DuckDB's avg and JS's sum-then-divide disagree in
            // the last ULPs. Measured on (0.1 … 0.7): avg(x) = 0.4, while both
            // JS and sum/count give 0.39999999999999997. The differential tests
            // use integer fixtures, so bare avg() passed while being wrong on
            // real decimal data. Emitting sum/count matches the JS fold's shape.
            const n = sqlNum(cols[ci].physical);
            expr = `CAST(sum(${n}) / nullif(count(${n}), 0) AS DOUBLE)`;
          } else {
            expr = `CAST(${fn}(${sqlNum(cols[ci].physical)}) AS DOUBLE)`;
          }
          // Always CAST(... AS DOUBLE): sum(INTEGER) is HUGEINT and would reach JS
          // as a BigInt (06 §4 D4).
          select.push(`${expr} AS ${phys}`);
          outCols.push({ physical: phys, name: agg.as, type: 'number' });
        }

        select.push(`min(${ORD}) AS ${ORD}`);

        let body = `SELECT ${select.join(', ')} FROM ${cur}`;
        if (keys.length > 0) {
          body += ` GROUP BY ${keys.join(', ')}`;
        } else {
          // A global aggregate emits one row of NULLs over an EMPTY input, but
          // transforms emits zero rows (`groups` is empty). HAVING count(*) > 0
          // reproduces that and is a no-op on non-empty input.
          body += ` HAVING count(*) > 0`;
        }
        emit(body);
        cols = outCols;
        break;
      }

      // ── dedupe ────────────────────────────────────────────────────────────
      case 'dedupe': {
        let keyPhys: string[];
        if (Array.isArray(step.columns) && step.columns.length > 0) {
          keyPhys = [];
          for (const name of step.columns) {
            const ci = colIndex(cols, name);
            if (ci < 0) warnings.push(`Dedupe: unknown column "${name}" ignored`);
            else keyPhys.push(cols[ci].physical);
          }
          if (keyPhys.length === 0) {
            warnings.push('Dedupe skipped: none of the given columns exist');
            break;
          }
        } else {
          keyPhys = cols.map((c) => c.physical);
        }
        if (keyPhys.length === 0) return bail('dedupe over a zero-column relation');
        // First-wins survivor (R-TRANS-12 pins the survivor's PAYLOAD, not just
        // the count). QUALIFY + row_number ORDER BY __ord is verified (06 §3 G2);
        // DISTINCT would pick an arbitrary row.
        emit(
          `SELECT ${projList(cols)} FROM ${cur} ` +
            `QUALIFY row_number() OVER (PARTITION BY ${keyPhys.join(', ')} ORDER BY ${ORD}) = 1`,
        );
        break;
      }

      // ── fill_empty ────────────────────────────────────────────────────────
      case 'fill_empty': {
        const ci = colIndex(cols, step.column);
        if (ci < 0) {
          warnings.push(`Fill empty skipped: unknown column "${step.column}"`);
          break;
        }
        const phys = cols[ci].physical;
        // transforms: `typeof value === 'number' ? value : String(value ?? '')`,
        // then retypeColumn stringifies every cell anyway — so stringify here and
        // let the TS retype pass produce the final type/values. That also keeps
        // the `fill with '' → null` quirk (coerceCell('') === null) intact.
        const fill = typeof step.value === 'number' ? String(step.value) : String(step.value ?? '');
        const override = new Map<string, string>();
        override.set(phys, `CASE WHEN ${sqlEmpty(phys)} THEN CAST(? AS VARCHAR) ELSE CAST(${phys} AS VARCHAR) END`);
        params.push(fill);
        emit(`SELECT ${projList(cols, override)} FROM ${cur}`);
        if (!retype.includes(phys)) retype.push(phys);
        retyped.add(phys);
        break;
      }

      // ── trim ──────────────────────────────────────────────────────────────
      case 'trim': {
        let targets: SqlColumn[];
        if (typeof step.column === 'string' && step.column) {
          const ci = colIndex(cols, step.column);
          if (ci < 0) {
            warnings.push(`Trim skipped: unknown column "${step.column}"`);
            break;
          }
          if (retyped.has(cols[ci].physical)) {
            return bail(`trim on "${step.column}" needs a data-derived type (retyped by an earlier fill_empty)`);
          }
          // A named NUMBER column is a no-op: transforms only rewrites cells where
          // `typeof v === 'string'`, and a number column holds JS numbers.
          targets = cols[ci].type === 'number' ? [] : [cols[ci]];
        } else {
          if (cols.some((c) => retyped.has(c.physical))) {
            return bail('trim (all columns) needs a data-derived type (retyped by an earlier fill_empty)');
          }
          // All-columns branch is text-only — `date` columns are NOT trimmed.
          targets = cols.filter((c) => c.type === 'text');
        }
        if (targets.length === 0) break; // no-op, no warning, no CTE
        const override = new Map<string, string>();
        for (const c of targets) override.set(c.physical, sqlTrim(c.physical));
        // Deliberately NO retype after trim (R-TRANS/T20): '  12  ' → '12' stays text.
        emit(`SELECT ${projList(cols, override)} FROM ${cur}`);
        break;
      }

      // ── drop_column ───────────────────────────────────────────────────────
      case 'drop_column': {
        const ci = colIndex(cols, step.column);
        if (ci < 0) {
          warnings.push(`Drop column skipped: unknown column "${step.column}"`);
          break;
        }
        cols = cols.filter((_, k) => k !== ci); // first match only
        emit(`SELECT ${projList(cols)} FROM ${cur}`);
        break;
      }

      // ── rename_column ─────────────────────────────────────────────────────
      // ZERO SQL: user-facing names live only in the metadata, so a rename (and
      // the duplicate names it is allowed to create) never touches the query.
      case 'rename_column': {
        const ci = colIndex(cols, step.from);
        if (ci < 0) {
          warnings.push(`Rename skipped: unknown column "${step.from}"`);
          break;
        }
        const to = typeof step.to === 'string' ? step.to.trim() : '';
        if (!to) {
          warnings.push(`Rename skipped: blank new name for "${step.from}"`);
          break;
        }
        cols = cols.map((c, k) => (k === ci ? { ...c, name: to } : c));
        break;
      }

      default:
        warnings.push(`Unknown step type "${(step as { type: string }).type}" skipped`);
        break;
    }
  }

  // A SELECT with an empty select list is a DuckDB PARSER error (06 §4 G7), and
  // transforms legitimately produces `{columns: [], rows: [[], ...]}`.
  if (cols.length === 0) return bail('zero output columns (empty select list is a DuckDB parser error)');

  const sql =
    `WITH ${ctes.join(',\n     ')}\n` +
    `SELECT ${cols.map((c) => c.physical).join(', ')} FROM ${cur} ORDER BY ${ORD}`;

  return { sql, params, columns: cols, warnings, retypeColumns: retype };
}
