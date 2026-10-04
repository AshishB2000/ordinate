// Ready pages → a 16:9 deck, one slide per page (reportWriters.ts
// buildPagedPptx). Blocks are laid down with a running `y` in inches; a slide
// that would overflow is clipped by PowerPoint — the half layout and Notes pages
// exist for that. KPIs and grids are NATIVE tables, so figures stay selectable.
// pptxgenjs loads on first use (a lazy chunk).

import { pageBlocks, PRINT_HEX as C, type PageSetup, type ReadyPage } from './blocks';

const W = 13.33;
const H = 7.5;

export async function pptxBlob(pages: ReadyPage[], report: PageSetup, date: string): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const name = report.name || 'Report';
  pages.forEach((rp, idx) => {
    const slide = pptx.addSlide();
    const cover = rp.kind === 'cover';
    let y = cover ? 1.9 : 0.55;
    if (!cover) {
      slide.addText(name, { x: 0.6, y: 0.22, w: 9.0, h: 0.26, fontSize: 10, color: C.muted });
      slide.addText(date, { x: 9.8, y: 0.22, w: 2.9, h: 0.26, fontSize: 10, color: C.muted, align: 'right' });
    }
    for (const b of pageBlocks(rp)) {
      switch (b.t) {
        case 'logo': {
          // A wordmark is wide: fit it to a 0.6in band, capped at 2.4in.
          const r = b.w / b.h || 1;
          const w = Math.min(2.4, 0.6 * r);
          slide.addImage({ data: b.src, x: 0.6, y: 1.0, w, h: w / r });
          break;
        }
        case 'title':
          slide.addText(b.text, { x: 0.6, y, w: W - 1.2, h: cover ? 1.0 : 0.6, fontSize: cover ? 40 : 26, bold: true, color: C.strong, valign: 'top' });
          y += cover ? 1.15 : 0.75;
          if (!cover) slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: y - 0.16, w: W - 1.2, h: 0.03, fill: { color: C.accent } });
          break;
        case 'sub':
          slide.addText(b.text, { x: 0.6, y, w: W - 1.2, h: 0.45, fontSize: 18, color: C.muted });
          y += 0.55;
          break;
        case 'meta':
          slide.addText(b.text, { x: 0.6, y, w: W - 1.2, h: 0.3, fontSize: 12, color: C.muted });
          y += 0.34;
          break;
        case 'para':
          slide.addText(b.text, { x: 0.6, y, w: W - 1.2, h: 0.9, fontSize: 14, color: C.ink, lineSpacingMultiple: 1.2, valign: 'top' });
          y += 1.0;
          break;
        case 'bullet':
          slide.addText(b.text, { x: 0.7, y, w: W - 1.4, h: 0.32, fontSize: 12, color: C.ink, bullet: true });
          y += 0.34;
          break;
        case 'caption':
        case 'note':
          slide.addText(b.text, { x: 0.6, y: Math.min(y, H - 1.0), w: W - 1.2, h: 0.4, fontSize: 12, italic: true, color: C.muted });
          y += 0.45;
          break;
        case 'kpis': {
          const head = b.rows.map((k) => ({ text: k.label, options: { bold: true, color: C.muted, fontSize: 11 } }));
          const vals = b.rows.map((k) => ({ text: k.value, options: { bold: true, color: C.strong, fontSize: 20 } }));
          slide.addTable([head, vals], { x: 0.6, y, w: W - 1.2, border: { type: 'none' }, autoPage: false });
          y += 1.1;
          break;
        }
        case 'grid': {
          const rows = [
            ...b.head.map((r) => r.map((text) => ({ text, options: { bold: true, color: C.muted, fontSize: 9 } }))),
            ...b.body.map((r) => r.map((text, i) => ({ text, options: { color: C.strong, fontSize: 10, align: (i === 0 ? 'left' : 'right') as 'left' | 'right' } }))),
          ];
          const h = Math.max(1.0, H - y - 0.9);
          slide.addTable(rows, { x: 0.6, y, w: W - 1.2, h, border: { type: 'solid', pt: 0.5, color: 'E5E7EB' }, autoPage: false });
          y += h + 0.15;
          break;
        }
        case 'image': {
          const h = Math.max(1.5, H - y - 1.0);
          slide.addImage({ data: b.png, x: 1.0, y, w: W - 2.0, h, sizing: { type: 'contain', w: W - 2.0, h } });
          y += h + 0.15;
          break;
        }
        case 'tiles': {
          const cellW = (W - 1.6) / 2;
          const rows = Math.max(1, Math.ceil(b.tiles.length / 2));
          const cellH = Math.max(1.2, (H - y - 0.9) / rows);
          b.tiles.forEach((tv, i) => {
            const cx = 0.6 + (i % 2) * (cellW + 0.4);
            const cy = y + Math.floor(i / 2) * cellH;
            if (tv.png) slide.addImage({ data: tv.png, x: cx, y: cy, w: cellW, h: cellH - 0.3, sizing: { type: 'contain', w: cellW, h: cellH - 0.3 } });
            else slide.addText(tv.note || 'Could not be drawn', { x: cx, y: cy, w: cellW, h: cellH - 0.3, fontSize: 11, italic: true, color: C.muted, align: 'center' });
            slide.addText(tv.title || '', { x: cx, y: cy + cellH - 0.3, w: cellW, h: 0.26, fontSize: 10, color: C.muted, align: 'center' });
          });
          y += rows * cellH;
          break;
        }
      }
    }
    if (!cover) slide.addText(`Ordinate · ${date} · ${idx + 1} / ${pages.length}`, { x: 0.6, y: H - 0.45, w: W - 1.2, h: 0.3, fontSize: 9, color: C.muted });
  });
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}
