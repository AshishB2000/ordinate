// Ready pages → ONE pdfmake document (the desktop's reportWriters.ts
// buildPagedPdfDoc): real page breaks, a running header with the report's name
// and date, "page n of N". pdfmake paginates the flow, so a long Notes page
// spills onto a continuation sheet instead of being clipped. pdfmake loads on
// first use (a lazy chunk); the document definition is pure and tested alone.

import { pageBlocks, PRINT, type PageSetup, type ReadyPage } from './blocks';

const PAGE_PT: Record<string, { w: number; h: number }> = { LETTER: { w: 612, h: 792 }, A4: { w: 595.28, h: 841.89 } };
const MARGIN = { x: 40, top: 48, bottom: 52 };

type Node = Record<string, unknown>;

export const pdfPageName = (r: PageSetup): 'A4' | 'LETTER' => (r.paper?.size === 'a4' ? 'A4' : 'LETTER');

function kpiTable(rows: Array<{ label: string; value: string }>, contentW: number): Node {
  const cols = Math.min(4, rows.length);
  const body: Node[][] = [];
  for (let i = 0; i < rows.length; i += cols) {
    const slice = rows.slice(i, i + cols);
    while (slice.length < cols) slice.push({ label: '', value: '' });
    body.push(slice.map((k) => ({ stack: [{ text: k.value, style: 'kpiValue' }, { text: k.label, style: 'kpiLabel' }], margin: [0, 6, 0, 6] })));
  }
  return { table: { widths: new Array(cols).fill(contentW / cols), body }, layout: 'noBorders', margin: [0, 0, 0, 14] };
}

function gridTable(head: string[][], body: string[][], contentW: number): Node {
  const rows = head.concat(body);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return {
    table: {
      headerRows: head.length,
      widths: new Array(cols).fill(contentW / cols),
      body: rows.map((r, ri) =>
        r.concat(new Array(Math.max(0, cols - r.length)).fill('')).map((text, i) => ({ text, style: ri < head.length ? 'gridHead' : 'gridCell', alignment: i === 0 ? 'left' : 'right' })),
      ),
    },
    layout: 'lightHorizontalLines',
    margin: [0, 8, 0, 8],
  };
}

function tileGrid(tiles: Array<{ title: string; png: string | null; note?: string }>, contentW: number, cellH: number): Node {
  const cellW = (contentW - 14) / 2;
  const body: Node[][] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    body.push(
      [tiles[i], tiles[i + 1]].map((tv) => {
        if (!tv) return { text: '' };
        const stack: Node[] = tv.png ? [{ image: tv.png, fit: [cellW - 8, cellH], alignment: 'center' }] : [{ text: tv.note || 'Could not be drawn', style: 'tileCap' }];
        if (tv.title) stack.push({ text: tv.title, style: 'tileCap' });
        return { stack, margin: [0, 4, 0, 4] };
      }),
    );
  }
  return { table: { widths: [cellW, cellW], body }, layout: 'noBorders', margin: [0, 4, 0, 4] };
}

/** The whole report as one pdfmake document definition. */
export function pdfDoc(pages: ReadyPage[], report: PageSetup, date: string): Node {
  const size = PAGE_PT[pdfPageName(report)];
  const landscape = report.paper?.orientation === 'landscape';
  const pageW = landscape ? size.h : size.w;
  const pageH = landscape ? size.w : size.h;
  const contentW = pageW - 2 * MARGIN.x;
  const imgH = Math.round(pageH * 0.46);
  const name = report.name || 'Report';
  const content: Node[] = [];
  pages.forEach((rp, idx) => {
    const nodes: Node[] = [];
    for (const b of pageBlocks(rp)) {
      switch (b.t) {
        case 'logo': nodes.push({ image: b.src, fit: [160, 48], alignment: 'center', margin: [0, 40, 0, 20] }); break;
        case 'title': nodes.push({ text: b.text, style: rp.kind === 'cover' ? 'coverTitle' : 'title' }); break;
        case 'sub': nodes.push({ text: b.text, style: 'sub' }); break;
        case 'meta': nodes.push({ text: b.text, style: 'meta' }); break;
        case 'para': nodes.push({ text: b.text, style: 'para' }); break;
        case 'bullet': nodes.push({ text: '•  ' + b.text, style: 'bullet' }); break;
        case 'caption': nodes.push({ text: b.text, style: 'caption' }); break;
        case 'note': nodes.push({ text: b.text, style: 'caption' }); break;
        case 'image': nodes.push({ image: b.png, fit: [contentW, imgH], alignment: 'center', margin: [0, 10, 0, 10] }); break;
        case 'kpis': nodes.push(kpiTable(b.rows, contentW)); break;
        case 'grid': nodes.push(gridTable(b.head, b.body, contentW)); break;
        case 'tiles': nodes.push(tileGrid(b.tiles, contentW, Math.round(imgH / 2))); break;
      }
    }
    if (!nodes.length) nodes.push({ text: ' ' });
    if (idx > 0) nodes[0] = { ...nodes[0], pageBreak: 'before' };
    // A cover breathes: its title sits a fifth of the way down.
    if (rp.kind === 'cover') nodes[0] = { ...nodes[0], margin: [0, Math.round(pageH * 0.18), 0, 0] };
    content.push(...nodes);
  });
  return {
    pageSize: pdfPageName(report),
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: [MARGIN.x, MARGIN.top + 14, MARGIN.x, MARGIN.bottom],
    content,
    header: (current: number) =>
      current === 1
        ? null
        : { margin: [MARGIN.x, 20, MARGIN.x, 0], columns: [{ text: name, style: 'runhead' }, { text: date, style: 'runhead', alignment: 'right', width: 'auto' }], columnGap: 8 },
    footer: (current: number, count: number) => ({
      margin: [MARGIN.x, 12, MARGIN.x, 0],
      columns: [
        { text: `Generated by Ordinate · ${date}`, style: 'footer' },
        { text: `Page ${current} of ${count}`, style: 'footer', alignment: 'right', width: 'auto' },
      ],
      columnGap: 8,
    }),
    styles: {
      coverTitle: { fontSize: 30, bold: true, color: PRINT.strong, margin: [0, 0, 0, 8] },
      title: { fontSize: 20, bold: true, color: PRINT.strong, margin: [0, 0, 0, 10] },
      sub: { fontSize: 13, color: PRINT.muted, margin: [0, 0, 0, 10] },
      meta: { fontSize: 10, color: PRINT.muted, margin: [0, 0, 0, 4] },
      para: { fontSize: 11, color: PRINT.ink, lineHeight: 1.4, margin: [0, 0, 0, 10] },
      bullet: { fontSize: 11, color: PRINT.ink, lineHeight: 1.35, margin: [0, 0, 0, 5] },
      caption: { fontSize: 11, color: PRINT.muted, italics: true, margin: [0, 6, 0, 0] },
      runhead: { fontSize: 9, color: PRINT.muted },
      footer: { fontSize: 8, color: PRINT.muted },
      kpiValue: { fontSize: 18, bold: true, color: PRINT.strong },
      kpiLabel: { fontSize: 9, color: PRINT.muted },
      tileCap: { fontSize: 9, color: PRINT.muted, alignment: 'center', margin: [0, 3, 0, 0] },
      gridHead: { fontSize: 8, bold: true, color: PRINT.muted },
      gridCell: { fontSize: 9, color: PRINT.strong },
    },
    defaultStyle: { font: 'Roboto', fontSize: 11, color: PRINT.ink },
    info: { title: name, creator: 'Ordinate' },
  };
}

/** pdfmake with its Roboto fonts, loaded once. */
async function loadPdfMake() {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  pdfMake.addVirtualFileSystem(vfs);
  return pdfMake;
}

export async function pdfBlob(pages: ReadyPage[], report: PageSetup, date: string): Promise<Blob> {
  const pdfMake = await loadPdfMake();
  return pdfMake.createPdf(pdfDoc(pages, report, date)).getBlob();
}
