// The server's pages → pages a writer can print: every `chart` (the server's
// own visual:data reply) drawn by the shared engine at the box it will fill on
// the page — T1.1's off-screen PNG helper for charts, ./mapPng for maps — in the
// print theme; the cover's logo rasterized to PNG and measured. Nothing here
// computes a figure: it draws the ones it was given.

import { renderChartPng } from '../../../charts/png';
import { VIZ_RENDERER, type VizId } from '../../../charts/vizLabels';
import type { MapData } from '../../../charts/maps/types';
import type { PageChart, RenderedPage } from '../api';
import { imageBox, type LogoImg, type PageSetup, type ReadyPage } from './blocks';
import { imageSize } from './image';
import p from './Print.module.css';

/** A data: URL as a PNG (an SVG logo rasterized on a canvas), with its natural size. */
async function pngLogo(src: string): Promise<LogoImg | null> {
  const size = await imageSize(src);
  if (!size) return null;
  if (src.startsWith('data:image/png')) return { src, ...size };
  const c = document.createElement('canvas');
  const scale = Math.max(1, 320 / Math.max(size.w, size.h));
  c.width = Math.round(size.w * scale);
  c.height = Math.round(size.h * scale);
  const img = new Image();
  await new Promise((r) => {
    img.onload = r;
    img.onerror = r;
    img.src = src;
  });
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/png'), w: c.width, h: c.height };
}

async function picture(chart: PageChart, box: { width: number; height: number }, projectId: string, host: HTMLElement): Promise<{ png: string | null; note?: string }> {
  const renderer = VIZ_RENDERER[chart.type as VizId];
  if (renderer === 'map') {
    const { renderMapPng } = await import('./mapPng');
    const png = await renderMapPng(chart.type, chart.data as unknown as MapData, { ...box, projectId });
    return png ? { png } : { png: null, note: 'The map could not be drawn for the file.' };
  }
  if (renderer === 'table') return { png: null, note: 'A table prints as rows on screen only.' };
  const png = await renderChartPng(chart.type, chart.data, chart.overrides, { ...box, host }).catch(() => null);
  return png ? { png } : { png: null, note: 'Could not be drawn' };
}

export async function materialize(pages: RenderedPage[], setup: PageSetup, projectId: string, onStep?: (done: number, total: number) => void): Promise<ReadyPage[]> {
  // The print theme's box: charts read their colours off the element they are drawn in.
  const host = document.createElement('div');
  host.className = p.light;
  document.body.appendChild(host);
  const total = pages.reduce((n, rp) => n + (rp.chart ? 1 : 0) + (rp.tiles || []).filter((t) => t.chart).length, 0);
  let done = 0;
  const step = () => onStep?.(++done, total);
  try {
    const out: ReadyPage[] = [];
    for (const rp of pages) {
      const { chart, tiles, logo, ...rest } = rp;
      const ready: ReadyPage = { ...rest };
      if (chart) {
        const pic = await picture(chart, imageBox(setup, 'tile'), projectId, host);
        ready.png = pic.png;
        if (pic.note && !ready.note) ready.note = pic.note;
        step();
      }
      if (tiles) {
        ready.tiles = [];
        for (const t of tiles) {
          if (t.chart) {
            const pic = await picture(t.chart, imageBox(setup, 'sheet'), projectId, host);
            ready.tiles.push({ title: t.title, png: pic.png, ...(t.note || pic.note ? { note: t.note || pic.note } : {}) });
            step();
          } else {
            ready.tiles.push({ title: t.title, png: t.png ?? null, ...(t.note ? { note: t.note } : {}) });
          }
        }
      }
      if (rp.kind === 'cover' && logo) {
        const src = logo === 'mark' ? (await import('./mark')).ORDINATE_MARK_PNG : logo;
        ready.logoImg = await pngLogo(src);
      }
      out.push(ready);
    }
    return out;
  } finally {
    host.remove();
  }
}
