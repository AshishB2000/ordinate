// The live question, step by step — IR → probes → statement → shaped answer.
// docs/live-data/00-plan.md L2.2, for the executor of L2.3.
//
// PURE apart from the injected `run`: this file never opens a socket or a
// DuckDB. The executor passes a runner that adds what is not the compiler's
// business — the per-dataset cache, the budget, the connector's `runBound`, the
// abort signal — and gets back exactly the shape the resident layer returns.
// scripts/test-liveParity.ts passes a runner over the DuckDB bridge.
//
// At most two warehouse round trips, each small and each separately
// cacheable: a probe for the category key (bin edges, or a date axis's grain),
// then the chart. A text axis needs no probe — its 50-plus-"Other" fold is one
// statement. Every period is already a range in the IR (./liveSpec).

import type { DateGrain } from '../../analysis/categoryKey';
import type { LiveIR, LiveRefusal } from './liveSpec';
import { isRefusal, refuse } from './liveSpec';
import type { CompileEnv, CompiledQuery, LiveKey } from './compile';
import { compileBinRange, compileChart, compileGrainProbe, compileMetric } from './compile';
import type { LiveChart, LiveRows } from './shape';
import { readBinRange, readGrain, shapeChart, shapeMetric } from './shape';

export type LiveStep = 'latest' | 'binRange' | 'grain' | 'chart' | 'metric';

/** Runs one compiled statement; rows positional to `query.columns`. Throws on a warehouse error. */
export type LiveRunner = (query: CompiledQuery, step: LiveStep) => Promise<LiveRows>;

export type LiveOutcome =
  | { ok: true; kind: 'chart'; chart: LiveChart; warnings: string[] }
  | { ok: true; kind: 'metric'; value: number | null; warnings: string[] }
  | LiveRefusal;

/** The category key, asking the warehouse only when the extract would have looked at the data. */
async function resolveKey(ir: LiveIR, env: CompileEnv, run: LiveRunner): Promise<LiveKey | LiveRefusal> {
  const cat = ir.category;
  if (!cat) return refuse('badQuery');
  if (cat.kind === 'text') return { kind: 'text' };
  if (cat.kind === 'bins') {
    const q = compileBinRange(ir, env);
    if (!q.ok) return q;
    return readBinRange(await run(q.query, 'binRange'), q.query, cat.bins);
  }
  // A week calendar buckets in our code, from days — except the `day` grain,
  // which no calendar changes (categoryKey.dateBucket).
  if (ir.weekCal && cat.grain !== 'day') return { kind: 'days', grain: cat.grain, weekCal: ir.weekCal };
  if (cat.grain) return { kind: 'date', grain: cat.grain };
  const q = compileGrainProbe(ir, env);
  if (!q.ok) return q;
  const g: DateGrain | LiveRefusal = readGrain(await run(q.query, 'grain'), q.query);
  return isRefusal(g) ? g : { kind: 'date', grain: g };
}

/**
 * Answer one live question. Refusals come back as values; a warehouse error is
 * the runner's to throw (the executor serves the last cached answer, labelled
 * stale, or a typed error — never an empty result, D6).
 */
export async function evaluateLive(ir: LiveIR, env: CompileEnv, run: LiveRunner): Promise<LiveOutcome> {
  if (ir.kind === 'metric') {
    const mq = compileMetric(ir, env);
    if (!mq.ok) return mq;
    const value = shapeMetric(await run(mq.query, 'metric'), mq.query, ir);
    if (isRefusal(value)) return value;
    return { ok: true, kind: 'metric', value, warnings: [] };
  }

  const key = await resolveKey(ir, env, run);
  if (isRefusal(key)) return key;
  const cq = compileChart(ir, key, env);
  if (!cq.ok) return cq;
  const chart = shapeChart(await run(cq.query, 'chart'), cq.query, ir, key, env.columns);
  if (isRefusal(chart)) return chart;
  return { ok: true, kind: 'chart', chart, warnings: [] };
}
