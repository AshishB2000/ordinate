// A resolved page → the flat list of what is ON it, in order (the desktop's
// reportRender.ts reportPageBlocks). The preview and the three writers each
// answer one question per block kind, so a page kind is described once, here,
// and a caption cannot go missing in one medium only. Pure: no DOM.

import type { RenderedPage, ReportFormat } from '../api';

/** A logo measured for the writers (pdfmake, pptxgenjs and docx want PNG and an aspect). */
export interface LogoImg {
  src: string;
  w: number;
  h: number;
}
/** A page with every chart already turned into a picture (./materialize.ts). */
export interface ReadyPage extends Omit<RenderedPage, 'chart' | 'tiles' | 'logo'> {
  png?: string | null;
  tiles?: Array<{ title: string; png: string | null; note?: string }>;
  logoImg?: LogoImg | null;
}

export type Block =
  | { t: 'logo'; src: string; w: number; h: number }
  | { t: 'title'; text: string }
  | { t: 'sub'; text: string }
  | { t: 'meta'; text: string }
  | { t: 'para'; text: string }
  | { t: 'bullet'; text: string }
  | { t: 'caption'; text: string }
  | { t: 'note'; text: string }
  | { t: 'image'; png: string; alt: string }
  | { t: 'tiles'; tiles: Array<{ title: string; png: string | null; note?: string }> }
  | { t: 'kpis'; rows: Array<{ label: string; value: string }> }
  | { t: 'grid'; head: string[][]; body: string[][] };

export function pageBlocks(rp: ReadyPage): Block[] {
  const out: Block[] = [];
  if (rp.kind === 'cover' && rp.logoImg) out.push({ t: 'logo', ...rp.logoImg });
  if (rp.title) out.push({ t: 'title', text: rp.title });
  if (rp.subtitle) out.push({ t: 'sub', text: rp.subtitle });
  for (const line of rp.meta || []) out.push({ t: 'meta', text: line });
  // Prose comes BEFORE the picture (the capture one-pager's order: title, paragraph, chart).
  for (const para of String(rp.body || '').split(/\n{2,}/)) if (para.trim()) out.push({ t: 'para', text: para.trim() });
  if (rp.kpis && rp.kpis.length) out.push({ t: 'kpis', rows: rp.kpis });
  if (rp.grid) out.push({ t: 'grid', head: rp.grid.head, body: rp.grid.body });
  if (rp.png) out.push({ t: 'image', png: rp.png, alt: rp.title || '' });
  else if (rp.note) out.push({ t: 'note', text: rp.note });
  if (rp.tiles && rp.tiles.length) out.push({ t: 'tiles', tiles: rp.tiles });
  for (const line of rp.bullets || []) out.push({ t: 'bullet', text: line });
  // A hidden chart's caption IS its note — said once, not twice.
  if (rp.caption && rp.caption !== rp.note) out.push({ t: 'caption', text: rp.caption });
  return out;
}

// ── Page geometry (reportRender.ts reportPageBox): logical px at 96 dpi; a deck is always 16:9 ──

const PAPER_IN: Record<string, { w: number; h: number }> = { letter: { w: 8.5, h: 11 }, a4: { w: 8.27, h: 11.69 } };

export interface PageSetup {
  name: string;
  format: ReportFormat;
  paper?: { size: string; orientation: string };
}

export function pageBox(r: PageSetup): { width: number; height: number } {
  if (r.format === 'pptx') return { width: 1280, height: 720 };
  const size = PAPER_IN[r.paper?.size ?? 'letter'] || PAPER_IN.letter;
  const portrait = r.paper?.orientation !== 'landscape';
  return { width: Math.round((portrait ? size.w : size.h) * 96), height: Math.round((portrait ? size.h : size.w) * 96) };
}

/** The box a chart picture fills on a page: the page minus margins, heading, caption and footer (reportImageBox). */
export function imageBox(r: PageSetup, kind: 'tile' | 'sheet'): { width: number; height: number } {
  const box = pageBox(r);
  const margin = Math.round(box.width * 0.08);
  const chrome = kind === 'sheet' ? 150 : 190;
  const full = { width: Math.max(160, box.width - 2 * margin), height: Math.max(120, box.height - 2 * margin - chrome) };
  // Two-up on a sheet page: each tile is half the width and half the height.
  return kind === 'sheet' ? { width: Math.round((full.width - 24) / 2), height: Math.round(full.height / 2) } : full;
}

/** `<name>-<YYYY-MM-DD>.<ext>`, the local date (reportSpec.reportFilename). */
export function reportFilename(name: string, ext: string, when: Date = new Date()): string {
  const slug =
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${slug}-${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}.${ext.replace(/[^a-z0-9]/gi, '')}`;
}

/** The light tokens a printed page uses — a file is always a white page, whatever the app's theme. */
export const PRINT = { ink: '#18181b', strong: '#0f1117', muted: '#6b7280', accent: '#2563eb' };
export const PRINT_HEX = { ink: '18181B', strong: '0F1117', muted: '6B7280', accent: '2563EB' };
