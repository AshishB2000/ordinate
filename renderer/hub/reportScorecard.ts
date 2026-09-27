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

const RS_STATUS: Record<string, string> = { good: 'On track', warn: 'At risk', off: 'Off track', none: 'No target' };

async function reportScorecardPage(ctx: ReportContext, page: any): Promise<RenderedPage | null> {
  if (!page || page.kind !== 'scorecard' || !page.scorecardId) return null;
  let sc: any = null;
  try { sc = await window.hubPower.scorecardSnapshot(ctx.projectId, String(page.scorecardId)); } catch (_) { sc = null; }
  if (!sc || sc.ok === false) {
    return { kind: 'scorecard', layout: page.layout, title: 'Scorecard', body: 'This scorecard is no longer in the project.' };
  }
  const counts: Record<string, number> = { good: 0, warn: 0, off: 0, none: 0 };
  for (const r of sc.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = ['good', 'warn', 'off'].map((k) => `${counts[k]} ${RS_STATUS[k].toLowerCase()}`).join(' · ')
    + (counts.none ? ` · ${counts.none} without a target` : '');
  const body: string[][] = [];
  const grouped = sc.rows.some((r: any) => r.group);
  for (const r of sc.rows) {
    const change = r.deltaDisplay ? r.deltaDisplay + (typeof r.pct === 'number' ? ` (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%)` : '') : '—';
    const row = [
      String(r.name), r.display || '—', r.targetDisplay || '—',
      typeof r.attainment === 'number' ? Math.round(r.attainment) + '%' : '—',
      RS_STATUS[r.status] || '', change, r.owner || '',
    ];
    if (grouped) row.unshift(r.group || 'Other');
    body.push(row);
  }
  const head = ['Metric', sc.window ? sc.window.label : 'Value', 'Target', 'Attainment', 'Status', 'vs previous', 'Owner'];
  if (grouped) head.unshift('Group');
  return {
    kind: 'scorecard',
    layout: page.layout,
    title: sc.name || 'Scorecard',
    subtitle: sc.window ? `${sc.window.label} · ${sc.window.from} – ${sc.window.to}` : '',
    caption: page.caption || summary,
    grid: body.length ? { head: [head], body } : null,
    body: body.length ? undefined : 'No metrics on this scorecard.',
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
