// Insights — the cards. What the app FOUND in the data, on three surfaces:
// Home ("What stands out"), a dataset's Insights tab, and the dashboard
// editor's Insights rail panel.
//
// ONE card builder, three callers. The surfaces differ only in which actions a
// card offers, so `insCard` takes the actions as an argument rather than
// growing a `mode` flag — and every card is a real `.dash-card`, so it picks up
// the dashboard tokens (surface, border, radius) in every theme for free.
//
// NOTHING HERE COMPUTES A NUMBER. Every figure a card prints came off
// `insights:list` (src/analysis/insights.ts); the sparkline is drawn by the
// SAME `visual:data` + `buildChart` pair a real chart uses, so a card and the
// tile you add from it cannot disagree.
//
// Classic global-scope renderer <script>: no import/export.

/** Cards in the Home row. Six is what fits before the row starts scrolling. */
const INS_HOME_MAX = 6;
/** The sparkline box, in CSS pixels. */
const INS_SPARK_W = 160;
const INS_SPARK_H = 56;

/** Last fetched list per surface, so a dismiss can repaint without a refetch. */
let insHomeList: any[] = [];
let insTabList: any[] = [];
let insRailList: any[] = [];

/** Chart.js instances drawn into cards, so a repaint destroys them first. */
const insCharts = new WeakMap<HTMLElement, any>();

function insEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function insFetch(datasetId?: string): Promise<any[]> {
  if (!currentProjectId) return [];
  try {
    const res: any = await window.hub.listInsights(currentProjectId, datasetId);
    return res && res.ok && Array.isArray(res.insights) ? res.insights : [];
  } catch (_) {
    return [];
  }
}

// ── The card ────────────────────────────────────────────────────────────────

interface InsAction {
  label: string;
  primary?: boolean;
  run: (ins: any) => void | Promise<void>;
}

/**
 * The chips are the app's own figures, read straight off `insight.facts`. Only
 * the three a card has room for, in a fixed order — a card is a headline, not a
 * table, and the full fact set is what the dock gets.
 */
const INS_CHIPS: ReadonlyArray<{ key: string; label: string; pct?: boolean }> = [
  { key: 'prev', label: 'prev' },
  { key: 'now', label: 'now' },
  { key: 'change', label: 'change' },
  { key: 'pctChange', label: 'change', pct: true },
  { key: 'share', label: 'share', pct: true },
  { key: 'total', label: 'total' },
];

function insChips(ins: any): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ins-chips';
  const facts = (ins && ins.facts) || {};
  let shown = 0;
  for (const c of INS_CHIPS) {
    if (shown >= 3) break;
    const v = facts[c.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    shown += 1;
    const chip = document.createElement('span');
    chip.className = 'ins-chip';
    const k = document.createElement('span');
    k.className = 'ins-chip-k';
    k.textContent = c.label;
    const n = document.createElement('span');
    n.className = 'ins-chip-v';
    // Printed, never derived: a percent fact is a ratio the app computed, and
    // ×100 is a UNIT change, not arithmetic on the figure.
    n.textContent = c.pct ? Math.round(v * 1000) / 10 + '%' : String(v);
    chip.appendChild(k);
    chip.appendChild(n);
    wrap.appendChild(chip);
  }
  return wrap;
}

/**
 * Draw the insight's own chart at card size. Silent on every failure — a card
 * without its sparkline is still a card with a number on it.
 */
async function insDrawSpark(ins: any, host: HTMLElement): Promise<void> {
  if (!ins || !ins.chart || !currentProjectId || typeof buildChart !== 'function') return;
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, ins.datasetId, ins.chart.encoding, ins.chart.filters || []);
  } catch (_) {
    return;
  }
  const data = res && res.ok !== false ? (res.data || res) : null;
  if (!data || !Array.isArray(data.labels) || !data.labels.length) return;

  const canvas = document.createElement('canvas');
  canvas.width = INS_SPARK_W;
  canvas.height = INS_SPARK_H;
  canvas.className = 'ins-spark-canvas';
  host.innerHTML = '';
  host.appendChild(canvas);
  const chart = buildChart(canvas, data, ins.chart.type || 'line', {
    showLegend: false,
    showGridlines: false,
    valueMode: 'off',
    yZero: false,
  });
  if (!chart) return;
  // A SPARKLINE HAS NO AXES. `buildChart` has no override for that — a real
  // chart always wants its ticks — so they are switched off on the instance
  // afterwards rather than by adding a card-only flag to a file every chart in
  // the app goes through. At 160x56 two dozen month labels are a grey smear,
  // and the figures are already on the chips above.
  try {
    for (const axis of Object.values(chart.options?.scales || {})) {
      if (axis && typeof axis === 'object') (axis as any).display = false;
    }
    chart.options.layout = { padding: 0 };
    chart.update('none');
  } catch (_) { /* a chart family with no scales (pie, gauge) — nothing to hide */ }
  insCharts.set(host, chart);
}

function insDestroySparks(root: HTMLElement): void {
  root.querySelectorAll('.ins-spark').forEach((h) => {
    const inst = insCharts.get(h as HTMLElement);
    if (inst && typeof inst.destroy === 'function') {
      try { inst.destroy(); } catch (_) { /* already gone */ }
    }
    insCharts.delete(h as HTMLElement);
  });
}

/**
 * One card. `onGone` is called after a successful dismiss so the caller can
 * drop it from its own list — the surfaces repaint from those lists.
 */
function insCard(ins: any, actions: InsAction[], onGone: (id: string) => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'dash-card ins-card';
  card.dataset.insightId = String(ins.id || '');

  const head = document.createElement('header');
  head.className = 'dash-card-head ins-head';
  const dot = document.createElement('span');
  // Severity is a dot, not a banner: a finding is information, not an alarm.
  dot.className = 'ins-dot' + (ins.severity === 'warn' ? ' ins-dot--warn' : '');
  dot.setAttribute('aria-hidden', 'true');
  head.appendChild(dot);
  const title = document.createElement('h3');
  title.className = 'dash-card-title ins-title';
  title.textContent = String(ins.title || '');
  title.title = String(ins.detail || '');
  head.appendChild(title);

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dash-card-btn ins-x';
  x.setAttribute('aria-label', 'Dismiss this insight');
  x.textContent = '×';
  x.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentProjectId) return;
    try {
      const res: any = await window.hub.dismissInsight(currentProjectId, String(ins.id));
      if (!res || res.ok === false) return;
    } catch (_) {
      return;
    }
    onGone(String(ins.id));
  });
  head.appendChild(x);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dash-card-body ins-body';
  body.appendChild(insChips(ins));

  if (ins.chart) {
    const spark = document.createElement('div');
    spark.className = 'ins-spark';
    body.appendChild(spark);
    void insDrawSpark(ins, spark);
  }

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'ins-actions';
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm' + (a.primary ? ' btn-primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); void a.run(ins); });
      row.appendChild(b);
    });
    body.appendChild(row);
  }

  card.appendChild(body);
  return card;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** A visual name derived from the app's own title. Never model text. */
function insVisualName(ins: any): string {
  return String(ins.title || 'Insight').slice(0, 80);
}

/**
 * Save the insight's chart as a real Visual. The card's `filters` travel with
 * it: a mover's chart is ABOUT one category, and a tile that quietly showed all
 * of them would not be the thing the card claims.
 */
async function insSaveVisual(ins: any): Promise<string | null> {
  if (!currentProjectId || !ins || !ins.chart) return null;
  try {
    const v: any = await window.hub.saveVisual({
      projectId: currentProjectId,
      datasetId: String(ins.datasetId),
      name: insVisualName(ins),
      chartType: String(ins.chart.type || 'line'),
      encoding: ins.chart.encoding,
      overrides: {},
      filters: ins.chart.filters || [],
    });
    return v && v.ok !== false && v.id ? String(v.id) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Home's "Add to dashboard": a saved visual, wrapped in a fresh one-sheet
 * dashboard, navigated to. `dkTurnIntoAnalysis` (dockPropose.ts) already does
 * exactly this for a proposed chart — same IPC, same sheet shape, one caller
 * more.
 */
async function insAddToDashboard(ins: any): Promise<void> {
  if (!ins.chart) return;
  const done = typeof dkTurnIntoAnalysis === 'function'
    && await dkTurnIntoAnalysis(String(ins.datasetId), insVisualName(ins),
      String(ins.chart.type || 'line'), ins.chart.encoding, ins.chart.filters || []);
  if (!done) showToast('Could not add that to a dashboard.');
}

/**
 * Home's "Ask why": open the dataset, then the dock, with the question already
 * typed. Deliberately does NOT send — the dock's context is resolved from the
 * surface the user is on, and they should see what is being asked.
 */
async function insAskWhy(ins: any): Promise<void> {
  if (typeof openSavedDataset === 'function') await openSavedDataset(String(ins.datasetId));
  if (typeof dkSetOpen === 'function') dkSetOpen(true);
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = 'Why: ' + String(ins.title || '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* not focusable yet */ }
}

/** The dataset tab's "Explain": the column profile panel, on the column. */
function insExplain(ins: any): void {
  const c = typeof expColumns !== 'undefined'
    ? expColumns.findIndex((col: any) => col && col.name === ins.column)
    : -1;
  if (c < 0 || typeof dsOpenProfile !== 'function') {
    showToast('That insight is not about one column.');
    return;
  }
  void dsOpenProfile(c);
}

/** The rail's "+ Add": one more tile on the open sheet, through dashAdd's path. */
async function insAddTile(ins: any): Promise<void> {
  const visualId = await insSaveVisual(ins);
  if (!visualId) { showToast('Could not add that tile.'); return; }
  // pushCard → markDashDirty → renderDashGrid: the same three steps every Add
  // takes, which is what puts this on the undo stack with everything else.
  pushCard({
    id: dashUuid(),
    type: 'visual',
    visualId,
    layout: { ...dashFindSlot(dashCards(), 6, 6), w: 6, h: 6 },
  });
}

// ── Surface 1: Home ─────────────────────────────────────────────────────────

/**
 * "What stands out", between the ask bar and the two-column body.
 *
 * NO EMPTY STATE: with nothing to say the section does not render at all.
 * Home already has a greeting, an ask bar and two filled columns; a panel
 * explaining that there is no panel is furniture.
 */
async function insRenderHome(): Promise<void> {
  const sec = insEl('home-insights');
  const row = insEl('home-insights-row');
  if (!sec || !row) return;
  insHomeList = (await insFetch()).filter((i: any) => i.chart).slice(0, INS_HOME_MAX);
  insPaintHome();
}

function insPaintHome(): void {
  const sec = insEl('home-insights');
  const row = insEl('home-insights-row');
  if (!sec || !row) return;
  insDestroySparks(row);
  row.innerHTML = '';
  sec.hidden = insHomeList.length === 0;
  if (!insHomeList.length) return;
  const gone = (id: string): void => {
    insHomeList = insHomeList.filter((i) => i.id !== id);
    insPaintHome();
  };
  insHomeList.forEach((ins) => {
    row.appendChild(insCard(ins, [
      { label: 'Add to dashboard', primary: true, run: insAddToDashboard },
      { label: 'Ask why', run: insAskWhy },
    ], gone));
  });
}

// ── Surface 2: the dataset's Insights tab ───────────────────────────────────

const INS_KIND_LABELS: Record<string, string> = {
  mover: 'Biggest movers',
  trend: 'Trends',
  concentration: 'Concentration',
  period_change: 'Period changes',
  numeric_outlier: 'Outliers',
  dominant_category: 'Dominant values',
  empty_heavy: 'Mostly empty',
  constant_column: 'Never changes',
};

async function insRenderDatasetTab(): Promise<void> {
  const host = insEl('ds-insights-body');
  if (!host) return;
  insTabList = typeof expId === 'string' && expId ? await insFetch(expId) : [];
  insPaintDatasetTab();
}

function insPaintDatasetTab(): void {
  const host = insEl('ds-insights-body');
  if (!host) return;
  insDestroySparks(host);
  host.innerHTML = '';
  if (!insTabList.length) {
    const empty = document.createElement('p');
    empty.className = 'ds-empty-note';
    empty.textContent =
      'Nothing stands out yet. Insights appear when a dataset has a date column and at ' +
      'least two periods, or a category with an outsized share.';
    host.appendChild(empty);
    return;
  }
  const gone = (id: string): void => {
    insTabList = insTabList.filter((i) => i.id !== id);
    insPaintDatasetTab();
  };
  // Grouped by kind, in the order the labels above declare, each with its count.
  for (const kind of Object.keys(INS_KIND_LABELS)) {
    const group = insTabList.filter((i) => i.kind === kind);
    if (!group.length) continue;
    const h = document.createElement('h3');
    h.className = 'ins-group-h';
    h.textContent = INS_KIND_LABELS[kind];
    const n = document.createElement('span');
    n.className = 'ins-group-n';
    n.textContent = String(group.length);
    h.appendChild(n);
    host.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'ins-grid';
    group.forEach((ins) => {
      grid.appendChild(insCard(ins, ins.column ? [{ label: 'Explain', run: insExplain }] : [], gone));
    });
    host.appendChild(grid);
  }
}

// ── Surface 3: the dashboard editor's Insights rail panel ───────────────────

/** The datasets the open dashboard actually uses — metric cards name one
 *  directly, visual cards name one through their saved Visual. */
async function insDashboardDatasets(): Promise<string[]> {
  const ids = new Set<string>();
  const cards = typeof dashCards === 'function' ? dashCards() : [];
  const visualIds = new Set<string>();
  for (const c of cards || []) {
    if (c && c.type === 'metric' && c.metric && c.metric.datasetId) ids.add(String(c.metric.datasetId));
    if (c && c.type === 'visual' && c.visualId) visualIds.add(String(c.visualId));
  }
  if (visualIds.size && currentProjectId) {
    try {
      const list: any[] = await window.hub.listVisuals(currentProjectId);
      for (const v of Array.isArray(list) ? list : []) {
        if (visualIds.has(String(v.id)) && v.datasetId) ids.add(String(v.datasetId));
      }
    } catch (_) { /* no visuals list — metric cards still contribute */ }
  }
  return [...ids];
}

async function insRenderRail(): Promise<void> {
  const host = insEl('an-insights-body');
  if (!host) return;
  const ids = await insDashboardDatasets();
  const all: any[] = [];
  for (const id of ids) all.push(...await insFetch(id));
  insRailList = all.filter((i: any) => i.chart);
  insPaintRail();
}

function insPaintRail(): void {
  const host = insEl('an-insights-body');
  if (!host) return;
  insDestroySparks(host);
  host.innerHTML = '';
  if (!insRailList.length) {
    const hint = document.createElement('p');
    hint.className = 'an-pane-hint';
    hint.textContent = 'Nothing stands out in the datasets this dashboard uses.';
    host.appendChild(hint);
    return;
  }
  const gone = (id: string): void => {
    insRailList = insRailList.filter((i) => i.id !== id);
    insPaintRail();
  };
  insRailList.forEach((ins) => {
    host.appendChild(insCard(ins, [{ label: '+ Add', primary: true, run: insAddTile }], gone));
  });
}
