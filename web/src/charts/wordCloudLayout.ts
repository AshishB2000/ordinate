// The word cloud's layout (renderer/hub/wordCloudLayout.ts) — PURE and
// DOM-free, and DETERMINISTIC by construction (no Math.random):
//   · words placed in DESCENDING weight order, ties broken by the word itself
//     (code-unit order, no locale), so the biggest word takes the centre;
//   · font size a SQUARE-ROOT scale of the weight between minSize and maxSize
//     px — area, not height, grows with the figure — rounded to a whole pixel;
//   · each word walks an Archimedean spiral out from the centre, stretched to
//     the box's aspect, and takes the FIRST position inside the area that
//     overlaps nothing placed before it (checked AFTER rounding);
//   · horizontal words only; collisions tested against a uniform grid.
// A word with no position within the spiral budget is DROPPED and named in
// `dropped` — the caller says "N words did not fit" rather than overlapping.

import type { Cx } from './types';

interface WcInput { text: string; weight: number; index: number }
export interface WcPlaced {
  text: string;
  weight: number;
  /** Index into the input list — the category the word stands for. */
  index: number;
  size: number;
  /** Top-left of the word's box, whole pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface WcOptions {
  width: number;
  height: number;
  minSize?: number;
  maxSize?: number;
  /** Width in px of `text` at `size` px — the canvas' measureText in the app. */
  measure: (text: string, size: number) => number;
  /** Box height per px of font size. */
  lineHeight?: number;
  /** Empty space kept around each word, px. */
  padding?: number;
  /** Spiral budget per word (positions tried). */
  maxSteps?: number;
}
export interface WcLayout { placed: WcPlaced[]; dropped: string[]; minSize: number; maxSize: number }


const CELL = 24;

function sizeScale(weights: number[], lo: number, hi: number): (w: number) => number {
  const roots = weights.map((w) => Math.sqrt(Math.max(0, w)));
  const a = Math.min(...roots);
  const b = Math.max(...roots);
  if (!(b > a)) return () => Math.round((lo + hi) / 2);
  return (w) => Math.round(lo + (hi - lo) * ((Math.sqrt(Math.max(0, w)) - a) / (b - a)));
}

export function wordCloudLayout(words: Array<{ text: string; weight: number }>, opts: WcOptions): WcLayout {
  const W = Math.max(1, Math.floor(opts.width));
  const H = Math.max(1, Math.floor(opts.height));
  const minSize = Math.max(6, Math.round(opts.minSize || 11));
  const maxSize = Math.max(minSize, Math.round(opts.maxSize || 56));
  const lineH = opts.lineHeight || 1.1;
  const pad = opts.padding === undefined ? 2 : Math.max(0, opts.padding);
  const maxSteps = opts.maxSteps || 30000;

  const list: WcInput[] = [];
  words.forEach((w, index) => {
    const weight = typeof w.weight === 'number' && Number.isFinite(w.weight) ? w.weight : NaN;
    const text = w.text == null ? '' : String(w.text);
    if (text && weight > 0) list.push({ text, weight, index });
  });
  list.sort((p, q) => (q.weight !== p.weight ? q.weight - p.weight : p.text < q.text ? -1 : p.text > q.text ? 1 : p.index - q.index));
  if (!list.length) return { placed: [], dropped: [], minSize, maxSize };
  const size = sizeScale(list.map((w) => w.weight), minSize, maxSize);

  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  const grid: WcPlaced[][] = Array.from({ length: cols * rows }, () => []);
  const cellsOf = (x: number, y: number, w: number, h: number): number[] => {
    const out: number[] = [];
    const c0 = Math.max(0, Math.floor(x / CELL));
    const c1 = Math.min(cols - 1, Math.floor((x + w - 1) / CELL));
    const r0 = Math.max(0, Math.floor(y / CELL));
    const r1 = Math.min(rows - 1, Math.floor((y + h - 1) / CELL));
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) out.push(r * cols + c);
    return out;
  };
  const hits = (x: number, y: number, w: number, h: number): boolean => {
    for (const k of cellsOf(x, y, w, h)) {
      for (const p of grid[k]) {
        if (x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h) return true;
      }
    }
    return false;
  };

  const placed: WcPlaced[] = [];
  const dropped: string[] = [];
  const cx = W / 2;
  const cy = H / 2;
  // The spiral is stretched to the area's aspect so a wide card fills sideways.
  const sx = Math.max(1, W / H);
  const sy = Math.max(1, H / W);
  for (const word of list) {
    let s = size(word.weight);
    let w = Math.ceil(opts.measure(word.text, s)) + 2 * pad;
    let h = Math.ceil(s * lineH) + 2 * pad;
    // A word wider than the whole area shrinks to fit rather than vanishing.
    while ((w > W || h > H) && s > minSize) {
      s -= 1;
      w = Math.ceil(opts.measure(word.text, s)) + 2 * pad;
      h = Math.ceil(s * lineH) + 2 * pad;
    }
    let spot: { x: number; y: number } | null = null;
    if (w <= W && h <= H) {
      // Rings half a word-height apart, walked in steps of a quarter of one,
      // so a small word probes finely and a big one does not crawl.
      const ring = Math.max(4, h / 2) / (2 * Math.PI);
      const ds = Math.max(2, h / 4);
      let t = 0;
      for (let k = 0; k < maxSteps; k += 1) {
        const r = ring * t;
        const x = Math.round(cx + r * sx * Math.cos(t) - w / 2);
        const y = Math.round(cy + r * sy * Math.sin(t) - h / 2);
        t += Math.min(0.5, ds / Math.max(1, r * Math.max(sx, sy)));
        if (x < 0 || y < 0 || x + w > W || y + h > H) {
          // The ellipse now encloses the whole area: every later point is outside it.
          if (r > 0 && (cx / (r * sx)) ** 2 + (cy / (r * sy)) ** 2 < 1) break;
          continue;
        }
        if (!hits(x, y, w, h)) {
          spot = { x, y };
          break;
        }
      }
    }
    if (!spot) {
      dropped.push(word.text);
      continue;
    }
    const p: WcPlaced = { text: word.text, weight: word.weight, index: word.index, size: s, x: spot.x, y: spot.y, w, h };
    placed.push(p);
    for (const k of cellsOf(p.x, p.y, p.w, p.h)) grid[k].push(p);
  }
  return { placed, dropped, minSize, maxSize };
}

// `visual:data` folds a text category past CATEGORY_CAP distinct values into
// ONE "Other" group (src/analysis/categoryKey.ts). That group is a bar's honest
// tail but not a word — drawn, it would be the biggest one. Mirrored here (a
// renderer script cannot import main); scripts/test-wordCloud.ts pins both
// constants to categoryKey's, so a change there fails a test, not a picture.
export const WC_CATEGORY_CAP = 50;
export const WC_OTHER_LABEL = 'Other';

/** Is label `i` the folded tail rather than a real category? */
export function wordCloudIsBucket(labels: Cx[], i: number): boolean {
  return labels.length > WC_CATEGORY_CAP && labels[i] === WC_OTHER_LABEL;
}

/** The placed word under (x, y), or null — the hover and click hit test. */
export function wordCloudHit(layout: WcLayout, x: number, y: number): WcPlaced | null {
  for (const p of layout.placed) if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return p;
  return null;
}
