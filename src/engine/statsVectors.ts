// The statistics workbench's vectors, read IN PLACE off the stored Parquet —
// MAIN PROCESS or the compute worker, on the ASYNC bridge (never the sync call:
// a panel click must not park every window).
//
// The maths runs once, in TypeScript, on vectors (src/analysis/stats). What
// goes resident is LOADING them: one SELECT of just the columns a spec needs,
// cast on the DECLARED type only (`sqlNum` for a number column, never a
// TRY_CAST on text — '007' stays a label), empty = NULL or '' or whitespace
// via the shared `sqlEmpty` class, the dashboard filters through
// `residentQuery.filterPredicates` (the one filter compiler), and rows in FILE
// order through `file_row_number` — a bare scan's order is not a contract.
//
// Reproduces analysis/stats/vectorsJs.loadVectorsJs exactly over the same
// file (scripts/test-statsVectors.ts, Object.is per cell). Returns null on any
// failure; the caller then hydrates and runs the reference.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { VectorNeed } from '../analysis/stats/spec';
import type { StatsVectors } from '../analysis/stats/run';
import { relationSql } from './parquetStore';
import { filterPredicates } from './residentQuery';
import { bomSafe, phys, sqlNum } from './residentCategory';
import { sqlEmpty } from './sqlGen';
import * as duck from './duckdb';

export interface VectorSource {
  parquetPath: string;
  /** The record's ParsedColumn[], positionally aligned to the file. */
  columns: ParsedColumn[];
}

export async function loadVectorsResident(src: VectorSource, needs: readonly VectorNeed[], filters: FilterStep[] = []): Promise<StatsVectors | null> {
  try {
    if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns) || !needs.length) return null;
    const proj: string[] = [];
    const kinds: Array<{ need: VectorNeed; num: boolean }> = [];
    for (const [i, need] of needs.entries()) {
      const ci = src.columns.findIndex((c) => c && c.name === need.column);
      if (ci < 0) return null;
      const num = src.columns[ci].type === 'number';
      if (need.as === 'number' && !num) return null; // the gate: never read text as a number
      const p = phys(ci);
      proj.push(num ? `${sqlNum(p)} AS v${i}` : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${bomSafe(p)} END AS v${i}`);
      kinds.push({ need, num });
    }
    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(src.columns, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    const rel = relationSql(src.parquetPath, { fileRowNumber: true });
    const rows = await duck.queryAsync(`SELECT ${proj.join(', ')} FROM ${rel}${where} ORDER BY file_row_number;`, params);
    const out: StatsVectors = { rows: rows.length, number: new Map(), label: new Map() };
    kinds.forEach(({ need, num }, i) => {
      const key = `v${i}`;
      if (need.as === 'number') {
        out.number.set(need.column, rows.map((r) => {
          const raw = r[key];
          const n = typeof raw === 'number' ? raw : raw == null ? null : Number(raw);
          return n !== null && Number.isFinite(n) ? n : null;
        }));
        return;
      }
      out.label.set(need.column, rows.map((r) => {
        const raw = r[key];
        if (raw == null) return null;
        if (!num) return typeof raw === 'string' ? raw : String(raw);
        const n = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(n) ? String(n) : null;
      }));
    });
    return out;
  } catch {
    // Bridge down, missing file, width mismatch — one answer: fall back.
    return null;
  }
}
