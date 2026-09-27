// Getting a sheet out of the app: presentation mode (renderer-only — no window,
// no IPC), export to HTML / PDF / PNG, and revealing the git-shareable project
// folder. Export goes through dashboardExport.sanitizeBundle in main, which is a
// security control, not a formatter.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── Presentation mode (renderer-only; no window, no IPC) ──────────────────────
let dashPresenting = false;
let dashPresentKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let dashPresentResizeHandler: (() => void) | null = null;

/** Below this a tile is a stripe, not a chart. A page too tall to fit keeps its
 *  natural pitch and scrolls, which is honest — squeezing 40 rows into a window
 *  makes an unreadable dashboard, not a presentable one. */
const PRESENT_MIN_ROW_PX = 28;

/**
 * Scale the grid so the page's rows fill the window exactly.
 *
 * `grid-auto-rows` is an absolute pixel pitch, so hiding ~150px of chrome used to
 * free vertical space that nothing consumed — the tiles stayed their authored
 * height and left a band of empty background below the last row. Present mode is
 * the one place the pitch should follow the viewport instead of the record.
 *
 * It moves --dash-row rather than resizing anything, so the tiles, the charts
 * inside them and the drag maths in dashboards.ts all follow from the one number
 * they already read. Set on #dash-editor and cleared on exit; the stored layout
 * is never touched.
 */
function fitDashPresentRows(): void {
  const ed = dashEl('dash-editor');
  const grid = dashEl('dash-grid');
  if (!ed || !grid) return;
  // Always measure at the natural pitch — otherwise each call compounds the last.
  ed.style.removeProperty('--dash-row');
  if (!dashPresenting) return;
  const page = dashCurrentPage();
  const cards = (page && Array.isArray(page.cards)) ? page.cards : [];
  let rows = 0;
  for (const c of cards) {
    const l = (c && c.layout) || {};
    rows = Math.max(rows, (Number(l.y) || 0) + Math.max(1, Number(l.h) || 1));
  }
  if (rows <= 0) return;
  // Measured against the EDITOR, not the window. #dash-editor is its own scroll
  // box inside a flex column, so sizing to window.innerHeight overshoots by
  // whatever sits above it and puts the last row under a scrollbar — which is
  // the same empty-space bug, upside down.
  const gap = dashGapPx();
  const edRect = ed.getBoundingClientRect();
  const above = grid.getBoundingClientRect().top - edRect.top; // padding + the page tabs, when shown
  const padBottom = parseFloat(getComputedStyle(ed).paddingBottom) || 0;
  const avail = ed.clientHeight - above - padBottom - 1; // 1px: never round INTO a scrollbar
  const row = (avail - (rows - 1) * gap) / rows;
  if (row >= PRESENT_MIN_ROW_PX) ed.style.setProperty('--dash-row', row + 'px');
}

function enterDashPresent(): void {
  if (dashPresenting || !dashCurrent) return;
  dashPresenting = true;
  document.documentElement.classList.add('dash-presenting');
  if (typeof dkSync === 'function') dkSync(); // dock.ts — presentation mode suppresses the dock
  dashShow('dash-present-exit', true);
  // The brand mark in the corner — the dashboard's, else the workspace's.
  void dashLogoFor(dashCurrent).then((url) => {
    const img = dashEl('dash-present-logo') as HTMLImageElement | null;
    if (!img || !dashPresenting || !url) return;
    img.src = url;
    img.hidden = false;
  });
  dashPresentKeyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); exitDashPresent(); } };
  document.addEventListener('keydown', dashPresentKeyHandler, true);
  // Pitch first, then render: charts size to their cell at construction, so
  // fitting afterwards would draw every one of them twice.
  fitDashPresentRows();
  renderDashGrid(); // rebuild so charts refit the fuller viewport (destroy→rebuild, no leak)
  dashPresentResizeHandler = () => { fitDashPresentRows(); renderDashGrid(); };
  window.addEventListener('resize', dashPresentResizeHandler);
}

function exitDashPresent(): void {
  if (!dashPresenting) return;
  dashPresenting = false;
  document.documentElement.classList.remove('dash-presenting');
  if (typeof dkSync === 'function') dkSync(); // dock.ts — re-evaluate now that presenting is off
  dashShow('dash-present-exit', false);
  dashShow('dash-present-logo', false);
  if (dashPresentKeyHandler) { document.removeEventListener('keydown', dashPresentKeyHandler, true); dashPresentKeyHandler = null; }
  if (dashPresentResizeHandler) { window.removeEventListener('resize', dashPresentResizeHandler); dashPresentResizeHandler = null; }
  fitDashPresentRows(); // dashPresenting is false now, so this only CLEARS the pitch
  renderDashGrid();
}

// ── Export (HTML / PDF / PNG) ─────────────────────────────────────────────────
// Core Chart.js types that can render LIVE from inlined {labels,series} in the
// self-contained HTML. Ordinate type → Chart.js native type. Anything else
// (clustered/stacked/combo/heatmap/treemap/… + maps + table) is embedded as a PNG.
const DASH_EXPORT_LIVE_TYPES: Record<string, string> = {
  column: 'bar', line: 'line', line_markers: 'line', area: 'line',
  pie: 'pie', donut: 'doughnut', scatter: 'scatter', bubble: 'bubble',
};
function dashIsMapType(t: string): boolean { return t === 'map_bubble' || t === 'map_choropleth'; }

// ── ONE theme for the whole export ───────────────────────────────────────────
//
// An export is rendered under the DASHBOARD's style, never the app's Appearance.
// Charts used to be captured off holders hanging under <body>, which inherit
// [data-theme] — so a dark-mode app pasted dark chart rectangles onto the light
// export sheet, and the choropleth came back in whichever theme the app happened
// to be in. Everything below answers one question: which style is this export?
//
// 'auto' declares no tokens on purpose (on screen it follows the app), and an
// exported file has no app around it — so here it resolves to LIGHT, the same
// resolution src/analysis/dashboardExport.ts makes for THEME_TOKENS.auto. That
// agreement is what keeps the PNG, the PDF and the HTML one document.
function dashExportStyle(): any {
  const s = dashCurrentStyle();
  // `chosen` matters: dashSanitizeStyle migrates an unchosen 'clean' back to
  // 'auto', so without it this resolution would immediately undo itself.
  return { ...s, theme: s.theme === 'auto' ? 'clean' : s.theme, chosen: true };
}

function dashExportStyleClasses(): string[] { return dashStyleClassList(dashExportStyle()); }

// The page box the one-pager is laid out in. 1160 is the logical width
// handleDashExport hands main; 20px of side padding matches .d-root below.
const DASH_EXPORT_PAGE_W = 1160;
const DASH_EXPORT_PAD = 20;

// Row pitch, matching src/analysis/dashboardExport.ts's DENSITY_TOKENS rather
// than hub.css's 48/36. An export page carries no app chrome and is narrower
// than a hub window, so the taller row is what keeps a chart card from coming
// out as a letterbox — and the two export formats have to agree, or the HTML
// and the PNG of one dashboard are two different documents.
const DASH_EXPORT_ROW: Record<string, number> = { comfortable: 80, compact: 60 };

// The theme tokens the one-pager's stylesheet consumes, READ OFF hub.css rather
// than transcribed into it. Transcription is exactly how the old one-pager
// drifted into a separate look; this way a colour that moves in hub.css moves
// in the export with it.
const DASH_EXPORT_TOKENS = [
  '--bg', '--surface', '--surface-2', '--text', '--text-strong', '--muted',
  '--text-dim', '--text-faint', '--border', '--border-2',
  '--font-ui', '--font-numeric',
];

interface DashExportMeasure {
  /** `--x: value;` declarations for the one-pager's :root. */
  vars: string;
  /** Grid gap in px, from --dash-gap. */
  gap: number;
  /** The row pitch the one-pager uses (see DASH_EXPORT_ROW). */
  row: number;
  /** A card's head strip and body padding in px, off a real .dash-card. */
  head: number;
  pad: number;
}

// Computed values only ever come from hub.css's own closed enum of preset
// classes, so nothing author-written can reach here — but they ARE interpolated
// into a <style> block, so the characters that could close one are dropped
// rather than trusted.
function dashExportCssSafe(v: string): string {
  return String(v || '').replace(/[<>{};]/g, ' ').trim();
}

/**
 * Measure the export's look off LIVE, themed hub.css elements.
 *
 * Two kinds of thing come back. The theme tokens are read from a container
 * carrying the export's `dash-theme--* / dash-density--* / dash-accent--*`
 * classes — the same element-scoped read charts use (chartPalette.getCSSVar).
 * The rest are the handful of things `.dash-card` and `.dash-metric-value`
 * hardcode as PROPERTIES rather than tokens (the Executive radius and shadow,
 * the KPI type scale, the head and body padding), measured off a real card
 * built from those classes.
 *
 * The probe is genuinely IN the document, off-screen: getComputedStyle returns
 * '' for a custom property on a detached element.
 */
function dashExportMeasure(): DashExportMeasure {
  const probe = document.createElement('div');
  probe.className = 'export-capture-holder';
  dashExportStyleClasses().forEach((c) => probe.classList.add(c));
  applyBrandTokens(probe, dashCurrentStyle().accentHex || '');
  if (typeof applyDashTheme === 'function') applyDashTheme(probe, dashCurrentStyle()); // themeApply.ts

  const card = document.createElement('div');
  card.className = 'dash-card dash-card--metric';
  const head = document.createElement('div');
  head.className = 'dash-card-head';
  const title = document.createElement('div');
  title.className = 'dash-card-title';
  title.textContent = 'x';
  head.appendChild(title);
  const body = document.createElement('div');
  body.className = 'dash-card-body';
  const value = document.createElement('div');
  value.className = 'dash-metric-value tnum';
  value.textContent = 'x';
  const label = document.createElement('div');
  label.className = 'dash-metric-label';
  label.textContent = 'x';
  body.appendChild(value);
  body.appendChild(label);
  card.appendChild(head);
  card.appendChild(body);
  probe.appendChild(card);
  document.body.appendChild(probe);

  try {
    const cs = (el: Element) => getComputedStyle(el);
    const root = cs(probe);
    const px = (v: string, fallback: number) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const vars = DASH_EXPORT_TOKENS
      .map((t) => t + ':' + (dashExportCssSafe(root.getPropertyValue(t)) || 'inherit') + ';')
      .concat([
        '--d-card-radius:' + (dashExportCssSafe(cs(card).borderRadius) || '12px') + ';',
        '--d-card-shadow:' + (dashExportCssSafe(cs(card).boxShadow) || 'none') + ';',
        '--d-head-pad:' + (dashExportCssSafe(cs(head).padding) || '7px 9px') + ';',
        '--d-body-pad:' + (dashExportCssSafe(cs(body).padding) || '10px') + ';',
        '--d-title-size:' + (dashExportCssSafe(cs(title).fontSize) || '11px') + ';',
        '--d-kpi-size:' + (dashExportCssSafe(cs(value).fontSize) || '26px') + ';',
        '--d-kpi-font:' + (dashExportCssSafe(cs(value).fontFamily) || 'inherit') + ';',
        '--d-kpi-label-size:' + (dashExportCssSafe(cs(label).fontSize) || '12px') + ';',
      ])
      .join('');
    return {
      vars,
      gap: px(root.getPropertyValue('--dash-gap'), 12),
      row: DASH_EXPORT_ROW[dashExportStyle().density] || DASH_EXPORT_ROW.comfortable,
      // getBoundingClientRect, not the padding sum: the head's height is its
      // padding PLUS a line of 11px title PLUS a 1px border, and only the box
      // knows all three.
      head: head.getBoundingClientRect().height || 30,
      pad: px(cs(body).paddingTop, 10),
    };
  } finally {
    probe.remove();
  }
}

/**
 * The logical pixel box a card's chart occupies on the export sheet.
 *
 * Capturing at THIS size is half of what fixes "the chart is a third of its
 * card": a fixed 1100x620 capture dropped into a card of any other shape is
 * letterboxed, whichever way the mismatch runs. The image then goes in at
 * `width: 100%`, so the card's height follows the picture rather than a grid
 * row count that knows nothing about it.
 */
function dashExportChartBox(m: DashExportMeasure, layout: any, titled: boolean): { width: number; height: number } {
  const content = DASH_EXPORT_PAGE_W - 2 * DASH_EXPORT_PAD;
  const colW = (content - (DASH_GRID_COLS - 1) * m.gap) / DASH_GRID_COLS;
  const w = Math.max(1, Math.min(DASH_GRID_COLS, Number(layout && layout.w) || 1));
  const h = Math.max(1, Number(layout && layout.h) || 1);
  return {
    width: Math.round(w * colW + (w - 1) * m.gap - 2 * m.pad),
    height: Math.round(h * m.row + (h - 1) * m.gap - (titled ? m.head : 0) - 2 * m.pad),
  };
}

// Plain-text "<label> = <value>" for one control card's CURRENT selection, for
// the export header summary only — an export never gets a live widget (the
// plan is explicit: "Do NOT export live controls"). Resolution mirrors
// controlCurrentValue (dashControls.ts, loaded before this file): whatever is
// in controlState, falling back to the kind's empty value. An inactive
// control (no active value) returns '' and is skipped from the summary —
// the same "unset control filters nothing" rule controlStepsRenderer
// (dashboards.ts) already applies to effectiveFilters(). Date range uses an
// en dash, matching the live widget's own separator (dashControls.ts).
function formatControlSummaryPart(card: any): string {
  const control = card.control;
  if (!control) return '';
  const cur = controlCurrentValue(card);
  let value = '';
  if (control.kind === 'multi') {
    const vals: string[] = Array.isArray(cur.values) ? cur.values : [];
    // Cap the summary at 5 named values — a multi-select with dozens picked
    // would otherwise blow the header out to an unreadable single line.
    value = vals.length > 5
      ? vals.slice(0, 5).join(', ') + ', and ' + (vals.length - 5) + ' more'
      : vals.join(', ');
  } else if (control.kind === 'date_range') {
    value = ppIsRelative(cur) || cur.from || cur.to ? periodValueText(cur) : '';
  } else {
    value = cur.value || '';
  }
  if (!value) return '';
  return (control.label || 'Filter') + ' = ' + value;
}

// Build the serializable export bundle. `forCapture` forces EVERY visual to a PNG image
// (the PNG/PDF one-pager is rendered offscreen where Chart.js isn't loaded); the HTML
// export keeps core chart types live. Only computed values + labels + PNGs are emitted —
// never a raw dataset row, never a secret.
async function assembleExportBundle(forCapture: boolean): Promise<any> {
  const pages: any[] = [];
  const controlParts: string[] = [];
  // Measured ONCE per export, not per card: it lays out a probe card and reads
  // computed style off it, and every card on every page wants the same answer.
  const measure = dashExportMeasure();
  const srcPages = (dashCurrent && Array.isArray(dashCurrent.pages)) ? dashCurrent.pages : [];
  for (const page of srcPages) {
    const cards: any[] = [];
    const srcCards = Array.isArray(page.cards) ? page.cards : [];
    for (const card of srcCards) {
      const layout = card.layout || { x: 0, y: 0, w: 6, h: 4 };
      if (card.type === 'control') {
        // No grid-cell entry — folded into the header summary instead. Not
        // "broken": intentionally excluded from the grid, scanned across ALL
        // pages (dashboard-wide scope, same as effectiveFilters()).
        const part = formatControlSummaryPart(card);
        if (part) controlParts.push(part);
        continue;
      }
      if (card.type === 'text') {
        cards.push({ kind: 'text', layout, heading: card.heading || '', text: card.text || '' });
        continue;
      }
      if (card.type === 'metric') {
        const built = await buildMetricExportCard(card, layout);
        cards.push(built);
        continue;
      }
      if (card.type === 'visual') {
        const built = await buildVisualExportCard(card, layout, forCapture, measure);
        cards.push(built);
        continue;
      }
      // cardKinds.ts: an image exports as its picture; layout-only kinds as nothing.
      const extra = await exportAuthoringCard(card, layout);
      if (extra !== undefined) { if (extra) cards.push(extra); continue; }
      cards.push({ kind: 'broken', layout, reason: 'Unknown card' });
    }
    pages.push({ name: page.name || 'Page', cards });
  }
  return {
    name: (dashCurrent && dashCurrent.name) || 'Dashboard',
    pages,
    // One muted line under the title, prefixed so a reader knows the figures
    // below are a SLICE — "Filtered: region = West · Quarter = Q3". Empty when
    // nothing is filtering, which is the honest thing to print in that case.
    controlsSummary: controlParts.length ? 'Filtered: ' + controlParts.join(' · ') : '',
    // A shared snapshot has to LOOK like what the author saw, so the style
    // travels with the bundle. Main re-clamps it (dashboardExport.sanitizeBundle)
    // — this is a closed enum on both sides, never free-form CSS.
    style: dashCurrentStyle(),
    // The brand: literal ramp colours (main cannot run the contrast walk) and
    // the logo for the header. Main re-validates both (sanitizeBrand).
    brand: {
      ramp: brandExportRamp(dashCurrentStyle(), dashExportStyle().theme === 'dark'),
      logo: await dashLogoFor(dashCurrent),
    },
    // The workspace theme it resolves to, as tokens (themeApply.ts); main
    // re-validates every one (dashboardExport.sanitizeBundle).
    theme: typeof dashThemeExport === 'function' ? dashThemeExport(dashCurrentStyle()) : null,
  };
}

async function buildMetricExportCard(card: any, layout: any): Promise<any> {
  const m = card.metric || {};
  const derived = (DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || '');
  const label = m.label || derived;
  // What the figure IS, under the name its author gave it — the third line a
  // KPI tile has room for. When there is no author label the two strings are
  // identical, so it is dropped rather than printed twice.
  const subLabel = m.label ? derived : '';
  // A card on a saved metric reads as the dashboard shows it — the metric's own
  // format ("$5.2M"), as dashFiltersUi's card does. Falls through on a dangling id.
  if (currentProjectId && m.metricId) {
    let mr: any = null;
    try { mr = await window.hub.metricValue(currentProjectId, m.metricId, effectiveFilters(), dashParamPayload()); } catch (_) { mr = null; }
    if (mr && mr.ok !== false) {
      return { kind: 'metric', layout, label: m.label || mr.name || label, subLabel: mr.name && mr.name !== m.label ? mr.name : '', value: mr.display || '—', format: 'auto' };
    }
  }
  if (!currentProjectId || !m.datasetId || !m.column || !m.aggregation) {
    return { kind: 'broken', layout, reason: 'Metric not configured' };
  }
  let r: any;
  try {
    r = await window.hub.computeMetric(
      currentProjectId, m.datasetId, m.column, m.aggregation,
      effectiveFilters(), dashParamPayload(),
    );
  } catch (_) { r = { ok: false }; }
  if (!r || r.ok === false) return { kind: 'broken', layout, reason: 'Source removed' };
  const value = r.value == null ? null : fmtWith(r.value, m.format || 'auto');
  return { kind: 'metric', layout, label, subLabel, value, format: m.format || 'auto' };
}

async function buildVisualExportCard(
  card: any, layout: any, forCapture: boolean, measure: DashExportMeasure,
): Promise<any> {
  if (!currentProjectId || (!card.visualId && !card.visual)) return { kind: 'broken', layout, reason: 'No visual selected' };
  // Same two-shaped resolution as renderVisualCard: an inline publish-time
  // snapshot wins, so an export of a published dashboard carries the frozen
  // definition — and still exports fine after the source visual is deleted.
  const resolved = await resolveCardVisual(card);
  if (!resolved) return { kind: 'broken', layout, reason: 'Source removed' };
  const visual = resolved.visual;
  const merged = mergeDashFilters(effectiveFilters(), visual.filters);
  // Asked WITH the share path: main applies the project's Share policy, so a
  // sensitive label arrives masked, or the tile arrives hidden (privacyShare.ts).
  let res: any;
  try { res = await pvVisualData(currentProjectId, visual.datasetId, visual.encoding, merged, dashParamPayload(), 'export'); }
  catch (_) { res = { ok: false }; }
  if (!res || res.ok === false) return { kind: 'broken', layout, reason: res && res.hiddenByPolicy ? res.error : 'Could not draw this visual' };
  const data = res.data || { labels: [], series: [] };
  const type = typeof visual.chartType === 'string' && visual.chartType ? visual.chartType : 'column';
  const title = dashSubst(visual.name || '');

  // Live-chartable core type in the HTML export → inline data (interactive).
  if (!forCapture && !dashIsMapType(type) && DASH_EXPORT_LIVE_TYPES[type]) {
    return {
      kind: 'chart', layout, chartType: DASH_EXPORT_LIVE_TYPES[type], title,
      data: {
        labels: Array.isArray(data.labels) ? data.labels : [],
        series: (Array.isArray(data.series) ? data.series : []).map((s: any) => ({
          label: s && s.name ? String(s.name) : '',
          values: Array.isArray(s.values) ? s.values : [],
        })),
      },
      // The project's colours, as ramp slots the export's own ramp draws (fmtApply.ts).
      ...fmtExportSlots(type, visual, data),
    };
  }
  // Everything else (maps / plugin charts / table, and ALL visuals in a capture) → PNG,
  // captured through the EXISTING report-capture helpers (reuse, no new dependency).
  //
  // The frame is the whole fix: the EXPORT's theme classes (never the app's) and
  // the box this image will actually fill on the sheet. Maps get the identical
  // frame — capturePage still does the snapshotting, it just snapshots a holder
  // that now carries the dashboard's own style.
  const frame = Object.assign(
    { themeClasses: dashExportStyleClasses(), accentHex: dashCurrentStyle().accentHex, style: dashCurrentStyle() },
    dashExportChartBox(measure, layout, !!title),
  );
  let png: string | null = null;
  try {
    png = dashIsMapType(type)
      ? await captureMapPNG(data, type, frame)
      : await captureChartPNG(type, data, fmtWithScope(visual.overrides || {}, { projectId: currentProjectId, encoding: visual.encoding }), frame);
  } catch (_) { png = null; }
  if (!png) return { kind: 'broken', layout, reason: 'Chart could not be rendered' };
  return { kind: 'image', layout, png, title };
}

// Static one-pager HTML for the PNG/PDF path. Rendered in an OFFSCREEN sandboxed window
// (its own data: origin — the hub CSP does not apply), so inline styles are fine here.
// Every card is an image / metric / text / broken tile (no live Chart.js needed).
//
// The stylesheet below used to be hand-written literals — a second, drifting
// description of a card that hub.css already describes. It is now token-only:
// every colour, radius, shadow, padding and type size comes in through
// dashExportMeasure(), read off real `.dash-card` / `.dash-metric-value`
// elements under the export's theme. The RULES here are the app's structure
// (head strip, body, centred KPI, note paragraph) minus the chrome a sheet of
// paper has no use for — the ⋯ menus, the drag handles, the Remove button.
function buildDashCaptureHtml(bundle: any): string {
  const esc = (s: any) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cols = DASH_GRID_COLS;
  const m = dashExportMeasure();
  const logo = bundle.brand && bundle.brand.logo ? `<img class="d-logo" alt="" src="${esc(bundle.brand.logo)}">` : '';
  let body = `<div class="d-head"><h1 class="d-title">${esc(bundle.name)}</h1>${logo}</div>`;
  if (bundle.controlsSummary) body += `<div class="d-controls-summary">${esc(bundle.controlsSummary)}</div>`;
  const multi = Array.isArray(bundle.pages) && bundle.pages.length > 1;
  (bundle.pages || []).forEach((page: any) => {
    if (multi) body += `<h2 class="d-page">${esc(page.name)}</h2>`;
    body += '<div class="d-grid">';
    (page.cards || []).forEach((card: any) => {
      const L = card.layout || { x: 0, y: 0, w: 6, h: 4 };
      const cell = `grid-column:${(L.x || 0) + 1} / span ${L.w || 1};grid-row:${(L.y || 0) + 1} / span ${L.h || 1};`;
      // Every card type wears the same head strip the app gives it — the "what
      // is this" line lives THERE, never doubled into the body (the rule
      // dashCardTitle states in dashGrid.ts).
      let headText = '';
      let inner = '';
      let kind = card.kind;
      if (card.kind === 'image') {
        headText = card.title || '';
        inner = `<img class="d-img" src="${esc(card.png)}" alt="${esc(card.title || 'chart')}">`;
      } else if (card.kind === 'metric') {
        headText = card.label || '';
        inner = `<div class="d-mv">${card.value == null ? '—' : esc(card.value)}</div>`;
        if (card.subLabel) inner += `<div class="d-ms">${esc(card.subLabel)}</div>`;
      } else if (card.kind === 'text') {
        headText = card.heading || '';
        if (card.text) inner = `<p class="d-tb">${esc(card.text)}</p>`;
      } else {
        kind = 'broken';
        inner = `<div class="d-bk">Unavailable</div><div class="d-bkr">${esc(card.reason || 'Source removed')}</div>`;
      }
      const head = headText ? `<div class="d-head">${esc(headText)}</div>` : '';
      body += `<div class="d-card d-card--${esc(kind)}" style="${cell}">`
        + `${head}<div class="d-body">${inner}</div></div>`;
    });
    body += '</div>';
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    :root{${m.vars}}
    *{box-sizing:border-box}
    html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui)}
    .d-root{max-width:${DASH_EXPORT_PAGE_W}px;margin:0 auto;padding:24px ${DASH_EXPORT_PAD}px 40px}
    .d-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
    .d-logo{max-width:160px;max-height:32px;object-fit:contain}
    .d-title{font-size:22px;font-weight:700;color:var(--text-strong);margin:0 0 4px}
    .d-controls-summary{font-size:13px;font-weight:500;color:var(--muted);margin:0 0 16px}
    .d-page{font-size:14px;font-weight:600;color:var(--muted);margin:18px 0 8px}
    /* minmax, not a fixed pitch: an image card's height follows its PICTURE, so
       a row band grows when the capture is taller than the cells it was given
       and never letterboxes one into cells it is shorter than. */
    .d-grid{display:grid;grid-template-columns:repeat(${cols},1fr);
      grid-auto-rows:minmax(${m.row}px,auto);gap:${m.gap}px;margin-bottom:24px}
    /* Deliberately NO break-inside:avoid here. The PDF paginates this one page
       across several sheets, and a chart card is over half a landscape sheet
       tall — so avoiding the break does not keep a card whole, it pushes the
       whole grid row to the next page and leaves two thirds of this one empty
       (measured: 4 pages becomes 5, with page 1 holding only the KPI row).
       A card that continues over the fold reads better than that. */
    .d-card{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;
      border:1px solid var(--border);border-radius:var(--d-card-radius);
      box-shadow:var(--d-card-shadow);background:var(--surface-2)}
    .d-head{padding:var(--d-head-pad);border-bottom:1px solid var(--border);
      font-size:var(--d-title-size);font-weight:600;color:var(--muted);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .d-body{flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;padding:var(--d-body-pad)}
    /* The image fills the body's WIDTH and keeps its own aspect — the capture
       was already taken at this box, so it lands at its natural size. */
    .d-img{display:block;width:100%;height:auto}
    .d-card--metric .d-body{display:flex;flex-direction:column;align-items:center;
      justify-content:center;text-align:center;gap:4px}
    .d-mv{font-family:var(--d-kpi-font);font-variant-numeric:tabular-nums;
      font-size:var(--d-kpi-size);font-weight:700;color:var(--text-strong);line-height:1.1}
    .d-ms{font-size:var(--d-kpi-label-size);color:var(--muted)}
    .d-tb{font-size:13px;color:var(--text);margin:0;white-space:pre-wrap}
    .d-card--broken{border-style:dashed;border-color:var(--border-2);background:var(--surface);
      box-shadow:none}
    .d-card--broken .d-body{display:flex;flex-direction:column;align-items:center;
      justify-content:center;text-align:center}
    .d-bk{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint)}
    .d-bkr{font-size:12px;color:var(--text-faint);margin-top:4px}
  </style></head><body><div class="d-root">${body}</div></body></html>`;
}

async function handleDashExport(): Promise<void> {
  if (!dashCurrent) return;
  const choice = await dashChooseModal(
    'Export dashboard',
    [
      { value: 'html', label: 'Interactive HTML (charts export as images)' },
      { value: 'pdf', label: 'PDF document' },
      { value: 'png', label: 'PNG image' },
    ],
    'Export',
    pvShareNote('export', await pvCardDatasetIds(dashCurrent)),
  );
  if (choice === null) return;
  await dashExportAs(choice as DashExportFormat, true);
}

type DashExportFormat = 'html' | 'pdf' | 'png';

/**
 * Export the open dashboard in one format, no chooser.
 *
 * Split out of handleDashExport so the three "Export as PDF/PNG/HTML" commands
 * (commandDefs.ts) reach the same code the dialog does. A command that built its
 * own bundle would be a second exporter to keep in step with the first.
 */
async function dashExportAs(choice: DashExportFormat, noted = false): Promise<void> {
  if (!dashCurrent) return;
  // The commands reach here with no dialog, so the gate toasts the policy line
  // for them; 'include' asks first either way.
  if (!(await pvShareGate('export', await pvCardDatasetIds(dashCurrent), { noted }))) return;
  const safe = String(dashCurrent.name || 'dashboard').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'dashboard';
  if (choice === 'html') {
    showToast('Building HTML…');
    try {
      const bundle = await assembleExportBundle(false);
      const res = await window.hub.exportDashboardHtml(bundle, safe + '.html');
      reportExportResult(res, 'HTML');
    } catch (e) { showToast('Export failed'); }
    return;
  }
  // PDF / PNG: build the offscreen one-pager (all visuals as PNGs), then capture in MAIN.
  showToast(choice === 'pdf' ? 'Building PDF…' : 'Building image…');
  try {
    const bundle = await assembleExportBundle(true);
    const html = buildDashCaptureHtml(bundle);
    const res = choice === 'pdf'
      ? await window.hub.exportDashboardPdf(html, 1160, safe + '.pdf')
      : await window.hub.exportDashboardPng(html, 1160, safe + '.png');
    reportExportResult(res, choice === 'pdf' ? 'PDF' : 'PNG');
  } catch (e) { showToast('Export failed'); }
}

function reportExportResult(res: any, kind: string): void {
  if (res && res.ok) showToast(kind + ' saved');
  else if (res && res.canceled) { /* user cancelled the save panel — no toast */ }
  else showToast((res && res.error) || (kind + ' export failed'));
}

// ── Share (reveal the git-shareable, secret-free project folder) ──────────────
function handleDashShare(): void {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal dash-share-modal';
  const h = document.createElement('div');
  h.className = 'ws-modal-title';
  h.textContent = 'Share this project';
  const p1 = document.createElement('p');
  p1.className = 'dash-share-note';
  p1.textContent = 'The project folder holds your datasets, visuals, and dashboards as plain text (JSON) — it is the shareable, git-able artifact. Commit it to a repo and others can open the exact same workspace.';
  const p2 = document.createElement('p');
  p2.className = 'dash-share-note dash-share-note--safe';
  p2.textContent = 'Connection secrets and API keys are NOT in this folder. They stay in a separate, gitignored config file and never leave your machine — so sharing the folder never leaks a secret.';
  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'btn btn-primary';
  reveal.textContent = 'Reveal folder';
  let done = false;
  function shut(): void {
    if (done) return; done = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') { e.preventDefault(); shut(); } }
  close.addEventListener('click', shut);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  reveal.addEventListener('click', async () => {
    try {
      const res = await window.hub.revealProjectFolder(currentProjectId as string);
      if (!res || res.ok === false) showToast((res && res.error) || 'Could not reveal the folder');
    } catch (_) { showToast('Could not reveal the folder'); }
    shut();
  });
  actions.appendChild(close);
  actions.appendChild(reveal);
  box.appendChild(h);
  box.appendChild(p1);
  box.appendChild(p2);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

