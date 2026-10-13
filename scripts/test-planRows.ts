// Self-check for a plan sheet's ROWS — src/analysis/planRows.ts (the vocabulary)
// and src/analysis/planLayout.ts (the geometry) — and for the places they reach:
// validatePlan, the preview's `layout`, the built cards and the draft's insight
// charts.
//
// A row lets the model that drafts a dashboard say HOW a sheet is arranged. It
// must not let it say WHERE anything is, so this suite holds:
//
//   1. THE APP STILL OWNS THE GEOMETRY. Over many random row stacks — valid,
//      degenerate and garbage — no two tiles overlap, none leaves the 12-column
//      grid, every row but a KPI strip fills its band edge to edge, and no chart
//      is narrower than half the sheet (reportSpec.isBigChart depends on that).
//      The checker ships its negative controls: a hand-made bad layout must FAIL.
//   2. A FLAT SHEET IS UNTOUCHED. A sheet with no rows gets exactly the geometry
//      the builder gave it before rows existed — compared with that packer, kept
//      here verbatim as the reference.
//   3. A VALIDATED PLAN SURVIVES RE-VALIDATION. The plan goes to the browser and
//      comes back to `analysis:buildPlan`, which validates it again.
//   4. THE FLAT ARRAYS ARE THE ROWS, FLATTENED. planPreview, stories and planExec
//      keep reading metrics / visuals / texts and must see the same tiles.
//   5. EVERY DEGENERATE ROW HAS ONE ANSWER, and a row that goes is reported.
//   6. THE PROMPT NAMES WHAT THE PARSER ACCEPTS — every row type, control kind.
//
//   npm run build:ts && node --test scripts/test-planRows.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-planrows-'));

const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const planRows: typeof import('../src/analysis/planRows') = require('../src/analysis/planRows');
const planLayout: typeof import('../src/analysis/planLayout') = require('../src/analysis/planLayout');
const planControls: typeof import('../src/analysis/planControls') = require('../src/analysis/planControls');
const planPreview: typeof import('../src/analysis/planPreview') = require('../src/analysis/planPreview');
const planBuild: typeof import('../src/analysis/planBuild') = require('../src/analysis/planBuild');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcInsights: typeof import('../src/ipc/insights') = require('../src/ipc/insights');
const analysesIpc: typeof import('../src/ipc/analyses') = require('../src/ipc/analyses');

type Tile = { kind: string; x: number; y: number; w: number; h: number };
type At = { metrics: Omit<Tile, 'kind'>[]; visuals: Omit<Tile, 'kind'>[]; texts: Omit<Tile, 'kind'>[] };

// ── Fixtures ────────────────────────────────────────────────────────────────
// Raw envelope items, as a model writes them. `any` throughout: the point of a
// raw envelope is that it is untyped.

const COLS = [
  { name: 'region', type: 'text' as const },
  { name: 'revenue', type: 'number' as const },
  { name: 'cost', type: 'number' as const },
];
const CTX: any = {
  datasets: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Sales', rowCount: 5, resident: false, columns: COLS }],
  visuals: [],
};

const V = (name = 'Chart'): any => ({
  dataset: 'Sales', name, chartType: 'bar',
  encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
});
const BAD_V: any = { ...V('Bad'), chartType: 'spiral' }; // not a chart type
const M = (label = 'Revenue'): any => ({ dataset: 'Sales', column: 'revenue', aggregation: 'sum', label });
const BAD_M: any = { dataset: 'Sales', column: 'region', aggregation: 'sum' }; // sum of text
const T = (heading = 'Note'): any => ({ heading, text: 'A sentence about the chart.' });

function validated(rows: unknown, extra: Record<string, unknown> = {}, ctx: any = CTX) {
  const res = plan.validatePlan({ name: 'P', sheets: [{ name: 'S', rows, ...extra }] }, ctx);
  return { res, sheet: res.plan.sheets[0], dropped: res.dropped };
}
const typesOf = (sheet: any): string => (sheet.rows || []).map((r: any) => r.type).join(',');
const names = (list: any[]): string => list.map((x) => x.name || x.label || x.heading).join(',');
const xywh = (l: any): string => (l ? `${l.x},${l.y},${l.w},${l.h}` : 'none');
const line = (list: any[]): string => list.map(xywh).join(' | ');

/** A seeded PRNG (mulberry32) — the same stacks on every run and every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The layout checker ──────────────────────────────────────────────────────

/** Everything wrong with a set of placed tiles, taken together. */
function problems(tiles: Tile[]): string[] {
  const out: string[] = [];
  tiles.forEach((t, i) => {
    const onGrid = [t.x, t.y, t.w, t.h].every(Number.isInteger) && t.x >= 0 && t.y >= 0 && t.w >= 1 && t.h >= 1;
    if (!onGrid) out.push(`tile ${i} is not on the grid (${xywh(t)})`);
    if (t.x + t.w > 12) out.push(`tile ${i} runs past column 12 (${xywh(t)})`);
    if (t.kind === 'visual' && t.w < 6) out.push(`chart ${i} is narrower than 6 (${xywh(t)})`);
    for (let j = i + 1; j < tiles.length; j += 1) {
      const u = tiles[j];
      if (t.x < u.x + u.w && u.x < t.x + t.w && t.y < u.y + u.h && u.y < t.y + t.h) {
        out.push(`tiles ${i} and ${j} overlap (${xywh(t)} / ${xywh(u)})`);
      }
    }
  });
  return out;
}

const tilesOf = (at: At): Tile[] => [
  ...at.metrics.map((l) => ({ kind: 'metric', ...l })),
  ...at.visuals.map((l) => ({ kind: 'visual', ...l })),
  ...at.texts.map((l) => ({ kind: 'text', ...l })),
];

/** Row by row: each starts on a fresh grid row at x=0, directly under the one
 *  before, and every row but a KPI strip fills its band edge to edge. */
function bandProblems(rows: any[], at: At): string[] {
  const out: string[] = [];
  let m = 0;
  let v = 0;
  let t = 0;
  let floor = 0;
  rows.forEach((row, ri) => {
    const n = planRows.flattenRows([row]);
    const tiles = [
      ...at.metrics.slice(m, m + n.metrics.length),
      ...at.visuals.slice(v, v + n.visuals.length),
      ...at.texts.slice(t, t + n.texts.length),
    ];
    m += n.metrics.length;
    v += n.visuals.length;
    t += n.texts.length;
    const top = Math.min(...tiles.map((x) => x.y));
    const bottom = Math.max(...tiles.map((x) => x.y + x.h));
    if (top !== floor) out.push(`row ${ri} (${row.type}) starts at y=${top}, not ${floor}`);
    if (Math.min(...tiles.map((x) => x.x)) !== 0) out.push(`row ${ri} (${row.type}) does not start at x=0`);
    const area = tiles.reduce((sum, x) => sum + x.w * x.h, 0);
    if (row.type !== 'kpis' && area !== 12 * (bottom - top)) out.push(`row ${ri} (${row.type}) is not flush to 12 wide`);
    floor = bottom;
  });
  return out;
}

function checkTheChecker(): void {
  const good: Tile[] = [{ kind: 'visual', x: 0, y: 0, w: 8, h: 6 }, { kind: 'metric', x: 8, y: 0, w: 4, h: 3 }];
  ok('checker: a sound layout has no problems', problems(good).length === 0, problems(good).join('; '));
  // NEGATIVE CONTROLS. A checker that cannot fail proves nothing about 500 stacks.
  const overlap: Tile[] = [{ kind: 'visual', x: 0, y: 0, w: 8, h: 6 }, { kind: 'metric', x: 6, y: 2, w: 4, h: 3 }];
  ok('checker: a hand-made OVERLAP fails', problems(overlap).some((p) => p.includes('overlap')));
  ok('checker: a tile past column 12 fails',
    problems([{ kind: 'text', x: 8, y: 0, w: 6, h: 2 }]).some((p) => p.includes('past column 12')));
  ok('checker: a chart narrower than 6 fails',
    problems([{ kind: 'visual', x: 0, y: 0, w: 4, h: 6 }]).some((p) => p.includes('narrower')));
  const half: At = { metrics: [], visuals: [{ x: 0, y: 0, w: 6, h: 6 }], texts: [] };
  ok('checker: a row with a gap beside its chart fails',
    bandProblems([{ type: 'charts', visuals: [{}] }], half).some((p) => p.includes('not flush')));
  const sunk: At = { metrics: [], visuals: [], texts: [{ x: 0, y: 2, w: 12, h: 2 }] };
  ok('checker: a row that leaves a blank band above it fails',
    bandProblems([{ type: 'note', text: {} }], sunk).some((p) => p.includes('starts at')));
}

// ── §1 The degenerate rules ─────────────────────────────────────────────────
function checkRules(): void {
  ok('the vocabulary is the five rows of the plan',
    planRows.ROW_TYPES.join(',') === 'kpis,charts,spotlight,annotated,note', planRows.ROW_TYPES.join(','));

  {
    const { sheet, dropped } = validated(['nope', { type: 'hero', visuals: [V()] }, { type: 'charts', visuals: [V()] }]);
    ok('unknown: the good row is kept', typesOf(sheet) === 'charts', typesOf(sheet));
    ok('unknown: both bad rows are reported as rows',
      dropped.length === 2 && dropped.every((d) => d.kind === 'row'), JSON.stringify(dropped));
    ok('unknown: each says where it was',
      dropped[0]?.where === 'sheets[0].rows[0]' && dropped[1]?.where === 'sheets[0].rows[1]');
    ok('unknown: the message stands on its own — sheet, row, the type it did not know',
      !!dropped[1] && dropped[1].message.includes('Sheet "S" row 2') && dropped[1].message.includes('"hero"'),
      dropped[1]?.message);
  }
  {
    const { sheet, dropped } = validated([{ type: 'charts', visuals: [V('a'), V('b'), V('c'), V('d'), V('e')] }]);
    ok('charts: five visuals split into rows of two', typesOf(sheet) === 'charts,charts,charts'
      && sheet.rows!.map((r: any) => r.visuals.length).join(',') === '2,2,1', JSON.stringify(sheet.rows));
    ok('charts: the split keeps their order and loses none', names(sheet.visuals) === 'a,b,c,d,e' && dropped.length === 0);
  }
  {
    const { sheet, dropped } = validated([{ type: 'spotlight', visual: BAD_V, metrics: [M('a'), M('b')] }]);
    ok('spotlight: a dropped visual leaves its metrics as a kpis row',
      typesOf(sheet) === 'kpis' && names(sheet.metrics) === 'a,b', typesOf(sheet));
    ok('spotlight: the visual that went is still reported', dropped.length === 1 && dropped[0].kind === 'chartType');
  }
  {
    const { sheet } = validated([{ type: 'spotlight', visual: V('hero'), metrics: [M('a')] }]);
    ok('spotlight: one metric is a kpis row, then a charts row', typesOf(sheet) === 'kpis,charts', typesOf(sheet));
  }
  {
    const { sheet } = validated([{ type: 'spotlight', visual: V('hero'), metrics: [M('a'), M('b'), M('c'), M('d'), M('e')] }]);
    const rows: any[] = sheet.rows || [];
    ok('spotlight: three in the rail, the rest in a following kpis row',
      typesOf(sheet) === 'spotlight,kpis' && names(rows[0].metrics) === 'a,b,c' && names(rows[1].metrics) === 'd,e',
      JSON.stringify(rows));
    ok('spotlight: the flat metrics keep their order', names(sheet.metrics) === 'a,b,c,d,e');
  }
  {
    const { sheet } = validated([{ type: 'spotlight', visual: V('hero'), metrics: [] }]);
    ok('spotlight: no metrics at all is a charts row', typesOf(sheet) === 'charts', typesOf(sheet));
  }
  {
    const noVisual = validated([{ type: 'annotated', visual: BAD_V, text: T() }]);
    ok('annotated: without its visual it is a note', typesOf(noVisual.sheet) === 'note', typesOf(noVisual.sheet));
    const noText = validated([{ type: 'annotated', visual: V(), text: {} }]);
    ok('annotated: without its text it is a charts row', typesOf(noText.sheet) === 'charts', typesOf(noText.sheet));
  }
  {
    const { sheet, dropped } = validated([
      { type: 'kpis', metrics: [] }, { type: 'charts' }, { type: 'kpis', metrics: [BAD_M] }, { type: 'note', text: T() },
    ]);
    ok('empty: rows left with nothing are removed', typesOf(sheet) === 'note', typesOf(sheet));
    ok('empty: a row that held nothing is reported once, an item that failed is reported as itself',
      dropped.map((d) => d.kind).join(',') === 'row,row,encoding', JSON.stringify(dropped));
  }
  {
    const many = validated(Array.from({ length: 14 }, (_x, i) => ({ type: 'note', text: T('n' + i) })));
    ok('cap: at most twelve rows a sheet', many.sheet.rows!.length === 12 && many.sheet.texts.length === 12);
    ok('cap: the rows that went are reported', many.dropped.length === 1 && many.dropped[0].kind === 'row'
      && many.dropped[0].where === 'sheets[0].rows' && many.dropped[0].message.includes('Sheet "S"'), JSON.stringify(many.dropped));
    // The cap is on the rows that come OUT — a split must not get past it.
    const split = validated([{ type: 'charts', visuals: Array.from({ length: 30 }, (_x, i) => V('v' + i)) }]);
    ok('cap: it holds after a split too', split.sheet.rows!.length === 12 && split.sheet.visuals.length === 24);
  }
  {
    const flat = { metrics: [M('m')], visuals: [V('v')], texts: [T('t')] };
    const none = validated([{ type: 'hero' }, { type: 'charts', visuals: [BAD_V] }], flat);
    ok('fallback: rows that validate to nothing leave the flat arrays in charge',
      !('rows' in none.sheet) && names(none.sheet.metrics) === 'm' && names(none.sheet.visuals) === 'v'
      && names(none.sheet.texts) === 't', JSON.stringify(none.sheet));
    const some = validated([{ type: 'note', text: T('only') }], { visuals: [V('ignored'), BAD_V], metrics: [BAD_M] });
    ok('rows win: a sheet with rows does not read its own flat arrays',
      some.sheet.visuals.length === 0 && some.sheet.metrics.length === 0 && names(some.sheet.texts) === 'only');
    ok('rows win: so nothing in them is reported either', some.dropped.length === 0, JSON.stringify(some.dropped));
    const today = plan.validatePlan({ name: 'P', sheets: [{ name: 'S', ...flat }] }, CTX).plan.sheets[0];
    ok('no rows: a flat sheet validates as it always did, with no `rows` key',
      Object.keys(today).join(',') === 'name,metrics,visuals,texts' && isDeepStrictEqual(today, none.sheet),
      Object.keys(today).join(','));
  }
  {
    // What a model writes when it flattens the note, and when it mixes up
    // "visuals" with "visual". Neither is worth losing a tile over.
    const { sheet, dropped } = validated([
      { type: 'note', heading: 'H', text: 'Body.' }, { type: 'charts', visual: V('solo') },
    ]);
    const rows: any[] = sheet.rows || [];
    ok('tolerant: a note written flat is the note', typesOf(sheet) === 'note,charts'
      && isDeepStrictEqual(rows[0].text, { heading: 'H', text: 'Body.' }) && dropped.length === 0, JSON.stringify(sheet.rows));
    ok('tolerant: "visual" for "visuals" is one chart', names(rows[1]?.visuals || []) === 'solo');
  }
  {
    // A saved visual placed by name comes out as a PlannedVisual with a
    // placeholder encoding — the shape that has to survive the trip back.
    const saved = { id: '99999999-2222-4333-8444-555555555555', name: 'Saved', datasetId: CTX.datasets[0].id, chartType: 'bar' };
    const ctx = { ...CTX, visuals: [saved] };
    const { res, sheet } = validated([{ type: 'annotated', visual: { visual: 'Saved' }, text: T() }], {}, ctx);
    const again = plan.validatePlan(res.plan, ctx);
    ok('reference: a saved visual sits in a row by name', typesOf(sheet) === 'annotated' && sheet.visuals[0]?.visualId === saved.id);
    ok('reference: and that row validates to itself again', isDeepStrictEqual(again.plan, res.plan) && again.dropped.length === 0);
  }
  {
    const controls = [{ dataset: 'Sales', kind: 'dropdown', column: 'region', label: 'Region' }];
    const { sheet } = validated([{ type: 'note', text: T() }], { controls });
    ok('controls are not rows: a sheet with rows keeps its filter chips', sheet.controls?.length === 1);
  }
}

// ── §2 Flattening, idempotence and the geometry — over random stacks ────────

/** One raw row: any type (one in eight unknown or not an object), with more or
 *  fewer items than its type holds, a fifth of them invalid. */
function rawRow(r: () => number): unknown {
  const pick = (n: number): number => Math.floor(r() * n);
  const roll = r();
  if (roll < 0.05) return 'not a row';
  const type = roll < 0.12 ? 'hero' : planRows.ROW_TYPES[pick(planRows.ROW_TYPES.length)];
  const vs = Array.from({ length: pick(6) }, (_x, i) => (r() < 0.2 ? BAD_V : V('v' + i)));
  const ms = Array.from({ length: pick(7) }, (_x, i) => (r() < 0.2 ? BAD_M : M('m' + i)));
  const text = r() < 0.7 ? T() : r() < 0.5 ? {} : undefined;
  if (r() < 0.2) return { type, visuals: vs, metrics: ms, text }; // keys the type has no slot for
  if (type === 'kpis') return { type, metrics: ms };
  if (type === 'charts') return { type, visuals: vs };
  if (type === 'spotlight') return { type, visual: vs[0], metrics: ms };
  if (type === 'annotated') return { type, visual: vs[0], text };
  return { type, text };
}

function checkRandomStacks(): void {
  const r = prng(20261012);
  const bad = { geometry: [] as string[], bands: [] as string[], flat: [] as string[], twice: [] as string[], order: [] as string[] };
  let withRows = 0;
  const seen = new Set<string>();
  for (let n = 0; n < 500; n += 1) {
    const raw = Array.from({ length: Math.floor(r() * 16) }, () => rawRow(r));
    const { res, sheet } = validated(raw, { metrics: [M('flat')], visuals: [V('flat')] });
    const rows: any[] = sheet.rows || [];
    if (rows.length) withRows += 1;
    for (const row of rows) seen.add(row.type);

    // The flat arrays ARE the rows, flattened, in row order — the same objects.
    const flat = planRows.flattenRows(rows);
    const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    if (rows.length && !(same(flat.metrics, sheet.metrics) && same(flat.visuals, sheet.visuals) && same(flat.texts, sheet.texts))) {
      bad.flat.push(`stack ${n}`);
    }
    if (rows.length > 12) bad.flat.push(`stack ${n}: ${rows.length} rows`);

    // validatePlan accepts its own output and returns the same plan, nothing dropped.
    const again = plan.validatePlan(res.plan, CTX);
    if (!isDeepStrictEqual(again.plan, res.plan) || again.dropped.length) bad.twice.push(`stack ${n}`);

    const at = planLayout.arrangeSheet(sheet);
    const aligned = at.metrics.length === sheet.metrics.length && at.visuals.length === sheet.visuals.length
      && at.texts.length === sheet.texts.length;
    if (!aligned) bad.geometry.push(`stack ${n}: layouts do not line up with the flat arrays`);
    for (const p of problems(tilesOf(at))) bad.geometry.push(`stack ${n}: ${p}`);
    for (const p of bandProblems(rows, at)) bad.bands.push(`stack ${n}: ${p}`);

    // Reading order: top to bottom, left to right — and within a kind that is
    // the flat array's own order, which is what lets a reader of the preview's
    // `layout` tie its n-th visual to `visuals[n]`.
    const read = planLayout.readingOrder(at);
    const sorted = read.every((x, i) => i === 0 || read[i - 1].y < x.y || (read[i - 1].y === x.y && read[i - 1].x < x.x));
    const kind = (k: string): string => line(read.filter((x) => x.kind === k));
    if (!sorted || kind('metric') !== line(at.metrics) || kind('visual') !== line(at.visuals) || kind('text') !== line(at.texts)) {
      bad.order.push(`stack ${n}`);
    }
  }
  ok('random stacks: most of the 500 kept rows, and every row type came up',
    withRows > 400 && seen.size === planRows.ROW_TYPES.length, `${withRows} with rows, ${Array.from(seen).join(',')}`);
  ok('random stacks: no overlap, nothing past column 12, no chart narrower than 6', bad.geometry.length === 0, bad.geometry[0]);
  ok('random stacks: every row starts fresh at x=0 and all but kpis are flush to 12', bad.bands.length === 0, bad.bands[0]);
  ok('random stacks: the flat arrays are the rows flattened, same objects, at most 12 rows', bad.flat.length === 0, bad.flat[0]);
  ok('random stacks: validatePlan(validatePlan(x).plan) is the same plan', bad.twice.length === 0, bad.twice[0]);
  ok('random stacks: reading order is sorted, and is the flat order within a kind', bad.order.length === 0, bad.order[0]);
}

/** Rows that never met the validator: typed, but with any number of anything,
 *  slots missing, nulls. arrangeSheet is handed these by whoever builds a sheet
 *  in code, and "never throws, never overlaps" has to hold for them too. */
function checkDegenerateTyped(): void {
  const r = prng(7);
  const pick = (n: number): number => Math.floor(r() * n);
  const things = (n: number): any[] => Array.from({ length: n }, () => ({}));
  const bad: string[] = [];
  for (let n = 0; n < 300; n += 1) {
    const rows: any[] = Array.from({ length: pick(16) }, () => {
      const type = ['kpis', 'charts', 'spotlight', 'annotated', 'note', 'hero'][pick(6)];
      if (r() < 0.05) return null;
      return {
        type,
        ...(r() < 0.6 ? { metrics: things(pick(10)) } : {}),
        ...(r() < 0.4 ? { visuals: things(pick(6)) } : r() < 0.5 ? { visual: {} } : {}),
        ...(r() < 0.5 ? { text: {} } : {}),
      };
    });
    try {
      const flat = planRows.flattenRows(rows);
      const at = planLayout.arrangeSheet({ ...flat, rows });
      if (at.metrics.length !== flat.metrics.length || at.visuals.length !== flat.visuals.length
        || at.texts.length !== flat.texts.length) bad.push(`stack ${n}: layouts do not line up`);
      for (const p of problems(tilesOf(at))) bad.push(`stack ${n}: ${p}`);
    } catch (err: any) {
      bad.push(`stack ${n} threw: ${err?.message}`);
    }
  }
  ok('degenerate typed rows: never throws, never overlaps, never leaves the grid', bad.length === 0, bad[0]);

  // Rows that do not account for the sheet's tiles are not an arrangement of it.
  const lying = planLayout.arrangeSheet({ metrics: things(1), visuals: things(3), texts: [], rows: [{ type: 'charts', visuals: things(1) }] } as any);
  ok('rows that disagree with the flat arrays are ignored, not half-applied',
    isDeepStrictEqual(lying, referenceFlat(1, 3, 0)), line(lying.visuals));
  ok('rows that are not a list do not throw',
    isDeepStrictEqual(planLayout.arrangeSheet({ metrics: [], visuals: things(1), texts: [], rows: {} } as any), referenceFlat(0, 1, 0)));
}

// ── §3 A flat sheet's geometry is unchanged ─────────────────────────────────

/**
 * THE REFERENCE: the builder's geometry before rows existed — the packer and
 * the three loops of planBuild.buildPlanRecords, verbatim, counting tiles
 * instead of saving them. Not to be "kept in step" with planLayout.ts: it is
 * what planLayout.ts has to keep agreeing with.
 */
function referenceFlat(nMetrics: number, nVisuals: number, nTexts: number): At {
  const GRID_COLS = 12;
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  const place = (w: number, h: number) => {
    if (cx + w > GRID_COLS) { cx = 0; cy += rowH; rowH = 0; }
    const layout = { x: cx, y: cy, w, h };
    cx += w;
    if (h > rowH) rowH = h;
    return layout;
  };
  const newRow = (): void => { if (cx > 0) { cx = 0; cy += rowH; rowH = 0; } };
  const at: At = { metrics: [], visuals: [], texts: [] };
  for (let i = 0; i < nMetrics; i += 1) at.metrics.push(place(3, 2));
  newRow();
  const chartW = nVisuals > 1 ? GRID_COLS / 2 : GRID_COLS;
  for (let i = 0; i < nVisuals; i += 1) at.visuals.push(place(chartW, 6));
  newRow();
  for (let i = 0; i < nTexts; i += 1) at.texts.push(place(GRID_COLS, 2));
  return at;
}

function checkGeometry(): void {
  const things = (n: number): any[] => Array.from({ length: n }, () => ({}));
  const differs: string[] = [];
  for (let m = 0; m <= 9; m += 1) {
    for (let v = 0; v <= 7; v += 1) {
      for (let t = 0; t <= 3; t += 1) {
        const got = planLayout.arrangeSheet({ metrics: things(m), visuals: things(v), texts: things(t) });
        if (!isDeepStrictEqual(got, referenceFlat(m, v, t))) differs.push(`${m} metrics, ${v} visuals, ${t} texts`);
      }
    }
  }
  ok('flat: every sheet up to 9 KPIs, 7 charts and 3 notes is placed exactly as before', differs.length === 0, differs[0]);
  ok('flat: three charts are still two-up and wrap (the line test-analysisPlan pins)',
    line(planLayout.arrangeSheet({ metrics: [], visuals: things(3), texts: [] }).visuals) === '0,0,6,6 | 6,0,6,6 | 0,6,6,6');

  // Each row type, to the cell.
  const { sheet } = validated([
    { type: 'charts', visuals: [V()] },
    { type: 'charts', visuals: [V(), V()] },
    { type: 'spotlight', visual: V(), metrics: [M(), M()] },
    { type: 'spotlight', visual: V(), metrics: [M(), M(), M()] },
    { type: 'annotated', visual: V(), text: T() },
    { type: 'kpis', metrics: [M(), M(), M(), M(), M()] },
    { type: 'note', text: T() },
  ]);
  const at = planLayout.arrangeSheet(sheet);
  ok('rows: one chart is 12 wide, two are 6 each; a spotlight and an annotated chart are 8',
    line(at.visuals) === '0,0,12,6 | 0,6,6,6 | 6,6,6,6 | 0,12,8,6 | 0,18,8,6 | 0,24,8,6', line(at.visuals));
  ok('rows: a rail of two is 4x3 each, of three 4x2 each; a kpis strip is 3x2 and wraps after four',
    line(at.metrics) === '8,12,4,3 | 8,15,4,3 | 8,18,4,2 | 8,20,4,2 | 8,22,4,2 | '
      + '0,30,3,2 | 3,30,3,2 | 6,30,3,2 | 9,30,3,2 | 0,32,3,2', line(at.metrics));
  ok('rows: the note beside a chart is 4x6, a note of its own 12x2',
    line(at.texts) === '8,24,4,6 | 0,34,12,2', line(at.texts));
}

// ── §4 The prompt names what the parser accepts ─────────────────────────────
function checkPrompt(): void {
  const prompt = plan.DRAFT_DASHBOARD_SYSTEM_PROMPT;
  for (const id of planRows.ROW_TYPES) ok(`prompt: describes the "${id}" row`, prompt.includes(`"type":"${id}"`));
  ok('prompt: (control) a row type that does not exist is not described', !prompt.includes('"type":"hero"'));
  ok('prompt: a sheet is written as rows and controls', prompt.includes('"rows"') && prompt.includes('"controls"'));

  ok('the control kinds under test are the validator\'s own', planControls.CONTROL_KINDS.size === 3,
    Array.from(planControls.CONTROL_KINDS).join(','));
  for (const kind of planControls.CONTROL_KINDS) {
    ok(`prompt: names the "${kind}" control`, prompt.includes(kind));
    const { sheet } = validated([{ type: 'note', text: T() }], { controls: [{ dataset: 'Sales', kind, column: 'region' }] });
    ok(`prompt: and "${kind}" is a control the validator keeps`, sheet.controls?.[0]?.kind === kind);
  }
  ok('prompt: (control) a kind the plan may not use is not offered', !prompt.includes('radius'));

  // The chart-variety guidance names chart types. Each must be one the app draws.
  for (const type of ['donut', 'bullet', 'gauge', 'bar', 'line', 'area', 'table']) {
    ok(`prompt: suggests "${type}", which is a real chart type`, prompt.includes(type) && plan.CHART_TYPE_IDS.has(type));
  }
  ok('prompt: still forbids positions and sizes', prompt.includes('Do NOT specify positions or sizes'));
  ok('prompt: still forbids a computed value', prompt.includes('NEVER output a computed value'));
}

// ── §5 Preview, build and the draft — against real records ──────────────────

let projectId = '';
let salesId = '';

async function setup(): Promise<void> {
  const p = await projects.createProject('Rows project');
  if (!p) throw new Error('createProject failed');
  projectId = p.id;
  const ds = await datasets.saveDataset(projectId, {
    name: 'Sales', sourceKind: 'csv', columns: COLS,
    rows: [['West', 100, 60], ['West', 250, 90], ['East', 175, 100], ['East', 25, 5], ['North', 400, 310]],
  });
  if (!ds) throw new Error('saveDataset failed');
  salesId = ds.id;
}

const ENVELOPE = {
  name: 'Rows',
  sheets: [
    {
      name: 'Story',
      controls: [{ dataset: 'Sales', kind: 'dropdown', column: 'region', label: 'Region' }],
      rows: [
        { type: 'note', text: T('Intro') },
        { type: 'spotlight', visual: V('Hero'), metrics: [M('A'), M('B')] },
        { type: 'charts', visuals: [V('Left'), V('Right')] },
        { type: 'kpis', metrics: [M('C')] },
      ],
    },
    { name: 'Flat', metrics: [M('D')], visuals: [V('One')] },
  ],
};

async function checkPreviewAndBuild(): Promise<void> {
  const preview = await planPreview.previewPlan(projectId, ENVELOPE);
  ok('preview: nothing dropped', preview.dropped.length === 0, JSON.stringify(preview.dropped));
  const shown = (i: number): string => preview.sheets[i].layout.map((t) => `${t.kind}@${xywh(t)}`).join(' ');
  ok('preview: a sheet carries its layout in reading order, each tile with its kind',
    shown(0) === 'text@0,0,12,2 visual@0,2,8,6 metric@8,2,4,3 metric@8,5,4,3 visual@0,8,6,6 visual@6,8,6,6 metric@0,14,3,2', shown(0));
  ok('preview: a flat sheet carries the layout it always had', shown(1) === 'metric@0,0,3,2 visual@0,2,12,6', shown(1));
  ok('preview: the flat arrays still read as before', names(preview.sheets[0].metrics) === 'A,B,C'
    && names(preview.sheets[0].visuals) === 'Hero,Left,Right' && names(preview.sheets[0].texts) === 'Intro');

  // What buildPlan HANDS the store is spied on: saveAnalysis switches a new
  // sheet on by itself, and a draft must not be on only by that default.
  const realSaveAnalysis = analysisStore.saveAnalysis;
  let handed: any[] = [];
  (analysisStore as any).saveAnalysis = async (pid: string, input: any) => {
    handed = input.sheets;
    return realSaveAnalysis(pid, input);
  };
  let built: Awaited<ReturnType<typeof planBuild.buildPlan>>;
  try {
    built = await planBuild.buildPlan(projectId, preview.plan);
  } finally {
    (analysisStore as any).saveAnalysis = realSaveAnalysis;
  }
  ok('build: succeeded', built.ok === true);
  if (!built.ok) return;
  const [story, flat] = built.analysis.sheets as any[];
  ok('build: buildPlan itself asks for click-to-filter on every sheet',
    handed.length === 2 && handed.every((s) => s.clickFilter === true), JSON.stringify(handed.map((s) => s.clickFilter)));
  ok('build: and it is on for every sheet of the saved dashboard',
    built.analysis.sheets.length === 2 && built.analysis.sheets.every((s) => s.clickFilter === true));

  // The ORDER of the cards is not the arrangement: controls, metrics, visuals,
  // texts, each in flat order — planExec.runDashboard ties KPI cards to metrics by it.
  ok('build: cards are still controls, then metrics, then visuals, then texts',
    story.cards.map((c: any) => c.type).join(',') === 'control,metric,metric,metric,visual,visual,visual,text',
    story.cards.map((c: any) => c.type).join(','));
  const of = (type: string): any[] => story.cards.filter((c: any) => c.type === type);
  ok('build: metrics in flat order', of('metric').map((c) => c.metric.label).join(',') === 'A,B,C');
  const builtNames: string[] = [];
  for (const c of of('visual')) builtNames.push((await visuals.getVisual(projectId, c.visualId))?.name || '?');
  ok('build: visuals in flat order', builtNames.join(',') === 'Hero,Left,Right', builtNames.join(','));

  // Only the layouts carry the arrangement — and they are the previewed ones.
  const at = planLayout.arrangeSheet(preview.plan.sheets[0]);
  ok('build: the layouts are the arrangement the preview showed',
    line(of('metric').map((c) => c.layout)) === line(at.metrics) && line(of('visual').map((c) => c.layout)) === line(at.visuals)
    && line(of('text').map((c) => c.layout)) === line(at.texts), line(story.cards.map((c: any) => c.layout)));
  ok('build: to the cell', line(of('visual').map((c) => c.layout)) === '0,2,8,6 | 0,8,6,6 | 6,8,6,6'
    && line(of('metric').map((c) => c.layout)) === '8,2,4,3 | 8,5,4,3 | 0,14,3,2' && line(of('text').map((c) => c.layout)) === '0,0,12,2');
  ok('build: a flat sheet is built exactly as before',
    flat.cards.map((c: any) => `${c.type}@${xywh(c.layout)}`).join(' ') === 'metric@0,0,3,2 visual@0,2,12,6');

  // A chart whose save FAILS is not on the sheet, and the row it was in must
  // not keep a hole for it: the arrangement is computed over what survived.
  const realSave = visuals.saveVisual;
  (visuals as any).saveVisual = async (pid: string, input: any) => (input.name === 'Hero' ? null : realSave(pid, input));
  let records: Awaited<ReturnType<typeof planBuild.buildPlanRecords>>;
  try {
    records = await planBuild.buildPlanRecords(projectId, preview.plan);
  } finally {
    (visuals as any).saveVisual = realSave;
  }
  const cards = records.sheets[0].cards as any[];
  const tiles = cards.filter((c) => c.type !== 'control').map((c) => ({ kind: c.type, ...c.layout }));
  ok('failed save: the chart is gone and the rest is all there',
    cards.map((c) => c.type).join(',') === 'control,metric,metric,metric,visual,visual,text');
  ok('failed save: its spotlight became a kpis row — no hole, no overlap',
    problems(tiles).length === 0
    && line(tiles) === '0,2,3,2 | 3,2,3,2 | 0,10,3,2 | 0,4,6,6 | 6,4,6,6 | 0,0,12,2', line(tiles));
}

// `withInsightCharts` is private to src/ipc/analyses.ts, so it is driven through
// the real `draftAnalysisPlan` with the model call and the insight scan stubbed.
async function checkInsightCharts(): Promise<void> {
  const realDraft = analyze.draftDashboard;
  const realList = ipcInsights.listInsights;
  const insight = (title: string): any => ({
    id: title, datasetId: salesId, title,
    chart: { type: 'line', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
  });
  const draftOf = (sheet: unknown): void => {
    (analyze as any).draftDashboard = async () => ({ ok: true, structure: { name: 'D', sheets: [sheet] } });
  };
  (ipcInsights as any).listInsights = async () => [insight('I1'), insight('I2'), insight('I3')];
  try {
    draftOf({ name: 'S', rows: [{ type: 'note', text: T('Mine') }] });
    const rows = await analysesIpc.draftAnalysisPlan(projectId, { intent: 'what changed last month' });
    const sheet = rows.plan?.sheets?.[0] || {};
    ok('insights: a sheet written as rows gets its insight charts as charts rows, two to a row',
      typesOf(sheet) === 'note,charts,charts' && names(sheet.rows[1].visuals) === 'I1,I2' && names(sheet.rows[2].visuals) === 'I3',
      JSON.stringify(sheet.rows || rows));
    ok('insights: nothing the model wrote was pushed out', names(sheet.texts || []) === 'Mine' && rows.dropped?.length === 0);

    draftOf({ name: 'S', visuals: [V('Mine')] });
    const flat = await analysesIpc.draftAnalysisPlan(projectId, { intent: 'what changed last month' });
    const flatSheet = flat.plan?.sheets?.[0] || {};
    ok('insights: a flat sheet gets them on `visuals`, exactly as before',
      !('rows' in flatSheet) && names(flatSheet.visuals || []) === 'Mine,I1,I2,I3', JSON.stringify(flatSheet));

    const quiet = await analysesIpc.draftAnalysisPlan(projectId, { intent: 'a sales overview' });
    ok('insights: an ask that is not about change gets none', names(quiet.plan?.sheets?.[0]?.visuals || []) === 'Mine');
  } finally {
    (analyze as any).draftDashboard = realDraft;
    (ipcInsights as any).listInsights = realList;
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  checkTheChecker();
  checkRules();
  checkRandomStacks();
  checkDegenerateTyped();
  checkGeometry();
  checkPrompt();

  ipcVisuals.register();
  await projects.init();
  await datasets.init();
  await visuals.init();
  await analysisStore.init();
  await setup();
  await checkPreviewAndBuild();
  await checkInsightCharts();

  if (failureCount()) console.error('\n' + failureCount() + ' plan-rows check(s) FAILED');
  else console.log('\nAll plan-rows checks passed.');
  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});
