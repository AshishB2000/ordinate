// Self-check for the static map thumbnail's two pure halves
// (renderer/hub/mapThumb.ts): the projection, and the per-feature fill choice.
//
// Pure by construction — no Electron, no canvas, no DOM. mapThumb.js is a
// classic renderer <script> that exports these two through the same tail
// `module.exports` hook geoMatch.js uses, precisely so this file can require the
// REAL implementation instead of mirroring it (docs/phase-0/README.md §5 records
// what mirrored helpers cost: three suites that kept passing after the originals
// were deleted).
//
// mapThumbFills calls the bare global `matchGeoItem`, which in the hub comes
// from geoMatch.js's window assignment. Node has no window, so the real matcher
// is hoisted onto globalThis first — the same object, not a stand-in.
//
// Run: node scripts/test-mapThumb.js   (exits non-zero on failure)

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

// ponytail: both are renderer global-scripts, not typed TS modules — loose types.
Object.assign(globalThis, require('../renderer/hub/geoMatch'));
const { mapThumbProject, mapThumbFills } = require('../renderer/hub/mapThumb') as {
  mapThumbProject: (
    bbox: [number, number, number, number], width: number, height: number, pad: number,
  ) => (lng: number, lat: number) => [number, number];
  mapThumbFills: (
    features: any[], items: any[], emptyFill: string, colorFor: (t: number) => string,
  ) => string[];
};

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── §1 projection: a known lat/lon lands in the expected box ────────────────
// A square bbox centred on the equator: cos(midLat) is 1, so this is plain
// equirectangular and every expected pixel is hand-computable.
{
  const p = mapThumbProject([-10, -10, 10, 10], 100, 100, 0);
  const c = p(0, 0);
  ok('projection: the bbox centre lands at the box centre', near(c[0], 50) && near(c[1], 50), c.join(','));

  const nw = p(-10, 10);
  ok('projection: NW corner → (0,0) — north is UP, so max lat is y=0',
    near(nw[0], 0) && near(nw[1], 0), nw.join(','));

  const se = p(10, -10);
  ok('projection: SE corner → (width,height)', near(se[0], 100) && near(se[1], 100), se.join(','));

  // 5°E on a 20°-wide bbox mapped to 100px = 25px from the left edge (75 total).
  const e5 = p(5, 0);
  ok('projection: longitude is linear across the box', near(e5[0], 75) && near(e5[1], 50), e5.join(','));
}

// ── §2 padding + aspect: the fit never stretches ────────────────────────────
{
  // A 20°×20° bbox in a 200×100 box: height binds, so the drawing is 100 tall
  // (minus padding) and CENTRED horizontally, not stretched to 200 wide.
  const p = mapThumbProject([-10, -10, 10, 10], 200, 100, 0);
  const w = p(10, 0)[0] - p(-10, 0)[0];
  const h = p(0, -10)[1] - p(0, 10)[1];
  ok('fit: aspect preserved — a square bbox stays square in a wide box', near(w, h), `${w} vs ${h}`);
  ok('fit: the shorter axis fills the box', near(h, 100), String(h));
  ok('fit: the longer axis is centred', near(p(-10, 0)[0], 50), String(p(-10, 0)[0]));

  const padded = mapThumbProject([-10, -10, 10, 10], 100, 100, 5);
  ok('fit: padding insets both edges', near(padded(-10, 10)[0], 5) && near(padded(10, -10)[0], 95),
    `${padded(-10, 10)[0]}..${padded(10, -10)[0]}`);
}

// ── §3 mid-latitude longitudes compress by cos(midLat) ─────────────────────
{
  // A US-shaped bbox: 1° of longitude at 40°N must be narrower than 1° of
  // latitude, or the country comes out ~30% too wide.
  const p = mapThumbProject([-100, 30, -80, 50], 100, 100, 0);
  const degX = p(-99, 40)[0] - p(-100, 40)[0];
  const degY = p(-90, 40)[1] - p(-90, 41)[1];
  ok('projection: 1° lng is narrower than 1° lat away from the equator', degX < degY, `${degX} vs ${degY}`);
  ok('projection: …by exactly cos(midLat)', near(degX / degY, Math.cos(40 * Math.PI / 180), 1e-9),
    String(degX / degY));
}

// ── §4 fills: matched regions take the scale, everything else the empty fill ─
{
  const EMPTY = '#eeeeee';
  const colorFor = (t: number) => 'T' + t.toFixed(3);   // the scale, made legible
  const feat = (name: string) => ({ properties: { name }, geometry: null });
  const features = [feat('California'), feat('Texas'), feat('Nevada'), feat('Ohio')];
  const items = [
    { name: 'California', value: 100 },
    { name: 'Texas', value: 50 },
    { name: 'Nevada', value: 0 },
  ];

  const fills = mapThumbFills(features, items, EMPTY, colorFor);
  ok('fills: one colour per feature, in feature order', fills.length === 4, String(fills.length));
  ok('fills: the maximum region sits at the top of the scale', fills[0] === 'T1.000', fills[0]);
  ok('fills: the midpoint normalises to 0.5', fills[1] === 'T0.500', fills[1]);
  ok('fills: the minimum region sits at the bottom — not at the empty fill',
    fills[2] === 'T0.000', fills[2]);
  ok('fills: an UNMATCHED region gets the empty fill', fills[3] === EMPTY, fills[3]);
}

// ── §5 fill edge cases ──────────────────────────────────────────────────────
{
  const EMPTY = '#eeeeee';
  const colorFor = (t: number) => 'T' + t.toFixed(3);
  const feat = (name: string) => ({ properties: { name }, geometry: null });

  const flat = mapThumbFills([feat('Ohio')], [{ name: 'Ohio', value: 7 }], EMPTY, colorFor);
  ok('fills: a single region (min === max) reads mid-scale, never NaN', flat[0] === 'T0.500', flat[0]);

  const nonNumeric = mapThumbFills([feat('Ohio')], [{ name: 'Ohio', value: null }], EMPTY, colorFor);
  ok('fills: a matched region with no numeric value is EMPTY, not zero',
    nonNumeric[0] === EMPTY, nonNumeric[0]);

  ok('fills: no items at all → every feature empty',
    mapThumbFills([feat('Ohio'), feat('Iowa')], [], EMPTY, colorFor).join() === [EMPTY, EMPTY].join());
  ok('fills: no features → no fills', mapThumbFills([], [{ name: 'Ohio', value: 1 }], EMPTY, colorFor).length === 0);

  // The join is geoMatch's, suffixes and all — the same one the live map uses.
  const suffixed = mapThumbFills([feat('Ohio')], [{ name: 'Ohio County', value: 3 }], EMPTY, colorFor);
  ok('fills: matching goes through geoMatch (admin suffixes normalise away)',
    suffixed[0] === 'T0.500', suffixed[0]);

  // Negatives are values, not absences: the normalisation is min→max, not 0→max.
  const negs = mapThumbFills(
    [feat('Ohio'), feat('Iowa')],
    [{ name: 'Ohio', value: -10 }, { name: 'Iowa', value: -2 }], EMPTY, colorFor);
  ok('fills: an all-negative range still spans the full scale',
    negs[0] === 'T0.000' && negs[1] === 'T1.000', negs.join());
}

finish();
