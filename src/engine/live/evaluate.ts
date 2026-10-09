// The live question, step by step — IR → probes → statement → shaped answer.
// docs/live-data/00-plan.md L2.2, for the executor of L2.3.
//
// PURE apart from the injected `run`: this file never opens a socket or a
// DuckDB. The executor passes a runner that adds what is not the compiler's
// business — the per-dataset cache, the budget, the connector's `runBound`, the
// abort signal — and gets back exactly the shape the resident layer returns.
// scripts/test-liveParity.ts passes a runner over the DuckDB bridge.
//
// At most three warehouse round trips, each small and each separately
// cacheable: the latest date (only for an answer's "last quarter"), a probe for
// the category key (bin edges, or a date axis's grain), then the chart. A text
// axis needs no probe — its 50-plus-"Other" fold is one statement.

import { periodBounds, resolvePeriod } from '../../ai/answerSpec';
import type { CivilDate, DateGrain } from '../../analysis/categoryKey';
import { emptyListWarning } from '../../data/filterOps';
import type { LiveFilter, LiveIR, LiveRefusal } from './liveSpec';
import { isRefusal, refuse } from './liveSpec';
import type { CompileEnv, CompiledQuery, LiveKey } from './compile';
import {
  compileBinRange, compileChart, compileGrainProbe, compileLatestDates, compileMetric, latestColumns,
} from './compile';
import type { LiveChart, LiveRows } from './shape';
import { readBinRange, readGrain, readLatest, shapeChart, shapeMetric } from './shape';

export type LiveStep = 'latest' | 'binRange' | 'grain' | 'chart' | 'metric';

/** Runs one compiled statement; rows positional to `query.columns`. Throws on a warehouse error. */
export type LiveRunner = (query: CompiledQuery, step: LiveStep) => Promise<LiveRows>;

export type LiveOutcome =
  | { ok: true; kind: 'chart'; chart: LiveChart; warnings: string[]; periodLabels: string[] }
  | { ok: true; kind: 'metric'; value: number | null; warnings: string[]; periodLabels: string[] }
  | LiveRefusal;

/**
 * Data-relative periods ("last quarter" in an answer) → concrete day ranges,
 * exactly as `answerSpec.specFilterSteps` resolves them: the period the DATA's
 * latest date falls in (`resolvePeriod`), as inclusive ISO bounds
 * (`periodBounds`). A column with no date at all skips the filter with the
 * warning the extract's empty `in` step gives.
 *
 * `periodLabels` are the card's "order_date: 2024-Q4" texts, in filter order.
 * Warnings of skipped periods follow the adapter's own warnings; the extract
 * interleaves them by filter position (only visible when a period with no dates
 * and another skipped filter meet in one answer).
 */
export function resolvePeriods(
  ir: LiveIR,
  latest: Record<string, CivilDate | null>,
): { ir: LiveIR; warnings: string[]; periodLabels: string[] } {
  const warnings: string[] = [];
  const periodLabels: string[] = [];
  const filters: LiveFilter[] = [];
  for (const f of ir.filters) {
    if (f.kind !== 'latest') {
      filters.push(f);
      continue;
    }
    const day = latest[f.column];
    if (!day) {
      warnings.push(emptyListWarning(f.column, 'in'));
      periodLabels.push(`${f.column}: no dates`);
      continue;
    }
    const p = resolvePeriod(f.period, day, f.yearsBack || 0);
    const b = periodBounds(p.grain, p.bucket);
    periodLabels.push(`${f.column}: ${p.label}`);
    filters.push({ kind: 'range', column: f.column, from: b.from, to: b.to });
  }
  return { ir: { ...ir, filters }, warnings, periodLabels };
}

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
  let q = ir;
  let warnings: string[] = [];
  let periodLabels: string[] = [];
  const names = latestColumns(ir);
  if (names.length) {
    const lq = compileLatestDates(ir, env);
    if (!lq.ok) return lq;
    const latest = readLatest(await run(lq.query, 'latest'), lq.query, names);
    if (isRefusal(latest)) return latest;
    const r = resolvePeriods(ir, latest);
    q = r.ir;
    warnings = r.warnings;
    periodLabels = r.periodLabels;
  }

  if (q.kind === 'metric') {
    const mq = compileMetric(q, env);
    if (!mq.ok) return mq;
    const value = shapeMetric(await run(mq.query, 'metric'), mq.query, q);
    if (isRefusal(value)) return value;
    return { ok: true, kind: 'metric', value, warnings, periodLabels };
  }

  const key = await resolveKey(q, env, run);
  if (isRefusal(key)) return key;
  const cq = compileChart(q, key, env);
  if (!cq.ok) return cq;
  const chart = shapeChart(await run(cq.query, 'chart'), cq.query, q, key, env.columns);
  if (isRefusal(chart)) return chart;
  return { ok: true, kind: 'chart', chart, warnings, periodLabels };
}
