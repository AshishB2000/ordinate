'use strict';

// The Metrics tab, under Data, beside Datasets and Captures.
// Classic global-scope renderer <script>: no import/export.
//
// Metrics are what a project's data MEANS — "Revenue" rather than "sum of the
// revenue column" — so they live where the project's data lives: a third tab on
// the Data page, driven by captureList.ts's tab strip.
//
// Nothing here is metric-specific design: the table is `.ws-table` /
// `.ws-table-cols` / `.ws-row` (the dataset list's), the empty state is
// `.ws-empty`, and the sparkline is `aiSparkline` (alertsInbox.ts) — the same
// 96×24 line the alert inbox draws, over app-computed values, for the same
// reason. Only `.mp-*` is new, and it is column widths and a format chip.
//
// EVERY FIGURE IS MAIN'S, and so is every string that renders one. A row shows
// `display` from `metric:value` and `definitionText` from `metric:list`; this
// file formats nothing.

let mpLoaded = false;
/** The rows currently on screen, so a save can repaint without a full reload. */
let mpMetrics: any[] = [];

function mpEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** The format chip's word — the picker's badge, same rule, same vocabulary. */
function mpFormatBadge(format: any): string {
  return mpkFormatBadge(format);
}

/**
 * One row: name, dataset, definition, format, value, sparkline, used-in.
 *
 * The three async cells (value, sparkline, used-in) each fill themselves in
 * AFTER the row is on screen, and each checks its cell is still in the document
 * before writing — a project switch mid-flight must not paint a figure from the
 * previous project into the new one's table.
 */
function mpMakeRow(m: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ws-row mp-row';
  row.dataset.metricId = String(m.id);

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'mp-name';
  name.textContent = m.name;
  if (m.description) name.title = m.description;
  name.addEventListener('click', () => void mpOpenEditor(m));
  ctDecorate(row, 'metric', String(m.id), name); // catalog tag chips

  const dataset = document.createElement('span');
  dataset.className = 'ws-cell';
  dataset.textContent = m.datasetName || t('metricsPage.missing_dataset');

  const definition = document.createElement('span');
  definition.className = 'ws-cell mp-def';
  definition.textContent = m.definitionText || '';
  definition.title = m.definitionText || '';

  const format = document.createElement('span');
  format.className = 'mp-badge';
  format.textContent = mpFormatBadge(m.format);

  const value = document.createElement('span');
  value.className = 'mp-value tnum';
  value.textContent = '…';

  const spark = document.createElement('span');
  spark.className = 'mp-spark';

  const used = document.createElement('span');
  used.className = 'ws-cell mp-used';
  used.textContent = '…';

  // ONE ⋯, not three text buttons — dashGrid.ts's card menu makes the same
  // call for the same reason. Three buttons needed a 236px track in an
  // eight-column table, which pushed the whole thing into a horizontal
  // scrollbar; the menu needs 40. `openMiniMenu` (chartControls.ts) is the
  // hub's existing popover, so positioning, Escape and outside-click are done.
  const actions = document.createElement('span');
  actions.className = 'ws-col-action mp-actions';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn btn-sm mp-more';
  more.setAttribute('aria-label', t('metricsPage.actions_for', { name: m.name }));
  more.setAttribute('aria-haspopup', 'menu');
  more.appendChild(icon('more-horizontal'));
  more.addEventListener('click', () => {
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      const items: Array<[string, () => void]> = [
        [t('common.edit'), () => void mpOpenEditor(m)],
        [t('common.alert_me'), () => void mpAlert(m)],
        [t('common.duplicate'), () => void mpDuplicate(m)],
        ['Delete', () => void mpDelete(m)],
      ];
      items.forEach(([label, run], i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chart-menu-item' + (i === items.length - 1 ? ' dash-card-menu-rm' : '');
        row.textContent = label;
        // close() FIRST: every one of these re-renders the list, which destroys
        // the anchor this menu is positioned against.
        row.addEventListener('click', () => { close(); run(); });
        menu.appendChild(row);
      });
    });
  });
  actions.appendChild(more);

  [name, dataset, definition, format, value, spark, used, actions].forEach((c) => row.appendChild(c));

  void (async () => {
    let r: any;
    try {
      r = await window.hub.metricValue(currentProjectId, m.id);
    } catch (_) {
      r = null;
    }
    if (!value.isConnected) return;
    value.textContent = r && r.ok !== false ? (r.display || '—') : '—';
  })();

  void (async () => {
    let r: any;
    try {
      r = await window.hub.metricSeries(currentProjectId, m.id);
    } catch (_) {
      r = null;
    }
    if (!spark.isConnected) return;
    const values = r && r.ok !== false && r.series ? r.series.values : null;
    // A dataset with no date column has no trend to draw, and a flat "—" in its
    // place would read as a failure rather than as an absence.
    const line = Array.isArray(values) ? aiSparkline(values.filter((v: any) => typeof v === 'number')) : null;
    if (line) spark.appendChild(line);
  })();

  void (async () => {
    let r: any;
    try {
      r = await window.hub.metricUsage(currentProjectId, m.id);
    } catch (_) {
      r = null;
    }
    if (!used.isConnected) return;
    const usage = r && r.ok !== false ? r.usage : null;
    used.textContent = usage && usage.total ? usage.summary : t('common.not_used_yet');
    used.classList.toggle('mp-unused', !(usage && usage.total));
  })();

  return row;
}

/**
 * Load and paint the table.
 *
 * `ensureDefaults` rather than `list` on the FIRST load of a project: a Metrics
 * page that opens empty asks the user to do the naming work before it will show
 * them anything, on a project whose columns already say what its measures are.
 * It seeds only when there are none, so a metric someone deleted stays deleted.
 */
async function refreshMetricsList(seed = true): Promise<void> {
  const list = mpEl('mp-list');
  const empty = mpEl('mp-empty');
  if (!list) return;

  mpMetrics = [];
  if (currentProjectId) {
    let res: any;
    try {
      res = seed
        ? await window.hub.ensureDefaultMetrics(currentProjectId)
        : await window.hub.listMetrics(currentProjectId);
    } catch (_) {
      res = null;
    }
    mpMetrics = res && res.ok && Array.isArray(res.metrics) ? res.metrics : [];
  }

  list.innerHTML = '';
  mpMetrics.forEach((m) => list.appendChild(mpMakeRow(m)));
  void ctAfterPaint(list, list.previousElementSibling as HTMLElement | null); // catalog tag bar + chips
  list.hidden = mpMetrics.length === 0;
  if (empty) empty.hidden = mpMetrics.length > 0;
  mpLoaded = true;

  // Hidden at zero, like the Visuals header's: "0 defined" over an empty state
  // that already says there are none is the count telling you twice.
  const count = mpEl('mp-count');
  if (count) {
    count.textContent = mpMetrics.length === 1 ? t('metricsPage.1_metric') : `${mpMetrics.length} metrics`;
    count.hidden = mpMetrics.length === 0;
  }
}

async function mpOpenEditor(existing: any): Promise<void> {
  // The editor takes the FULL record — the list carries a summary, and a
  // summary has no filters on it, so opening one to edit would silently drop
  // them on save.
  let full = existing;
  if (existing) {
    let r: any;
    try {
      r = await window.hub.getMetric(currentProjectId, existing.id);
    } catch (_) {
      r = null;
    }
    if (r && r.ok !== false) full = r.metric;
  }
  const saved = await openMetricEditor(full);
  if (saved) await refreshMetricsList(false);
}

/**
 * Watch this metric.
 *
 * Opens the ordinary alert dialog (alerts.ts) with `metricId` set, so the rule
 * that comes out is about THIS metric — it shows up in the metric's usage, and
 * deleting the metric warns about it.
 *
 * A FORMULA metric is refused and says why: the evaluator reads
 * `{column, aggregation}` off the rule, and `[Profit] / [Revenue]` has neither.
 * Making it work means teaching `alertStore.metricFor` to resolve a metric,
 * which is a change to the evaluator rather than a field on a rule.
 */
async function mpAlert(m: any): Promise<void> {
  const def = m.definition || {};
  if (typeof def.formula === 'string') {
    showToast(t('common.alerts_watch_a_column_rolled_up'));
    return;
  }
  if (!def.column) { showToast(t('common.this_metric_has_no_column_to')); return; }
  await openAlertDialog({
    datasetId: String(m.datasetId),
    column: String(def.column),
    aggregation: String(def.aggregation || 'sum'),
    label: m.name,
    metricId: String(m.id),
  });
  await refreshMetricsList(false);
}

async function mpDuplicate(m: any): Promise<void> {
  try {
    await window.hub.duplicateMetric(currentProjectId, m.id);
  } catch (_) { /* a copy that could not be written is reported by the reload */ }
  await refreshMetricsList(false);
}

/**
 * Delete, with the usage read FIRST.
 *
 * The confirm names what would break ("Used by 4 cards and 1 alert") because
 * that is the only fact that makes this decision answerable. Nothing is
 * blocked: a card whose metric is gone falls back to its own stored column and
 * aggregation, the same graceful degrade a dangling visualId already gets.
 */
async function mpDelete(m: any): Promise<void> {
  let usage: any = null;
  try {
    const r = await window.hub.metricUsage(currentProjectId, m.id);
    if (r && r.ok !== false) usage = r.usage;
  } catch (_) { /* a usage read that failed must not claim "used by nothing" */ }

  const used = usage && usage.total
    ? t('metricsPage.used_by_those_keep_working_from', { summary: usage.summary })
    : usage
      ? t('metricsPage.nothing_uses_it_yet')
      : t('metricsPage.ordinate_could_not_check_what_uses');
  // `window.confirm`, like every other destructive action in the hub
  // (dsList, captureList, connRun): a bespoke confirm dialog for this one
  // button would be a second modal to keep accessible.
  if (!window.confirm(t('metricsPage.delete', { name: m.name, used }))) return;
  try {
    await window.hub.deleteMetric(currentProjectId, m.id);
  } catch (_) { /* reported by the reload */ }
  await refreshMetricsList(false);
}

/**
 * "Save as metric…" for a surface that has a definition in hand.
 *
 * The inline promote: a KPI card's ⋯ and a builder measure chip both have a
 * `{datasetId, column, aggregation, label}` already, so the editor opens
 * prefilled rather than asking for it again. Returns the saved metric so the
 * caller can link itself to it.
 */
async function promoteToMetric(seed: {
  datasetId: string; column?: string; aggregation?: string; label?: string;
}): Promise<any> {
  // A prefill, not a record: `openMetricEditor` creates rather than updates
  // whenever the draft has no id, so this opens "New metric" with the boxes
  // already filled from the card.
  const saved = await openMetricEditor({
    name: seed.label || '',
    datasetId: seed.datasetId,
    definition: { column: seed.column || '', aggregation: seed.aggregation || 'sum' },
    filters: [],
    format: {},
  }, { datasetId: seed.datasetId });
  if (saved && mpLoaded) await refreshMetricsList(false);
  return saved;
}

/**
 * The ⋯ items a METRIC CARD gets, concatenated by dashGrid's menu builder the
 * same way `alCardMenuItems` is. A card that already names a metric offers the
 * metric instead of offering to make a second one.
 */
function mpCardMenuItems(card: any): Array<[string, () => void]> {
  if (!card || card.type !== 'metric' || !card.metric) return [];
  const m = card.metric;
  if (m.metricId) {
    return [[t('metricsPage.edit_metric'), () => {
      void (async () => {
        const r = await window.hub.getMetric(currentProjectId, m.metricId);
        if (r && r.ok !== false) await openMetricEditor(r.metric);
      })();
    }]];
  }
  return [[t('metricsPage.save_as_metric'), () => {
    void (async () => {
      const saved = await promoteToMetric({
        datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, label: m.label,
      });
      // Linking the card is what makes this a promote rather than a second
      // definition standing beside the first.
      if (saved) {
        m.metricId = saved.id;
        if (!m.label) m.label = saved.name;
        // The same "the card changed, write it and redraw" call every other ⋯
        // item makes (dashGrid.ts's nudgeCard / resizeCard).
        markDashDirty(t('metricsPage.save_as_metric_2'));
      }
    })();
  }]];
}

// ── Boot wiring (once) ──────────────────────────────────────────────────────
function initMetricsPage(): void {
  const newBtn = mpEl('mp-new');
  if (newBtn) newBtn.addEventListener('click', () => void mpOpenEditor(null));
  const emptyNew = mpEl('mp-empty-new');
  if (emptyNew) emptyNew.addEventListener('click', () => void mpOpenEditor(null));
}
