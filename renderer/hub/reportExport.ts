// Report export — chart→PNG capture, the export dialog, and PDF/PPTX/DOCX
// generation. Extracted from hub.js as a pure structural move (no logic changes).
// Classic script sharing global scope with hub.js: buildChart, window.hub.save*,
// and the pdfMake / PptxGenJS / docx globals all resolve at call time.

// ── Report export (stage 1: chart→PNG + dialog; file generation is next stage) ──
// Render `type` to a crisp PNG data URL OFF-SCREEN (2x, no animation), composited
// onto a solid background so it embeds cleanly in a report. Reuses buildChart, so
// the exported chart matches the on-screen one. Resolves null if the type can't draw.
// Maps are NOT handled here — see captureMapPNG below, which snapshots the live
// MapLibre render through the main process instead of rasterizing a Chart.js canvas.
function captureChartPNG(type: string, data: any, overrides?: any): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const holder = document.createElement('div');
    holder.className = 'export-capture-holder';
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    document.body.appendChild(holder);
    let chart: any = null;
    const finish = (url: string | null) => {
      if (chart) { try { chart.destroy(); } catch (_) {} }
      holder.remove();
      resolve(url);
    };
    try {
      chart = buildChart(canvas, data, type, Object.assign({}, overrides, { noAnimate: true, devicePixelRatio: 2 }));
      if (!chart) return finish(null);
      chart.update('none'); // force the final, animation-free frame before we read pixels
      requestAnimationFrame(() => {
        try {
          const src = chart.canvas;
          const out = document.createElement('canvas');
          out.width = src.width; out.height = src.height;
          const ctx = out.getContext('2d')!;
          // Solid background = the theme surface, so dark-theme charts stay readable
          // (white-page reports can force light theme in the next stage).
          ctx.fillStyle = getCSSVar('--surface') || '#ffffff';
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(src, 0, 0);
          finish(out.toDataURL('image/png'));
        } catch (_) { finish(null); }
      });
    } catch (_) { finish(null); }
  });
}

// ── MapLibre map → PNG ───────────────────────────────────────────────────────
//
// PHASE-4 CONTRACT — the two export hooks renderer/hub/mapRender.ts publishes:
//   • `getMapInContainer(container)` → the live MapLibre map drawn into that container,
//     or null when a geo fallback (bar chart / note) drew instead.
//   • `waitForMapIdle(container, timeoutMs)` → true once the map has loaded its tiles
//     and settled on 'idle', false on timeout. This replaces the Leaflet-era DOM
//     tile-counting wait: MapLibre knows when it is done, the DOM does not.
// mapRender.ts also owns `preserveDrawingBuffer: true` on the map — needed ONLY by the
// last-resort canvas fallback below, never by capturePage. It is set in exactly one
// place, there, and is not duplicated here.
//
// WHY capturePage AND NOT `canvas.toDataURL()` as the primary. MapLibre draws the whole
// map (tiles, fills, circles, labels) into ONE WebGL canvas, but the legend, the
// "couldn't place" note and the value chips are DOM siblings — reading the canvas alone
// would silently drop them. `webContents.capturePage` snapshots the COMPOSITED page, so
// WebGL layers and DOM overlays come back in one image, at the display's scale factor,
// with no CORS/canvas tainting and no new dependency. It also does NOT depend on
// preserveDrawingBuffer, because the compositor reads the presented surface rather than
// the drawing buffer. The canvas read is kept only as a degraded fallback.
//
// The holder is `position: fixed` at the hub's top-left (.export-map-capture), i.e. it
// is genuinely on-screen in the VISIBLE hub window while the snapshot is taken — the
// offscreen report window (src/reportCapture.ts) never renders a map itself, it only
// embeds the `data:` PNG produced here. That is deliberate: it keeps WebGL entirely out
// of the hidden-BrowserWindow path.
//
// Returns null if the map can't be captured cleanly (never idles, comes back blank, IPC
// failure) so the caller falls back rather than embedding a half-drawn map.
async function captureMapPNG(vizData: any, type: string): Promise<string | null> {
  if (!window.hub || typeof window.hub.captureRegion !== 'function') return null;
  if (typeof renderMapInArea !== 'function') return null;

  const holder = document.createElement('div');
  holder.className = 'export-map-capture';
  // Generous capture size (clamped to the window) → crisp at the display's pixel ratio.
  const W = Math.min(960, Math.max(480, window.innerWidth - 40));
  const H = Math.min(600, Math.max(320, window.innerHeight - 40));
  holder.style.width = W + 'px';
  holder.style.height = H + 'px';
  document.body.appendChild(holder);

  try {
    await renderMapInArea(holder, vizData, type);
    // Drop the interactive controls — the Values / ⋯ cluster and MapLibre's own
    // zoom/compass buttons. The value legend and the OSM attribution both stay.
    holder.querySelectorAll<HTMLElement>('.cv-graph-controls, .maplibregl-ctrl-group')
      .forEach(c => { c.style.display = 'none'; });

    const map = getMapInContainer(holder);
    if (!map) return null;   // a geo fallback (bar chart / note) drew instead of a map

    // The holder was sized before the map was built, but a resize() is free insurance
    // that the GL drawing buffer matches the box we are about to snapshot.
    try { if (typeof map.resize === 'function') map.resize(); } catch (_) {}

    const idle = await waitForMapIdle(holder, 8000);
    if (!idle) return null;
    // Two frames so the last render pass is composited before the snapshot is taken.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const rect = holder.getBoundingClientRect();
    const png = await window.hub.captureRegion({
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
    });
    // A uniform image means the WebGL layer did not make it into the composite — the
    // one failure mode that would otherwise ship a blank rectangle into a report.
    if (png && !(await isUniformImage(png))) return png;
    return await captureMapCanvasPNG(map);
  } catch (e) {
    console.error('[export] map capture failed', e);
    return null;
  } finally {
    if (typeof destroyMapInContainer === 'function') { try { destroyMapInContainer(holder); } catch (_) {} }
    holder.remove();
  }
}

// Last resort when the composited snapshot came back blank: read the map's own WebGL
// canvas. Loses the DOM legend/notes, but a map without its legend beats no map at all.
// This is the ONE caller that needs the map to have been created with
// preserveDrawingBuffer: true (set in mapRender.ts, see the contract above) — without
// it the read comes back transparent, which the uniform check below rejects, and the
// caller degrades to "couldn't capture the map" rather than embedding a blank box.
async function captureMapCanvasPNG(map: any): Promise<string | null> {
  try {
    const canvas = typeof map.getCanvas === 'function' ? map.getCanvas() : null;
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    if (typeof map.triggerRepaint === 'function') map.triggerRepaint();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Composite onto the theme surface so a transparent GL background doesn't turn into
    // a black block in a PDF/Word page.
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = getCSSVar('--surface') || '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const url = out.toDataURL('image/png');
    return (await isUniformImage(url)) ? null : url;
  } catch (e) {
    console.error('[export] map canvas fallback failed', e);
    return null;
  }
}

// True when every pixel of `dataUrl` is the same colour — the signature of a capture
// that produced nothing (blank GL layer, empty surface). Sampled through a small
// downscale so the check costs a fixed ~1k pixel reads regardless of capture size.
// Errors resolve false: a check we can't run must never discard a good image.
function isUniformImage(dataUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const img = new Image();
      img.onerror = () => resolve(false);
      img.onload = () => {
        try {
          const S = 32;
          const c = document.createElement('canvas');
          c.width = S; c.height = S;
          const ctx = c.getContext('2d');
          if (!ctx) return resolve(false);
          ctx.drawImage(img, 0, 0, S, S);
          const d = ctx.getImageData(0, 0, S, S).data;
          for (let i = 4; i < d.length; i += 4) {
            if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) {
              return resolve(false);
            }
          }
          resolve(true);
        } catch (_) { resolve(false); }
      };
      img.src = dataUrl;
    } catch (_) { resolve(false); }
  });
}

let _exportEscape: ((e: KeyboardEvent) => void) | null = null;
let _exportA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
function closeExportDialog(): void {
  const ov = document.getElementById('export-overlay');
  if (ov) ov.remove();
  if (_exportEscape) { document.removeEventListener('keydown', _exportEscape, true); _exportEscape = null; }
  if (_exportA11y) { _exportA11y.release(); _exportA11y = null; } // return focus to the trigger
}

// A filesystem-safe default filename from the capture title, for a given extension.
function reportFilename(title: string | null | undefined, ext: string): string {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return (base || 'screenchart-report') + '.' + ext;
}

// Rasterize an inline SVG to a 2x PNG data URL (canvas), for embedding in formats
// that take raster images cleanly (pptx). Self-contained SVG → no canvas taint.
// Resolves null on any failure so the caller degrades gracefully (logo omitted).
function svgToPngDataUrl(svg: string, w: number, h: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = w * 2; c.height = h * 2;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      // An SVG loaded into an <img> MUST declare the SVG namespace or the browser
      // refuses to decode it (onerror) — inline SVG in HTML doesn't need this, which
      // is why the PDF (pdfmake's own parser) kept the logo but the raster path
      // (used by Word + PPTX) returned null.
      const ns = /<svg[^>]*\sxmlns=/.test(svg) ? svg
        : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      img.src = 'data:image/svg+xml;base64,' + btoa(ns);
    } catch (_) { resolve(null); }
  });
}

// Build the pdfmake document definition for the one-page report. Colors are the
// app's LIGHT-theme tokens hardcoded (the PDF is always a white page, regardless
// of the app's current theme). A4 with 36pt side margins → 523pt content width.
// The app's brand mark — a hexagonal frame holding three ascending bars,
// matching assets/icons/mark.svg. Hardcoded to the LIGHT tokens because the PDF
// is always a white page regardless of the app's theme. Inlined as an SVG string
// so the report needs no image asset — assets/icons is NOT bundled into the
// packaged asar, and pdfmake renders {svg} as crisp vector.
const REPORT_LOGO_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
  '<path d="M12 3.1L20 7.9V16.1L12 20.9L4 16.1V7.9Z" ' +
  'stroke="#0f1117" stroke-width="2.2" stroke-linejoin="round"/>' +
  '<g fill="#2563eb">' +
  '<rect x="8.25" y="13.2" width="2" height="2.6" rx="1"/>' +
  '<rect x="11" y="11.4" width="2" height="4.4" rx="1"/>' +
  '<rect x="13.75" y="9.8" width="2" height="6" rx="1"/></g></svg>';

// ponytail: the export args ({ title, analysis, headlineSegments, png, … }) and the
// pdfmake/pptxgenjs/docx document trees are big untyped envelopes — typed `any`
// throughout this file; the vendor globals are already `any` in globals.d.ts.
function buildReportDoc({ title, analysis, headlineSegments, png }: any) {
  // Mirror renderer/theme.css light tokens — kept literal since a PDF can't read CSS vars.
  const C = { ink: '#18181b', strong: '#0f1117', muted: '#6b7280', accent: '#2563eb', border: '#e5e7eb' };
  const CONTENT_W = 523;
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const content: any[] = [];
  // Header: capture title (left) + a small brand lockup, top-right — logo mark,
  // then the Screenchart wordmark with the date beneath it.
  content.push({
    columns: [
      { text: title || 'Analysis', style: 'title', width: '*' },
      { svg: REPORT_LOGO_SVG, width: 13, height: 13, margin: [0, 2, 5, 0] },
      { stack: [{ text: 'Screenchart', style: 'wordmark' }, { text: dateStr, style: 'date' }], width: 'auto' },
    ],
    columnGap: 0,
  });
  // Accent rule under the header.
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 2, lineColor: C.accent }], margin: [0, 10, 0, 16] });
  // Qualitative analysis paragraph.
  const hasHeadline = Array.isArray(headlineSegments) && headlineSegments.length;
  if (analysis) content.push({ text: analysis, style: 'analysis', margin: [0, 0, 0, hasHeadline ? 10 : 16] });
  // Headline — keep the bold emphasis on the key figures (our segments → pdfmake runs).
  if (hasHeadline) {
    content.push({
      text: headlineSegments.map((s: any) => (s && s.bold) ? { text: s.text, bold: true, color: C.strong } : (s ? s.text : '')),
      style: 'headline', margin: [0, 0, 0, 18],
    });
  }
  // The chosen chart as the crisp PNG — fit (preserves aspect, never stretches).
  if (png) content.push({ image: png, fit: [CONTENT_W, 360], alignment: 'center' });
  else content.push({ text: '(chart unavailable for this view)', style: 'muted', italics: true, margin: [0, 8, 0, 0] });

  return {
    pageSize: 'A4',
    pageMargins: [36, 40, 36, 52],
    content,
    // Subtle footer: attribution + date on the left; a page number on the right
    // only when the report spills past one page.
    footer: (currentPage: number, pageCount: number) => {
      const cols: any[] = [{ text: 'Generated by Screenchart · ' + dateStr, style: 'footer' }];
      if (pageCount > 1) cols.push({ text: currentPage + ' / ' + pageCount, style: 'footer', alignment: 'right', width: 'auto' });
      return { margin: [36, 8, 36, 0], columns: cols, columnGap: 8 };
    },
    styles: {
      title: { fontSize: 18, bold: true, color: C.strong },
      wordmark: { fontSize: 11, bold: true, color: C.accent },
      date: { fontSize: 9, color: C.muted, margin: [0, 2, 0, 0] },
      analysis: { fontSize: 11, color: C.ink, lineHeight: 1.4 },
      headline: { fontSize: 12, color: C.ink, lineHeight: 1.4 },
      muted: { fontSize: 10, color: C.muted },
      footer: { fontSize: 8, color: C.muted },
    },
    defaultStyle: { font: 'Roboto', fontSize: 11, color: C.ink },
    info: { title: title || 'Screenchart report', creator: 'Screenchart' },
  };
}

// Generate the one-page PDF (pdfmake, in-renderer) and save it via the native
// dialog (main process). png is the Stage-A capture (null if the chart couldn't
// be drawn — the doc then notes that gracefully instead of failing).
async function exportPdf({ title, analysis, headlineSegments, type, png }: any) {
  showToast('Preparing PDF engine…');
  await ensureBundle('pdf');
  if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') {
    showToast('PDF engine not loaded'); return;
  }
  showToast('Building PDF…');
  let base64;
  try {
    const doc = buildReportDoc({ title, analysis, headlineSegments, png });
    // pdfmake 0.3.x: getBase64() returns a Promise (no callback) — await it directly.
    // (Passing a callback here silently hung at "Building PDF…".)
    base64 = await window.pdfMake.createPdf(doc).getBase64();
  } catch (e) {
    console.error('[export] PDF build failed', e);
    showToast('Couldn’t build the PDF'); return;
  }
  try {
    const res = await window.hub.savePdf(base64, reportFilename(title, 'pdf'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] save failed', e);
    showToast('Save failed');
  }
}

// Build the .pptx deck — same content as the PDF, laid out as SLIDES (16:9). Slide 1
// is title + brand lockup + analysis + the bold-figure headline; slide 2 is the chart
// big and centered. pptxgenjs colors are bare hex (no '#'). logoPng is the rasterized
// brand mark (null → omitted). Returns the configured PptxGenJS instance.
function buildReportPptx({ title, analysis, headlineSegments, png, logoPng }: any) {
  const C = { ink: '18181B', strong: '0F1117', muted: '6B7280', accent: '2563EB' };
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in (16:9 widescreen)
  const W = 13.33;
  const t = title || 'Analysis';

  const header = (slide: any) => {
    if (logoPng) slide.addImage({ data: logoPng, x: 11.3, y: 0.4, w: 0.38, h: 0.38 });
    slide.addText('Screenchart', { x: 11.74, y: 0.34, w: 1.55, h: 0.3, fontSize: 14, bold: true, color: C.accent });
    slide.addText(dateStr, { x: 11.74, y: 0.64, w: 1.55, h: 0.22, fontSize: 9, color: C.muted });
    slide.addText(t, { x: 0.6, y: 0.4, w: 10.6, h: 0.7, fontSize: 26, bold: true, color: C.strong, valign: 'top' });
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.18, w: W - 1.2, h: 0.03, fill: { color: C.accent } });
  };
  const footer = (slide: any, n: number) => slide.addText(`Screenchart  ·  ${dateStr}  ·  ${n}`,
    { x: 0.6, y: 7.05, w: W - 1.2, h: 0.3, fontSize: 9, color: C.muted });

  // Slide 1 — analysis + headline (key figures bold).
  const s1 = pptx.addSlide();
  header(s1);
  if (analysis) s1.addText(analysis, { x: 0.6, y: 1.5, w: W - 1.2, h: 1.6, fontSize: 16, color: C.ink, lineSpacingMultiple: 1.25, valign: 'top' });
  if (Array.isArray(headlineSegments) && headlineSegments.length) {
    s1.addText(
      headlineSegments.map((s: any) => ({ text: (s && s.text) || '', options: { bold: !!(s && s.bold), color: (s && s.bold) ? C.strong : C.ink } })),
      { x: 0.6, y: analysis ? 3.3 : 1.6, w: W - 1.2, h: 1.7, fontSize: 18, color: C.ink, lineSpacingMultiple: 1.25, valign: 'top' });
  }
  footer(s1, 1);

  // Slide 2 — the chosen chart, large + centered (contain = never stretched).
  const s2 = pptx.addSlide();
  header(s2);
  if (png) s2.addImage({ data: png, x: 1.0, y: 1.5, w: W - 2.0, h: 5.2, sizing: { type: 'contain', w: W - 2.0, h: 5.2 } });
  else s2.addText('(chart unavailable for this view)', { x: 0.6, y: 3.5, w: W - 1.2, h: 0.5, fontSize: 14, italic: true, color: C.muted, align: 'center' });
  footer(s2, 2);

  return pptx;
}

// Generate the .pptx (pptxgenjs, in-renderer) and save via the native dialog.
async function exportPptx({ title, analysis, headlineSegments, png }: any) {
  showToast('Preparing PowerPoint engine…');
  await ensureBundle('pptx');
  if (!window.PptxGenJS) { showToast('PowerPoint engine not loaded'); return; }
  showToast('Building PowerPoint…');
  let base64;
  try {
    const logoPng = await svgToPngDataUrl(REPORT_LOGO_SVG, 48, 48);
    const pptx = buildReportPptx({ title, analysis, headlineSegments, png, logoPng });
    base64 = await pptx.write({ outputType: 'base64' });
  } catch (e) {
    console.error('[export] PPTX build failed', e);
    showToast('Couldn’t build the PowerPoint'); return;
  }
  try {
    const res = await window.hub.savePptx(base64, reportFilename(title, 'pptx'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] save failed', e);
    showToast('Save failed');
  }
}

// Natural pixel size of a PNG data URL (for sizing the image in the .docx).
function imageSize(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
// data: URL → Uint8Array (docx ImageRun wants raw bytes, not a data URL).
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(String(dataUrl).split(',')[1] || '');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Build the one-page Word document — same content + feel as the PDF, as a real
// editable .docx (heading run, body font, accent divider, bold key figures, the
// chart PNG sized to the content width, subtle footer). Colors are the app's LIGHT
// tokens as bare hex (docx wants no '#'); the doc is always a white page.
function buildReportDocx({ title, analysis, headlineSegments, png, logoPng, pngDims }: any) {
  const d = window.docx;
  const { Document, Paragraph, TextRun, ImageRun, AlignmentType, BorderStyle, Header, Footer,
    PageNumber, TabStopType, Table, TableRow, TableCell, WidthType, VerticalAlign } = d;
  const C = { ink: '18181B', strong: '0F1117', muted: '6B7280', accent: '2563EB' };
  const FONT = 'Calibri';
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  // A4 in twips (1pt = 20 twips); margins mirror the PDF [L36 T40 R36 B52]pt.
  const PAGE_W = 11906, PAGE_H = 16838, MARGIN = { top: 800, right: 720, bottom: 1040, left: 720 };
  const CONTENT_TW = PAGE_W - MARGIN.left - MARGIN.right;          // content width, twips
  const CONTENT_PX = Math.round((CONTENT_TW / 20) * (96 / 72));    // ≈ content width in px

  // ── Header: title (left) + brand lockup (right) in a borderless 2-col table ──
  const brandRuns: any[] = [];
  if (logoPng) brandRuns.push(new ImageRun({ type: 'png', data: dataUrlToBytes(logoPng), transformation: { width: 22, height: 22 } }));
  brandRuns.push(new TextRun({ text: (logoPng ? '  ' : '') + 'Screenchart', bold: true, color: C.accent, size: 26, font: FONT }));
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  // The accent rule under the header lives on the header cells' BOTTOM border (a
  // full-width 2pt blue line under the row) — more reliable than an empty-paragraph
  // border, which some editors don't render. Matches the PDF's accent divider.
  const accentRule = { style: BorderStyle.SINGLE, size: 16, color: C.accent, space: 4 };
  const cellBorders = { top: noBorder, bottom: accentRule, left: noBorder, right: noBorder };
  const headerTable = new Table({
    width: { size: CONTENT_TW, type: WidthType.DXA },
    borders: { top: noBorder, bottom: accentRule, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
    columnWidths: [Math.round(CONTENT_TW * 0.62), Math.round(CONTENT_TW * 0.38)],
    rows: [new TableRow({
      children: [
        new TableCell({
          borders: cellBorders, verticalAlign: VerticalAlign.CENTER,
          width: { size: Math.round(CONTENT_TW * 0.62), type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: title || 'Analysis', bold: true, color: C.strong, size: 36, font: FONT })] })],
        }),
        new TableCell({
          borders: cellBorders, verticalAlign: VerticalAlign.CENTER,
          width: { size: Math.round(CONTENT_TW * 0.38), type: WidthType.DXA },
          children: [
            new Paragraph({ alignment: AlignmentType.RIGHT, children: brandRuns }),
            new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: dateStr, color: C.muted, size: 18, font: FONT })] }),
          ],
        }),
      ],
    })],
  });

  // Spacer below the accent rule (the rule itself is the header cells' bottom border).
  const divider = new Paragraph({ spacing: { after: 220 }, children: [] });

  const children = [headerTable, divider];

  if (analysis) {
    children.push(new Paragraph({
      spacing: { after: 200, line: 336, lineRule: 'auto' },
      children: [new TextRun({ text: analysis, color: C.ink, size: 22, font: FONT })],
    }));
  }
  if (Array.isArray(headlineSegments) && headlineSegments.length) {
    children.push(new Paragraph({
      spacing: { after: 320, line: 336, lineRule: 'auto' },
      children: headlineSegments.map((s: any) => new TextRun({
        text: (s && s.text) || '', bold: !!(s && s.bold),
        color: (s && s.bold) ? C.strong : C.ink, size: 24, font: FONT,
      })),
    }));
  }

  // Chart PNG, sized to content width (preserve aspect; cap height like the PDF).
  if (png) {
    const maxW = CONTENT_PX, maxH = 480;
    let w = maxW, h = maxW;
    if (pngDims && pngDims.w && pngDims.h) {
      h = Math.round(maxW * (pngDims.h / pngDims.w));
      if (h > maxH) { h = maxH; w = Math.round(maxH * (pngDims.w / pngDims.h)); }
    } else { h = Math.round(maxW * 0.6); }
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 60 },
      children: [new ImageRun({ type: 'png', data: dataUrlToBytes(png), transformation: { width: w, height: h } })],
    }));
  } else {
    children.push(new Paragraph({
      spacing: { before: 120 },
      children: [new TextRun({ text: '(chart unavailable for this view)', italics: true, color: C.muted, size: 20, font: FONT })],
    }));
  }

  // Subtle footer: attribution left, page number right (Word footers are uniform,
  // so the page number always shows; it reads "Page 1 of 1" on a one-pager).
  const footer = new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TW }],
      children: [
        new TextRun({ text: 'Generated by Screenchart · ' + dateStr, color: C.muted, size: 16, font: FONT }),
        new TextRun({ text: '\tPage ', color: C.muted, size: 16, font: FONT }),
        new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 16, font: FONT }),
        new TextRun({ text: ' of ', color: C.muted, size: 16, font: FONT }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], color: C.muted, size: 16, font: FONT }),
      ],
    })],
  });

  return new Document({
    creator: 'Screenchart',
    title: title || 'Screenchart report',
    styles: { default: { document: { run: { font: FONT, size: 22, color: C.ink } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: MARGIN } },
      footers: { default: footer },
      children,
    }],
  });
}

// Generate the one-page .docx (docx lib, in-renderer) and save via the native dialog.
async function exportDocx({ title, analysis, headlineSegments, png }: any) {
  showToast('Preparing Word engine…');
  await ensureBundle('docx');
  if (!window.docx || !window.docx.Packer) { showToast('Word engine not loaded'); return; }
  showToast('Building Word…');
  let base64;
  try {
    const logoPng = await svgToPngDataUrl(REPORT_LOGO_SVG, 22, 22);
    const pngDims = png ? await imageSize(png) : null;
    const doc = buildReportDocx({ title, analysis, headlineSegments, png, logoPng, pngDims });
    base64 = await window.docx.Packer.toBase64String(doc);
  } catch (e) {
    console.error('[export] DOCX build failed', e);
    showToast('Couldn’t build the Word doc'); return;
  }
  try {
    const res = await window.hub.saveDocx(base64, reportFilename(title, 'docx'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] save failed', e);
    showToast('Save failed');
  }
}

function escapeHtml(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the report as a standalone HTML page that mirrors the PDF one-pager —
// header (title + brand lockup: logo, "Screenchart" wordmark, date) + accent rule +
// qualitative analysis + headline with bold key figures + the chosen chart + footer —
// using the same hardcoded LIGHT-theme tokens as buildReportDoc (the report is always
// a white page). Self-contained: inline CSS, inline logo SVG, chart as a data: URL,
// no scripts and no external assets, so MAIN can render+capture it in a hidden window.
// System sans is used (not the bundled Hanken Grotesk) to avoid embedding a font.
function buildReportHtml({ title, analysis, headlineSegments, png }: any): string {
  const C = { ink: '#18181b', strong: '#0f1117', muted: '#6b7280', accent: '#2563eb', page: '#ffffff' };
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const hasHeadline = Array.isArray(headlineSegments) && headlineSegments.length;
  const headlineHtml = hasHeadline
    ? headlineSegments.map((s: any) => (s && s.bold)
        ? `<strong>${escapeHtml(s.text)}</strong>`
        : escapeHtml(s ? s.text : '')).join('')
    : '';
  const chartHtml = png
    ? `<div class="chartwrap"><img class="report-chart" src="${png}" alt="chart"></div>`
    : `<div class="unavail">(chart unavailable for this view)</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: ${C.page}; }
    body { font-family: -apple-system, system-ui, 'Hanken Grotesk', 'Segoe UI', sans-serif;
           color: ${C.ink}; -webkit-font-smoothing: antialiased; }
    .page { padding: 40px 44px 44px; }
    .head { display: flex; align-items: flex-start; gap: 14px; }
    .title { flex: 1 1 auto; font-size: 23px; font-weight: 700; color: ${C.strong}; line-height: 1.22; }
    .brand { display: flex; align-items: flex-start; gap: 6px; flex: 0 0 auto; }
    .brand svg { width: 17px; height: 17px; margin-top: 2px; }
    .brand .wm { font-size: 13px; font-weight: 700; color: ${C.accent}; line-height: 1.2; }
    .brand .date { font-size: 10px; color: ${C.muted}; margin-top: 3px; white-space: nowrap; }
    .rule { height: 2px; background: ${C.accent}; margin: 12px 0 18px; }
    .analysis { font-size: 13.5px; line-height: 1.5; color: ${C.ink}; }
    .headline { font-size: 14.5px; line-height: 1.5; color: ${C.ink}; margin-top: 12px; }
    .headline strong { font-weight: 700; color: ${C.strong}; }
    .chartwrap { margin-top: 20px; text-align: center; }
    .report-chart { max-width: 100%; max-height: 420px; height: auto; }
    .unavail { margin-top: 10px; font-size: 12px; font-style: italic; color: ${C.muted}; }
    .footer { margin-top: 22px; font-size: 9px; color: ${C.muted}; }
  </style></head><body><div class="page">
    <div class="head">
      <div class="title">${escapeHtml(title || 'Analysis')}</div>
      <div class="brand">${REPORT_LOGO_SVG}<div><div class="wm">Screenchart</div><div class="date">${escapeHtml(dateStr)}</div></div></div>
    </div>
    <div class="rule"></div>
    ${analysis ? `<div class="analysis">${escapeHtml(analysis)}</div>` : ''}
    ${hasHeadline ? `<div class="headline">${headlineHtml}</div>` : ''}
    ${chartHtml}
    <div class="footer">Generated by Screenchart · ${escapeHtml(dateStr)}</div>
  </div></body></html>`;
}

// Export the FULL report as a single PNG — same content + layout as the PDF one-pager,
// rendered as HTML and snapshotted in MAIN by a hidden, content-sized window (2x on
// retina). `png` is the same 2x chart/map image the other formats embed; the dialog's
// map/fallback handling already ran, so a null chart just renders the "unavailable" note.
async function exportPng({ title, analysis, headlineSegments, png }: any) {
  if (!window.hub || typeof window.hub.captureReport !== 'function') { showToast('Save failed'); return; }
  showToast('Rendering report…');
  let reportPng;
  try {
    const html = buildReportHtml({ title, analysis, headlineSegments, png });
    reportPng = await window.hub.captureReport(html, 640);
  } catch (e) {
    console.error('[export] report PNG render failed', e);
  }
  if (!reportPng) { showToast('Couldn’t render the report image'); return; }
  try {
    const res = await window.hub.saveImage(reportPng, reportFilename(title, 'png'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] PNG save failed', e);
    showToast('Save failed');
  }
}

// recommended/selectedExtra/current: the same three-tier picker state as the main view
// (chartable types only — maps/tables can't be rasterized into a report). vizData/entry/
// turnIdx let the dialog render a LIVE chart with the real "⋯" cluster and share
// entry.chartOverrides, so Values/Periods/Customize tweaks here sync back to the on-screen
// chart. The chart TYPE choice is report-only (it doesn't change the on-screen selection).
function openExportDialog({ recommended, selectedExtra, current, vizData, entry, turnIdx, hasGeo, analysis, title, headlineSegments }: any): void {
  closeExportDialog();
  recommended = recommended || [];
  if (!recommended.length) { showToast('No chart to export'); return; }
  const isMapType = (t: string) => t === 'map_bubble' || t === 'map_choropleth';
  const overridesFor = (t: string) => (entry && entry.chartOverrides && entry.chartOverrides[`${turnIdx}:${t}`]) || {};

  const overlay = document.createElement('div');
  overlay.id = 'export-overlay';
  overlay.className = 'export-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'export-modal';
  overlay.appendChild(dialog);

  // Header
  const head = document.createElement('div');
  head.className = 'export-head';
  const titles = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'export-eyebrow';
  eyebrow.textContent = 'REPORT';
  const titleEl = document.createElement('div');
  titleEl.className = 'export-title';
  titleEl.textContent = 'Export report';
  titles.appendChild(eyebrow); titles.appendChild(titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'export-x';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeExportDialog);
  head.appendChild(titles); head.appendChild(closeBtn);
  dialog.appendChild(head);

  // Body
  const body = document.createElement('div');
  body.className = 'export-body';
  dialog.appendChild(body);

  // Chart label + the shared picker (chip row + "+ More" three-tier panel)
  const typeLabel = document.createElement('div');
  typeLabel.className = 'export-label';
  typeLabel.textContent = 'Chart';
  body.appendChild(typeLabel);

  // Live preview = a real chart with its own "⋯" cluster (Values / Periods / Customize),
  // identical to the main view. The format buttons disable while it can't render.
  const previewArea = document.createElement('div');
  previewArea.className = 'cv-viz-area export-viz-area';

  let fmtRow: HTMLDivElement | null = null;
  const setFmtEnabled = (on: boolean) => {
    if (!fmtRow) return;
    fmtRow.querySelectorAll<HTMLButtonElement>('.export-fmt-btn').forEach(b => { b.disabled = !on; b.classList.toggle('is-disabled', !on); });
  };

  function renderSelected(type: string, info: any) {
    if (!info.canRender) {
      previewArea.innerHTML = '';
      const m = document.createElement('div');
      m.className = 'cv-chart-fallback';
      m.textContent = (VIZ_LABELS[type] || type) + ' needs ' + info.needs + " — it doesn't fit this data.";
      previewArea.appendChild(m);
      setFmtEnabled(false);
      return;
    }
    renderVizInArea(previewArea, vizData, type, entry, turnIdx);   // live chart + real ⋯ menu
    if (!info.suited && type !== 'table' && !isMapType(type)) {
      const note = document.createElement('div');
      note.className = 'cv-fit-note';
      note.textContent = 'This chart may not be the best fit for this data.';
      previewArea.appendChild(note);
    }
    setFmtEnabled(true);
  }

  // ponytail: picker is the buildVizPicker widget object ({ switcher, getSelected,
  // select }) — globals.d.ts types the factory's return loosely as HTMLElement.
  const picker: any = buildVizPicker({
    recommended,
    // Charts + maps (maps capture via capturePage); the raw table can't be a report image.
    pool: ALL_CHART_TYPE_IDS.concat(['map_bubble', 'map_choropleth']),
    data: vizData, hasGeo: !!hasGeo,
    initial: (recommended.indexOf(current) !== -1 || (selectedExtra || []).indexOf(current) !== -1) ? current : recommended[0],
    initialSelected: selectedExtra || [],
    onSelect: renderSelected,
  });
  body.appendChild(picker.switcher);
  body.appendChild(previewArea);

  // Format buttons
  const fmtLabel = document.createElement('div');
  fmtLabel.className = 'export-label';
  fmtLabel.textContent = 'Format';
  body.appendChild(fmtLabel);
  fmtRow = document.createElement('div');
  fmtRow.className = 'export-fmt-row';
  [['pdf', 'PDF'], ['word', 'Word'], ['ppt', 'PowerPoint'], ['png', 'PNG']].forEach(([fmt, lbl]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'export-fmt-btn';
    b.textContent = lbl;
    b.addEventListener('click', async () => {
      const type = picker.getSelected();
      const isMap = isMapType(type);
      showToast(isMap ? 'Capturing map…' : 'Preparing report…');
      // Maps snapshot the live render (capturePage); charts rasterize offscreen at 2x.
      const png = isMap
        ? await captureMapPNG(vizData, type)
        : await captureChartPNG(type, vizData, overridesFor(type));
      // Graceful fallback: never embed a blank/half-loaded map. Keep the dialog open
      // with a clear message so the user can retry or pick a different chart.
      if (!png) {
        showToast(isMap
          ? "Couldn't capture the map — try again, or pick a chart for the report"
          : "Couldn't render that chart for the report");
        return;
      }
      closeExportDialog();
      const args = { title, analysis, headlineSegments: headlineSegments || [], type, png };
      if (fmt === 'pdf') await exportPdf(args);
      else if (fmt === 'ppt') await exportPptx(args);
      else if (fmt === 'word') await exportDocx(args);
      else if (fmt === 'png') await exportPng(args);
    });
    fmtRow.appendChild(b);
  });
  body.appendChild(fmtRow);

  // Dismiss: backdrop click + Esc; Tab is trapped within the dialog.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeExportDialog(); });
  _exportEscape = (e) => {
    if (e.key === 'Escape') closeExportDialog();
    else if (_exportA11y) _exportA11y.onTabKey(e);
  };
  document.addEventListener('keydown', _exportEscape, true);

  document.body.appendChild(overlay);
  // Dialog semantics + move focus into the modal (close button) + focus return on close.
  _exportA11y = makeModalAccessible(dialog, 'Export report', closeBtn);
  requestAnimationFrame(() => picker.select(picker.getSelected()));
}
