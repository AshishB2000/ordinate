// Where each glossary term is used — the Data model Glossary's "Used by" (term:usage). A read only.
//
// A use is a `{ type: 'term', term: <id> }` step anywhere in a record: a visual, a dashboard (its sheets,
// cards, controls and saved views all live on the analysis record), a metric, an alert rule and a
// scorecard. A report uses a term exactly when its dashboard does, as in ./metricUsage. The same filter
// written inline ("region = West") is not a use: it does not follow the term when the term changes.

import * as analysis from './analysis';
import * as visuals from './visuals';
import * as alertStore from './alertStore';
import * as metrics from './metrics';
import * as scorecards from './scorecards';
import { listReports } from './reportSpec';
import { isTermStep } from '../data/termStep';
import { isValidId } from '../app/ids';

export type TermUsageKind = 'visual' | 'dashboard' | 'metric' | 'alert' | 'scorecard' | 'report';
export interface TermUsage { total: number; summary: string; refs: { kind: TermUsageKind; id: string; name: string }[] }

const ORDER: TermUsageKind[] = ['visual', 'dashboard', 'metric', 'alert', 'scorecard', 'report'];

/** Every term id a `{ type: 'term', term: <UUID> }` step names, at any depth. Iterative, so a deep record cannot overflow the stack. */
export function termIdsIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (isTermStep(v) && isValidId(v.term)) out.add(v.term);
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
  }
  return out;
}

/** "1 visual, 1 dashboard and 2 metrics" — worded as metricUsage.summarize words its own. */
function summarize(refs: TermUsage['refs']): string {
  const parts: string[] = [];
  for (const kind of ORDER) {
    const n = refs.filter((r) => r.kind === kind).length;
    if (n) parts.push(`${n} ${kind}${n === 1 ? '' : 's'}`);
  }
  return parts.length <= 1 ? parts[0] || '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Each term with at least one use, by id (a null-prototype record). Never throws: each store is read in its own try. */
export async function termUsage(projectId: string): Promise<Record<string, TermUsage>> {
  const refsOf = new Map<string, TermUsage['refs']>();
  const add = (record: unknown, kind: TermUsageKind, id: string, name: string): Set<string> => {
    const ids = termIdsIn(record);
    for (const t of ids) {
      if (!refsOf.has(t)) refsOf.set(t, []);
      refsOf.get(t)!.push({ kind, id, name });
    }
    return ids;
  };
  try {
    for (const s of await visuals.listVisuals(projectId)) {
      const v = await visuals.getVisual(projectId, s.id);
      if (v) add(v, 'visual', v.id, v.name);
    }
  } catch (_) { /* a store we cannot read is a use we cannot count */ }
  const byAnalysis = new Map<string, Set<string>>();
  try {
    for (const s of await analysis.listAnalyses(projectId)) {
      const a = await analysis.getAnalysis(projectId, s.id);
      if (a) byAnalysis.set(a.id, add(a, 'dashboard', a.id, a.name));
    }
  } catch (_) { /* as above */ }
  try {
    for (const s of await metrics.listMetrics(projectId)) {
      const m = await metrics.getMetric(projectId, s.id);
      if (m) add(m, 'metric', m.id, m.name);
    }
  } catch (_) { /* as above */ }
  try {
    for (const rule of (await alertStore.load(projectId)).rules) add(rule, 'alert', rule.id, rule.name);
  } catch (_) { /* as above */ }
  try {
    for (const s of await scorecards.listScorecards(projectId)) {
      const sc = await scorecards.getScorecard(projectId, s.id);
      if (sc) add(sc, 'scorecard', sc.id, sc.name);
    }
  } catch (_) { /* as above */ }
  try {
    for (const r of await listReports(projectId)) {
      for (const t of byAnalysis.get(r.analysisId) ?? []) refsOf.get(t)!.push({ kind: 'report', id: r.id, name: r.name });
    }
  } catch (_) { /* as above */ }
  const out: Record<string, TermUsage> = Object.create(null);
  for (const [t, refs] of refsOf) out[t] = { total: refs.length, summary: summarize(refs), refs };
  return out;
}
