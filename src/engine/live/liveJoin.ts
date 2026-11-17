// The env a Live chart across saved relationships compiles under (./compileJoin) — MAIN PROCESS, records only: no
// warehouse call. docs/live-data/00-plan.md L4.
//
// ipc/liveJoin plans the chart (analysis/joinPlan `resolveVizJoin`, the copy's planner) and takes the caller's row lock
// on each related table (`withLockOf`); the executor (./liveQuery `liveJoinedVizData`) resolves every table's target
// and asks here for the sides: each related one under its lock and the range its table requires (`lookupRequired`, as
// a lookup takes it: inside its own scan), the primary as its own questions are (its range comes from the question,
// `withRequiredRange`, in the executor). Every side must be a Live table on the primary's connection.

import type { FilterStep } from '../../data/transforms';
import type { VizEncoding } from '../../analysis/visuals';
import type { LiveTarget } from './liveTarget';
import type { CompileEnv } from './compile';
import type { JoinSide, LiveJoin } from './compileJoin';
import type { LiveColumn, LiveRefusal } from './liveSpec';
import { adaptFilters, refuse } from './liveSpec';
import { encodingNames, missingRefusal } from './liveMissing';
import { lookupRequired } from './liveDateRange';

/** A chart across links, as ipc/liveJoin plans it: every table, the merged layout, the question over merged names. */
export interface LiveJoinRequest {
  /** [0] is the primary; each other one with the hop that adds it and the caller's row lock on it. */
  tables: { datasetId: string; via?: { parent: number; from: string; to: string }; lock: FilterStep[] }[];
  /** Merged column i → its table and its own name (analysis/joinPlan `mergedLayout`). */
  columns: { name: string; table: number; column: string }[];
  /** The question over MERGED names, every dataset reference gone (`VizJoin.encoding`, `.filters`). */
  encoding: VizEncoding;
  filters: FilterStep[];
  /** A KPI across links (ipc/liveJoin `liveMetricJoinOf`): its measure over a MERGED name; the encoding is then empty. */
  metric?: { column: string; aggregation: string };
}

/** The joined env and the related sides' range sentences, or why it cannot be asked. `ts[i]` is `req.tables[i]`'s target. */
export function joinedEnv(ts: LiveTarget[], req: LiveJoinRequest): { ok: true; env: CompileEnv & { join: LiveJoin }; notes: string[] } | LiveRefusal {
  const t0 = ts[0];
  const at = new Map(req.columns.map((c) => [c.name, c]));
  const named = [...encodingNames(req.encoding, req.filters), ...(req.metric ? [req.metric.column] : [])].flatMap((n) => (at.has(n) ? [at.get(n)!] : []));
  const sides: JoinSide[] = [];
  const notes: string[] = [];
  for (let i = 0; i < req.tables.length; i++) {
    const t = ts[i];
    const tb = req.tables[i];
    if (!t || t.semantic) return refuse('related'); // a semantic layer returns totals, never rows to join
    if (t.connectionId !== t0.connectionId || t.dialect !== t0.dialect) return refuse('badQuery'); // one statement is one warehouse's
    const keys = [...(tb.via ? [tb.via.to] : []), ...req.tables.flatMap((k) => (k.via && k.via.parent === i ? [k.via.from] : []))];
    // A column the warehouse dropped (L2.5) is said as exactly that, on whichever side it was read.
    const gone = missingRefusal(t.live.missingColumns, [...named.filter((c) => c.table === i).map((c) => c.column), ...keys]);
    if (gone) return gone;
    if (!tb.via) {
      sides.push({ env: t.env, filters: [] });
      continue;
    }
    const lock = adaptFilters(tb.lock, t.columns, {}); // a lock step never skips (liveSpec adaptFilter)
    if (!lock.ok) return lock;
    const r = lookupRequired(t, lock.filters);
    if (!r.ok) return r;
    notes.push(...r.notes);
    sides.push({ env: r.env, filters: r.filters, via: tb.via });
  }
  // Each merged column as its own table declares it, its warehouse type kept (the readers' safe casts need it).
  const columns: LiveColumn[] = req.columns.map((c) => {
    const own = ts[c.table]?.columns.find((x) => x.name === c.column);
    return own ? { ...own, name: c.name } : { name: c.name, type: 'text' };
  });
  return { ok: true, env: { dialect: t0.dialect, source: t0.source, columns, join: { sides, columns: req.columns.map(({ table, column }) => ({ table, column })) } }, notes };
}
