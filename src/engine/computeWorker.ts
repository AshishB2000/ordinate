// The compute worker — a worker_thread that runs a job's CPU and DuckDB work
// OFF the main thread. Started and fed by ./computePool.ts; never imported.
//
// WHY A SECOND THREAD AS WELL AS THE ASYNC BRIDGE. Since T4.2 every resident
// module runs on the async bridge, so its queries no longer park the main
// thread — but a big job's DECODING and maths (millions of cells, k-means, a
// regression) still would. Here that work runs on THIS thread. The module
// registry is per-thread, so on the desktop this thread gets its own DuckDB
// bridge (its own in-memory database; the Parquet files are the shared state).
// On the server (T4.3) each op instead arrives with a port to the CALLER'S org
// worker (src/engine/duckdbPool.ts) and every query goes there, under that
// org's directory lock — this thread never opens a DuckDB of its own.
// The same async code runs here unchanged; a worker thread is also exempt
// from `forbidSyncOnMainThread`, and is never reachable from a handler's
// require graph (scripts/test-asyncReach.ts).
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
import type { MessagePort } from 'worker_threads';
import { setRouter } from './duckdb';
import { DuckClient } from './duckdbClient';
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
  port.on('message', (msg: { id: number; op: string; args: unknown; duck?: { port: MessagePort; timeoutMs: number } }) => {
    const fn = OPS[msg && msg.op];
    // Server: this op's DuckDB is the caller's org worker, over the leased port
    // (computePool). One op per thread, so a module-level router is this op's.
    const line = msg && msg.duck;
    if (line) {
      const client = new DuckClient(line.port, line.timeoutMs);
      setRouter({ call: (kind, sql, params) => client.call(kind, sql, params), available: () => true });
    }
    const hangUp = (): void => {
      if (!line) return;
      setRouter(null);
      line.port.close();
    };
    const progress: Progress = (fraction, note) => port.postMessage({ id: msg.id, type: 'progress', fraction, note });
    if (!fn) {
      port.postMessage({ id: msg && msg.id, type: 'error', message: 'Unknown compute op' });
      hangUp();
      return;
    }
    fn(msg.args, progress).then(
      (result) => port.postMessage({ id: msg.id, type: 'done', result }),
      (err) => port.postMessage({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) }),
    ).finally(hangUp);
  });
}
