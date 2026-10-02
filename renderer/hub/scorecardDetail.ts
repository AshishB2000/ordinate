// A scorecard row's DETAIL — the metric over its last 24 periods as a large
// line with its target and a forecast drawn as Analytics overlays, the chosen
// period broken out by the dataset's top dimension, and "Alert me".
//
// Every figure — the history, the target line, the forecast and its interval,
// the breakdown — comes back from `scorecard:detail` (src/ipc/scorecards.ts).
// The charts are drawn by the ordinary buildChart, and the overlays by the same
// annotations plugin the builder's charts use (chartAnnotations.js), because the
// detail's `series` carries `analytics` exactly like a `visual:data` reply.
//
// Classic global-scope script — NO import/export. textContent only.

let scDetailMetric = '';
let scDetailCharts: any[] = [];
let scDetailSeq = 0;

function scDestroyDetailCharts(): void {
  for (const c of scDetailCharts) { try { c.destroy(); } catch (_) { /* already gone */ } }
  scDetailCharts = [];
}

function scCloseDetail(): void {
  scDestroyDetailCharts();
  scDetailMetric = '';
  const aside = scEl('sc-detail');
  if (aside) aside.hidden = true;
  const page = scEl('sc-page');
  if (page) page.classList.remove('has-detail');
  document.querySelectorAll('#sc-table .sc-row.is-selected').forEach((r) => r.classList.remove('is-selected'));
}

function scFigure(label: string, value: string, cls = ''): HTMLElement {
  const f = document.createElement('div');
  f.className = 'sc-fig' + (cls ? ' ' + cls : '');
  const l = document.createElement('span');
  l.className = 'sc-fig-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'sc-fig-value';
  v.textContent = value;
  f.append(l, v);
  return f;
}

async function scOpenDetail(metricId: string): Promise<void> {
  if (!scCurrent || !currentProjectId) return;
  const my = ++scDetailSeq;
  scDetailMetric = metricId;
  const aside = scEl('sc-detail');
  const page = scEl('sc-page');
  const body = scEl('sc-detail-body');
  if (!aside || !body) return;
  aside.hidden = false;
  if (page) page.classList.add('has-detail');
  document.querySelectorAll('#sc-table .sc-row').forEach((r) =>
    r.classList.toggle('is-selected', (r as HTMLElement).dataset.metricId === metricId));
  body.classList.add('is-loading');

  let res: any = null;
  try { res = await window.hubPower.scorecardDetail(currentProjectId, scCurrent.id, metricId, scOffset); } catch (_) { res = null; }
  if (my !== scDetailSeq || scDetailMetric !== metricId) return;
  body.classList.remove('is-loading');
  scDestroyDetailCharts();
  body.textContent = '';
  const title = scEl('sc-detail-title');
  if (!res || res.ok === false) {
    if (title) title.textContent = t('common.metric');
    const p = document.createElement('p');
    p.className = 'sc-error';
    p.textContent = (res && res.error) || t('scorecardDetail.could_not_load_this_metric');
    body.appendChild(p);
    return;
  }
  if (title) {
    title.textContent = '';
    title.append(scDot(res.status), document.createTextNode(String(res.metric.name)));
  }

  const figs = document.createElement('div');
  figs.className = 'sc-figs';
  figs.appendChild(scFigure(res.window ? res.window.label : t('common.value'), res.display || '—', 'sc-fig--lead'));
  figs.appendChild(scFigure(t('common.target'), res.targetDisplay || t('scorecardDetail.none_set')));
  figs.appendChild(scFigure(t('common.attainment'), typeof res.attainment === 'number' ? Math.round(res.attainment) + '%' : '—'));
  figs.appendChild(scFigure(t('common.status'), res.statusWord ? res.statusWord.charAt(0).toUpperCase() + res.statusWord.slice(1) : '—', 'sc-fig--' + res.status));
  body.appendChild(figs);
  const def = document.createElement('p');
  def.className = 'sc-detail-def';
  def.textContent = res.metric.definitionText || '';
  body.appendChild(def);

  // The history: a large line, target and forecast overlays resolved in main.
  const series = res.series || { labels: [], series: [] };
  const lineHead = document.createElement('div');
  lineHead.className = 'sc-detail-sub';
  lineHead.textContent = res.dateColumn ? t('scorecardDetail.last_periods_by', { labelsCount: series.labels.length, dateColumn: res.dateColumn }) : t('scorecardDetail.no_date_column_no_history_to');
  body.appendChild(lineHead);
  if (series.labels.length) {
    const wrap = document.createElement('div');
    wrap.className = 'sc-detail-chart';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', t('scorecardDetail.over_time_with_its_target_and', { name: res.metric.name }));
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    const chart = buildChart(canvas, series, 'line', { showLegend: false, valueMode: 'off' });
    if (chart) scDetailCharts.push(chart);
    const fc = (series.analytics || []).find((o: any) => o.kind === 'forecast');
    if (fc) {
      const note = document.createElement('p');
      note.className = 'sc-detail-note';
      note.textContent = t('scorecardDetail.forecast', { text: fc.text, p1: (fc.forecast && fc.forecast.season ? t('scorecardDetail.season_of_detected', { season: fc.forecast.season }) : '') });
      body.appendChild(note);
    }
  }

  // The breakdown: this period, by the dataset's top dimension.
  if (res.breakdown && res.breakdown.labels.length) {
    const h = document.createElement('div');
    h.className = 'sc-detail-sub';
    h.textContent = `${res.window ? res.window.label : t('scorecardDetail.this_period')} by ${res.breakdown.dimension}`;
    body.appendChild(h);
    const wrap = document.createElement('div');
    wrap.className = 'sc-detail-chart sc-detail-chart--bars';
    wrap.style.height = Math.max(120, Math.min(360, 28 * res.breakdown.labels.length + 40)) + 'px';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', `${res.metric.name} by ${res.breakdown.dimension}`);
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    const chart = buildChart(canvas, { labels: res.breakdown.labels, series: [{ name: res.metric.name, values: res.breakdown.values }] },
      'bar', { showLegend: false, valueMode: 'all' });
    if (chart) scDetailCharts.push(chart);
  }

  const actions = document.createElement('div');
  actions.className = 'sc-detail-actions';
  const alertBtn = document.createElement('button');
  alertBtn.type = 'button';
  alertBtn.className = 'btn btn-primary';
  alertBtn.append(icon('bell', 16), Object.assign(document.createElement('span'), { textContent: t('common.alert_me') }));
  alertBtn.addEventListener('click', () => { void scAlertMe(res.metric); });
  actions.appendChild(alertBtn);
  body.appendChild(actions);
}

/** "Alert me" — the same dialog every other surface opens, on this metric. */
async function scAlertMe(m: any): Promise<void> {
  const def = (m && m.definition) || {};
  if (typeof def.formula === 'string') {
    showToast(t('common.alerts_watch_a_column_rolled_up'));
    return;
  }
  if (!def.column) { showToast(t('common.this_metric_has_no_column_to')); return; }
  const rule = await openAlertDialog({
    datasetId: String(m.datasetId),
    column: String(def.column),
    aggregation: String(def.aggregation || 'sum'),
    label: String(m.name),
    metricId: String(m.id),
  });
  if (rule) void scCompute(); // the row's latest-alert cell follows
}

/** "Create report…" — a report of this scorecard, opened in the report builder. */
async function scCreateReport(id: string): Promise<void> {
  if (!currentProjectId) return;
  let res: any = null;
  try { res = await window.hubPower.scorecardCreateReport(currentProjectId, id); } catch (_) { res = null; }
  if (!res || res.ok === false || !res.report) { showToast(t('scorecardDetail.could_not_create_the_report')); return; }
  await scClose();
  await rbOpenReportById(String(res.report.id));
}
