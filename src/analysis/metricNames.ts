// The metrics a formula's names resolve to (`[Revenue]`), read by those names alone — MAIN PROCESS.
//
// A formula (or period) metric names other metrics, and its figure needs only those, never every metric of the
// project (docs/assistant/00-design.md "Scale rules"). `metricNames` answers what `metricsByName(projectId)` holds
// under each lower-cased name asked, reading only the metrics of those names through step 3's index
// (../ipc/specVocabulary metricsNamed); without the index, or when a lookup fails, it reads metricsByName once, the
// reference. scripts/test-formulaNames.ts holds every figure path Object.is-equal to it.

import * as metrics from './metrics';
import type { Metric, MetricDefinition } from './metrics';
import { tokenize } from '../formula/formulaTokens';
import { bindFormulaText, type ParamValues } from './params';

/** A walk of names deeper than this reads every metric instead: past every evaluator's own depth limit. */
const MAX_LEVELS = 16;

export interface MetricNames {
  /** What metricsByName holds under `key` (a lower-cased name), or undefined. */
  get(key: string): Promise<Metric | undefined>;
  /** Several names in one lookup (one index query, one read); each is looked up once. */
  load(keys: Iterable<string>): Promise<void>;
  /** metricsByName itself, read once, when the index cannot answer (there is none, or a lookup failed); else null. */
  reference(): Promise<Map<string, Metric>> | null;
}

/** A lookup for one resolution (a resolver context): what it has read, it keeps. */
export function metricNames(projectId: string): MetricNames {
  const got = new Map<string, Metric | undefined>();
  let all: Promise<Map<string, Metric>> | null = null;
  // Lazy: both import what imports this.
  const search = () => require('../ipc/assistantSearch') as typeof import('../ipc/assistantSearch');
  const sv = () => require('../ipc/specVocabulary') as typeof import('../ipc/specVocabulary');
  const reference = (): Promise<Map<string, Metric>> | null => {
    if (!all && !search().indexedFor(projectId)) all = metrics.metricsByName(projectId);
    return all;
  };
  const load = async (keys: Iterable<string>): Promise<void> => {
    const want = [...new Set(keys)].filter((k) => !got.has(k));
    if (!want.length) return;
    const found = reference() ? null : await sv().metricsNamed(projectId, want).catch(() => null);
    if (found) {
      for (const k of want) got.set(k, found.get(k));
      return;
    }
    const byName = await (all ??= metrics.metricsByName(projectId)); // once, however many ask at a time
    for (const k of want) got.set(k, byName.get(k));
  };
  return { load, get: async (key) => { await load([key]); return got.get(key); }, reference };
}

/** Every name a formula can look up: its bracketed and bare names, lower-cased, in its text and as its parameters bind it. */
export function namesSaid(def: MetricDefinition, params: ParamValues = new Map()): string[] {
  if (!metrics.isFormulaDefinition(def)) return [];
  return [def.formula, bindFormulaText(def.formula, params).text].flatMap((text) => {
    try {
      return tokenize(text).flatMap((t) => (t.kind === 'col' || t.kind === 'name' ? [t.value.toLowerCase()] : []));
    } catch (_) {
      return []; // it does not tokenize: nothing reads a name from it
    }
  });
}

/**
 * What metricsByName holds of every name `defs` reach (their formulas' names, a period metric's base by its name, and
 * theirs in turn), for an evaluator that looks names up as it goes (../analysis/additivity additivityOf,
 * ../analysis/driverShape metricShape): it can ask no name this does not hold as metricsByName holds it. `params`:
 * what the evaluator binds. Without the index (or past MAX_LEVELS), metricsByName itself: the reference.
 */
export async function metricsReached(projectId: string, defs: readonly MetricDefinition[], params: ParamValues = new Map(), names = metricNames(projectId)): Promise<Map<string, Metric>> {
  const out = new Map<string, Metric>();
  const seen = new Set<string>();
  let level = [...defs];
  for (let depth = 0; level.length; depth++) {
    const ref = depth > MAX_LEVELS ? metrics.metricsByName(projectId) : names.reference();
    if (ref) return ref;
    const keys = level.flatMap((d) => namesSaid(d, params));
    for (const d of level) {
      const base = metrics.isPeriodDefinition(d) ? await metrics.getMetric(projectId, d.base) : null;
      if (base) keys.push(base.name.toLowerCase()); // found by id among the values: its name's first is
    }
    await names.load(keys);
    const failed = names.reference(); // a lookup failed: the reference
    if (failed) return failed;
    level = [];
    for (const k of keys) {
      const m = await names.get(k);
      if (!m) continue;
      out.set(k, m);
      if (!seen.has(m.id)) {
        seen.add(m.id);
        level.push(m.definition);
      }
    }
  }
  return out;
}
