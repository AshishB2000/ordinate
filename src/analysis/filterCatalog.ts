// TYPED FILTERS — what a dashboard can be filtered BY, read off its datasets.
// MAIN PROCESS, no Electron: the IPC (src/ipc/filterParse.ts) feeds it, the
// self-check (scripts/test-filterParse.ts) drives it directly.
//
// One dataset → its text columns with their distinct values (first-seen order,
// capped at datasetPage.MAX_DISTINCT), its number columns with their observed
// max (which is what tells "20%" apart as 0.2 or 20, see filterParse.ts), and
// its date columns. Two builds, the house pair:
//   catalogResident — off the stored Parquet (readDistinctPage +
//                     computeMetricResident), no row hydrated; null = fall back
//   catalogJs       — the reference, over hydrated rows (distinctValuesPageJs +
//                     computeMetric)
// Both are already differential-tested one call at a time; the self-check
// compares the two whole catalogs on the bundled sample with Object.is.

import { readDistinctPage, distinctValuesPageJs, MAX_DISTINCT } from '../engine/datasetPage';
import type { PageSource } from '../engine/datasetPage';
import { computeMetricResident } from '../engine/residentQuery';
import { computeMetric } from './metricValue';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import type { FilterCatalog } from './filterParse';

function shape(
  columns: ParsedColumn[],
  datasetId: string,
  distinct: (column: string) => string[] | null,
  max: (column: string) => number | null,
): FilterCatalog | null {
  const out: FilterCatalog = { dimensions: [], measures: [], dates: [] };
  for (const c of columns) {
    if (c.type === 'text') {
      const values = distinct(c.name);
      if (values === null) return null;
      out.dimensions.push({ column: c.name, datasetId, type: 'text', values });
    } else if (c.type === 'number') {
      out.measures.push({ column: c.name, type: 'number', max: max(c.name) });
    } else if (c.type === 'date') {
      out.dates.push(c.name);
    }
  }
  return out;
}

/** Off the Parquet. Null when any distinct read fails — the caller then builds the JS one. */
export function catalogResident(src: PageSource, datasetId: string): FilterCatalog | null {
  return shape(
    src.columns,
    datasetId,
    (column) => {
      const r = readDistinctPage(src, column, { limit: MAX_DISTINCT });
      return r ? r.values : null;
    },
    // A resident null is "no numeric cells" OR "failed"; either way the %
    // rule then takes the number as typed, the same as the JS path's null.
    (column) => computeMetricResident(src, { column, aggregation: 'max' }),
  );
}

/** The reference, over hydrated rows. Never null. */
export function catalogJs(columns: ParsedColumn[], rows: Cell[][], datasetId: string): FilterCatalog {
  return shape(
    columns,
    datasetId,
    (column) => distinctValuesPageJs(columns, rows, column, { limit: MAX_DISTINCT, search: '' }).values,
    (column) => computeMetric(columns, rows, { column, aggregation: 'max' }),
  ) as FilterCatalog;
}

/**
 * Several datasets → one catalog. A filter names its column, not its dataset,
 * and applies to every card whose dataset has it, so a column two datasets
 * share is ONE dimension with the union of their values (first-seen order,
 * still capped). Dataset order, then column order, is the dimension order.
 */
export function mergeCatalogs(parts: FilterCatalog[]): FilterCatalog {
  const out: FilterCatalog = { dimensions: [], measures: [], dates: [] };
  for (const p of parts) {
    for (const d of p.dimensions) {
      const have = out.dimensions.find((x) => x.column === d.column);
      if (!have) { out.dimensions.push({ ...d, values: d.values.slice() }); continue; }
      for (const v of d.values) if (have.values.length < MAX_DISTINCT && !have.values.includes(v)) have.values.push(v);
    }
    for (const m of p.measures) {
      const have = out.measures.find((x) => x.column === m.column);
      if (!have) out.measures.push({ ...m });
      else if (typeof m.max === 'number' && (typeof have.max !== 'number' || m.max > have.max)) have.max = m.max;
    }
    for (const d of p.dates) if (!out.dates.includes(d)) out.dates.push(d);
  }
  return out;
}
