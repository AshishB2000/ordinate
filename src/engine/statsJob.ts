// The statistics workbench's resident run — the body of the compute worker's
// 'stats' op (./computeWorker.ts) and of the inline path in src/ipc/stats.ts.
// Electron-free, like everything the worker imports: plain paths and records
// in, a structured-cloneable result out; null means "the resident read
// declined", and the caller hydrates and runs the JS reference instead.

import type { FilterStep } from '../data/transforms';
import type { StatsSpec, VectorNeed } from '../analysis/stats/spec';
import { pairScatter, runStats } from '../analysis/stats/run';
import type { PairScatter, StatsResult, StatsVectors } from '../analysis/stats/run';
import { loadVectorsResident } from './statsVectors';
import type { VectorSource } from './statsVectors';

export interface StatsRunArgs {
  src: VectorSource;
  spec: StatsSpec;
  needs: VectorNeed[];
  filters: FilterStep[];
  pair?: [string, string];
}

/** Spec + loaded vectors → the answer: a result, or a pair's scatter. */
export function finishStats(spec: StatsSpec, v: StatsVectors, pair?: [string, string]): StatsResult | PairScatter {
  if (!pair) return runStats(spec, v);
  return pairScatter(pair[0], pair[1], v.number.get(pair[0]) || [], v.number.get(pair[1]) || [], spec.method || 'pearson');
}

export async function runStatsOnSource(args: StatsRunArgs): Promise<StatsResult | PairScatter | null> {
  const v = await loadVectorsResident(args.src, args.needs, args.filters);
  return v ? finishStats(args.spec, v, args.pair) : null;
}
