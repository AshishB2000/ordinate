// Ready pages → one Word document (reportWriters.ts buildPagedDocx): a heading
// per page, pictures sized to the content width with their aspect kept,
// captions, KPIs and grids as real tables, Word's own page breaks (so it
// re-paginates if the reader changes the paper). docx loads on first use.

import { pageBlocks, PRINT_HEX as C, type PageSetup, type ReadyPage } from './blocks';
import { imageSize } from './image';

const PAGE_TW: Record<string, { w: number; h: number }> = { LETTER: { w: 12240, h: 15840 }, A4: { w: 11906, h: 16838 } };
const MARGIN = { top: 900, right: 900, bottom: 900, left: 900 };
const FONT = 'Calibri';

/** data: URL → bytes (an ImageRun wants raw bytes). */
export function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(String(url).split(',')[1] || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function docxBlob(pages: ReadyPage[], report: PageSetup, date: string): Promise<Blob> {
  const d = await import('docx');
  const { Document, Paragraph, TextRun, ImageRun, AlignmentType, BorderStyle, Header, Footer, PageNumber, TabStopType, Table, TableRow, TableCell, WidthType, VerticalAlign, HeadingLevel, Packer } = d;
  const dims = new Map<string, { w: number; h: number }>();
  for (const rp of pages) {
    for (const b of pageBlocks(rp)) {
      const urls = b.t === 'image' ? [b.png] : b.t === 'logo' ? [b.src] : b.t === 'tiles' ? b.tiles.map((x) => x.png).filter((x): x is string => !!x) : [];
      for (const u of urls) if (!dims.has(u)) { const s = await imageSize(u); if (s) dims.set(u, s); }
    }
  }
  const landscape = report.paper?.orientation === 'landscape';
  const base = PAGE_TW[report.paper?.size === 'a4' ? 'A4' : 'LETTER'];
  const pageW = landscape ? base.h : base.w;
  const pageH = landscape ? base.w : base.h;
  const contentTw = pageW - MARGIN.left - MARGIN.right;
  const contentPx = Math.round((contentTw / 20) * (96 / 72));
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: none, bottom: none, left: none, right: none };
  const blank = { ...noBorders, insideHorizontal: none, insideVertical: none };
  const run = (text: string, o: Record<string, unknown> = {}) => new TextRun({ text, font: FONT, ...o });
  const imagePara = (png: string, maxW: number, maxH: number) => {
    const nat = dims.get(png);
    let w = maxW;
    let h = nat && nat.w ? Math.round(maxW * (nat.h / nat.w)) : Math.round(maxW * 0.6);
    if (h > maxH) {
      h = maxH;
      w = nat && nat.h ? Math.round(maxH * (nat.w / nat.h)) : maxW;
    }
    return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new ImageRun({ type: 'png', data: dataUrlBytes(png), transformation: { width: w, height: h } })] });
  };

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  pages.forEach((rp, idx) => {
    // Word's own break, on a paragraph of its own (a table cannot carry pageBreakBefore).
    if (idx > 0) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    for (const b of pageBlocks(rp)) {
      switch (b.t) {
        case 'logo': children.push(imagePara(b.src, 160, 64)); break;
        case 'title':
          children.push(new Paragraph({ heading: rp.kind === 'cover' ? HeadingLevel.TITLE : HeadingLevel.HEADING_1, spacing: { after: 160 }, children: [run(b.text, { bold: true, color: C.strong, size: rp.kind === 'cover' ? 56 : 34 })] }));
          break;
        case 'sub': children.push(new Paragraph({ spacing: { after: 160 }, children: [run(b.text, { color: C.muted, size: 26 })] })); break;
        case 'meta': children.push(new Paragraph({ spacing: { after: 80 }, children: [run(b.text, { color: C.muted, size: 20 })] })); break;
        case 'para': children.push(new Paragraph({ spacing: { after: 200, line: 336 }, children: [run(b.text, { color: C.ink, size: 22 })] })); break;
        case 'bullet': children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: [run(b.text, { color: C.ink, size: 22 })] })); break;
        case 'caption':
        case 'note':
          children.push(new Paragraph({ spacing: { before: 80, after: 200 }, children: [run(b.text, { italics: true, color: C.muted, size: 22 })] }));
          break;
        case 'image': children.push(imagePara(b.png, contentPx, 520)); break;
        case 'kpis': {
          const cols = Math.min(4, Math.max(1, b.rows.length));
          const cw = Math.round(contentTw / cols);
          const rows = [];
          for (let i = 0; i < b.rows.length; i += cols) {
            rows.push(new TableRow({
              children: b.rows.slice(i, i + cols).map((k) => new TableCell({
                borders: noBorders, width: { size: cw, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
                children: [new Paragraph({ children: [run(k.value, { bold: true, color: C.strong, size: 36 })] }), new Paragraph({ children: [run(k.label, { color: C.muted, size: 18 })] })],
              })),
            }));
          }
          children.push(new Table({ width: { size: contentTw, type: WidthType.DXA }, borders: blank, rows }), new Paragraph({ spacing: { after: 200 }, children: [] }));
          break;
        }
        case 'grid': {
          const all = b.head.concat(b.body);
          const cols = Math.max(1, ...all.map((r) => r.length));
          const cw = Math.round(contentTw / cols);
          const rows = all.map((r, ri) => new TableRow({
            tableHeader: ri < b.head.length,
            children: Array.from({ length: cols }, (_, ci) => new TableCell({
              width: { size: cw, type: WidthType.DXA },
              children: [new Paragraph({
                alignment: ci === 0 ? undefined : AlignmentType.RIGHT,
                children: [run(r[ci] ?? '', { bold: ri < b.head.length, color: ri < b.head.length ? C.muted : C.strong, size: ri < b.head.length ? 16 : 18 })],
              })],
            })),
          }));
          children.push(new Table({ width: { size: contentTw, type: WidthType.DXA }, rows }), new Paragraph({ spacing: { after: 200 }, children: [] }));
          break;
        }
        case 'tiles': {
          const cw = Math.round(contentTw / 2);
          const cellPx = Math.round(contentPx / 2) - 12;
          const rows = [];
          for (let i = 0; i < b.tiles.length; i += 2) {
            rows.push(new TableRow({
              children: [b.tiles[i], b.tiles[i + 1]].map((tv) => new TableCell({
                borders: noBorders, width: { size: cw, type: WidthType.DXA },
                children: tv
                  ? [
                      tv.png ? imagePara(tv.png, cellPx, 300) : new Paragraph({ children: [run(tv.note || 'Could not be drawn', { italics: true, color: C.muted, size: 18 })] }),
                      new Paragraph({ alignment: AlignmentType.CENTER, children: [run(tv.title || '', { color: C.muted, size: 18 })] }),
                    ]
                  : [new Paragraph({ children: [] })],
              })),
            }));
          }
          children.push(new Table({ width: { size: contentTw, type: WidthType.DXA }, borders: blank, rows }));
          break;
        }
      }
    }
  });
  const name = report.name || 'Report';
  const doc = new Document({
    creator: 'Ordinate',
    title: name,
    styles: { default: { document: { run: { font: FONT, size: 22, color: C.ink } } } },
    sections: [{
      properties: { page: { size: { width: pageW, height: pageH }, margin: MARGIN } },
      headers: { default: new Header({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: contentTw }], children: [run(name, { color: C.muted, size: 18 }), run('\t' + date, { color: C.muted, size: 18 })] })] }) },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: contentTw }],
            children: [
              run('Generated by Ordinate', { color: C.muted, size: 16 }),
              run('\tPage ', { color: C.muted, size: 16 }),
              new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 16, font: FONT }),
              run(' of ', { color: C.muted, size: 16 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], color: C.muted, size: 16, font: FONT }),
            ],
          })],
        }),
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
