'use strict';

// A report's SCORECARD page, and the dashboard stand-in a report made from a
// scorecard runs on. Classic global-scope script: no import/export.
//
// One more `RenderedPage`, so the PDF, PPTX and DOCX writers print it with no
// code of their own: the scorecard's name and period, the status count, then a
// native table — metric, value, target, attainment, status, change, owner —
// never a picture of numbers. Every cell is the display string main computed
// (`scorecard:snapshot` → src/ipc/scorecards.ts), read for the REPORT's project:
// a scheduled run prints reports of projects nobody has open.

const RS_STATUS: Record<string, string> = { good: t('common.on_track'), warn: t('common.at_risk'), off: t('common.off_track'), none: t('common.no_target') };

async function reportScorecardPage(ctx: ReportContext, page: any): Promise<RenderedPage | null> {
  if (!page || page.kind !== 'scorecard' || !page.scorecardId) return null;
  let sc: any = null;
  try { sc = await window.hubPower.scorecardSnapshot(ctx.projectId, String(page.scorecardId)); } catch (_) { sc = null; }
  if (!sc || sc.ok === false) {
    return { kind: 'scorecard', layout: page.layout, title: t('common.scorecard'), body: t('reportScorecard.this_scorecard_is_no_longer_in') };
  }
  const counts: Record<string, number> = { good: 0, warn: 0, off: 0, none: 0 };
  for (const r of sc.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = ['good', 'warn', 'off'].map((k) => `${counts[k]} ${RS_STATUS[k].toLowerCase()}`).join(' · ')
    + (counts.none ? t('reportScorecard.without_a_target', { none: counts.none }) : '');
  const body: string[][] = [];
  const grouped = sc.rows.some((r: any) => r.group);
  for (const r of sc.rows) {
    const change = r.deltaDisplay ? r.deltaDisplay + (typeof r.pct === 'number' ? ` (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%)` : '') : '—';
    const row = [
      String(r.name), r.display || '—', r.targetDisplay || '—',
      typeof r.attainment === 'number' ? Math.round(r.attainment) + '%' : '—',
      RS_STATUS[r.status] || '', change, r.owner || '',
    ];
    if (grouped) row.unshift(r.group || t('common.other'));
    body.push(row);
  }
  const head = [t('common.metric'), sc.window ? sc.window.label : t('common.value'), t('common.target'), t('common.attainment'), t('common.status'), t('common.vs_previous'), t('common.owner')];
  if (grouped) head.unshift(t('common.group'));
  return {
    kind: 'scorecard',
    layout: page.layout,
    title: sc.name || t('common.scorecard'),
    subtitle: sc.window ? `${sc.window.label} · ${sc.window.from} – ${sc.window.to}` : '',
    caption: page.caption || summary,
    grid: body.length ? { head: [head], body } : null,
    body: body.length ? undefined : t('reportScorecard.no_metrics_on_this_scorecard'),
  };
}

/**
 * The dashboard a report runs on. A report made from a SCORECARD has none, and
 * gets an empty stand-in (no sheets, default style) so the cover, the scorecard
 * page and the discussion page all build exactly as on any other report.
 */
async function reportAnalysisFor(projectId: string, report: any): Promise<any> {
  let a: any = null;
  if (report && report.analysisId) {
    try { a = await window.hub.getAnalysis(projectId, report.analysisId); } catch (_) { a = null; }
  }
  if (a) return a;
  return report && report.scorecardId
    ? { id: '', name: report.name, sheets: [], filters: [], style: {} }
    : null;
}
