// A dashboard KPI card under a WHAT-IF SCENARIO — the card's figure as the
// scenario has it, a "Scenario: Price +5%" chip, and the change on the baseline
// in the card's ordinary delta pill. RENDERER ONLY. Classic global-scope
// <script>: no import/export. Loads after kpiCompare.js.
//
// Nothing here computes a figure: `scenario:card` (src/ipc/scenarios.ts)
// resolves the metric twice under the dashboard's effective filters and
// parameters — baseline and scenario — and a driver bound to a parameter takes
// that parameter's current value, so a filter-bar slider moves the scenario.
// The card stores only which scenario it wants (`card.metric.scenarioId`).

/**
 * Paint a metric card from its scenario. False when there is nothing to paint
 * (no scenario, an "As of" view, or the scenario is gone) — the card then shows
 * its ordinary figure, the way a card with a deleted metric degrades.
 */
async function snPaintScenarioCard(card: any, body: HTMLElement, valEl: HTMLElement, labelEl: HTMLElement): Promise<boolean> {
  const m = card && card.metric;
  if (!m || !m.scenarioId || !m.metricId || !currentProjectId || snapDashAsOf) return false;
  let r: any = null;
  try {
    r = await window.hubScenarios.card(currentProjectId, m.scenarioId, m.metricId, effectiveFilters(), dashParamPayload());
  } catch (_) {
    r = null;
  }
  if (!r || r.ok === false) return false;
  valEl.textContent = r.display || '—';
  if (!m.label && r.name) labelEl.textContent = r.name;

  // Three lines in a two-row card, as Compare lays them out: the figure, the
  // change on the baseline, then the chip. The label goes when the title says it.
  const title = (body.closest('.dash-card')?.querySelector('.dash-card-title')?.textContent || '').trim();
  if ((labelEl.textContent || '').trim() === title) labelEl.hidden = true;
  body.classList.add('has-delta');
  const base = t('common.baseline', { p0: (r.baselineDisplay || '—') });
  if (typeof r.delta === 'number' && r.delta !== 0) {
    const row = document.createElement('div');
    row.className = 'dash-metric-delta ' + (r.tone === 'good' ? 'is-good' : r.tone === 'bad' ? 'is-bad' : 'is-flat');
    row.title = base;
    row.appendChild(icon(r.delta > 0 ? 'arrow-up' : 'arrow-down', 12));
    const val = document.createElement('span');
    val.className = 'dash-metric-delta-val tnum';
    val.textContent = r.deltaDisplay;
    row.appendChild(val);
    if (typeof r.pct === 'number' && Number.isFinite(r.pct)) {
      const pct = document.createElement('span');
      pct.className = 'dash-metric-delta-pct tnum';
      pct.textContent = '(' + kpiPct(r.pct) + ')';
      row.appendChild(pct);
    }
    body.appendChild(row);
  }
  const chip = document.createElement('div');
  chip.className = 'dash-metric-scn';
  chip.title = t('scenarioCard.a_what_if', { p0: base.toLowerCase() });
  const tv = document.createElement('span');
  tv.textContent = t('scenarioCard.scenario', { scenarioName: r.scenarioName });
  chip.append(icon('sliders', 12), tv);
  body.appendChild(chip);
  return true;
}

/** The Scenario section of a metric card's Properties, beside Compare. Writes `card.metric.scenarioId`. */
async function snRenderKpiScenarioProps(card: any, host: HTMLElement): Promise<void> {
  const m = card && card.metric;
  if (!m || !m.metricId || !currentProjectId) return;
  const sec = document.createElement('div');
  sec.className = 'sn-kpi-props';
  const h = document.createElement('div');
  h.className = 'an-kpi-props-h';
  const tv = document.createElement('span');
  tv.textContent = t('common.scenario');
  h.append(icon('sliders', 14), tv);
  const sel = document.createElement('select');
  sel.className = 'an-prop-input';
  sel.setAttribute('aria-label', t('scenarioCard.show_this_metric_under_a_scenario'));
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('scenarioCard.baseline_no_scenario');
  sel.appendChild(none);
  const note = document.createElement('p');
  note.className = 'an-prop-note an-prop-note--info';
  note.textContent = t('scenarioCard.shows_the_figure_under_a_saved');
  sec.append(h, sel, note);
  host.appendChild(sec); // placed now, filled below — so it keeps its place in the panel

  let list: any[] = [];
  try { list = await window.hubScenarios.list(currentProjectId); } catch (_) { list = []; }
  if (!sec.isConnected) return;
  for (const s of Array.isArray(list) ? list : []) {
    const o = document.createElement('option');
    o.value = String(s.id);
    o.textContent = String(s.name);
    sel.appendChild(o);
  }
  sel.value = m.scenarioId && list.some((s) => String(s.id) === m.scenarioId) ? m.scenarioId : '';
  if (!list.length) {
    sel.disabled = true;
    note.textContent = t('scenarioCard.no_scenarios_in_this_project_yet');
  }
  sel.addEventListener('change', () => {
    if (sel.value) m.scenarioId = sel.value;
    else delete m.scenarioId;
    markDashDirty(t('common.scenario'));
    renderDashGrid();
    anPaintSelection();
  });
}
