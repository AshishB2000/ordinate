// The compute worker — a worker_thread that runs a job's CPU and DuckDB work
// OFF the main thread. Started and fed by ./computePool.ts; never imported.
//
// WHY A SECOND THREAD AND NOT THE ASYNC BRIDGE. The resident modules
// (anomaliesResident, insightsAgg, qualityResident) are written against the
// SYNCHRONOUS `duck.query()`, and on the main thread every one of those calls
// parks the event loop — all windows, the menu bar, the hotkey. Rewriting each
// module to `queryAsync` would fork them from their differential tests. Here
// the same synchronous code runs unchanged: `duck.query()` parks THIS thread
// instead, which is exactly what a background job is allowed to do. The module
// registry is per-thread, so this thread gets its own DuckDB bridge (its own
// in-memory database; the Parquet files are the shared state, read-only here).
//
// NOTHING HERE IMPORTS ELECTRON (a worker thread has no `app`): every op takes
// plain paths and records, and scripts/test-computeWorker.ts checks the import
// graph stays that way.
//
// Protocol (one op in flight per worker — computePool guarantees it):
//   in   { id, op, args }
//   out  { id, type: 'progress', fraction, note? } *
//        { id, type: 'done', result } | { id, type: 'error', message }

import { parentPort } from 'worker_threads';
import { detectAnomaliesResident } from './anomaliesResident';
import { detectInsights, fromAnomaly, residentAgg } from '../analysis/insights';
import type { Insight } from '../analysis/insights';
import { evaluateRulesResident } from './qualityResident';
import type { QualitySource } from './qualityResident';
import type { QualityRule } from '../analysis/qualityRules';
import { parseFile } from '../data/fileImport';
import type { FileSourceKind } from '../data/fileImport';
import type { ParsedColumn } from '../data/parse';
import { fitResident, rfmCustomersResident } from './segmentResident';
import type { RfmSpec } from '../analysis/rfm';
import { runStatsOnSource } from './statsJob';
import type { StatsRunArgs } from './statsJob';

type Progress = (fraction: number, note?: string) => void;

interface Src { parquetPath: string; columns: ParsedColumn[] }

/** Every op the worker knows. Each returns plain structured-cloneable data. */
const OPS: Record<string, (args: any, progress: Progress) => Promise<unknown>> = { // any: validated per op below
  /** One dataset's insights off its Parquet; null = the resident path declined. */
  async insights(args: { datasetId: string; src: Src }): Promise<Insight[] | null> {
    const anomalies = await detectAnomaliesResident(args.src);
    if (!anomalies) return null;
    return [
      ...(await detectInsights(args.datasetId, args.src.columns, residentAgg(args.src))),
      ...anomalies.map((a) => fromAnomaly(args.datasetId, a, args.src.columns)).filter((i): i is Insight => !!i),
    ];
  },

  /** Quality rules off Parquet; null = the resident path declined. */
  async quality(args: { src: QualitySource; rules: QualityRule[]; refs: Array<[string, QualitySource | null]> }) {
    return evaluateRulesResident(args.src, args.rules, new Map(args.refs));
  },

  /** Find segments off the Parquet (src/ipc/segments.ts); null = the resident path declined. */
  async segmentFit(args: { src: Src; features: string[] }, progress: Progress) {
    return fitResident(args.src, args.features, progress);
  },

  /** RFM's per-customer aggregates off the Parquet; null = the resident path declined. */
  async rfm(args: { src: Src; spec: RfmSpec }) {
    return rfmCustomersResident(args.src, args.spec);
  },

  /** Read and parse a data file (csv/json/xlsx) — the import's CPU half. */
  async parse(args: { filePath: string; kind: FileSourceKind; sheetName?: string }, progress: Progress) {
    progress(0.05, 'Reading the file');
    const out = await parseFile(args.filePath, args.kind, args.sheetName);
    progress(1, `${out.rowCount.toLocaleString('en-US')} rows read`);
    return out;
  },

  /** A statistics workbench run off Parquet (src/ipc/stats.ts); null = the resident read declined. */
  async stats(args: StatsRunArgs, progress: Progress) {
    progress(0.1, 'Reading the columns');
    return runStatsOnSource(args);
  },

  /** Test hook: burn CPU for `ms`, reporting progress — proves cancel and off-thread. */
  async spin(args: { ms: number }, progress: Progress) {
    const end = Date.now() + Math.max(0, Number(args.ms) || 0);
    let last = 0;
    while (Date.now() < end) {
      if (Date.now() - last > 20) {
        last = Date.now();
        progress(1 - (end - Date.now()) / Math.max(1, Number(args.ms) || 1));
      }
    }
    return 'spun';
  },
};

if (parentPort) {
  const port = parentPort;
  port.on('message', (msg: { id: number; op: string; args: unknown }) => {
    const fn = OPS[msg && msg.op];
    const progress: Progress = (fraction, note) => port.postMessage({ id: msg.id, type: 'progress', fraction, note });
    if (!fn) {
      port.postMessage({ id: msg && msg.id, type: 'error', message: 'Unknown compute op' });
      return;
    }
    fn(msg.args, progress).then(
      (result) => port.postMessage({ id: msg.id, type: 'done', result }),
      (err) => port.postMessage({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  });
}
