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

function enterDashPresent(): void {
  if (dashPresenting || !dashCurrent) return;
  dashPresenting = true;
  document.documentElement.classList.add('dash-presenting');
  dashShow('dash-present-exit', true);
  dashPresentKeyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); exitDashPresent(); } };
  document.addEventListener('keydown', dashPresentKeyHandler, true);
  renderDashGrid(); // rebuild so charts refit the fuller viewport (destroy→rebuild, no leak)
}

function exitDashPresent(): void {
  if (!dashPresenting) return;
  dashPresenting = false;
  document.documentElement.classList.remove('dash-presenting');
  dashShow('dash-present-exit', false);
  if (dashPresentKeyHandler) { document.removeEventListener('keydown', dashPresentKeyHandler, true); dashPresentKeyHandler = null; }
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

// Build the serializable export bundle. `forCapture` forces EVERY visual to a PNG image
// (the PNG/PDF one-pager is rendered offscreen where Chart.js isn't loaded); the HTML
// export keeps core chart types live. Only computed values + labels + PNGs are emitted —
// never a raw dataset row, never a secret.
async function assembleExportBundle(forCapture: boolean): Promise<any> {
  const pages: any[] = [];
  const srcPages = (dashCurrent && Array.isArray(dashCurrent.pages)) ? dashCurrent.pages : [];
  for (const page of srcPages) {
    const cards: any[] = [];
    const srcCards = Array.isArray(page.cards) ? page.cards : [];
    for (const card of srcCards) {
      const layout = card.layout || { x: 0, y: 0, w: 6, h: 4 };
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
        const built = await buildVisualExportCard(card, layout, forCapture);
        cards.push(built);
        continue;
      }
      cards.push({ kind: 'broken', layout, reason: 'Unknown card' });
    }
    pages.push({ name: page.name || 'Page', cards });
  }
  return { name: (dashCurrent && dashCurrent.name) || 'Dashboard', pages };
}

async function buildMetricExportCard(card: any, layout: any): Promise<any> {
  const m = card.metric || {};
  const label = m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  if (!currentProjectId || !m.datasetId || !m.column || !m.aggregation) {
    return { kind: 'broken', layout, reason: 'Metric not configured' };
  }
  let r: any;
  try {
    r = await window.hub.computeMetric(
      currentProjectId, m.datasetId, m.column, m.aggregation,
      effectiveFilters(),
    );
  } catch (_) { r = { ok: false }; }
  if (!r || r.ok === false) return { kind: 'broken', layout, reason: 'Source removed' };
  const value = r.value == null ? null : fmtWith(r.value, m.format || 'auto');
  return { kind: 'metric', layout, label, value, format: m.format || 'auto' };
}

async function buildVisualExportCard(card: any, layout: any, forCapture: boolean): Promise<any> {
  if (!currentProjectId || (!card.visualId && !card.visual)) return { kind: 'broken', layout, reason: 'No visual selected' };
  // Same two-shaped resolution as renderVisualCard: an inline publish-time
  // snapshot wins, so an export of a published dashboard carries the frozen
  // definition — and still exports fine after the source visual is deleted.
  const resolved = await resolveCardVisual(card);
  if (!resolved) return { kind: 'broken', layout, reason: 'Source removed' };
  const visual = resolved.visual;
  const merged = mergeDashFilters(effectiveFilters(), visual.filters);
  let res: any;
  try { res = await window.hub.computeVisualData(currentProjectId, visual.datasetId, visual.encoding, merged); }
  catch (_) { res = { ok: false }; }
  if (!res || res.ok === false) return { kind: 'broken', layout, reason: 'Could not draw this visual' };
  const data = res.data || { labels: [], series: [] };
  const type = typeof visual.chartType === 'string' && visual.chartType ? visual.chartType : 'column';
  const title = visual.name || '';

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
    };
  }
  // Everything else (maps / plugin charts / table, and ALL visuals in a capture) → PNG,
  // captured through the EXISTING report-capture helpers (reuse, no new dependency).
  let png: string | null = null;
  try {
    png = dashIsMapType(type)
      ? await captureMapPNG(data, type)
      : await captureChartPNG(type, data, visual.overrides || {});
  } catch (_) { png = null; }
  if (!png) return { kind: 'broken', layout, reason: 'Chart could not be rendered' };
  return { kind: 'image', layout, png, title };
}

// Static one-pager HTML for the PNG/PDF path. Rendered in an OFFSCREEN sandboxed window
// (its own data: origin — the hub CSP does not apply), so inline styles are fine here.
// Every card is an image / metric / text / broken tile (no live Chart.js needed).
function buildDashCaptureHtml(bundle: any): string {
  const esc = (s: any) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cols = DASH_GRID_COLS;
  let body = `<h1 class="d-title">${esc(bundle.name)}</h1>`;
  const multi = Array.isArray(bundle.pages) && bundle.pages.length > 1;
  (bundle.pages || []).forEach((page: any) => {
    if (multi) body += `<h2 class="d-page">${esc(page.name)}</h2>`;
    body += '<div class="d-grid">';
    (page.cards || []).forEach((card: any) => {
      const L = card.layout || { x: 0, y: 0, w: 6, h: 4 };
      const style = `grid-column:${(L.x || 0) + 1} / span ${L.w || 1};grid-row:${(L.y || 0) + 1} / span ${L.h || 1};`;
      let inner = '';
      if (card.kind === 'image') {
        if (card.title) inner += `<div class="d-ct">${esc(card.title)}</div>`;
        inner += `<img class="d-img" src="${esc(card.png)}" alt="${esc(card.title || 'chart')}">`;
      } else if (card.kind === 'metric') {
        if (card.label) inner += `<div class="d-ml">${esc(card.label)}</div>`;
        inner += `<div class="d-mv">${card.value == null ? '—' : esc(card.value)}</div>`;
      } else if (card.kind === 'text') {
        if (card.heading) inner += `<div class="d-th">${esc(card.heading)}</div>`;
        if (card.text) inner += `<div class="d-tb">${esc(card.text)}</div>`;
      } else {
        inner = `<div class="d-bk">Unavailable</div><div class="d-bkr">${esc(card.reason || 'Source removed')}</div>`;
      }
      const cls = card.kind === 'broken' ? 'd-card d-card-broken' : 'd-card';
      body += `<div class="${cls}" style="${style}">${inner}</div>`;
    });
    body += '</div>';
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:#f4f4f5;color:#18181b;
      font-family:-apple-system,system-ui,'Segoe UI',sans-serif}
    .d-root{max-width:1160px;margin:0 auto;padding:24px 20px 40px}
    .d-title{font-size:22px;font-weight:700;margin:0 0 16px}
    .d-page{font-size:14px;font-weight:600;color:#6b7280;margin:18px 0 8px}
    .d-grid{display:grid;grid-template-columns:repeat(${cols},1fr);grid-auto-rows:80px;gap:12px;margin-bottom:24px}
    .d-card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:12px;overflow:hidden;
      display:flex;flex-direction:column;min-height:0}
    .d-ct{font-size:12px;font-weight:600;color:#6b7280;margin-bottom:8px;text-transform:uppercase;letter-spacing:.03em}
    .d-img{max-width:100%;max-height:100%;object-fit:contain;margin:auto}
    .d-ml{font-size:13px;color:#6b7280}
    .d-mv{font-size:30px;font-weight:700;margin-top:auto}
    .d-th{font-size:16px;font-weight:600;margin-bottom:6px}
    .d-tb{font-size:13px;color:#3f3f46;white-space:pre-wrap}
    .d-card-broken{border-style:dashed;border-color:#d4d4d8;background:#fafafa;align-items:center;
      justify-content:center;text-align:center;color:#9ca3af}
    .d-bk{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa}
    .d-bkr{font-size:12px;color:#b4b4bb;margin-top:4px}
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
  );
  if (choice === null) return;
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

