'use strict';

// A KPI card's COMPARE — the delta line under the figure, and the setting that
// turns it on. RENDERER ONLY. Classic global-scope <script>: no import/export.
// Loads after dashFiltersUi.js (renderMetricCard calls paintMetricCompare) and
// before authoringProps.js (whose panel calls anRenderCompareProps).
//
// Nothing here computes a figure. The comparison is a SECOND resolution in main
// (`metric:compare` → src/ipc/periods.ts): the card's own filters with their
// date range moved to the previous period, the same period last year, or a
// custom range, run through the same function the card's figure runs through.
// It is recomputed on every render and never stored — the card stores only
// which comparison it wants.

const KPI_COMPARE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'No comparison' },
  { value: 'previous_period', label: 'Previous period' },
  { value: 'previous_year', label: 'Same period last year' },
  { value: 'custom', label: 'Custom range…' },
];

/** "+18.2%" / "−4.1%" — one decimal under 10%, none above, a real minus sign. */
function kpiPct(pct: number): string {
  const a = Math.abs(pct);
  const body = OrdFormat.formatNumber(a, { maxDecimals: a < 10 ? 1 : 0 });
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + body + '%';
}

/**
 * Append the delta line to a metric card body: an arrow, the change as a value
 * and a percent, and what it is against — coloured by the metric's DIRECTION,
 * so a cost going up is red even though the arrow points up.
 */
async function paintMetricCompare(card: any, body: HTMLElement): Promise<void> {
  const m = card && card.metric;
  if (!m || !m.compare || !m.compare.mode || !currentProjectId) return;
  const row = document.createElement('div');
  row.className = 'dash-metric-delta is-loading';
  row.textContent = ' ';
  body.appendChild(row);

  let r: any = null;
  try {
    r = await window.hub.compareMetric(
      currentProjectId,
      { metricId: m.metricId, datasetId: m.datasetId, column: m.column, aggregation: m.aggregation },
      effectiveFilters(),
      m.compare,
      dashParamPayload(),
    );
  } catch (_) {
    r = null;
  }
  if (!row.isConnected) return; // the grid re-rendered while this was in flight
  row.classList.remove('is-loading');
  row.textContent = '';
  if (!r || r.ok === false) { row.remove(); return; }

  if (r.reason === 'no_date_filter') {
    row.classList.add('is-hint');
    body.classList.add('has-delta');
    row.appendChild(icon('calendar', 12));
    row.appendChild(document.createTextNode(' Add a date filter to compare'));
    row.title = 'Previous period and last year move the date range in scope, and this card has none.';
    return;
  }
  if (r.delta == null) {
    row.classList.add('is-flat');
    row.textContent = 'No figure ' + r.label;
    return;
  }

  const up = r.delta > 0;
  const flat = r.delta === 0;
  const good = r.direction === 'down_good' ? !up : up;
  row.classList.add(flat ? 'is-flat' : good ? 'is-good' : 'is-bad');
  if (!flat) row.appendChild(icon(up ? 'arrow-up' : 'arrow-down', 12));

  const val = document.createElement('span');
  val.className = 'dash-metric-delta-val tnum';
  val.textContent = r.deltaDisplay || fmtWith(Math.abs(r.delta), m.format || 'auto');
  row.appendChild(val);
  if (typeof r.pct === 'number' && Number.isFinite(r.pct)) {
    const pct = document.createElement('span');
    pct.className = 'dash-metric-delta-pct tnum';
    pct.textContent = '(' + kpiPct(r.pct) + ')';
    row.appendChild(pct);
  }
  // What it is against goes UNDER the pill, small: inside it, the sentence
  // wrapped and a two-row card clipped its own figure.
  const vs = document.createElement('div');
  vs.className = 'dash-metric-vs';
  vs.textContent = r.label;
  row.insertAdjacentElement('afterend', vs);
  // The label under the figure repeats the card's title in the common case;
  // with a delta to show, that line is the one the card can spare.
  const label = body.querySelector('.dash-metric-label') as HTMLElement | null;
  const title = (body.closest('.dash-card')?.querySelector('.dash-card-title')?.textContent || '').trim();
  if (label && (label.textContent || '').trim() === title) label.hidden = true;
  body.classList.add('has-delta');

  const prevText = r.previousDisplay || (r.previous == null ? '—' : fmtWith(r.previous, m.format || 'auto'));
  const range = r.prior ? ppFmtRange(r.prior.from, r.prior.to) : '';
  row.title = 'Was ' + prevText + (range ? ' · ' + range : '');
}

/**
 * The Compare section of a metric card's Properties. Writes `card.metric.compare`
 * and saves the dashboard like any other card edit — this IS authoring.
 */
function anRenderCompareProps(card: any, host: HTMLElement): void {
  const m = card.metric;
  if (!m) return;
  const cur = m.compare && m.compare.mode ? m.compare : null;

  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Compare with');
  sel.className = 'an-prop-input';
  KPI_COMPARE_OPTIONS.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  sel.value = cur ? cur.mode : '';
  host.appendChild(sel);

  const range = document.createElement('div');
  range.className = 'an-compare-range';
  const mk = (label: string, key: 'from' | 'to'): HTMLInputElement => {
    const wrap = document.createElement('label');
    wrap.className = 'an-compare-field';
    const t = document.createElement('span');
    t.textContent = label;
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'an-prop-input';
    input.value = cur && cur.mode === 'custom' && cur[key] ? cur[key] : '';
    wrap.appendChild(t);
    wrap.appendChild(input);
    range.appendChild(wrap);
    return input;
  };
  const from = mk('From', 'from');
  const to = mk('To', 'to');
  host.appendChild(range);

  const note = document.createElement('p');
  note.className = 'an-prop-note an-prop-note--info';
  host.appendChild(note);

  function sync(): void {
    const mode = sel.value;
    range.hidden = mode !== 'custom';
    note.textContent = mode === 'custom'
      ? 'The card\'s figure against the same figure over these dates.'
      : mode
        ? 'Moves the date range of the dashboard\'s filters and resolves the figure again — so it needs a date filter or date control in scope.'
        : 'Show how the figure changed against another period, coloured by whether up is good.';
  }
  function write(): void {
    const mode = sel.value;
    if (!mode) delete m.compare;
    else if (mode === 'custom') {
      if (!from.value || !to.value) { sync(); return; } // half a range compares nothing
      m.compare = { mode, from: from.value, to: to.value };
    } else m.compare = { mode };
    sync();
    markDashDirty('Compare');
    renderDashGrid();
    anPaintSelection();
  }
  sel.addEventListener('change', write);
  from.addEventListener('change', write);
  to.addEventListener('change', write);
  sync();
}

/** The Build tab's KPI section: shown for a metric card, emptied for anything else. */
function anRenderKpiProps(card: any): void {
  const host = document.getElementById('an-kpi-props');
  if (!host) return;
  host.innerHTML = '';
  host.hidden = !card || !card.metric;
  if (host.hidden) return;
  const h = document.createElement('div');
  h.className = 'an-kpi-props-h';
  h.appendChild(icon('arrow-up', 14));
  const t = document.createElement('span');
  t.textContent = 'Compare';
  h.appendChild(t);
  host.appendChild(h);
  anRenderCompareProps(card, host);
  void tcRenderKpiProps(card, host); // "Calculate as" (calcMenu.ts)
}
