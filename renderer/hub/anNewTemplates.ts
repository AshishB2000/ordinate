// The create-dashboard wizard's TEMPLATE GALLERY and MAP COLUMNS step.
//
// Split out of anNew.ts (.claude/rules/file-size.md): that file owns the wizard
// — its steps, its footer, its two create routes — and this one owns the two
// panes templates added. Classic global-scope renderer <script>: no
// import/export. Loads AFTER chartRender.js (whose `buildChart` draws the card
// thumbnails) and BEFORE anNew.js.
//
// THUMBNAILS ARE REAL CHARTS. Each card's picture is the template's signature
// chart type, drawn by the SAME `buildChart` the app draws every chart with,
// from a tiny fixture series — not a hand-drawn SVG that can drift from what
// the app actually renders. Rendered once per chart type into an offscreen
// canvas and cached as a data URL, so a repaint of the gallery costs nothing.
//
// NOTHING HERE COMPUTES A FIGURE. The mapping step's KPI preview asks MAIN for
// each number through `dashboard:metric` — the exact channel the built tile
// will call — and shows "—" when it comes back null. The renderer never does
// arithmetic on data.

// ── Thumbnails ──────────────────────────────────────────────────────────────

const AN_TPL_THUMB_W = 200;
const AN_TPL_THUMB_H = 92;

/** Six periods and two series: enough labels for a funnel (which needs 3) and
 *  enough series for a clustered column, and the same numbers for every card so
 *  the row reads as one family rather than six unrelated pictures. */
const AN_TPL_FIXTURE = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
  series: [
    { name: 'This year', values: [38, 52, 46, 67, 74, 88] },
    { name: 'Last year', values: [30, 34, 41, 45, 52, 58] },
  ],
};

/** chartType → a rendered data URL. */
const anTplThumbCache = new Map<string, string>();

/** Off-screen host for the one canvas a thumbnail is drawn on. Attached to the
 *  document because Chart.js measures its canvas; positioned out of the way
 *  from JS, never an inline `style=` (the hub CSP forbids those). */
function anTplThumbHost(): HTMLElement {
  let host = document.getElementById('an-tpl-thumb-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'an-tpl-thumb-host';
    host.setAttribute('aria-hidden', 'true');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = AN_TPL_THUMB_W + 'px';
    host.style.height = AN_TPL_THUMB_H + 'px';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * A data URL of `chartType` drawn from the fixture, or '' when that type cannot
 * be drawn (a card then keeps its plain tile, exactly like vizThumbs.ts does).
 *
 * `noAnimate` is load-bearing: `toDataURL()` reads whatever is on the canvas
 * NOW, and an animating chart is a blank one for the first frame.
 */
function anTplThumbUrl(chartType: string): string {
  if (!chartType) return '';
  const cached = anTplThumbCache.get(chartType);
  if (cached !== undefined) return cached;
  let url = '';
  let chart: any = null;
  const canvas = document.createElement('canvas');
  canvas.width = AN_TPL_THUMB_W;
  canvas.height = AN_TPL_THUMB_H;
  try {
    anTplThumbHost().appendChild(canvas);
    chart = buildChart(canvas, AN_TPL_FIXTURE as any, chartType, {
      noAnimate: true, showLegend: false, showGridlines: false, valueMode: 'off', title: '',
    });
    if (chart) {
      const o = chart.options || {};
      o.events = [];
      Object.keys(o.scales || {}).forEach((k) => {
        const s = (o.scales as any)[k];
        if (!s) return;
        s.ticks = Object.assign({}, s.ticks, { display: false });
        s.grid = Object.assign({}, s.grid, { display: false, drawOnChartArea: false });
        s.border = Object.assign({}, s.border, { display: false });
        if (s.title) s.title.display = false;
      });
      chart.update('none');
      url = canvas.toDataURL('image/png');
    }
  } catch (_) {
    url = ''; // an undrawable type keeps the plain tile — never break the card
  }
  try { if (chart) chart.destroy(); } catch (_) { /* torn down already */ }
  canvas.remove();
  anTplThumbCache.set(chartType, url);
  return url;
}

// ── The gallery ─────────────────────────────────────────────────────────────

/** "Needs: date, revenue, category" — the REQUIRED roles, lower-cased. */
function anTplNeedsLine(tpl: any): string {
  const req = (tpl.roles || []).filter((r: any) => r.required).map((r: any) => String(r.label).toLowerCase());
  return req.length ? 'Needs: ' + req.join(', ') : '';
}

/**
 * The six subject cards, as one row above the layouts.
 *
 * A card whose REQUIRED roles could not map on the chosen dataset is DIMMED and
 * disabled, with the mapper's own reason underneath ("Needs a cost column"), so
 * the gallery never offers a dashboard it cannot build.
 */
function anTplRenderGallery(host: HTMLElement, templates: any[], picked: string, onPick: (id: string) => void): void {
  host.innerHTML = '';
  for (const tpl of templates) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'an-wiz-tpl';
    card.dataset.tpl = String(tpl.id);
    card.setAttribute('role', 'radio');
    const blocked = !!tpl.reason;
    card.disabled = blocked;
    card.classList.toggle('is-blocked', blocked);
    const on = !blocked && picked === tpl.id;
    card.classList.toggle('is-selected', on);
    card.setAttribute('aria-checked', on ? 'true' : 'false');

    const art = document.createElement('span');
    art.className = 'an-wiz-tpl-art';
    // A user template's picture is the dashboard it was saved from (r7:templates).
    const url = tpl.thumbnail ? String(tpl.thumbnail) : anTplThumbUrl(String(tpl.thumb || ''));
    if (url) {
      const img = document.createElement('img');
      img.className = 'an-wiz-tpl-img';
      img.src = url;
      img.alt = '';
      art.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'an-wiz-tpl-t';
    name.textContent = String(tpl.name || '');
    const needs = document.createElement('span');
    needs.className = 'an-wiz-tpl-needs';
    needs.textContent = blocked ? String(tpl.reason) : anTplNeedsLine(tpl);
    card.appendChild(art);
    card.appendChild(name);
    card.appendChild(needs);
    card.title = blocked ? String(tpl.reason) : String(tpl.blurb || '');
    card.addEventListener('click', () => { if (!blocked) onPick(String(tpl.id)); });
    host.appendChild(card);
  }
}

// ── The mapping step ────────────────────────────────────────────────────────

const AN_TPL_SKIP = '';
/** How long to wait after a select changes before asking main to re-plan. A
 *  mapping change is two IPC round-trips plus one per KPI; a user walking down
 *  five selects should cost one refresh, not five. */
const AN_TPL_DEBOUNCE_MS = 220;

interface AnTplMapApi {
  el: HTMLElement;
  /** Point the pane at a template + dataset and render its rows. */
  load(projectId: string, datasetId: string, tpl: any, columns: any[], name: string): void;
  /** The current role → column mapping, Skips omitted. */
  mapping(): Record<string, string>;
  /** The plan main last built from that mapping, for Create. */
  plan(): any;
}

/**
 * One row per role: the role's name, a select over the dataset's columns
 * (preselected from `mapRoles`), the dataset's own type glyph, and a confidence
 * dot. Below them, a live line saying how much of the template will be built and
 * a KPI strip showing REAL figures for the current mapping.
 */
function anTplMapPane(): AnTplMapApi {
  const el = document.createElement('div');
  el.className = 'an-wiz-pane an-tpl-map';

  const rows = document.createElement('div');
  rows.className = 'an-tpl-rows';
  const summary = document.createElement('p');
  summary.className = 'an-tpl-summary';
  const previewWrap = document.createElement('div');
  previewWrap.className = 'an-tpl-preview';
  const previewH = document.createElement('span');
  previewH.className = 'an-tpl-preview-h';
  previewH.textContent = 'Preview';
  const kpis = document.createElement('div');
  kpis.className = 'an-tpl-kpis';
  previewWrap.appendChild(previewH);
  previewWrap.appendChild(kpis);
  el.appendChild(rows);
  el.appendChild(summary);
  el.appendChild(previewWrap);

  let projectId = '';
  let datasetId = '';
  let dashName = '';
  let tpl: any = null;
  let picks: Record<string, string> = {};
  let lastPlan: any = null;
  /** Tiles the template builds when EVERY role maps — the denominator of
   *  "2 tiles will be skipped". Captured from the preselected mapping, which is
   *  the most complete one this dataset can produce. */
  let maxTiles = 0;
  let timer: any = null;
  /** Only the newest refresh may write to the DOM: the selects are faster than
   *  the round-trip and an out-of-order reply would show the wrong numbers. */
  let seq = 0;

  function mapping(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of Object.keys(picks)) if (picks[k]) out[k] = picks[k];
    return out;
  }

  function tilesIn(plan: any): number {
    const sheets = (plan && plan.sheets) || [];
    return sheets.reduce((n: number, s: any) =>
      n + (s.metrics || []).length + (s.visuals || []).length + (s.controls || []).length, 0);
  }

  function renderRows(): void {
    rows.innerHTML = '';
    const byName = new Map<string, string>(
      (tpl.columns || []).map((c: any) => [String(c.name), String(c.type || 'text')] as [string, string]));
    for (const role of tpl.roles || []) {
      const row = document.createElement('label');
      row.className = 'an-tpl-row';
      const label = document.createElement('span');
      label.className = 'an-tpl-role';
      label.textContent = String(role.label);
      if (!role.required) {
        const opt = document.createElement('span');
        opt.className = 'an-wiz-optional';
        opt.textContent = 'Optional';
        label.appendChild(opt);
      }
      const sel = document.createElement('select');
      sel.className = 'ws-modal-input an-tpl-select';
      sel.setAttribute('aria-label', String(role.label) + ' column');
      if (!role.required) {
        const skip = document.createElement('option');
        skip.value = AN_TPL_SKIP;
        skip.textContent = 'Skip';
        sel.appendChild(skip);
      }
      for (const c of tpl.columns || []) {
        const o = document.createElement('option');
        o.value = String(c.name);
        o.textContent = String(c.name);
        sel.appendChild(o);
      }
      sel.value = picks[role.id] || AN_TPL_SKIP;
      // A required role with nothing mapped falls back to the first column
      // rather than an empty select, so Create is never blocked by a blank.
      if (role.required && !sel.value && sel.options.length) {
        sel.selectedIndex = 0;
        picks[role.id] = sel.value;
      }
      const badge = document.createElement('span');
      badge.className = 'ds-type an-tpl-glyph';
      const paintBadge = (): void => {
        const t = byName.get(sel.value) || '';
        badge.className = 'ds-type an-tpl-glyph ds-type-' + (t || 'text');
        badge.textContent = t || '—';
        badge.hidden = !sel.value;
      };
      const dot = document.createElement('span');
      dot.className = 'an-tpl-dot';
      const match = (tpl.matches || []).find((m: any) => m.role === role.id);
      const paintDot = (): void => {
        // The dot reports how confident the MAPPER was — so a column the user
        // chose themselves carries no claim, and says so.
        const auto = match && match.column === sel.value;
        const conf = auto ? String(match.confidence) : sel.value ? 'chosen' : 'none';
        dot.className = 'an-tpl-dot is-' + conf;
        dot.title =
          conf === 'high' ? 'Matched confidently'
          : conf === 'medium' ? 'Best match — worth a look'
          : conf === 'low' ? 'A guess — check this one'
          : conf === 'chosen' ? 'You chose this column'
          : 'Not mapped';
      };
      sel.addEventListener('change', () => {
        picks[role.id] = sel.value;
        paintBadge();
        paintDot();
        schedule();
      });
      paintBadge();
      paintDot();
      row.appendChild(label);
      row.appendChild(sel);
      row.appendChild(badge);
      row.appendChild(dot);
      rows.appendChild(row);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { refresh(); }, AN_TPL_DEBOUNCE_MS);
  }

  /**
   * Ask main for the plan this mapping produces, then show what it will build.
   *
   * THE SAME TWO CHANNELS THE BUILD USES: `template:plan` is the factory the
   * Create button runs, and `analysis:previewPlan` is the validator's own
   * verdict on it — so the count here is what appears, not an estimate. The
   * figures come from `dashboard:metric`, which is what the built KPI tile
   * calls; previewPlan deliberately returns no numbers at all.
   */
  async function refresh(): Promise<void> {
    const mine = ++seq;
    const mapped = Object.keys(mapping()).length;
    const total = (tpl.roles || []).length;
    if (tpl.user) { await utRefreshMapping(mine, mapped, total); return; }
    let res: any = null;
    try {
      res = await window.hub.templatePlan({
        projectId, datasetId, templateId: String(tpl.id), mapping: mapping(), name: dashName,
      });
    } catch (_) { res = null; }
    if (mine !== seq) return;
    if (!res || res.ok === false || !res.plan) {
      lastPlan = null;
      summary.textContent = (res && res.error) || 'This mapping cannot be built.';
      kpis.innerHTML = '';
      return;
    }
    lastPlan = res.plan;
    let preview: any = null;
    try {
      preview = await window.hub.previewAnalysisPlan(projectId, res.plan);
    } catch (_) { preview = null; }
    if (mine !== seq) return;
    const shown = preview && preview.ok !== false ? preview : null;
    const tiles = shown ? tilesIn({ sheets: shown.sheets }) : tilesIn(res.plan);
    if (!maxTiles) maxTiles = tiles;
    const skipped = Math.max(0, maxTiles - tiles);
    summary.textContent =
      `${mapped} of ${total} mapped · ${tiles} tile${tiles === 1 ? '' : 's'} will be built`
      + (skipped ? ` · ${skipped} skipped` : '');
    const metrics = (shown && shown.sheets && shown.sheets[0] && shown.sheets[0].metrics) || [];
    await paintKpis(metrics, mine);
  }

  /** r7:templates — a USER template's mapping step: main plans it (utpl:preview)
   *  and says which tiles a skipped role takes with it; the KPI strip is the
   *  same `dashboard:metric` path. Create then goes through utpl:apply. */
  async function utRefreshMapping(mine: number, mapped: number, total: number): Promise<void> {
    let res: any = null;
    try {
      res = await window.hubTemplates.preview({ projectId, datasetId, templateId: String(tpl.id), mapping: mapping() });
    } catch (_) { res = null; }
    if (mine !== seq) return;
    if (!res || !res.ok) {
      lastPlan = null;
      summary.textContent = (res && res.error) || 'This mapping cannot be built.';
      summary.title = '';
      kpis.innerHTML = '';
      return;
    }
    lastPlan = { user: true };
    const skipped = Math.max(0, res.total - res.tiles);
    summary.textContent = `${mapped} of ${total} mapped · ${res.tiles} tile${res.tiles === 1 ? '' : 's'} will be built`
      + (skipped ? ` · ${skipped} skipped` : '');
    summary.title = (res.dropped || []).join('\n');
    await paintKpis(res.kpis || [], mine);
  }

  /** One `dashboard:metric` call per KPI — the built tile's own channel. A KPI
   *  over a column this plan is about to COMPUTE has no column yet, so it comes
   *  back null and shows an em dash rather than a made-up number. */
  async function paintKpis(metrics: any[], mine: number): Promise<void> {
    kpis.innerHTML = '';
    const tiles = metrics.slice(0, 4).map((m: any) => {
      const tile = document.createElement('span');
      tile.className = 'an-tpl-kpi';
      const lab = document.createElement('span');
      lab.className = 'an-tpl-kpi-l';
      lab.textContent = String(m.label || m.column);
      const val = document.createElement('span');
      val.className = 'an-tpl-kpi-v';
      val.textContent = '…';
      tile.appendChild(val);
      tile.appendChild(lab);
      kpis.appendChild(tile);
      return { m, val };
    });
    for (const { m, val } of tiles) {
      let r: any = null;
      try {
        r = await window.hub.computeMetric(projectId, String(m.datasetId), String(m.column), String(m.aggregation));
      } catch (_) { r = null; }
      if (mine !== seq) return;
      const v = r && r.ok !== false ? r.value : null;
      val.textContent = typeof v === 'number' ? fmtWith(v, 'auto') : '—';
    }
  }

  return {
    el,
    load(pid, dsid, template, columns, name) {
      projectId = pid;
      datasetId = dsid;
      dashName = name;
      tpl = Object.assign({}, template, { columns });
      picks = {};
      for (const m of template.matches || []) if (m.column) picks[m.role] = m.column;
      lastPlan = null;
      maxTiles = 0;
      seq += 1;
      summary.textContent = 'Reading your data…';
      summary.title = '';
      kpis.innerHTML = '';
      renderRows();
      refresh();
    },
    mapping,
    plan() { return lastPlan; },
  };
}
