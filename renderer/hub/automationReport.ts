'use strict';

// The report half of `ordinate --cli reports run` / the `run_report` MCP tool.
// Classic global-scope renderer <script>: no import/export.
//
// Main opens a HIDDEN hub window with `?headless=report&project=…&report=…`
// (src/automation/reportRunner.ts). Once every script has loaded, this drives
// the SAME pipeline the scheduled run uses (reportBuilder.ts reportsRunDue →
// buildReportPages → reportBytes) and hands the bytes back to main, which
// writes the file. In an ordinary hub window it does nothing at all.

(function automationHeadlessReport(): void {
  const q = new URLSearchParams(location.search);
  if (q.get('headless') !== 'report') return;
  const projectId = q.get('project') || '';
  const reportId = q.get('report') || '';

  let skippedMaps = 0;
  const answer = (outcome: { ok: boolean; base64?: string; ext?: string; error?: string }): void => {
    void window.hubAutomation.reportDone({ ...outcome, skippedMaps });
  };

  const run = async (): Promise<void> => {
    // A map needs WebGL2 in the VISIBLE window (reportExport.ts captureMapPNG):
    // here it would idle out after 8 s and fetch tiles for nothing. Leave the
    // picture out — the page keeps its title and caption — and say so in the
    // command's output. A classic script's function is a window property, so
    // this replaces it for every caller in THIS window only.
    (window as any).captureMapPNG = async (): Promise<string | null> => { skippedMaps++; return null; };
    const report = await window.hub.reportsGet(projectId, reportId);
    if (!report) return answer({ ok: false, error: t('automationReport.report_not_found') });
    const analysis = await window.hub.getAnalysis(projectId, report.analysisId);
    if (!analysis) return answer({ ok: false, error: t('automationReport.the_dashboard_this_report_prints_no') });
    const pages = await buildReportPages({
      projectId, analysis, report,
      filters: Array.isArray(analysis.filters) ? analysis.filters : [],
    });
    if (!pages.length) return answer({ ok: false, error: t('automationReport.every_page_of_this_report_is') });
    const { base64, ext } = await reportBytes(pages, report);
    if (!base64) return answer({ ok: false, error: t('automationReport.the_report_could_not_be_built') });
    answer({ ok: true, base64, ext });
  };

  // DOMContentLoaded fires after every classic script has run, so the whole
  // report pipeline (and the hub's own boot) is defined by then.
  document.addEventListener('DOMContentLoaded', () => {
    run().catch((e) => answer({ ok: false, error: (e && e.message) || t('automationReport.the_report_could_not_be_built') }));
  });
})();
