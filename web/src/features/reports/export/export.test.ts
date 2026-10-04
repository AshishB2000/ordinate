// The export layer: the block list every medium draws, page geometry, the
// filename, the PDF document definition, real PPTX / DOCX bytes, and the map
// marker compositing that replaces the desktop's capturePage.

import { describe, expect, it } from 'vitest';
import { imageBox, pageBlocks, pageBox, reportFilename, type ReadyPage } from './blocks';
import { pngSize } from './image';
import { compositeMarkers } from './mapPng';
import { pdfDoc } from './pdf';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const setup = { name: 'Board report', format: 'pdf' as const, paper: { size: 'letter', orientation: 'portrait' } };

const cover: ReadyPage = { kind: 'cover', title: 'Board', subtitle: 'Q3', meta: ['4 Oct 2026', 'Filtered: Region = West'], logoImg: { src: PNG, w: 1, h: 1 } };
const sheet: ReadyPage = {
  kind: 'sheet',
  title: 'Overview',
  kpis: [{ label: 'Revenue', value: '$2,409' }],
  tiles: [
    { title: 'By region', png: PNG },
    { title: 'Hidden', png: null, note: 'Hidden by the share policy' },
  ],
  caption: 'Revenue 2.4K',
};
const hidden: ReadyPage = { kind: 'tile', title: 'Sales', png: null, note: 'Hidden by the share policy', caption: 'Hidden by the share policy' };
const notes: ReadyPage = { kind: 'notes', title: 'Notes', body: 'First.\n\nSecond paragraph.' };
const grid: ReadyPage = { kind: 'scorecard', title: 'Scorecard', grid: { head: [['Metric', 'Oct']], body: [['Revenue', '$1']] } };

describe('pageBlocks', () => {
  it('a cover: logo, title, subtitle, meta — in that order', () => {
    expect(pageBlocks(cover).map((b) => b.t)).toEqual(['logo', 'title', 'sub', 'meta', 'meta']);
  });
  it('prose before figures, KPIs before pictures, the caption last', () => {
    expect(pageBlocks(sheet).map((b) => b.t)).toEqual(['title', 'kpis', 'tiles', 'caption']);
    expect(pageBlocks(notes).map((b) => b.t)).toEqual(['title', 'para', 'para']);
  });
  it('a hidden chart says why once — its note, not the same words again as a caption', () => {
    expect(pageBlocks(hidden)).toEqual([{ t: 'title', text: 'Sales' }, { t: 'note', text: 'Hidden by the share policy' }]);
  });
  it('a grid is a table, never a picture', () => {
    expect(pageBlocks(grid).map((b) => b.t)).toEqual(['title', 'grid']);
  });
});

describe('geometry and names', () => {
  it('paper at 96 dpi; a deck is always 16:9', () => {
    expect(pageBox(setup)).toEqual({ width: 816, height: 1056 });
    expect(pageBox({ ...setup, paper: { size: 'a4', orientation: 'landscape' } })).toEqual({ width: 1122, height: 794 });
    expect(pageBox({ ...setup, format: 'pptx' })).toEqual({ width: 1280, height: 720 });
  });
  it('a sheet tile is a two-up half of the tile box', () => {
    const t = imageBox(setup, 'tile');
    const s = imageBox(setup, 'sheet');
    expect(s.width).toBe(Math.round((t.width - 24) / 2));
    expect(t.width).toBeGreaterThan(s.width);
  });
  it('a PNG data URL is measured from its header (no decode)', () => {
    expect(pngSize(PNG)).toEqual({ w: 1, h: 1 });
    expect(pngSize('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
  });
  it('<name>-<YYYY-MM-DD>.<ext>, local date', () => {
    expect(reportFilename('Q3 Board / Report!', 'pdf', new Date(2026, 9, 4, 23, 30))).toBe('q3-board-report-2026-10-04.pdf');
    expect(reportFilename('', 'docx', new Date(2026, 0, 2))).toBe('report-2026-01-02.docx');
  });
});

describe('pdfDoc', () => {
  const doc = pdfDoc([cover, sheet, hidden, grid], setup, '4 Oct 2026') as Record<string, any>; // any: a pdfmake document tree
  it('one document, a page break before every page after the first', () => {
    const breaks = doc.content.filter((n: { pageBreak?: string }) => n.pageBreak === 'before');
    expect(breaks).toHaveLength(3);
    expect(doc.pageSize).toBe('LETTER');
    expect(doc.pageOrientation).toBe('portrait');
  });
  it('no running header on the cover; "Page n of N" in the footer', () => {
    expect(doc.header(1)).toBeNull();
    expect(doc.header(2).columns[0].text).toBe('Board report');
    expect(doc.footer(2, 4).columns[1].text).toBe('Page 2 of 4');
  });
  it('KPIs and grids are real tables (the figures stay text)', () => {
    const tables = doc.content.filter((n: { table?: unknown }) => n.table);
    expect(tables.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(tables)).toContain('$2,409');
    expect(JSON.stringify(tables)).toContain('Revenue');
  });
});

describe('PPTX and DOCX bytes', () => {
  const zip = async (b: Blob) => new Uint8Array(await b.arrayBuffer()).subarray(0, 2);
  it('a deck is a zip (OOXML)', async () => {
    const { pptxBlob } = await import('./pptx');
    const b = await pptxBlob([cover, sheet, hidden, notes, grid], { ...setup, format: 'pptx' }, '4 Oct 2026');
    expect(Array.from(await zip(b))).toEqual([0x50, 0x4b]);
  }, 30_000);
  it('a Word document is a zip (OOXML)', async () => {
    const { docxBlob } = await import('./docx');
    const b = await docxBlob([cover, sheet, hidden, notes, grid], { ...setup, format: 'docx' }, '4 Oct 2026');
    expect(Array.from(await zip(b))).toEqual([0x50, 0x4b]);
  }, 30_000);
});

describe('compositeMarkers', () => {
  it('paints each DOM marker at its laid-out place, scaled to the canvas, in its own colours', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="cv-map-value-label">CA 1.2M</div><div class="cv-map-cluster">12</div><div class="other">x</div>';
    wrap.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 300 }) as DOMRect;
    const [a, b] = wrap.querySelectorAll<HTMLElement>('div');
    a.getBoundingClientRect = () => ({ left: 120, top: 60, width: 40, height: 16 }) as DOMRect;
    b.getBoundingClientRect = () => ({ left: 200, top: 100, width: 20, height: 20 }) as DOMRect;
    a.style.backgroundColor = 'rgb(255, 255, 255)';
    a.style.color = 'rgb(10, 20, 30)';
    const calls: Array<[string, unknown[]]> = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, k: string) => (...args: unknown[]) => void calls.push([k, args]),
      set: (_t, k: string, v) => (calls.push(['set:' + k, [v]]), true),
    }) as unknown as CanvasRenderingContext2D;
    expect(compositeMarkers(ctx, wrap, 2)).toBe(2);
    const texts = calls.filter(([k]) => k === 'fillText');
    // (120-100)*2 + 40*2/2 = 80, (60-50)*2 + 16*2/2 = 36
    expect(texts[0][1]).toEqual(['CA 1.2M', 80, 36]);
    expect(texts[1][1][0]).toBe('12');
    expect(calls.some(([k, v]) => k === 'set:fillStyle' && v[0] === 'rgb(10, 20, 30)')).toBe(true);
  });
});
