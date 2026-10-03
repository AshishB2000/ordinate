// The numbers a chart prints ON ITSELF — the text of a value label, where it
// sits, whether a round slice can hold it, and which points get one
// (renderer/hub/chartValueLabels.ts, its pure half). The plugins that draw them
// are valueLabels.ts and familiesPlugins.ts.

import { fmtVal, fmtWith } from './format';
import type { Cx } from './types';

/**
 * The text a value label prints, when the chart carries no explicit
 * "Number format" override.
 *
 * THE RULE, unchanged: at or above 10,000 abbreviate (`_fmtVal` → "12.2K"),
 * below it show the real number. A label is the figure the reader takes away,
 * and rounding 9,481 to "9.5K" on a chart small enough to read exactly is a
 * loss; abbreviating 1,204,388 is a gain. The threshold is where those cross.
 *
 * WHAT WAS WRONG was the "show the real number" half: it was `String(v)`, which
 * prints a float at full binary precision. A summed money column is almost never
 * exact — filter the bundled sample to one category and the line chart's minimum
 * printed `3908.359999999999` straight across the y-axis ticks. It stayed hidden
 * for as long as it did because it only shows BELOW 10,000, and most unfiltered
 * dashboards sum to more than that.
 *
 * `toLocaleString()` is the fix and also already the app's answer: it is exactly
 * what `fmtWith(v, 'plain')` does, so "no override" now agrees with the override
 * a reader would pick to mean the same thing. It groups thousands and rounds at
 * three decimals.
 *
 * …except at the bottom of the range, where that rounding turns a real figure
 * into "0". A margin of 0.0001234 is not zero, and a chart that says it is would
 * be wrong in the one way this app must never be. Below 0.001 — precisely where
 * the default rounding collapses — significant digits take over instead.
 */
export function valueLabelText(v: number): string {
  if (Math.abs(v) >= 10000) return fmtVal(v);
  if (v !== 0 && Math.abs(v) < 0.001) return v.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  return v.toLocaleString();
}

/**
 * The text of one value label: Format → Data labels' own number format when the
 * chart has one, else the chart's number format, else the rule above.
 */
export function valueLabelOf(v: number, overrides: Cx, fmt: (v: Cx) => string): string {
  if (overrides && overrides.labelFormat) return fmtWith(v, overrides.labelFormat);
  return overrides && overrides.numberFormat ? fmt(v) : valueLabelText(v);
}

/**
 * Where a value label sits (Format → Data labels → Position). `outside` — and
 * absent, which every chart drawn before the option existed is — is the
 * original placement, byte for byte: above a column's top, right of a bar's
 * end. `inside` tucks it just within the mark's value end (below a line's
 * point); `center` puts it at the mark's middle. On a bar the label then sits
 * ON the fill, which is why `onMark` asks for white ink.
 */
export function valueLabelAt(
  el: Cx, pos: { x: number; y: number }, isHoriz: boolean, place: string,
  w: number, h: number, isBar: boolean,
): { x: number; y: number; bx: number; onMark: boolean } {
  if (place === 'center') {
    const cp = el && typeof el.getCenterPoint === 'function' ? el.getCenterPoint() : pos;
    const y = isHoriz ? cp.y : cp.y + h / 2;
    return { x: cp.x, y, bx: cp.x - w / 2, onMark: isBar };
  }
  if (place === 'inside') {
    const x = isHoriz && isBar ? pos.x - 6 - w / 2 : pos.x;
    const y = isHoriz ? pos.y : pos.y + h + (isBar ? 4 : 6);
    return { x, y, bx: x - w / 2, onMark: isBar };
  }
  const x = isHoriz ? pos.x + 8 : pos.x;
  return { x, y: isHoriz ? pos.y : pos.y - 4, bx: isHoriz ? x : x - w / 2, onMark: false };
}

/**
 * Does a round-chart slice have room to hold its label?
 *
 * The old rule was `frac >= 0.06` — a share of the TOTAL, which says nothing
 * about pixels. At a dashboard card's ~150px tile a 6% slice is a few pixels
 * wide, so "Technology" in 10px type was drawn straight across the ring and out
 * the other side. The same rule mislabels a full-size chart too, just less
 * often: a long category in a thin slice has always overflowed.
 *
 * SO TEST THE TEXT AGAINST THE SLICE, AND DO IT IN THE RIGHT DIRECTION. The
 * first attempt at this compared the text width to the slice's chord at the
 * label radius. That is rotation-independent, and the label is not: it is drawn
 * HORIZONTALLY, so a slice sitting at 4 o'clock offers far less left-to-right
 * room than its chord suggests. It fixed the pie and left the donut exactly as
 * broken, which is what sent this back for a second pass.
 *
 * What actually settles it is the label's own box. The text is a rectangle
 * centred on the slice's mid-radius, mid-angle point; it fits when all FOUR of
 * its corners are still inside the annular sector — radius within
 * [inner, outer], angle within [start, end]. That is exact, cheap, and
 * orientation-aware by construction.
 *
 * Pure and unit-testable on purpose: everything here is a number, so
 * scripts/test-roundLabels.ts can drive real thumbnail and full-size geometry
 * without a canvas. `textWidth` is measured by the caller, which is the only
 * part that needs a 2-D context.
 */
export function roundLabelFits(
  geom: { innerRadius: number; outerRadius: number; startAngle: number; endAngle: number },
  textWidth: number, textHeight: number,
): boolean {
  const inner = Math.max(0, Number(geom.innerRadius) || 0);
  const outer = Math.max(0, Number(geom.outerRadius) || 0);
  const start = Number(geom.startAngle) || 0;
  const end = Number(geom.endAngle) || 0;
  const w = Number(textWidth) || 0;
  const h = Number(textHeight) || 0;
  if (!(outer > inner) || !(w > 0) || !(h > 0)) return false;

  const span = Math.abs(end - start);
  const TAU = Math.PI * 2;
  // A slice covering the whole circle has no edges to cross, so only the radii
  // can rule the label out. Checked first because the angle test below would
  // otherwise depend on floating-point luck at exactly 2π.
  const whole = span >= TAU - 1e-9;

  const rMid = (inner + outer) / 2;
  const mid = (start + end) / 2;
  const cx = rMid * Math.cos(mid);
  const cy = rMid * Math.sin(mid);
  // 4px of breathing room each side, or the text kisses the slice edges and
  // reads as overflowing even when it technically fits.
  const hw = w / 2 + 4;
  const hh = h / 2 + 2;

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = cx + sx * hw;
      const y = cy + sy * hh;
      const r = Math.sqrt(x * x + y * y);
      if (r < inner || r > outer) return false;
      if (whole) continue;
      // Sweep from `start` to this corner, normalised into [0, 2π), must land
      // inside the slice's own span.
      let d = (Math.atan2(y, x) - start) % TAU;
      if (d < 0) d += TAU;
      if (d > span) return false;
    }
  }
  return true;
}

// Which data points the Values menu labels, given a mode and the 2-D value grid
// (`values[seriesIdx][catIdx]`; hidden series passed as all-null so they can't win).
// Returns a Set of "seriesIdx:catIdx" keys.
//   all    → every non-null cell
//   single series → the one global max / min over categories
//   multi series  → per category column, the max series (and/or min series)  [per-group]
//   maxmin → union of max and min
export function valueLabelKeys(mode: string, values: Cx[][]): Set<string> {
  const keys = new Set<string>();
  if (!mode || mode === 'off' || !Array.isArray(values) || !values.length) return keys;
  const S = values.length;
  const C = Math.max(0, ...values.map((r: Cx[]) => (Array.isArray(r) ? r.length : 0)));
  const num = (s: number, c: number): number | null => { const v = values[s] && values[s][c]; return typeof v === 'number' ? v : null; };
  const add = (s: number, c: number) => keys.add(s + ':' + c);
  if (mode === 'all') {
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) if (num(s, c) != null) add(s, c);
    return keys;
  }
  const wantMax = mode === 'max' || mode === 'maxmin';
  const wantMin = mode === 'min' || mode === 'maxmin';
  // One max and one min per series — each line/bar's own peak and trough across
  // categories (so N series → up to N maxes + N mins).
  for (let s = 0; s < S; s++) {
    let maxC = -1, minC = -1, maxV = -Infinity, minV = Infinity;
    for (let c = 0; c < C; c++) {
      const v = num(s, c); if (v == null) continue;
      if (v > maxV) { maxV = v; maxC = c; }
      if (v < minV) { minV = v; minC = c; }
    }
    if (wantMax && maxC >= 0) add(s, maxC);
    if (wantMin && minC >= 0) add(s, minC);
  }
  return keys;
}

// Reads a numeric value out of a Chart.js data point (handles {x,y} scatter points).
export const numOf = (raw: Cx): number | null => {
  const v = (raw && typeof raw === 'object') ? raw.y : raw;
  return typeof v === 'number' ? v : null;
};
