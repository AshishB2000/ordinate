// Report document writers — a page list becomes PDF, PPTX or DOCX bytes.
//
// Split out of reportExport.ts under the 800-line cap
// (.claude/rules/file-size.md). The division of labour, three files, three jobs:
//
//   reportExport.ts   capture a chart or a map to a PNG, and the capture
//                     export dialog.
//   reportRender.ts   a Report's page list becomes `RenderedPage`s and the
//                     flat `reportPageBlocks` every consumer draws; also the
//                     builder's live preview.
//   reportWriters.ts  those blocks become a file. THIS file.
//
// It is a split, not a fork: there is still exactly ONE set of writers, and the
// capture report's one-pager goes through them like any other report — see the
// bottom of this file.
//
// Loads after reportExport.js (it uses REPORT_LOGO_PNG, ensureBundle and
// showToast) and after reportRender.js (reportPageBlocks, reportDateStr).

// ── The three writers: one page list, three media ────────────────────────────
//
// Every writer below reads the SAME `reportPageBlocks(page)` list (see
// reportRender.ts) and answers one question per block kind. That is the whole
// reason the one-page capture report and the multi-page dashboard report are
// one exporter rather than two: a capture is a report whose page list has one
// Tile page on it, and it goes through these same functions.
//
// ponytail: the pdfmake / pptxgenjs / docx document trees are big untyped
// envelopes — `any` throughout, as the vendor globals already are in
// globals.d.ts.

/** The light-theme tokens the printed page uses. A file is always a white page
 *  whatever the app's Appearance is, so these are literal rather than read off
 *  CSS vars — the same resolution reportStyleClasses makes for the captures. */
const REPORT_C = { ink: '#18181b', strong: '#0f1117', muted: '#6b7280', accent: '#2563eb' };
/** The same six, as pptxgenjs/docx want them: bare hex, no '#'. */
const REPORT_CX = { ink: '18181B', strong: '0F1117', muted: '6B7280', accent: '2563EB' };

/** pdfmake page sizes in points, for the content-width arithmetic. */
const PDF_PAGE_PT: Record<string, { w: number; h: number }> = {
  LETTER: { w: 612, h: 792 },
  A4: { w: 595.28, h: 841.89 },
};
const PDF_MARGIN = { x: 40, top: 48, bottom: 52 };

function pdfPageName(report: any): string {
  return (report && report.paper && report.paper.size === 'a4') ? 'A4' : 'LETTER';
}
function pdfIsLandscape(report: any): boolean {
  return !!(report && report.paper && report.paper.orientation === 'landscape');
}

/**
 * The whole report as ONE pdfmake document definition.
 *
 * Real page breaks (`pageBreak: 'before'` on each page's first node), a running
 * header carrying the report name and the date, and a "page n of N" footer.
 * pdfmake paginates the flow itself, so a page whose content overruns spills
 * onto a continuation sheet rather than being clipped — which is the right
 * behaviour for a Notes page someone wrote four paragraphs into.
 */
function buildPagedPdfDoc(pages: any[], report: any) {
  const size = PDF_PAGE_PT[pdfPageName(report)];
  const landscape = pdfIsLandscape(report);
  const pageW = landscape ? size.h : size.w;
  const pageH = landscape ? size.w : size.h;
  const CONTENT_W = pageW - 2 * PDF_MARGIN.x;
  const IMG_H = Math.round(pageH * 0.46);
  const dateStr = reportDateStr();
  const name = report.name || 'Report';

  const content: any[] = [];
  pages.forEach((rp: any, pageIdx: number) => {
    const blocks = reportPageBlocks(rp);
    const nodes: any[] = [];
    for (const b of blocks) {
      switch (b.t) {
        case 'logo': nodes.push({ image: b.src, fit: [160, 48], alignment: 'center', margin: [0, 40, 0, 20] }); break;
        case 'title': nodes.push({ text: b.text, style: rp.kind === 'cover' ? 'coverTitle' : 'title' }); break;
        case 'sub': nodes.push({ text: b.text, style: 'sub' }); break;
        case 'meta': nodes.push({ text: b.text, style: 'meta' }); break;
        case 'para': nodes.push({ text: b.text, style: 'para' }); break;
        case 'bullet': nodes.push({ text: '•  ' + b.text, style: 'bullet' }); break;
        case 'caption': nodes.push({ text: b.text, style: 'caption' }); break;
        case 'runs': nodes.push({
          text: b.segments.map((s: any) => (s && s.bold)
            ? { text: s.text, bold: true, color: REPORT_C.strong } : (s ? s.text : '')),
          style: 'headline',
        }); break;
        case 'image': nodes.push({ image: b.png, fit: [CONTENT_W, IMG_H], alignment: 'center', margin: [0, 10, 0, 10] }); break;
        case 'kpis': nodes.push(pdfKpiTable(b.rows, CONTENT_W)); break;
        case 'grid': nodes.push(pdfGrid(b.head, b.body, CONTENT_W)); break;
        case 'tiles': nodes.push(pdfTileGrid(b.tiles, CONTENT_W, Math.round(IMG_H / 2))); break;
      }
    }
    if (!nodes.length) nodes.push({ text: ' ' });
    if (pageIdx > 0) nodes[0] = { ...nodes[0], pageBreak: 'before' };
    // A cover breathes: the title sits a third of the way down rather than
    // hard against the top margin like every other page's heading.
    if (rp.kind === 'cover') nodes[0] = { ...nodes[0], margin: [0, Math.round(pageH * 0.18), 0, 0] };
    content.push(...nodes);
  });

  return {
    pageSize: pdfPageName(report),
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: [PDF_MARGIN.x, PDF_MARGIN.top + 14, PDF_MARGIN.x, PDF_MARGIN.bottom],
    content,
    header: (currentPage: number) => (currentPage === 1 ? null : {
      margin: [PDF_MARGIN.x, 20, PDF_MARGIN.x, 0],
      columns: [
        { text: name, style: 'runhead' },
        { text: dateStr, style: 'runhead', alignment: 'right', width: 'auto' },
      ],
      columnGap: 8,
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [PDF_MARGIN.x, 12, PDF_MARGIN.x, 0],
      columns: [
        { text: 'Generated by Ordinate · ' + dateStr, style: 'footer' },
        { text: 'Page ' + currentPage + ' of ' + pageCount, style: 'footer', alignment: 'right', width: 'auto' },
      ],
      columnGap: 8,
    }),
    styles: {
      coverTitle: { fontSize: 30, bold: true, color: REPORT_C.strong, margin: [0, 0, 0, 8] },
      title: { fontSize: 20, bold: true, color: REPORT_C.strong, margin: [0, 0, 0, 10] },
      sub: { fontSize: 13, color: REPORT_C.muted, margin: [0, 0, 0, 10] },
      meta: { fontSize: 10, color: REPORT_C.muted, margin: [0, 0, 0, 4] },
      para: { fontSize: 11, color: REPORT_C.ink, lineHeight: 1.4, margin: [0, 0, 0, 10] },
      bullet: { fontSize: 11, color: REPORT_C.ink, lineHeight: 1.35, margin: [0, 0, 0, 5] },
      headline: { fontSize: 12, color: REPORT_C.ink, lineHeight: 1.4, margin: [0, 0, 0, 14] },
      caption: { fontSize: 11, color: REPORT_C.muted, italics: true, margin: [0, 6, 0, 0] },
      runhead: { fontSize: 9, color: REPORT_C.muted },
      footer: { fontSize: 8, color: REPORT_C.muted },
      kpiValue: { fontSize: 18, bold: true, color: REPORT_C.strong },
      kpiLabel: { fontSize: 9, color: REPORT_C.muted },
      tileCap: { fontSize: 9, color: REPORT_C.muted, alignment: 'center', margin: [0, 3, 0, 0] },
      gridHead: { fontSize: 8, bold: true, color: REPORT_C.muted },
      gridCell: { fontSize: 9, color: REPORT_C.strong },
    },
    defaultStyle: { font: 'Roboto', fontSize: 11, color: REPORT_C.ink },
    info: { title: name, creator: 'Ordinate' },
  };
}

/** KPIs as a real table of figures, never a picture of one — the same rule the
 *  other two writers follow, so the numbers stay selectable and searchable. */
function pdfKpiTable(rows: any[], contentW: number) {
  if (!rows.length) return { text: '' };
  const cols = Math.min(4, rows.length);
  const cells: any[][] = [];
  for (let i = 0; i < rows.length; i += cols) {
    const slice = rows.slice(i, i + cols);
    while (slice.length < cols) slice.push({ label: '', value: '' });
    cells.push(slice.map((k: any) => ({
      stack: [{ text: k.value, style: 'kpiValue' }, { text: k.label, style: 'kpiLabel' }],
      margin: [0, 6, 0, 6],
    })));
  }
  return {
    table: { widths: new Array(cols).fill(contentW / cols), body: cells },
    layout: 'noBorders',
    margin: [0, 0, 0, 14],
  };
}

/**
 * A pivot as a real pdfmake table — the same rule `pdfKpiTable` follows, for
 * the same reason: a grid of figures that is text stays selectable, searchable
 * and copyable out of the finished PDF. Column widths are equal and the label
 * column is left-aligned; the figures are right-aligned, as on screen.
 */
function pdfGrid(head: string[][], body: string[][], contentW: number) {
  const rows = head.concat(body);
  if (!rows.length) return { text: '' };
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => r.concat(new Array(Math.max(0, cols - r.length)).fill(''));
  const cell = (text: string, i: number, isHead: boolean) => ({
    text,
    style: isHead ? 'gridHead' : 'gridCell',
    alignment: i === 0 ? 'left' : 'right',
  });
  return {
    table: {
      headerRows: head.length,
      widths: new Array(cols).fill((contentW) / cols),
      body: rows.map((r, ri) => pad(r).map((t, i) => cell(t, i, ri < head.length))),
    },
    layout: 'lightHorizontalLines',
    margin: [0, 8, 0, 8],
  };
}

/** A sheet's tiles, two up. */
function pdfTileGrid(tiles: any[], contentW: number, cellH: number) {
  const cellW = (contentW - 14) / 2;
  const body: any[][] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    body.push([tiles[i], tiles[i + 1]].map((t: any) => {
      if (!t) return { text: '' };
      const stack: any[] = t.png
        ? [{ image: t.png, fit: [cellW - 8, cellH], alignment: 'center' }]
        : [{ text: 'Could not be drawn', style: 'tileCap' }];
      if (t.title) stack.push({ text: t.title, style: 'tileCap' });
      return { stack, margin: [0, 4, 0, 4] };
    }));
  }
  return { table: { widths: [cellW, cellW], body }, layout: 'noBorders', margin: [0, 4, 0, 4] };
}

/** Build the PDF bytes. Returns base64, or '' when the engine or the build
 *  fails — the caller decides what to tell the user. */
async function reportPdfBase64(pages: any[], report: any): Promise<string> {
  await ensureBundle('pdf');
  if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') return '';
  try {
    // pdfmake 0.3.x: getBase64() returns a Promise (no callback) — await it
    // directly. Passing a callback here silently hung at "Building PDF…".
    return await window.pdfMake.createPdf(buildPagedPdfDoc(pages, report)).getBase64();
  } catch (e) {
    console.error('[report] PDF build failed', e);
    return '';
  }
}

// ── PPTX ─────────────────────────────────────────────────────────────────────

const PPT_W = 13.33;
const PPT_H = 7.5;

/**
 * One slide per page, 16:9 — a deck is not paper, so the paper setting is
 * ignored here rather than quietly producing a letter-shaped slide.
 *
 * Blocks are laid down with a running `y` cursor in inches. A slide that would
 * overflow is clipped by PowerPoint rather than paginated; that is what the
 * `half` page layout and the Notes page are for, and a deck slide that needs
 * four paragraphs wanted to be a PDF.
 */
function buildPagedPptx(pages: any[], report: any) {
  const dateStr = reportDateStr();
  const name = report.name || 'Report';
  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  pages.forEach((rp: any, idx: number) => {
    const slide = pptx.addSlide();
    let y = 0.55;
    const cover = rp.kind === 'cover';
    if (!cover) {
      slide.addText(name, { x: 0.6, y: 0.22, w: 9.0, h: 0.26, fontSize: 10, color: REPORT_CX.muted });
      slide.addText(dateStr, { x: 9.8, y: 0.22, w: 2.9, h: 0.26, fontSize: 10, color: REPORT_CX.muted, align: 'right' });
    } else {
      y = 1.9;
    }
    for (const b of reportPageBlocks(rp)) {
      switch (b.t) {
        case 'logo': {
          // A wordmark is wide: fit it to a 0.6in-tall band, capped at 2.4in.
          const r = b.w / b.h || 1;
          const w = Math.min(2.4, 0.6 * r);
          slide.addImage({ data: b.src, x: 0.6, y: 1.0, w, h: w / r });
          break;
        }
        case 'title':
          slide.addText(b.text, { x: 0.6, y, w: PPT_W - 1.2, h: cover ? 1.0 : 0.6, fontSize: cover ? 40 : 26, bold: true, color: REPORT_CX.strong, valign: 'top' });
          y += cover ? 1.15 : 0.75;
          if (!cover) {
            slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: y - 0.16, w: PPT_W - 1.2, h: 0.03, fill: { color: REPORT_CX.accent } });
          }
          break;
        case 'sub':
          slide.addText(b.text, { x: 0.6, y, w: PPT_W - 1.2, h: 0.45, fontSize: 18, color: REPORT_CX.muted });
          y += 0.55;
          break;
        case 'meta':
          slide.addText(b.text, { x: 0.6, y, w: PPT_W - 1.2, h: 0.3, fontSize: 12, color: REPORT_CX.muted });
          y += 0.34;
          break;
        case 'para':
          slide.addText(b.text, { x: 0.6, y, w: PPT_W - 1.2, h: 0.9, fontSize: 14, color: REPORT_CX.ink, lineSpacingMultiple: 1.2, valign: 'top' });
          y += 1.0;
          break;
        case 'bullet':
          slide.addText(b.text, { x: 0.7, y, w: PPT_W - 1.4, h: 0.32, fontSize: 12, color: REPORT_CX.ink, bullet: true });
          y += 0.34;
          break;
        case 'caption':
          slide.addText(b.text, { x: 0.6, y: Math.min(y, PPT_H - 1.0), w: PPT_W - 1.2, h: 0.4, fontSize: 12, italic: true, color: REPORT_CX.muted });
          y += 0.45;
          break;
        case 'runs':
          slide.addText(
            b.segments.map((s: any) => ({
              text: (s && s.text) || '',
              options: { bold: !!(s && s.bold), color: (s && s.bold) ? REPORT_CX.strong : REPORT_CX.ink },
            })),
            { x: 0.6, y, w: PPT_W - 1.2, h: 1.1, fontSize: 16, lineSpacingMultiple: 1.2, valign: 'top' });
          y += 1.2;
          break;
        case 'kpis': {
          // A NATIVE table, as the spec asks: the figures stay selectable in
          // PowerPoint instead of being baked into a picture.
          const head = b.rows.map((k: any) => ({ text: k.label, options: { bold: true, color: REPORT_CX.muted, fontSize: 11 } }));
          const vals = b.rows.map((k: any) => ({ text: k.value, options: { bold: true, color: REPORT_CX.strong, fontSize: 20 } }));
          slide.addTable([head, vals], { x: 0.6, y, w: PPT_W - 1.2, border: { type: 'none' }, autoPage: false });
          y += 1.1;
          break;
        }
        case 'grid': {
          // A native PowerPoint table, for the same reason the KPI row is one.
          const rows: any[][] = [];
          for (const r of b.head) {
            rows.push(r.map((t: string) => ({
              text: t, options: { bold: true, color: REPORT_CX.muted, fontSize: 9 },
            })));
          }
          for (const r of b.body) {
            rows.push(r.map((t: string, i: number) => ({
              text: t,
              options: { color: REPORT_CX.strong, fontSize: 10, align: i === 0 ? 'left' : 'right' },
            })));
          }
          const h = Math.max(1.0, PPT_H - y - 0.9);
          slide.addTable(rows, {
            x: 0.6, y, w: PPT_W - 1.2, h,
            border: { type: 'solid', pt: 0.5, color: 'E5E7EB' },
            autoPage: false,
          });
          y += h + 0.15;
          break;
        }
        case 'image': {
          const h = Math.max(1.5, PPT_H - y - 1.0);
          slide.addImage({ data: b.png, x: 1.0, y, w: PPT_W - 2.0, h, sizing: { type: 'contain', w: PPT_W - 2.0, h } });
          y += h + 0.15;
          break;
        }
        case 'tiles': {
          const cellW = (PPT_W - 1.6) / 2;
          const rows = Math.max(1, Math.ceil(b.tiles.length / 2));
          const cellH = Math.max(1.2, (PPT_H - y - 0.9) / rows);
          b.tiles.forEach((t: any, i: number) => {
            const cx = 0.6 + (i % 2) * (cellW + 0.4);
            const cy = y + Math.floor(i / 2) * cellH;
            if (t.png) slide.addImage({ data: t.png, x: cx, y: cy, w: cellW, h: cellH - 0.3, sizing: { type: 'contain', w: cellW, h: cellH - 0.3 } });
            slide.addText(t.title || '', { x: cx, y: cy + cellH - 0.3, w: cellW, h: 0.26, fontSize: 10, color: REPORT_CX.muted, align: 'center' });
          });
          y += rows * cellH;
          break;
        }
      }
    }
    if (!cover) {
      slide.addText(`Ordinate  ·  ${dateStr}  ·  ${idx + 1} of ${pages.length}`,
        { x: 0.6, y: PPT_H - 0.45, w: PPT_W - 1.2, h: 0.3, fontSize: 9, color: REPORT_CX.muted });
    }
  });
  return pptx;
}

async function reportPptxBase64(pages: any[], report: any): Promise<string> {
  await ensureBundle('pptx');
  if (!window.PptxGenJS) return '';
  try {
    return await buildPagedPptx(pages, report).write({ outputType: 'base64' });
  } catch (e) {
    console.error('[report] PPTX build failed', e);
    return '';
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

// ── DOCX ─────────────────────────────────────────────────────────────────────

/** docx wants raw pixel dimensions for an ImageRun, so every image is measured
 *  once up front and looked up by data URL while the tree is built. */
async function measureReportImages(pages: any[]): Promise<Map<string, { w: number; h: number }>> {
  const out = new Map<string, { w: number; h: number }>();
  for (const rp of pages) {
    for (const b of reportPageBlocks(rp)) {
      const urls: string[] = b.t === 'image' ? [b.png] : b.t === 'logo' ? [b.src]
        : b.t === 'tiles' ? b.tiles.map((t: any) => t.png).filter(Boolean) : [];
      for (const url of urls) {
        if (out.has(url)) continue;
        const dims = await imageSize(url);
        if (dims) out.set(url, dims);
      }
    }
  }
  return out;
}

/** Page geometry in twips (1pt = 20 twips). */
const DOCX_PAGE_TW: Record<string, { w: number; h: number }> = {
  LETTER: { w: 12240, h: 15840 },
  A4: { w: 11906, h: 16838 },
};
const DOCX_MARGIN = { top: 900, right: 900, bottom: 900, left: 900 };

/**
 * The whole report as one Word document: a heading per page, images, captions,
 * and KPIs as a real table.
 *
 * Page breaks are `pageBreakBefore` on each page's first paragraph — Word's own
 * break, so the document re-paginates correctly if the reader changes the paper
 * or the font, which a manual sequence of empty paragraphs would not.
 */
function buildPagedDocx(pages: any[], report: any, dims: Map<string, { w: number; h: number }>) {
  const d = window.docx;
  const { Document, Paragraph, TextRun, ImageRun, AlignmentType, BorderStyle, Header, Footer,
    PageNumber, TabStopType, Table, TableRow, TableCell, WidthType, VerticalAlign, HeadingLevel } = d;
  const FONT = 'Calibri';
  const dateStr = reportDateStr();
  const name = report.name || 'Report';

  const landscape = pdfIsLandscape(report);
  const base = DOCX_PAGE_TW[pdfPageName(report)];
  const PAGE_W = landscape ? base.h : base.w;
  const PAGE_H = landscape ? base.w : base.h;
  const CONTENT_TW = PAGE_W - DOCX_MARGIN.left - DOCX_MARGIN.right;
  const CONTENT_PX = Math.round((CONTENT_TW / 20) * (96 / 72));
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const blank = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder };

  /** An image sized to a box, aspect preserved. */
  const imagePara = (png: string, maxW: number, maxH: number, align?: any) => {
    const nat = dims.get(png);
    let w = maxW;
    let h = nat && nat.w ? Math.round(maxW * (nat.h / nat.w)) : Math.round(maxW * 0.6);
    if (h > maxH) { h = maxH; w = nat && nat.h ? Math.round(maxH * (nat.w / nat.h)) : maxW; }
    return new Paragraph({
      alignment: align || AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [new ImageRun({ type: 'png', data: dataUrlToBytes(png), transformation: { width: w, height: h } })],
    });
  };

  const children: any[] = [];
  pages.forEach((rp: any, pageIdx: number) => {
    // Word's own page break, carried on an empty leading paragraph. A Table
    // cannot take `pageBreakBefore` and a page may well start with one, so the
    // break gets a paragraph of its own rather than a branch per block kind.
    if (pageIdx > 0) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    const push = (node: any): number => children.push(node);
    for (const b of reportPageBlocks(rp)) {
      switch (b.t) {
        case 'logo':
          push(imagePara(b.src, 160, 64));
          break;
        case 'title':
          push(new Paragraph({
            heading: rp.kind === 'cover' ? HeadingLevel.TITLE : HeadingLevel.HEADING_1,
            spacing: { after: 160 },
            children: [new TextRun({ text: b.text, bold: true, color: REPORT_CX.strong, size: rp.kind === 'cover' ? 56 : 34, font: FONT })],
          }));
          break;
        case 'sub':
          push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: b.text, color: REPORT_CX.muted, size: 26, font: FONT })] }));
          break;
        case 'meta':
          push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: b.text, color: REPORT_CX.muted, size: 20, font: FONT })] }));
          break;
        case 'para':
          push(new Paragraph({ spacing: { after: 200, line: 336, lineRule: 'auto' }, children: [new TextRun({ text: b.text, color: REPORT_CX.ink, size: 22, font: FONT })] }));
          break;
        case 'bullet':
          push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: [new TextRun({ text: b.text, color: REPORT_CX.ink, size: 22, font: FONT })] }));
          break;
        case 'caption':
          push(new Paragraph({ spacing: { before: 80, after: 200 }, children: [new TextRun({ text: b.text, italics: true, color: REPORT_CX.muted, size: 22, font: FONT })] }));
          break;
        case 'runs':
          push(new Paragraph({
            spacing: { after: 280, line: 336, lineRule: 'auto' },
            children: b.segments.map((s: any) => new TextRun({
              text: (s && s.text) || '', bold: !!(s && s.bold),
              color: (s && s.bold) ? REPORT_CX.strong : REPORT_CX.ink, size: 24, font: FONT,
            })),
          }));
          break;
        case 'image':
          push(imagePara(b.png, CONTENT_PX, 520));
          break;
        case 'kpis': {
          // A native Word table — the figures stay text, not a picture.
          const cols = Math.min(4, Math.max(1, b.rows.length));
          const cw = Math.round(CONTENT_TW / cols);
          const rows: any[] = [];
          for (let i = 0; i < b.rows.length; i += cols) {
            const slice = b.rows.slice(i, i + cols);
            rows.push(new TableRow({
              children: slice.map((k: any) => new TableCell({
                borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
                width: { size: cw, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
                children: [
                  new Paragraph({ children: [new TextRun({ text: k.value, bold: true, color: REPORT_CX.strong, size: 36, font: FONT })] }),
                  new Paragraph({ children: [new TextRun({ text: k.label, color: REPORT_CX.muted, size: 18, font: FONT })] }),
                ],
              })),
            }));
          }
          push(new Table({ width: { size: CONTENT_TW, type: WidthType.DXA }, borders: blank, rows }));
          push(new Paragraph({ spacing: { after: 200 }, children: [] }));
          break;
        }
        case 'grid': {
          // A native Word table, like the KPI one directly above.
          const all = b.head.concat(b.body);
          const cols = Math.max(1, ...all.map((r: string[]) => r.length));
          const cw = Math.round(CONTENT_TW / cols);
          const rows = all.map((r: string[], ri: number) => new TableRow({
            tableHeader: ri < b.head.length,
            children: new Array(cols).fill('').map((_, ci) => new TableCell({
              width: { size: cw, type: WidthType.DXA },
              children: [new Paragraph({
                alignment: ci === 0 ? undefined : AlignmentType.RIGHT,
                children: [new TextRun({
                  text: r[ci] ?? '',
                  bold: ri < b.head.length,
                  color: ri < b.head.length ? REPORT_CX.muted : REPORT_CX.strong,
                  size: ri < b.head.length ? 16 : 18,
                  font: FONT,
                })],
              })],
            })),
          }));
          push(new Table({ width: { size: CONTENT_TW, type: WidthType.DXA }, rows }));
          push(new Paragraph({ spacing: { after: 200 }, children: [] }));
          break;
        }
        case 'tiles': {
          const cw = Math.round(CONTENT_TW / 2);
          const cellPx = Math.round(CONTENT_PX / 2) - 12;
          const rows: any[] = [];
          for (let i = 0; i < b.tiles.length; i += 2) {
            rows.push(new TableRow({
              children: [b.tiles[i], b.tiles[i + 1]].map((t: any) => new TableCell({
                borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
                width: { size: cw, type: WidthType.DXA },
                children: t
                  ? [
                    t.png ? imagePara(t.png, cellPx, 300) : new Paragraph({ children: [new TextRun({ text: 'Could not be drawn', italics: true, color: REPORT_CX.muted, size: 18, font: FONT })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t.title || '', color: REPORT_CX.muted, size: 18, font: FONT })] }),
                  ]
                  : [new Paragraph({ children: [] })],
              })),
            }));
          }
          push(new Table({ width: { size: CONTENT_TW, type: WidthType.DXA }, borders: blank, rows }));
          break;
        }
      }
    }
  });

  return new Document({
    creator: 'Ordinate',
    title: name,
    styles: { default: { document: { run: { font: FONT, size: 22, color: REPORT_CX.ink } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: DOCX_MARGIN } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TW }],
            children: [
              new TextRun({ text: name, color: REPORT_CX.muted, size: 18, font: FONT }),
              new TextRun({ text: '\t' + dateStr, color: REPORT_CX.muted, size: 18, font: FONT }),
            ],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TW }],
            children: [
              new TextRun({ text: 'Generated by Ordinate', color: REPORT_CX.muted, size: 16, font: FONT }),
              new TextRun({ text: '\tPage ', color: REPORT_CX.muted, size: 16, font: FONT }),
              new TextRun({ children: [PageNumber.CURRENT], color: REPORT_CX.muted, size: 16, font: FONT }),
              new TextRun({ text: ' of ', color: REPORT_CX.muted, size: 16, font: FONT }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], color: REPORT_CX.muted, size: 16, font: FONT }),
            ],
          })],
        }),
      },
      children,
    }],
  });
}

async function reportDocxBase64(pages: any[], report: any): Promise<string> {
  await ensureBundle('docx');
  if (!window.docx || !window.docx.Packer) return '';
  try {
    const dims = await measureReportImages(pages);
    return await window.docx.Packer.toBase64String(buildPagedDocx(pages, report, dims));
  } catch (e) {
    console.error('[report] DOCX build failed', e);
    return '';
  }
}

// ── the one entry point ──────────────────────────────────────────────────────

/**
 * A page list + a Report record → the file's bytes, base64.
 *
 * The ONE place a report becomes a file. The builder's Generate, a scheduled
 * run and the capture report's export all come through here, which is what
 * makes "there is one exporter" true rather than aspirational.
 */
async function reportBytes(pages: any[], report: any): Promise<{ base64: string; ext: string }> {
  const ext = report && report.format === 'pptx' ? 'pptx' : report && report.format === 'docx' ? 'docx' : 'pdf';
  if (ext === 'pptx') return { base64: await reportPptxBase64(pages, report), ext };
  if (ext === 'docx') return { base64: await reportDocxBase64(pages, report), ext };
  return { base64: await reportPdfBase64(pages, report), ext };
}

// ── the capture report: ONE Report with a single Tile page ───────────────────
//
// The capture export used to have three document builders of its own. It has
// none now: a capture report IS a report whose page list is one Tile page
// carrying the title, the analysis paragraph, the bold-figure headline and the
// chart. Everything below just shapes those four things into that page and
// hands them to the writers above — which is why a change to the report layout
// can no longer leave the capture export behind.

function captureReportRecord(title: string, format: string) {
  return {
    name: title || 'Ordinate report',
    format,
    paper: { size: 'a4', orientation: 'portrait' },
    cover: { title: title || 'Analysis', logo: true },
  };
}

function captureReportPages({ title, analysis, headlineSegments, png }: any): any[] {
  return [{
    kind: 'tile', layout: 'full',
    title: title || 'Analysis',
    body: analysis || '',
    segments: Array.isArray(headlineSegments) && headlineSegments.length ? headlineSegments : undefined,
    png: png || null,
    caption: png ? '' : '(chart unavailable for this view)',
  }];
}

/** Build the capture report in `format` and save it through the native panel. */
async function exportCaptureReport(format: 'pdf' | 'pptx' | 'docx', args: any): Promise<void> {
  const ENGINE: Record<string, string> = { pdf: 'PDF', pptx: 'PowerPoint', docx: 'Word' };
  showToast(`Preparing ${ENGINE[format]} engine…`);
  const report = captureReportRecord(args && args.title, format);
  const pages = captureReportPages(args || {});
  showToast(`Building ${ENGINE[format]}…`);
  const { base64 } = await reportBytes(pages, report);
  if (!base64) { showToast(`Couldn’t build the ${ENGINE[format]}`); return; }
  const save = format === 'pdf' ? window.hub.savePdf : format === 'pptx' ? window.hub.savePptx : window.hub.saveDocx;
  try {
    const res = await save(base64, reportFilename(args && args.title, format));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] save failed', e);
    showToast('Save failed');
  }
}

// The three names openExportDialog already calls, kept as FUNCTION
// DECLARATIONS: they are reached from handlers this file builds further down,
// and a `const` would sit in its temporal dead zone there.
function exportPdf(args: any): Promise<void> { return exportCaptureReport('pdf', args); }
function exportPptx(args: any): Promise<void> { return exportCaptureReport('pptx', args); }
function exportDocx(args: any): Promise<void> { return exportCaptureReport('docx', args); }
