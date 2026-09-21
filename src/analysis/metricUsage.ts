// What points at a metric — MAIN PROCESS.
// Reads the project's records and answers "where is this used", for the Metrics
// page's Used-in column and for the delete confirm ("Used by 4 cards and 1
// alert"). A read only: nothing here writes, and nothing here BLOCKS a delete
// (see metrics.deleteMetric's header for why that is the UI's call, not the
// store's).
//
// Five kinds of reference, and one that deliberately is not:
//   · a metric CARD on an analysis sheet   (Card.metric.metricId)
//   · a MEASURE on a saved visual          (VizEncoding.values[].metricId)
//   · a VALUE on a saved pivot             (VizEncoding.pivot.values[].metricId)
//   · an ALERT rule                        (AlertRule.metric.metricId)
//   · another METRIC's formula             ([Revenue] by name)
//   · a REPORT, transitively — a report names an analysisId, so it uses the
//     metric exactly when that analysis does. Counting it directly would mean
//     a report page carrying its own metric reference, which it does not.
//
// INSIGHTS are not a usage site. They are computed on demand from a dataset
// (src/ipc/insights.ts has no store), so there is no insight record that could
// hold a reference — an insight that happens to narrate a metric is not a thing
// deleting the metric would break.

import * as analysis from './analysis';
import * as visuals from './visuals';
import * as alertStore from './alertStore';
import * as metrics from './metrics';
import { listReports } from './reportSpec';
import { compileMetricFormula } from './metricFormula';
import { isFormulaDefinition } from './metrics';

export type MetricUsageKind = 'card' | 'visual' | 'alert' | 'report' | 'metric';

export interface MetricUsageRef {
  kind: MetricUsageKind;
  /** What the reader sees this thing called. */
  name: string;
  /** The record to open — an analysis id for a card, the record's own id
   *  otherwise. Never a filesystem path. */
  id: string;
  /** For a card: which sheet it sits on, so "open" lands on the right one. */
  sheetIndex?: number;
}

export interface MetricUsage {
  total: number;
  refs: MetricUsageRef[];
  /** "4 cards and 1 alert" — the delete confirm's sentence, built once here so
   *  the page and the confirm cannot word it differently. */
  summary: string;
}

const PLURALS: Record<MetricUsageKind, [string, string]> = {
  card: ['card', 'cards'],
  visual: ['visual', 'visuals'],
  alert: ['alert', 'alerts'],
  report: ['report', 'reports'],
  metric: ['metric', 'metrics'],
};

/** "4 cards and 1 alert"; "3 cards, 1 visual and 2 alerts"; "" for none. */
export function summarize(refs: MetricUsageRef[]): string {
  const order: MetricUsageKind[] = ['card', 'visual', 'alert', 'report', 'metric'];
  const parts: string[] = [];
  for (const kind of order) {
    const n = refs.filter((r) => r.kind === kind).length;
    if (!n) continue;
    parts.push(`${n} ${PLURALS[kind][n === 1 ? 0 : 1]}`);
  }
  if (parts.length <= 1) return parts[0] || '';
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * Every reference to one metric in one project.
 *
 * Never throws: each store is read in its own try, so a corrupt analysis file
 * costs the alerts count rather than the whole answer. A usage read that failed
 * would otherwise turn into a delete confirm that said "used by nothing" about
 * a metric four cards depend on, which is the one way this function can do
 * damage.
 */
export async function metricUsage(projectId: string, metricId: string): Promise<MetricUsage> {
  const refs: MetricUsageRef[] = [];
  const usingAnalyses = new Set<string>();

  try {
    for (const summary of await analysis.listAnalyses(projectId)) {
      const a = await analysis.getAnalysis(projectId, summary.id);
      if (!a) continue;
      a.sheets.forEach((sheet, sheetIndex) => {
        for (const card of sheet.cards || []) {
          if (card.type !== 'metric' || !card.metric || card.metric.metricId !== metricId) continue;
          usingAnalyses.add(a.id);
          refs.push({
            kind: 'card',
            name: card.metric.label || a.name,
            id: a.id,
            sheetIndex,
          });
        }
      });
    }
  } catch (_) { /* a sheet we cannot read is a card we cannot count */ }

  try {
    for (const summary of await visuals.listVisuals(projectId)) {
      const v = await visuals.getVisual(projectId, summary.id);
      if (!v) continue;
      // A chart measure, or a PIVOT value — both are "this visual shows that
      // metric", and a pivot's values live on their own shelf rather than in
      // `encoding.values`.
      const pivotValues = (v.encoding as { pivot?: { values?: { metricId?: string }[] } }).pivot?.values || [];
      if (v.encoding.values.some((m) => m.metricId === metricId)
        || pivotValues.some((m) => m && m.metricId === metricId)) {
        refs.push({ kind: 'visual', name: v.name, id: v.id });
      }
    }
  } catch (_) { /* as above */ }

  try {
    const file = await alertStore.load(projectId);
    for (const rule of file.rules) {
      if (rule.metric && rule.metric.metricId === metricId) {
        refs.push({ kind: 'alert', name: rule.name, id: rule.id });
      }
    }
  } catch (_) { /* as above */ }

  try {
    for (const r of await listReports(projectId)) {
      if (usingAnalyses.has(r.analysisId)) refs.push({ kind: 'report', name: r.name, id: r.id });
    }
  } catch (_) { /* as above */ }

  try {
    const self = await metrics.getMetric(projectId, metricId);
    const name = self ? self.name.toLowerCase() : '';
    if (name) {
      for (const s of await metrics.listMetrics(projectId)) {
        if (s.id === metricId || !isFormulaDefinition(s.definition)) continue;
        // Compiled, not string-matched: `[Revenue]` inside a quoted string or a
        // metric called "Revenue growth" are both substring hits and neither is
        // a reference.
        const compiled = compileMetricFormula(s.definition.formula, []);
        if (!compiled.ok) continue;
        if (compiled.program.metricRefs.some((r) => r.toLowerCase() === name)) {
          refs.push({ kind: 'metric', name: s.name, id: s.id });
        }
      }
    }
  } catch (_) { /* as above */ }

  return { total: refs.length, refs, summary: summarize(refs) };
}
