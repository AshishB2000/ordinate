// Find segments and RFM off the stored Parquet, IN PLACE — MAIN PROCESS or a
// compute worker (engine/computeWorker.ts runs it off the main thread).
//
// The resident twin of segmentModel.jsSegmentIo and rfm.rfmCustomersJs, held
// to them with Object.is by scripts/test-segmentsDuck.ts. Every method returns
// null on any failure and the caller falls back to the JS reference.
//
// Exactness is by construction, not by luck:
//   · numbers are read on the DECLARED type only (sqlNum on `number` columns);
//   · every sum is `sum(x ORDER BY <ordinal>)` — an ordered aggregate folds in
//     stored order, which is exactly the JS left fold (a bare parallel sum
//     differs in the last bits, and a model must not);
//   · every division and square root happens in JS, in the shared
//     finishStats / finishSummary;
//   · the sample keeps the rows the JS stride rule keeps, by the same integer
//     arithmetic, numbered over an explicit ordinal;
//   · rows are assigned by sqlGenSegment.segmentRelation — the Prepare step's
//     own SQL.

import { runOrdered } from './residentQuery';
import { sqlEmpty } from './sqlGen';
import { sqlNum } from './sqlGenPower';
import type { Param } from './sqlGenPower';
import { dbl, segmentRelation } from './sqlGenSegment';
import { sqlPeriodDate } from './periodSql';
import type { ParsedColumn } from '../data/parse';
import { featureIndexes } from '../data/stepsSegment';
import { finishStats, finishSummary, runFit } from '../analysis/segmentModel';
import type { FitResult, SegmentIo } from '../analysis/segmentModel';
import type { RfmCustomer, RfmCustomers, RfmSpec } from '../analysis/rfm';

export interface SegmentSource {
  parquetPath: string;
  columns: ParsedColumn[];
}

const phys = (i: number): string => `"c${i}"`;
const REL = '<<segment-rel>>'; // replaced by the ordinal FROM; never part of any value

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

/** The ordered relation of the features as x0…xn, only rows with all of them. */
function featureRows(idx: number[], from: string, ord: string): string {
  const xs = idx.map((ci, j) => `${sqlNum(phys(ci))} AS x${j}`).join(', ');
  const all = idx.map((_, j) => `x${j} IS NOT NULL`).join(' AND ');
  return `SELECT * FROM (SELECT ${xs}, ${ord} AS __o FROM ${from}) WHERE ${all}`;
}

export function residentSegmentIo(src: SegmentSource): SegmentIo {
  return {
    stats(idx) {
      try {
        const sums = idx.map((_, j) => `sum(x${j} ORDER BY __o) AS s${j}`).join(', ');
        const first = runOrdered(src.parquetPath, (from, ord) => `SELECT count(*) AS n, ${sums} FROM (${featureRows(idx, from, ord)});`, []);
        const n = num(first[0]?.n);
        if (!Number.isFinite(n)) return null;
        if (n === 0) return { count: 0, means: [], stds: [] };
        const s = idx.map((_, j) => num(first[0][`s${j}`]));
        const params: Param[] = [];
        const sq = idx.map((_, j) => {
          const m = s[j] / n;
          params.push(dbl(m), dbl(m));
          return `sum((x${j} - CAST(? AS DOUBLE)) * (x${j} - CAST(? AS DOUBLE)) ORDER BY __o) AS q${j}`;
        }).join(', ');
        const second = runOrdered(src.parquetPath, (from, ord) => `SELECT ${sq} FROM (${featureRows(idx, from, ord)});`, params);
        return finishStats(n, s, idx.map((_, j) => num(second[0][`q${j}`])));
      } catch {
        return null;
      }
    },

    sample(idx, n, cap) {
      try {
        const T = Math.floor(cap);
        const N = Math.floor(n);
        const keep = N <= T ? 'TRUE' : `(i * ${T}) // ${N} > ((i - 1) * ${T}) // ${N}`;
        const xs = idx.map((_, j) => `x${j}`).join(', ');
        const rows = runOrdered(src.parquetPath, (from, ord) =>
          `SELECT ${xs} FROM (SELECT ${xs}, row_number() OVER (ORDER BY __o) AS i FROM (${featureRows(idx, from, ord)})) ` +
          `WHERE ${keep} ORDER BY i;`, []);
        return rows.map((r) => idx.map((_, j) => num(r[`x${j}`])));
      } catch {
        return null;
      }
    },

    summary(step) {
      try {
        const idx = featureIndexes(src.columns, step);
        if (idx.some((i) => i < 0)) return null;
        const params: Param[] = [];
        const tpl = segmentRelation(REL, idx.map(phys), step, params);
        const xs = idx.map((ci, j) => `${sqlNum(phys(ci))} AS x${j}`).join(', ');
        const sums = idx.map((_, j) => `sum(x${j} ORDER BY __o) AS s${j}`).join(', ');
        const rows = runOrdered(src.parquetPath, (from, ord) =>
          `SELECT __sg AS g, count(*) AS n, ${sums} FROM (SELECT __sg, __o, ${xs} FROM (` +
          tpl.replace(REL, `(SELECT *, ${ord} AS __o FROM ${from})`) +
          ')) GROUP BY __sg;', params);
        const k = step.centroids.length;
        const sizes = new Array<number>(k).fill(0);
        const s = Array.from({ length: k }, () => new Array<number>(idx.length).fill(0));
        let empty = 0;
        for (const r of rows) {
          if (r.g === null || r.g === undefined) { empty = num(r.n); continue; }
          const g = num(r.g);
          sizes[g] = num(r.n);
          s[g] = idx.map((_, j) => num(r[`s${j}`]));
        }
        return finishSummary(sizes, empty, s);
      } catch {
        return null;
      }
    },
  };
}

/** The whole fit off the Parquet; null = fall back to the JS reference. */
export function fitResident(src: SegmentSource, features: string[], progress?: (f: number, note?: string) => void): FitResult | { error: string } | null {
  return runFit(src.columns, features, residentSegmentIo(src), progress);
}

/** rfm.rfmCustomersJs off the Parquet: one row per customer, first-seen order. */
export function rfmCustomersResident(src: SegmentSource, spec: RfmSpec): RfmCustomers | null {
  try {
    const at = (n: string): number => src.columns.findIndex((c) => c.name === n);
    const [ii, di, ai] = [at(spec.id), at(spec.date), at(spec.amount)];
    if (ii < 0 || di < 0 || ai < 0 || src.columns[ai].type !== 'number') return null;
    const day = `date_diff('day', DATE '1970-01-01', ${sqlPeriodDate(phys(di))})`;
    const rows = runOrdered(src.parquetPath, (from, ord) =>
      `SELECT k, max(d) AS last, count(*) AS fq, sum(a ORDER BY __o) AS mon, min(__o) AS first FROM (` +
      `SELECT CAST(${phys(ii)} AS VARCHAR) AS k, ${day} AS d, ${sqlNum(phys(ai))} AS a, ${ord} AS __o ` +
      `FROM ${from} WHERE NOT ${sqlEmpty(phys(ii))}) ` +
      'WHERE d IS NOT NULL AND a IS NOT NULL GROUP BY k ORDER BY first;', []);
    const total = runOrdered(src.parquetPath, (from) => `SELECT count(*) AS n FROM ${from};`, []);
    const customers: RfmCustomer[] = rows.map((r) => ({
      id: String(r.k),
      last: num(r.last),
      frequency: num(r.fq),
      monetary: num(r.mon),
    }));
    const used = customers.reduce((a, c) => a + c.frequency, 0);
    return { customers, used, skipped: num(total[0]?.n) - used };
  } catch {
    return null;
  }
}
