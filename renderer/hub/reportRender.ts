// Report page layout — ONE description of a page, three writers and a preview.
//
// The problem this file solves: a report page has to look the same in the PDF,
// in the PPTX, in the DOCX and in the builder's live preview. Four independent
// layouts is four places for a caption to go missing. So the page list is
// resolved ONCE, here, into a plain data description — a title, an image, a
// caption, a KPI table, some bullets — and the four consumers only decide how
// to draw that description in their own medium. reportWriters.ts holds the
// three document writers; renderPreviewPage below is the fourth consumer.
//
// Nothing here reads `dashCurrent`. The builder has the dashboard open, but a
// SCHEDULED run does not, and a report that silently opened someone's dashboard
// to print itself would be a visible, disruptive side effect. So the context —
// project, analysis record, filters, style — is passed in, and both callers
// supply it from what they actually have.
//
// Figures come from the same two compute channels the dashboard itself uses
// (`computeVisualData`, `computeMetric`), and sentences from `reports:caption`
// in main. No number is composed in this file.

/** How a page is drawn, in the one vocabulary all four consumers share. */
interface RenderedPage {
  kind: string;
  /** The heading, large. */
  title: string;
  /** Under the heading, muted. */
  subtitle?: string;
  /** The app's (or the author's) sentence for the picture on this page. */
  caption?: string;
  /** Prose — notes and narrative pages. */
  body?: string;
  /** Bold-run text, for the capture report's headline. */
  segments?: Array<{ text: string; bold?: boolean }>;
  /** One big picture. */
  png?: string | null;
  /** A grid of pictures — a sheet page. */
  tiles?: Array<{ title: string; png: string | null }>;
  /** A native table in every format — never an image of numbers. */
  kpis?: Array<{ label: string; value: string }>;
  /**
   * A PIVOT as a native table — header rows then body rows, already formatted.
   * Set instead of `png` when the grid is small enough to typeset; a big one
   * still goes as a picture, because a 300-row table across four pages of a
   * slide deck is not a report.
   */
  grid?: { head: string[][]; body: string[][] } | null;
  /** One line per tile — the summary page. */
  bullets?: string[];
  /** Cover only: the filter line and the date. */
  meta?: string[];
  /** Cover only: the mark to draw, with its natural size so every writer can
   *  keep its aspect. Null when the dashboard's Style says no logo. */
  logo?: ReportLogo | null;
  layout?: string;
}

interface ReportLogo { src: string; w: number; h: number }

/**
 * The cover's mark: the dashboard's own logo, else the workspace's (Settings →
 * Appearance → Branding), else Ordinate's. A dashboard styled "No logo" gets
 * none. Always a PNG — pdfmake, pptxgenjs and docx cannot embed an SVG.
 */
async function reportLogo(analysis: any): Promise<ReportLogo | null> {
  if (analysis && analysis.style && analysis.style.logo === 'none') return null;
  const src = (await dashLogoFor(analysis, true)) || REPORT_LOGO_PNG;
  const size = await imageSize(src);
  return { src, w: size ? size.w : 1, h: size ? size.h : 1 };
}

/** Everything a page list needs to resolve. Supplied, never read off globals. */
interface ReportContext {
  projectId: string;
  /** The Analysis record — `sheets` is the card source. */
  analysis: any;
  /** Filter steps in force. The builder passes the live filter bar's. */
  filters: any[];
  /** The Report record. */
  report: any;
  /** Parameters in force, `[{ name, kind, value }]` — the live ones when the
   *  builder was opened from the dashboard on screen, else its saved defaults. */
  params?: any[];
}

// ── page geometry ────────────────────────────────────────────────────────────
//
// Logical pixels at 96dpi, which is what a capture's `width`/`height` frame
// wants and what the preview's CSS uses. PPTX is not paper: it is always 16:9,
// so the paper setting is ignored for it rather than quietly producing a
// letter-shaped slide.
const REPORT_PAPER_IN: Record<string, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  a4: { w: 8.27, h: 11.69 },
};
const REPORT_DPI = 96;

function reportPageBox(report: any): { width: number; height: number } {
  if (report && report.format === 'pptx') return { width: 1280, height: 720 };
  const paper = (report && report.paper) || {};
  const size = REPORT_PAPER_IN[paper.size] || REPORT_PAPER_IN.letter;
  const portrait = paper.orientation !== 'landscape';
  return {
    width: Math.round((portrait ? size.w : size.h) * REPORT_DPI),
    height: Math.round((portrait ? size.h : size.w) * REPORT_DPI),
  };
}

/** The picture box on a full-bleed page: the page minus margins, heading,
 *  caption and footer. The numbers mirror the preview CSS in hub.css. */
function reportImageBox(report: any, kind: string): { width: number; height: number } {
  const box = reportPageBox(report);
  const margin = Math.round(box.width * 0.08);
  const chrome = kind === 'sheet' ? 150 : 190; // heading + caption + footer
  return {
    width: Math.max(160, box.width - 2 * margin),
    height: Math.max(120, box.height - 2 * margin - chrome),
  };
}

// ── theme ────────────────────────────────────────────────────────────────────
//
// Same resolution dashShare's export makes and for the same reason: 'auto'
// declares no tokens because on screen it follows the app, and a printed page
// has no app around it — so it resolves to LIGHT. Without this a dark-mode app
// pastes dark chart rectangles onto a white page, which is the exact bug
// smoke-export.ts exists to catch.
function reportStyleClasses(analysis: any): string[] {
  const s = dashSanitizeStyle(analysis && analysis.style);
  return dashStyleClassList({ ...s, theme: s.theme === 'auto' ? 'clean' : s.theme, chosen: true });
}

// ── resolving one card ───────────────────────────────────────────────────────

/** A card's visual definition, without going through dashGrid's
 *  `resolveCardVisual` — that one reads `currentProjectId`, and a scheduled run
 *  may be printing a report from a project that is not the open one. */
async function reportCardVisual(projectId: string, card: any): Promise<any> {
  if (card && card.visual && card.visual.datasetId) return card.visual;
  if (!card || !card.visualId) return null;
  try {
    return (await window.hub.getVisual(projectId, card.visualId)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * How many BODY rows a pivot may have and still be printed as a real table.
 * Past it the grid runs over more pages than it is worth and goes as an image
 * — one page with a picture of the shape beats four pages of figures nobody
 * asked to page through.
 */
const REPORT_GRID_MAX_ROWS = 40;

interface ResolvedTile {
  cardId: string;
  title: string;
  png: string | null;
  caption: string;
  /** A pivot small enough to print as a real table — see REPORT_GRID_MAX_ROWS. */
  grid?: { head: string[][]; body: string[][] } | null;
}

/**
 * One visual card → its picture and its sentence.
 *
 * The capture goes through the SAME helpers the dashboard export uses
 * (captureChartPNG / captureMapPNG, reportExport.ts), framed with the report's
 * theme and the box this image will actually fill. Capturing at the destination
 * box is what stops a chart arriving letterboxed — the lesson dashShare's
 * `dashExportChartBox` already paid for.
 */
async function reportTile(
  ctx: ReportContext, card: any, box: { width: number; height: number },
): Promise<ResolvedTile | null> {
  const visual = await reportCardVisual(ctx.projectId, card);
  if (!visual) return null;
  const type = typeof visual.chartType === 'string' && visual.chartType ? visual.chartType : 'column';
  const merged = mergeDashFilters(ctx.filters, visual.filters);
  // A report LEAVES the app: asked with the share path, so main applies the
  // Share policy (privacyShare.ts). A tile the policy hides keeps its place and
  // says why, rather than vanishing from the page.
  let res: any;
  try {
    res = await pvVisualData(ctx.projectId, visual.datasetId, visual.encoding, merged, ctx.params, 'report', visual.analytics);
  } catch (_) { res = { ok: false }; }
  if (res && res.hiddenByPolicy) {
    return { cardId: card.id, title: paramSubst(visual.name || '', ctx.params || []), png: null, caption: String(res.error), grid: null };
  }
  if (!res || res.ok === false) return null;
  const data = res.data || { labels: [], series: [] };

  // A PIVOT that fits is typeset, not photographed: the figures stay text, so
  // they are selectable, searchable and readable by a screen reader in the
  // finished document — the same rule the KPI table already follows. Over the
  // cap it falls back to the picture, which is what every chart does anyway.
  let grid: { head: string[][]; body: string[][] } | null = null;
  if (type === 'pivot' && data.pivot) {
    const rows = pivotToRows(data.pivot);
    const headCount = data.pivot.colHeaders.length
      ? Math.max(...data.pivot.colHeaders.map((h: string[]) => h.length))
      : 1;
    if (rows.length - headCount <= REPORT_GRID_MAX_ROWS) {
      grid = { head: rows.slice(0, headCount), body: rows.slice(headCount) };
    }
  }

  const frame = Object.assign({ themeClasses: reportStyleClasses(ctx.analysis), accentHex: dashSanitizeStyle(ctx.analysis && ctx.analysis.style).accentHex }, box);
  let png: string | null = null;
  if (!grid) {
    try {
      png = (type === 'map_bubble' || type === 'map_choropleth')
        ? await captureMapPNG(data, type, frame)
        : await captureChartPNG(type, data, visual.overrides || {}, frame);
    } catch (_) { png = null; }
  }

  let caption = '';
  try {
    caption = await window.hub.reportsCaption({
      chartType: type, data, geo: data.geo || null, pivot: data.pivot || null,
      projectId: ctx.projectId, datasetId: visual.datasetId, // → the catalog's column display names
      overrides: visual.overrides || null,   // a waterfall's totals, a bullet's target
    });
  } catch (_) { caption = ''; }
  return { cardId: card.id, title: paramSubst(visual.name || '', ctx.params || []), png, caption, grid };
}

/** Every metric card on a sheet → its app-computed figure, formatted. */
async function reportKpis(ctx: ReportContext, sheet: any): Promise<Array<{ label: string; value: number | null; text: string }>> {
  const out: Array<{ label: string; value: number | null; text: string }> = [];
  const cards = (sheet && Array.isArray(sheet.cards)) ? sheet.cards : [];
  for (const card of cards) {
    if (!card || card.type !== 'metric' || !card.metric) continue;
    const m = card.metric;
    const label = paramSubst(m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || '')), ctx.params || []);
    let value: number | null = null;
    try {
      const r = await window.hub.computeMetric(ctx.projectId, m.datasetId, m.column, m.aggregation, ctx.filters, ctx.params);
      value = (r && r.ok !== false && typeof r.value === 'number') ? r.value : null;
    } catch (_) { value = null; }
    out.push({ label, value, text: value == null ? '—' : fmtWith(value, m.format || 'auto') });
  }
  return out;
}

/** Plain-text "<label> = <value>" for the whole filter bar, for the cover.
 *  Reuses dashShare's per-control formatter rather than restating its
 *  resolution rules — one description of "what is filtering right now". */
function reportFilterLine(ctx: ReportContext): string {
  const parts: string[] = [];
  for (const sheet of (Array.isArray(ctx.analysis.sheets) ? ctx.analysis.sheets : [])) {
    for (const card of (Array.isArray(sheet.cards) ? sheet.cards : [])) {
      if (card && card.type === 'control') {
        const p = formatControlSummaryPart(card);
        if (p) parts.push(p);
      }
    }
  }
  return parts.length ? 'Filtered: ' + parts.join(' · ') : '';
}

// ── the page list ────────────────────────────────────────────────────────────


/**
 * Resolve a Report's page list into `RenderedPage`s, in order, skipping the
 * pages the author unchecked.
 *
 * Every tile is captured at most ONCE even when it appears on both its sheet
 * page and its own tile page: the cache below is keyed by card id and capture
 * box, which is the whole cost of the operation (a chart capture is an
 * offscreen Chart.js render).
 */
async function buildReportPages(ctx: ReportContext): Promise<RenderedPage[]> {
  const report = ctx.report;
  const sheets: any[] = Array.isArray(ctx.analysis.sheets) ? ctx.analysis.sheets : [];
  const pages: RenderedPage[] = [];
  const cache = new Map<string, ResolvedTile | null>();

  const tileFor = async (card: any, box: { width: number; height: number }): Promise<ResolvedTile | null> => {
    const key = card.id + ':' + box.width + 'x' + box.height;
    if (!cache.has(key)) cache.set(key, await reportTile(ctx, card, box));
    return cache.get(key) || null;
  };
  const findCard = (cardId: string): { card: any; sheet: any } | null => {
    for (const sheet of sheets) {
      for (const card of (Array.isArray(sheet.cards) ? sheet.cards : [])) {
        if (card && card.id === cardId) return { card, sheet };
      }
    }
    return null;
  };

  // The summary page needs every tile's sentence, and it is usually the SECOND
  // page — so the captions are gathered up front rather than back-patched.
  const summaryWanted = (report.pages || []).some((p: any) => p.include !== false && (p.kind === 'summary' || p.kind === 'narrative'));
  const allCaptions: string[] = [];
  const allKpis: Array<{ label: string; value: number | null; text: string }> = [];
  if (summaryWanted) {
    for (const sheet of sheets) {
      const kpis = await reportKpis(ctx, sheet);
      allKpis.push(...kpis);
      if (kpis.length) {
        try {
          allCaptions.push(await window.hub.reportsCaption({ kpis: kpis.map((k) => ({ label: k.label, value: k.value })) }));
        } catch (_) { /* a missing sentence must not lose the page */ }
      }
      for (const card of (Array.isArray(sheet.cards) ? sheet.cards : [])) {
        if (!card || card.type !== 'visual') continue;
        const t = await tileFor(card, reportImageBox(report, 'tile'));
        if (t && t.caption) allCaptions.push((t.title ? t.title + ' — ' : '') + t.caption);
      }
    }
  }

  for (const page of (Array.isArray(report.pages) ? report.pages : [])) {
    if (page.include === false) continue;
    const rp = await buildOnePage(page);
    if (rp) pages.push(rp);
  }
  return pages;

  async function buildOnePage(page: any): Promise<RenderedPage | null> {
    const cover = report.cover || {};
    switch (page.kind) {
      case 'cover': {
        const meta = [reportDateStr()];
        if (report.includeFilters !== false) {
          const line = reportFilterLine(ctx);
          if (line) meta.push(line);
        }
        // "Contains financial data" — main reads the catalog; values are never redacted.
        try { meta.push(...((await window.hub.catalogSensitivity(ctx.projectId, ctx.analysis.id)).lines || [])); } catch (_) { /* no line */ }
        return {
          kind: 'cover', layout: page.layout,
          title: cover.title || report.name || 'Report',
          subtitle: cover.subtitle || '',
          meta, logo: cover.logo !== false ? await reportLogo(ctx.analysis) : null,
        };
      }
      case 'summary':
        return {
          kind: 'summary', layout: page.layout, title: 'Summary',
          kpis: allKpis.map((k) => ({ label: k.label, value: k.text })),
          bullets: allCaptions.slice(),
          caption: page.caption,
        };
      case 'sheet': {
        const sheet = sheets[Number(page.sheetIdx) || 0];
        if (!sheet) return null;
        const box = reportImageBox(report, 'sheet');
        // Two-up on a sheet page: a sheet is several tiles, and a full-width
        // capture of each would run to a page apiece — which is what the TILE
        // pages are for.
        const half = { width: Math.round((box.width - 24) / 2), height: Math.round(box.height / 2) };
        const tiles: Array<{ title: string; png: string | null }> = [];
        for (const card of (Array.isArray(sheet.cards) ? sheet.cards : [])) {
          if (!card || card.type !== 'visual') continue;
          const t = await tileFor(card, half);
          if (t) tiles.push({ title: t.title, png: t.png });
        }
        const kpis = await reportKpis(ctx, sheet);
        let caption = page.caption;
        if (!caption && kpis.length) {
          try {
            caption = await window.hub.reportsCaption({ kpis: kpis.map((k) => ({ label: k.label, value: k.value })) });
          } catch (_) { caption = ''; }
        }
        return {
          kind: 'sheet', layout: page.layout, title: sheet.name || 'Sheet',
          kpis: kpis.map((k) => ({ label: k.label, value: k.text })), tiles, caption,
        };
      }
      case 'tile': {
        const found = page.cardId ? findCard(page.cardId) : null;
        if (!found) {
          // A card the author removed from the dashboard. The page stays and
          // says so, rather than vanishing from a report someone has already
          // ordered a schedule of.
          return { kind: 'tile', layout: page.layout, title: 'Tile', body: 'This tile is no longer on the dashboard.' };
        }
        const t = await tileFor(found.card, reportImageBox(report, 'tile'));
        if (!t) return { kind: 'tile', layout: page.layout, title: 'Tile', body: 'This tile could not be drawn.' };
        return {
          kind: 'tile', layout: page.layout, title: t.title || 'Tile',
          png: t.png, grid: t.grid || null, caption: page.caption || t.caption,
        };
      }
      case 'notes':
        return { kind: 'notes', layout: page.layout, title: 'Notes', body: page.notes || '' };
      case 'narrative': {
        const body = await reportNarrative(ctx, allCaptions);
        return body ? { kind: 'narrative', layout: page.layout, title: 'Narrative', body } : null;
      }
      default:
        return reportDiscussionPage(ctx, page); // 'discussion' (reportDiscussion.ts); null for any other kind
    }
  }
}

/**
 * The one optional model-written page.
 *
 * It is handed the app's OWN captions and asked to join them into prose — it
 * never sees a dataset and never computes anything, so the only figures it can
 * print are figures the app already wrote. If there is no model, or the call
 * fails, or it takes too long, the page is DROPPED: a report must not wait on a
 * model, and a scheduled 06:00 delivery that hangs is worse than one without a
 * narrative.
 */
async function reportNarrative(ctx: ReportContext, captions: string[]): Promise<string> {
  if (!captions.length) return '';
  const prompt = 'Write exactly two short paragraphs summarising this dashboard for a business reader. '
    + 'Use ONLY the figures in these app-computed sentences, verbatim — do not calculate, round or invent any number:\n\n'
    + captions.map((c) => '- ' + c).join('\n');
  try {
    // ponytail: this lands as a turn in the project's current conversation,
    // like any other ask. A dedicated per-report thread would be tidier; do it
    // if someone minds the dock filling up with narrative prompts.
    const res = await Promise.race([
      window.hub.copilotAsk(ctx.projectId, { kind: 'analysis', id: ctx.analysis.id }, prompt),
      new Promise((resolve) => setTimeout(() => resolve(null), 30_000)),
    ]) as any;
    if (!res || res.ok === false || typeof res.answer !== 'string') return '';
    return res.answer.trim();
  } catch (_) {
    return '';
  }
}

// ── blocks: the flat form every consumer actually draws ──────────────────────
//
// A `RenderedPage` says what a page IS; a block list says what is ON it, in
// order, in ten kinds. This second step is what stopped the four consumers from
// each growing their own `switch (page.kind)` with five cases in it — five
// cases times four media is twenty places for the cover's subtitle to go
// missing. Now each consumer answers one question per block kind, and adding a
// page kind is a change HERE, once.
type ReportBlock =
  | { t: 'logo'; src: string; w: number; h: number }
  | { t: 'title'; text: string }
  | { t: 'sub'; text: string }
  | { t: 'meta'; text: string }
  | { t: 'para'; text: string }
  | { t: 'bullet'; text: string }
  | { t: 'caption'; text: string }
  | { t: 'runs'; segments: Array<{ text: string; bold?: boolean }> }
  | { t: 'image'; png: string; alt: string }
  | { t: 'tiles'; tiles: Array<{ title: string; png: string | null }> }
  | { t: 'kpis'; rows: Array<{ label: string; value: string }> }
  | { t: 'grid'; head: string[][]; body: string[][] };

function reportPageBlocks(rp: RenderedPage): ReportBlock[] {
  const out: ReportBlock[] = [];
  if (rp.kind === 'cover' && rp.logo) out.push({ t: 'logo', ...rp.logo });
  if (rp.title) out.push({ t: 'title', text: rp.title });
  if (rp.subtitle) out.push({ t: 'sub', text: rp.subtitle });
  for (const line of (rp.meta || [])) out.push({ t: 'meta', text: line });
  // Prose and the bold-figure headline come BEFORE the picture. That ordering
  // is not cosmetic: it is what the capture report's one-pager has always
  // printed (title, analysis paragraph, headline, chart), and that one-pager is
  // now just a one-page report through this same list — see reportExport.ts.
  for (const para of String(rp.body || '').split(/\n{2,}/)) {
    if (para.trim()) out.push({ t: 'para', text: para.trim() });
  }
  if (rp.segments && rp.segments.length) out.push({ t: 'runs', segments: rp.segments });
  if (rp.kpis && rp.kpis.length) out.push({ t: 'kpis', rows: rp.kpis });
  if (rp.grid) out.push({ t: 'grid', head: rp.grid.head, body: rp.grid.body });
  if (rp.png) out.push({ t: 'image', png: rp.png, alt: rp.title || '' });
  if (rp.tiles && rp.tiles.length) out.push({ t: 'tiles', tiles: rp.tiles });
  for (const line of (rp.bullets || [])) out.push({ t: 'bullet', text: line });
  if (rp.caption) out.push({ t: 'caption', text: rp.caption });
  return out;
}

/** The one date string a report prints, everywhere it prints one. */
/** Today, in the workspace's date style (Settings → Formats). */
function reportDateStr(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return OrdFormat.formatDate(iso);
}

/**
 * Scale the full-size sheet down to fit its stage, and keep it fitted.
 *
 * The scaler reserves the scaled height, because a `transform` does not change
 * layout — without it the stage would still reserve the page's full 1056px and
 * the caption editor below would be pushed off screen. The observer is attached
 * once per stage (the flag), so repainting the preview does not stack them.
 */
function fitPreviewSheet(host: HTMLElement): void {
  const scaler = host.querySelector('.rb-scaler') as HTMLElement | null;
  const sheet = scaler && scaler.firstElementChild as HTMLElement | null;
  if (!scaler || !sheet) return;
  const pageW = Number(sheet.style.getPropertyValue('--rb-page-w')) || 816;
  const pageH = Number(sheet.style.getPropertyValue('--rb-page-h')) || 1056;
  const availW = Math.max(120, host.clientWidth - 32);
  const availH = Math.max(120, host.clientHeight - 32);
  const scale = Math.min(availW / pageW, availH / pageH, 1);
  scaler.style.setProperty('--rb-scale', String(scale));
  scaler.style.width = Math.round(pageW * scale) + 'px';
  scaler.style.height = Math.round(pageH * scale) + 'px';
  if (!(host as any)._rbFit && typeof ResizeObserver === 'function') {
    (host as any)._rbFit = new ResizeObserver(() => fitPreviewSheet(host));
    (host as any)._rbFit.observe(host);
  }
}

// ── the preview ──────────────────────────────────────────────────────────────

/**
 * Draw one resolved page into `host`, at the true page aspect.
 *
 * The fourth consumer of the same block list the three writers read, which is
 * the point: what the builder shows is what the file will say. Sizing goes
 * through CSS custom properties on the sheet element — the hub CSP forbids
 * inline `style=` in HTML, but `element.style.x` from JS is fine.
 */
function renderPreviewPage(host: HTMLElement, rp: RenderedPage | null, report: any): void {
  host.textContent = '';
  const box = reportPageBox(report);
  // THE SHEET IS BUILT AT FULL PAGE SIZE and then scaled down to fit, rather
  // than being laid out at whatever width the pane happens to be. Type on the
  // page is specified in points — 11pt captions, 9pt headers — and points only
  // mean anything against a real page: laid out in a 385px-wide box, a 16:9
  // slide's title came out three times too big and pushed its own caption off
  // the bottom. Scaling the finished page is how a print preview has always
  // done this, and it is the only way the preview can promise to be the file.
  const scaler = document.createElement('div');
  scaler.className = 'rb-scaler';
  const sheet = document.createElement('div');
  sheet.className = 'rb-sheet rb-sheet--' + (rp ? rp.kind : 'empty');
  sheet.style.setProperty('--rb-page-w', String(box.width));
  sheet.style.setProperty('--rb-page-h', String(box.height));
  scaler.appendChild(sheet);
  host.appendChild(scaler);
  fitPreviewSheet(host);
  if (!rp) {
    const empty = document.createElement('p');
    empty.className = 'rb-sheet-empty';
    empty.textContent = 'Select a page to preview it.';
    sheet.appendChild(empty);
    return;
  }

  const head = document.createElement('div');
  head.className = 'rb-sheet-head';
  const hName = document.createElement('span');
  hName.textContent = report.name || 'Report';
  const hDate = document.createElement('span');
  hDate.textContent = reportDateStr();
  head.appendChild(hName);
  head.appendChild(hDate);
  sheet.appendChild(head);

  const body = document.createElement('div');
  body.className = 'rb-sheet-body';
  sheet.appendChild(body);

  const text = (cls: string, s: string, tag = 'p'): void => {
    const el = document.createElement(tag);
    el.className = cls;
    el.textContent = s;
    body.appendChild(el);
  };

  for (const b of reportPageBlocks(rp)) {
    switch (b.t) {
      case 'logo': {
        const mark = document.createElement('img');
        mark.className = 'rb-cover-mark';
        mark.src = b.src;
        mark.alt = '';
        body.appendChild(mark);
        break;
      }
      case 'title': text('rb-sheet-title', b.text, 'h2'); break;
      case 'sub': text('rb-sheet-sub', b.text); break;
      case 'meta': text('rb-sheet-meta', b.text); break;
      case 'para': text('rb-sheet-para', b.text); break;
      case 'bullet': text('rb-sheet-bullet', '• ' + b.text); break;
      case 'caption': text('rb-sheet-caption', b.text); break;
      case 'runs': {
        const p = document.createElement('p');
        p.className = 'rb-sheet-para';
        for (const seg of b.segments) {
          const span = document.createElement(seg.bold ? 'strong' : 'span');
          span.textContent = seg.text || '';
          p.appendChild(span);
        }
        body.appendChild(p);
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.className = 'rb-sheet-img';
        img.src = b.png;
        img.alt = b.alt;
        body.appendChild(img);
        break;
      }
      case 'grid': {
        // A REAL table in the preview too, so what the author sees on the page
        // is what the PDF/PPTX/DOCX writers will typeset — not a picture here
        // and text there.
        const t = document.createElement('table');
        t.className = 'rb-grid';
        const thead = document.createElement('thead');
        for (const hr of b.head) {
          const tr = document.createElement('tr');
          hr.forEach((cellText, i) => {
            const th = document.createElement('th');
            th.textContent = cellText;
            if (i === 0) th.className = 'rb-grid-label';
            tr.appendChild(th);
          });
          thead.appendChild(tr);
        }
        t.appendChild(thead);
        const tb = document.createElement('tbody');
        for (const br of b.body) {
          const tr = document.createElement('tr');
          br.forEach((cellText, i) => {
            const td = document.createElement('td');
            td.textContent = cellText;
            if (i === 0) td.className = 'rb-grid-label';
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        body.appendChild(t);
        break;
      }
      case 'kpis': {
        const row = document.createElement('div');
        row.className = 'rb-kpis';
        for (const k of b.rows) {
          const cell = document.createElement('div');
          cell.className = 'rb-kpi';
          const v = document.createElement('div');
          v.className = 'rb-kpi-value tnum';
          v.textContent = k.value;
          const l = document.createElement('div');
          l.className = 'rb-kpi-label';
          l.textContent = k.label;
          cell.appendChild(v);
          cell.appendChild(l);
          row.appendChild(cell);
        }
        body.appendChild(row);
        break;
      }
      case 'tiles': {
        const grid = document.createElement('div');
        grid.className = 'rb-tiles';
        for (const t of b.tiles) {
          const cell = document.createElement('figure');
          cell.className = 'rb-tile';
          if (t.png) {
            const img = document.createElement('img');
            img.src = t.png;
            img.alt = t.title;
            cell.appendChild(img);
          } else {
            const miss = document.createElement('div');
            miss.className = 'rb-tile-missing';
            miss.textContent = 'Could not be drawn';
            cell.appendChild(miss);
          }
          const cap = document.createElement('figcaption');
          cap.textContent = t.title;
          cell.appendChild(cap);
          grid.appendChild(cell);
        }
        body.appendChild(grid);
        break;
      }
    }
  }
}
