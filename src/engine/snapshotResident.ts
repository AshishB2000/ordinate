// A snapshot per entity, kept in place (semantic layer part 5, D11) — the resident twin of
// analysis/snapshot.snapshotRows with `per`, held to it with Object.is (scripts/test-snapshotPer.ts).
//
// Part 1's snapshot keeps one day for the whole scope, which the doors express as a filter. "Each account's own last
// day" is a day per entity, so it needs a row-level step: the filtered rows that qualify are written to a temp table
// on the org's own worker with ONE parameterised statement, registered as a relation (residentQuery.withRelationAsync,
// the hook fx and joins use), and the UNCHANGED resident KPI and chart queries run over it. Dropped in `finally`.

import { randomUUID } from 'crypto';
import type { DateGrain } from '../analysis/categoryKey';
import type { MetricSnapshot } from '../analysis/snapshot';
import type { FilterStep } from '../data/transforms';
import * as duck from './duckdb';
import { filterPredicates, resolveCatKey, runOrderedAsync, withRelationAsync } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { dateBucketSql, phys, sqlCanonicalDate } from './residentCategory';
import { entityKeySql } from './cohortResident';

const NAME = /^snap_[0-9a-f]{32}$/;

/**
 * `run` over the rows `src` keeps under `filters` for `snap`: each entity's (and, with `bucket`, each entity's per
 * date bucket) rows on its latest (or earliest) day of `snap.column`, a row with no day dropped first, ties all kept.
 * The empty entities are one partition (SQL's NULL key). `run` reads the kept rows as `kept` with NO filters of its
 * own (they are applied here). Null when this cannot answer exactly — a snapshot date SQL cannot read (a non-canonical
 * shape), a column gone, a failed statement, or `run`'s own null — and the caller's JS reference answers.
 */
export async function withSnapshotRows<T>(
  src: ResidentSource,
  filters: FilterStep[],
  snap: MetricSnapshot & { per: string },
  bucket: DateGrain | null,
  run: (kept: ResidentSource) => Promise<T | null>,
): Promise<T | null> {
  const cols = src.columns;
  const di = cols.findIndex((c) => c.name === snap.column);
  const ei = cols.findIndex((c) => c.name === snap.per);
  if (di < 0 || ei < 0 || cols[di].type !== 'date') return null;
  // SQL reads the two canonical date shapes only; any other day under the filters is the JS reference's (Date.parse).
  if (!(await resolveCatKey(src, snap.column, [{ column: snap.column, aggregation: 'count' }], filters, 'day'))) return null;
  const name = `snap_${randomUUID().replace(/-/g, '')}`;
  if (!NAME.test(name)) return null;
  const day = sqlCanonicalDate(phys(di));
  const part = [entityKeySql(phys(ei), cols[ei].type === 'number'), ...(bucket ? [dateBucketSql(day, bucket)] : [])].join(', ');
  const params: duck.DuckValue[] = [];
  const where = [...filterPredicates(cols, filters, params), `${day} IS NOT NULL`].join(' AND ');
  const list = cols.map((_, i) => phys(i)).join(', ');
  const fn = snap.take === 'last' ? 'max' : 'min';
  try {
    await runOrderedAsync(src.parquetPath, (from, ord) =>
      `CREATE TEMP TABLE ${name} AS SELECT __o AS __ord, ${list} FROM (SELECT ${ord} AS __o, * FROM ${from} WHERE ${where}) ` +
      `QUALIFY ${day} = ${fn}(${day}) OVER (PARTITION BY ${part});`, params);
  } catch {
    return null; // nothing was created
  }
  try {
    return await withRelationAsync(name, name, () => run({ parquetPath: name, columns: cols }));
  } finally {
    await duck.execAsync(`DROP TABLE IF EXISTS ${name};`).catch(() => undefined); // a dying bridge takes its in-memory catalog with it
  }
}
