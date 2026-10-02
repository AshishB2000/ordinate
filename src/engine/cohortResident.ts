'use strict';

// A cohort's (cohort, period) groups computed IN PLACE off the stored Parquet —
// the resident twin of `analysis/cohortData.buildCohort`'s grouping pass.
//
// It produces GROUPS, not a grid: `cohortData.foldCohort` turns them into
// percentages, running sums and averages on both paths, so the only thing this
// file can get wrong is the grouping, which scripts/test-cohort.ts compares
// `Object.is` against the JS path.
//
// The cohort itself is a WINDOW: `min(period) OVER (PARTITION BY entity)`.
// The layer's standing rules apply unchanged:
//   • Cast on the DECLARED type — a number entity keys on its DOUBLE, anything
//     else on its text; the value column is read only when it IS a number.
//   • Order is never assumed — the fold sorts groups itself, and the value sum
//     is `sum(v ORDER BY <file ordinal>)`, the JS left fold's exact order.
//   • Empty is null OR '' OR whitespace (`sqlEmpty`).
//   • Every aggregate is `CAST(… AS DOUBLE)`.
// A date is read by `periodSql.sqlPeriodDate`, `dateIntel.periodDay`'s pinned
// twin. Returns null on ANY failure; the caller falls back to the JS reference.

import type { FilterStep } from '../data/transforms';
import type { CalendarPrefs } from '../analysis/dateIntel';
import { getCalendar } from '../analysis/dateIntel';
import { unitOfGrain, weekCalOf } from '../analysis/retailCalendar';
import { weekOrdinalSql } from './weekCalSql';
import type { CohortEncoding, CohortGrain, CohortGrid, CohortGroups } from '../analysis/cohortData';
import { cohortNeeds, foldCohort } from '../analysis/cohortData';
import { sqlEmpty } from './sqlGen';
import { sqlPeriodDate } from './periodSql';
import { filterPredicates, runOrdered } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { phys, sqlNum } from './residentCategory';
import type * as duck from './duckdb';

/** `cohortData.periodOrdinal` in SQL, over a DATE column `dt`. Calendar values are sanitised integers. */
export function periodOrdinalSql(dt: string, grain: CohortGrain, cal: CalendarPrefs): string {
  const wc = weekCalOf(cal);
  if (wc) return weekOrdinalSql(dt, unitOfGrain(grain)!, wc);
  const ws = Math.trunc(cal.weekStart);
  const fy = Math.trunc(cal.fiscalYearStart);
  if (grain === 'week') {
    return `CAST(floor((date_diff('day', DATE '1970-01-01', ${dt}) + ${4 - ws}) / 7.0) AS INTEGER)`;
  }
  const month = `(year(${dt}) * 12 + month(${dt}) - 1)`;
  return grain === 'month' ? month : `CAST(floor((${month} - ${fy - 1}) / 3.0) AS INTEGER)`;
}

/** The entity key cast on its DECLARED type; NULL excludes the row, as `cohortData.entityKey` does. */
export function entityKeySql(p: string, isNumber: boolean): string {
  return isNumber ? sqlNum(p) : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE CAST(${p} AS VARCHAR) END`;
}

const num = (raw: duck.DuckValue): number => (typeof raw === 'number' ? raw : Number(raw));

/** The per-(cohort, k) groups, the last period and the excluded count — or null. */
export function cohortGroupsResident(
  src: ResidentSource,
  enc: CohortEncoding,
  filters?: FilterStep[],
  cal: CalendarPrefs = getCalendar(),
): CohortGroups | null {
  try {
    const cols = Array.isArray(src.columns) ? src.columns : [];
    if (cohortNeeds(cols, enc)) return null;
    const idx = (name: string): number => cols.findIndex((c) => c && c.name === name);
    const ei = idx(enc.entity);
    const di = idx(enc.date);
    const vi = enc.show === 'value' && enc.value ? idx(enc.value) : -1;
    const key = entityKeySql(phys(ei), cols[ei].type === 'number');
    const val = vi >= 0 ? sqlNum(phys(vi)) : 'CAST(NULL AS DOUBLE)';
    const period = periodOrdinalSql('dt', enc.grain, cal);

    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(cols, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    const withSql = (from: string, ord: string): string =>
      `WITH base AS (SELECT ${ord} AS o, ${key} AS e, ${sqlPeriodDate(phys(di))} AS dt, ${val} AS v ` +
      `FROM ${from}${where}), ` +
      `ev AS (SELECT o, e, v, ${period} AS p FROM base WHERE e IS NOT NULL AND dt IS NOT NULL), ` +
      `co AS (SELECT o, e, v, p, min(p) OVER (PARTITION BY e) AS c FROM ev) `;

    const cellRows = runOrdered(src.parquetPath, (from, ord) =>
      withSql(from, ord) +
      `SELECT CAST(c AS DOUBLE) AS c, CAST(p - c AS DOUBLE) AS k, CAST(count(DISTINCT e) AS DOUBLE) AS active, ` +
      `CAST(sum(v ORDER BY o) AS DOUBLE) AS val FROM co GROUP BY c, p - c;`, params);
    const meta = runOrdered(src.parquetPath, (from, ord) =>
      withSql(from, ord) +
      `SELECT CAST(count(*) AS DOUBLE) AS n, (SELECT CAST(count(*) AS DOUBLE) FROM ev) AS kept, ` +
      `(SELECT CAST(max(p) AS DOUBLE) FROM ev) AS last FROM base;`, params);

    const m = meta[0] || {};
    return {
      cells: cellRows.map((r) => ({
        c: num(r.c), k: num(r.k), active: num(r.active),
        value: r.val == null ? null : num(r.val),
      })),
      last: m.last == null ? null : num(m.last),
      excluded: num(m.n ?? 0) - num(m.kept ?? 0),
    };
  } catch {
    return null;
  }
}

/** The whole resident answer, folded — or null to run `cohortData.buildCohort`. */
export function cohortGridResident(
  src: ResidentSource,
  enc: CohortEncoding,
  filters?: FilterStep[],
  cal: CalendarPrefs = getCalendar(),
): CohortGrid | null {
  const groups = cohortGroupsResident(src, enc, filters, cal);
  return groups ? foldCohort(enc, groups, cal) : null;
}
