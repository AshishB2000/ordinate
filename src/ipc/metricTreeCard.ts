// "Add to dashboard" for a metric tree — MAIN PROCESS. The card stores the
// metric's id (its tree lives on the metric record), full width at the foot of
// the dashboard's last sheet — an existing dashboard, or a new one named
// `name`. As `stats:addToDashboard` does for a statistics card.

import { randomUUID } from 'crypto';
import * as analysis from '../analysis/analysis';
import * as metrics from '../analysis/metrics';
import * as config from '../app/config';
import * as versions from '../app/versions';
import { DASHBOARD_STYLE_PRESETS } from '../analysis/dashboards';
import * as msg from '../analysis/metricTreeMessages';

/** Columns × rows of a new tree card on the 12-column grid. */
const CARD_W = 12;
const CARD_H = 11;

export async function addTreeCard(projectId: string, metricId: string, analysisId: string | undefined, name: string | undefined) {
  if (!(await metrics.getMetric(projectId, metricId))) return { ok: false as const, error: msg.metricGone() };
  // Read and write under the dashboard's hold (every pod): an editor's save between the two is never dropped.
  return analysis.lockedAnalysis(projectId, analysisId ?? '', async () => {
    let a = analysisId ? await analysis.getAnalysis(projectId, analysisId) : null;
    if (!analysisId) {
      const preset = DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
      a = await analysis.saveAnalysis(projectId, { name: String(name ?? '').trim().slice(0, 200) || 'Untitled dashboard', style: preset });
      if (a) await versions.record(projectId, 'dashboard', a);
    }
    if (!a) return { ok: false as const, error: 'That dashboard could not be opened.' };
    const sheets = a.sheets.map((p) => ({ ...p, cards: [...(p.cards || [])] }));
    const last = sheets[sheets.length - 1];
    const y = last.cards.reduce((m, c) => Math.max(m, (c.layout?.y ?? 0) + (c.layout?.h ?? 0)), 0);
    last.cards.push({ id: randomUUID(), type: 'metricTree', metricTree: { metricId }, layout: { x: 0, y, w: CARD_W, h: CARD_H } } as (typeof last.cards)[number]);
    const before = analysisId ? a : undefined;
    const saved = await analysis.updateAnalysis(projectId, a.id, { sheets });
    if (!saved) return { ok: false as const, error: 'Could not add it to that dashboard.' };
    await versions.record(projectId, 'dashboard', saved, before ? { before } : undefined);
    return { ok: true as const, analysisId: saved.id, name: saved.name };
  });
}
