'use strict';

// The three doors into "Why did this change?" and the panel's three actions.
// RENDERER ONLY, classic global-scope script (no import/export). Loads after
// driversPanel.js.
//
//   · a KPI card with Compare on — a "Why?" beside its delta line
//     (kpiCompare.ts paintMetricCompare calls drvMountKpiWhy);
//   · a point on a line chart over dates — "Why did this change?" in the panel
//     a click opens (drill.ts calls drvPointWhy and drvMountDrillWhy);
//   · an alert event — "Why?" in the bell's popover (alertsInbox.ts).
//
// Each builds a QUESTION (which metric, under which filters, which two
// periods) and hands it to main; nothing here computes a figure.

/** The question the dock should answer from, after "Ask the Assistant". */
let drvPinned: { token: string; name: string; section: string; analysisId: string } | null = null;

// ── Doors ───────────────────────────────────────────────────────────────────

/** A KPI card's question: its own figure against its Compare, under the sheet's filters. */
function drvKpiRequest(card: any): any {
  const m = card && card.metric;
  if (!m || !m.compare || !m.compare.mode || !m.datasetId) return null;
  return {
    datasetId: m.datasetId,
    metric: { metricId: m.metricId, column: m.column, aggregation: m.aggregation, label: m.label || undefined },
    filters: typeof effectiveFilters === 'function' ? effectiveFilters() : [],
    compare: m.compare,
    path: [],
  };
}

/**
 * "Why?" beside a KPI's "vs …" line — in a row WITH it rather than inside it,
 * so the line still says only what the figure is against.
 */
function drvMountKpiWhy(card: any, vs: HTMLElement): void {
  const req = drvKpiRequest(card);
  if (!req || !currentProjectId) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dash-metric-why';
  b.textContent = t('common.why');
  b.setAttribute('aria-label', t('common.why_did_this_change'));
  b.title = t('driversEntry.break_the_change_down_by_what');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const pid = currentProjectId;
    const params = typeof dashParamPayload === 'function' ? dashParamPayload() : undefined;
    void openDriversPanel(() => window.hubDrivers.explain(pid, { ...req, params }), params);
  });
  const line = document.createElement('div');
  line.className = 'dash-metric-vsrow';
  vs.insertAdjacentElement('beforebegin', line);
  line.append(vs, b);
}

const DRV_YEAR = /^\d{4}$/;
const DRV_QUARTER = /^\d{4}-Q[1-4]$/;
const DRV_MONTH = /^\d{4}-\d{2}$/;
const DRV_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The grain an axis label was written at (categoryKey.dateBucketLabel's shapes). */
function drvGrainOf(label: string, prev: string, set?: string): string | null {
  // A week calendar's labels (FY24 P03 W2, 2020-W53 — retailCalendar.weekLabel); main checks them.
  if (calIsWeekCal() && !DRV_DAY.test(label)) {
    if (/W\d+$/.test(label)) return 'week';
    if (/P\d{2}$/.test(label)) return 'month';
    if (/Q[1-4]$/.test(label)) return 'quarter';
    return /^(FY)?\d+$/.test(label) ? 'year' : null;
  }
  if (set === 'week' || set === 'day') return DRV_DAY.test(label) ? set : null;
  if (DRV_YEAR.test(label)) return 'year';
  if (DRV_QUARTER.test(label)) return 'quarter';
  if (DRV_MONTH.test(label)) return 'month';
  if (!DRV_DAY.test(label) || !DRV_DAY.test(prev)) return null;
  // Weeks and days are both labelled by their first day; seven days apart is a week.
  const gap = (Date.parse(label + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) / 86400000;
  return gap === 7 ? 'week' : 'day';
}

/**
 * An axis label back to its bucket key. chartRender.asMonthLabels shows a
 * first-of-month axis ("2024-12-01") as "Dec 2024" in the runtime's locale;
 * the same formatter, run over the label's year, finds the month it came from —
 * returned as a MONTH key, since every cell in that bucket is inside it.
 */
function drvRawLabel(label: string): string {
  if (DRV_YEAR.test(label) || DRV_QUARTER.test(label) || DRV_MONTH.test(label) || DRV_DAY.test(label)) return label;
  const y = /\b(\d{4})\b/.exec(label);
  if (!y) return label;
  for (let m = 1; m <= 12; m += 1) {
    const shown = new Date(Date.UTC(+y[1], m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    if (shown === label) return `${y[1]}-${String(m).padStart(2, '0')}`;
  }
  return label;
}

/**
 * A clicked point on a line chart over a date axis → the bucket and the one
 * before it, or null (not a line, not a date axis, the first point).
 */
function drvPointWhy(area: HTMLElement, mark: any, ctx: any): { label: string; prev: string; grain: string; params?: any[] } | null {
  const chart = typeof chartInstances !== 'undefined' ? chartInstances.get(area) : null;
  if (!chart || !chart.config || chart.config.type !== 'line' || !mark) return null;
  const enc = ctx && ctx.encoding;
  if (!enc || !enc.category || !Array.isArray(enc.values) || !enc.values.length) return null;
  if (enc.values[0].aggregation === 'none') return null; // one point per row: nothing to decompose
  const labels: any[] = (chart.data && chart.data.labels) || [];
  const i = labels.findIndex((l) => String(l) === String(mark.category));
  if (i < 1) return null;
  const label = drvRawLabel(String(labels[i]));
  const prev = drvRawLabel(String(labels[i - 1]));
  const grain = drvGrainOf(label, prev, enc.grain);
  return grain ? { label, prev, grain, params: ctx.params } : null;
}

/** The drill panel's "Why did this change?" — shown only for a point that has one. */
function drvMountDrillWhy(head: HTMLElement | null, opts: any): void {
  if (!head) return;
  let b = head.querySelector('.drill-why') as HTMLButtonElement | null;
  if (!b) {
    b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary btn-sm drill-why';
    b.appendChild(icon('activity', 16));
    b.appendChild(document.createTextNode(t('common.why_did_this_change')));
    head.appendChild(b);
  }
  const why = opts && opts.why;
  b.hidden = !why;
  b.onclick = null;
  if (!why) return;
  b.title = t('driversEntry.break_the_change_from_to_down', { prev: why.prev, label: why.label });
  b.onclick = () => {
    const enc = opts.encoding;
    const v = enc.values[0];
    const filters = (opts.filters || []).slice();
    if (enc.series && opts.mark && opts.mark.series !== undefined) {
      filters.push({ type: 'filter', column: enc.series, op: '=', value: opts.mark.series });
    }
    const req = {
      datasetId: opts.datasetId,
      metric: { metricId: v.metricId, column: v.column, aggregation: v.aggregation },
      filters,
      compare: { mode: 'bucket', column: enc.category, label: why.label, prev: why.prev, grain: why.grain },
      path: [],
    };
    const pid = opts.projectId;
    const params = why.params;
    closeDrillPanel();
    void openDriversPanel(() => window.hubDrivers.explain(pid, { ...req, params }), params);
  };
}

/** An alert event's "Why?" — the rule's latest two periods, resolved in main. */
function drvWhyFromAlert(ruleId: string): void {
  if (!currentProjectId || !ruleId) return;
  const pid = currentProjectId;
  void openDriversPanel(() => window.hubDrivers.explainAlert(pid, ruleId));
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function drvAddTile(): Promise<void> {
  const r = drvRes;
  if (!r || !r.selected || !drvReq || !currentProjectId) return;
  const name = t('driversEntry.why_changed_by', { name: r.metric.name, column: r.selected.column });
  let res: any;
  try {
    res = await window.hubDrivers.addTile(currentProjectId, { ...drvReq, dimension: r.selected.column }, name);
  } catch (_) {
    res = null;
  }
  if (!res || !res.ok) { showToast((res && res.error) || t('driversEntry.could_not_add_the_tile')); return; }
  const onSheet = currentSection === 'analyses' && dashCurrent && !dashReadOnly && typeof pushCard === 'function';
  if (onSheet) {
    pushCard({ id: dashUuid(), type: 'visual', visualId: res.visual.id, layout: { ...dashFindSlot(dashCards(), 6, 6), w: 6, h: 6 } });
    closeDriversPanel();
    showToast(t('driversEntry.added_a_waterfall_tile_it_recomputes'));
  } else {
    showToast(t('driversEntry.saved_to_visuals', { name }));
  }
}

async function drvAsk(): Promise<void> {
  const r = drvRes;
  if (!r) return;
  drvPinned = {
    token: r.token,
    name: r.metric.name,
    section: String(currentSection || ''),
    analysisId: dashCurrent && dashCurrent.id ? String(dashCurrent.id) : '',
  };
  closeDriversPanel();
  const verb = typeof r.totals.delta === 'number' && r.totals.delta < 0 ? 'fall' : 'rise';
  if (typeof dkAsk === 'function') await dkAsk(t('driversEntry.why_did_from_to', { name: r.metric.name, verb, b: r.periods.b, a: r.periods.a }));
}

/**
 * The dock's context while a drivers question is pinned (dock.ts dkContextRef
 * asks this first). It lapses the moment the user is somewhere else.
 */
function drvDockContext(): { kind: string; id: string; label: string; name: string } | null {
  const p = drvPinned;
  if (!p) return null;
  const here = dashCurrent && dashCurrent.id ? String(dashCurrent.id) : '';
  if (String(currentSection || '') !== p.section || here !== p.analysisId) {
    drvPinned = null;
    return null;
  }
  return { kind: 'drivers', id: p.token, label: t('driversEntry.why', { name: p.name }), name: p.name };
}

async function drvAlertMe(): Promise<void> {
  const a = drvRes && drvRes.alert;
  if (!a) return;
  closeDriversPanel();
  await openAlertDialog({
    datasetId: a.datasetId,
    column: a.column,
    aggregation: a.aggregation,
    label: a.label,
    metricId: a.metricId,
    filters: a.filters,
    analysisId: dashCurrent && dashCurrent.id ? String(dashCurrent.id) : undefined,
    existing: { compare: 'change', change: { pct: 10, direction: a.direction, vs: 'previous_period', periodColumn: a.periodColumn } },
  });
}
