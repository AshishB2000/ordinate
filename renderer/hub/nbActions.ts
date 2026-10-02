'use strict';

// What a notebook's results can BECOME: a dataset, a pinned dashboard visual,
// a Markdown file. Classic global-scope renderer <script>: no import/export.
//
//   Save as dataset   the Query tab's path exactly: main reads the WHOLE result
//                     as a job and stages it, and the COMPOSER opens with the
//                     `notebook` origin — named by the user, steps if wanted.
//                     The dataset then refreshes when the cell's inputs change.
//   Pin to dashboard  pick the dashboard first (vizGallery's dashPickForAdd),
//                     then main saves the chart's SOURCE cell as a notebook
//                     dataset — reused if it already is one — and an ordinary
//                     visual over it with the cell's own spec; the card goes on
//                     the dashboard's last sheet (dashAppendVisualCard). Live,
//                     because that dataset refreshes with its inputs.
//   Export Markdown   charts captured by the reports' own captureChartPNG, the
//                     tables and the file written by main (notebook:exportMarkdown).

async function nbSaveAsDataset(id: string): Promise<void> {
  if (!nbDoc) return;
  const doc = nbDoc;
  const pid = nbDocProject;
  await nbFlush();
  const btn = nbCellEl(id)?.querySelector('.nb-save') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; iconLabel(btn, 'loader', t('nbActions.reading_every_row')); }
  let res: any = null;
  try {
    res = await window.hubNotebooks.prepareSave(pid, doc.id, id);
  } catch (_) {
    res = { ok: false, error: t('nbActions.the_result_could_not_be_read') };
  }
  if (btn) { btn.disabled = false; iconLabel(btn, 'database', t('common.save_as_dataset')); }
  if (res && res.canceled) return;
  if (!res || !res.ok) { showToast((res && res.error) || t('nbActions.the_result_could_not_be_read'), { kind: 'error' }); return; }
  const columns: any[] = Array.isArray(res.columns) ? res.columns : [];
  const rows: any[] = Array.isArray(res.rows) ? res.rows : [];
  const name = String(res.name || t('nbActions.notebook_result'));
  // The composer lives on the Datasets tab and closes back onto it; the
  // notebook stays open behind the Notebooks tab, results and all.
  clSelectTab('datasets');
  openComposer(
    {
      label: name,
      rows: typeof res.rowCount === 'number' ? res.rowCount : rows.length,
      kind: 'notebook',
      ref: { inline: { name, columns, rows, stagedId: res.stagedId } },
      columns: columns.map((k: any) => String(k.name)),
    },
    { name, sourceKind: 'notebook', origin: res.origin },
  );
}

async function nbPinChart(id: string): Promise<void> {
  if (!nbDoc) return;
  const doc = nbDoc;
  const pid = nbDocProject;
  await nbFlush();
  const analysis = await dashPickForAdd();
  if (!analysis) return;
  const btn = nbCellEl(id)?.querySelector('.nb-pin') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; iconLabel(btn, 'loader', t('nbActions.pinning')); }
  let res: any = null;
  try {
    res = await window.hubNotebooks.pinVisual(pid, doc.id, id);
  } catch (_) {
    res = { ok: false, error: t('nbActions.the_chart_could_not_be_pinned') };
  }
  if (btn) { btn.disabled = false; iconLabel(btn, 'layout-dashboard', t('common.pin_to_dashboard')); }
  if (!res || !res.ok) { showToast((res && res.error) || t('nbActions.the_chart_could_not_be_pinned'), { kind: 'error' }); return; }
  if (!(await dashAppendVisualCard(analysis, String(res.visualId)))) return;
  const where = analysis.name ? String(analysis.name) : t('common.the_dashboard');
  showToast(res.datasetCreated
    ? t('nbActions.pinned_to_its_data_is_saved', { where })
    : t('nbActions.pinned_to', { where }));
}

async function nbExportMarkdown(): Promise<void> {
  if (!nbDoc) return;
  const doc = nbDoc;
  const pid = nbDocProject;
  await nbFlush();
  // Charts are drawn here — the chart engine lives in the renderer — so any
  // chart without a current result runs first.
  const charts: Record<string, string> = {};
  for (const c of doc.cells) {
    if (c.kind !== 'chart') continue;
    if (nbCellState(c.id) !== 'ok' && !(await nbRunCell(c.id))) continue;
    const r = nbResults.get(c.id);
    if (!r || !r.ok || !r.chart) continue;
    const png = await captureChartPNG(r.chart.chartType, r.chart.data, {});
    if (png) charts[c.id] = png;
  }
  if (nbDoc !== doc) return;
  let res: any = null;
  try {
    res = await window.hubNotebooks.exportMarkdown(pid, doc.id, charts);
  } catch (_) {
    res = { ok: false, error: t('nbActions.the_export_failed') };
  }
  if (res && res.canceled) return;
  if (!res || !res.ok) { showToast((res && res.error) || t('nbActions.the_export_failed'), { kind: 'error' }); return; }
  showToast(t('nbActions.exported_to', { p0: String(res.dest).split(/[\\/]/).pop() }));
}
