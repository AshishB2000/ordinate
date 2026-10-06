// Project-wide category colours: the dealing rule (src/analysis/colorMap.ts),
// the same rule the renderer runs from its cache, so both must agree exactly.
//
//   · determinism — the same map and values always deal the same slots;
//   · a value keeps its slot, and the map keeps its order, whatever order a
//     later chart draws in;
//   · past eight values the slots cycle by count;
//   · persistence ACROSS charts — two charts over one column, drawing in
//     different orders and subsets, give every shared value one colour;
//   · the sanitizer drops junk (bad tokens, over-long keys, over the caps,
//     prototype keys) and never throws.
//
//   npm run build:ts && node scripts/test-colorMap.js

export {};
import { ok, failureCount, finish } from './selfcheck';
import * as cm from '../src/analysis/colorMap';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── Determinism ─────────────────────────────────────────────────────────────
const vals = ['Technology', 'Furniture', 'Office Supplies'];
const a1 = cm.assignColors(null, vals);
const a2 = cm.assignColors(null, vals);
ok('the same values deal the same map', same(a1.colors, a2.colors) && same(a1.tokens, a2.tokens));
ok('a fresh column deals slots 1, 2, 3 in draw order',
  same(a1.tokens, ['chart-1', 'chart-2', 'chart-3']), JSON.stringify(a1.tokens));
ok('…and says it changed', a1.changed === true);
const again = cm.assignColors(a1.colors, vals);
ok('dealing values already in the map changes nothing', again.changed === false && same(again.colors, a1.colors));
ok('assignColors never mutates the map it is given', Object.keys(a1.colors).length === 3
  && (cm.assignColors(a1.colors, ['New']), Object.keys(a1.colors).length === 3));

// ── Existing entries keep their slot and their order ──────────────────────
const reordered = cm.assignColors(a1.colors, ['Office Supplies', 'Appliances', 'Technology']);
ok('an existing value keeps its slot whatever order it is drawn in',
  reordered.tokens[0] === 'chart-3' && reordered.tokens[2] === 'chart-1', JSON.stringify(reordered.tokens));
ok('a new value takes the lowest free slot', reordered.tokens[1] === 'chart-4');
ok('the stored order is the order values were first dealt',
  same(Object.keys(reordered.colors), ['Technology', 'Furniture', 'Office Supplies', 'Appliances']));
// A hand-set colour leaves a gap below it: the next deal fills the gap first.
const gap = cm.setColor(cm.setColor(null, 'A', 'chart-1'), 'B', 'chart-3');
ok('with slots 1 and 3 held, the next value gets slot 2', cm.assignColors(gap, ['C']).tokens[0] === 'chart-2');

// ── More than eight values cycle by count ─────────────────────────────────
const twelve = Array.from({ length: 12 }, (_, i) => 'v' + i);
const cyc = cm.assignColors(null, twelve);
ok('the first eight values take the eight slots', same(cyc.tokens.slice(0, 8), cm.COLOR_TOKENS));
ok('the ninth wraps to slot 1, then 2, 3, 4',
  same(cyc.tokens.slice(8), ['chart-1', 'chart-2', 'chart-3', 'chart-4']), JSON.stringify(cyc.tokens.slice(8)));
ok('cycling is deterministic too', same(cm.assignColors(null, twelve).tokens, cyc.tokens));
// …and in chunks, as values arrive across draws, it lands in the same place.
const chunked = cm.assignColors(cm.assignColors(null, twelve.slice(0, 5)).colors, twelve);
ok('dealing 5 then 12 gives the same slots as dealing 12 at once', same(chunked.tokens, cyc.tokens));

// ── Persistence across two charts over one column ─────────────────────────
// A project's map, as main stores it: chart A (a donut, natural order) draws,
// its deal is persisted; chart B (a pie of another measure, sorted by value,
// with a category A never had) draws against the STORED map.
let project: cm.ColorMap = cm.sanitizeColorMap(null);
const drawChart = (column: string, labels: string[]): (string | null)[] => {
  const d = cm.assignColors(project[column], labels);
  if (d.changed) project = cm.sanitizeColorMap({ ...project, [column]: d.colors });
  return d.tokens;
};
const chartA = drawChart('region', ['East', 'West', 'North', 'South']);
const chartB = drawChart('region', ['South', 'Central', 'East']);
const colourOf = (labels: string[], toks: (string | null)[], v: string) => toks[labels.indexOf(v)];
ok('chart B paints South in chart A\'s colour',
  colourOf(['South', 'Central', 'East'], chartB, 'South') === colourOf(['East', 'West', 'North', 'South'], chartA, 'South'));
ok('…and East', colourOf(['South', 'Central', 'East'], chartB, 'East') === chartA[0]);
ok('…and deals its new value the next free slot', colourOf(['South', 'Central', 'East'], chartB, 'Central') === 'chart-5');
// A second column is independent: its values start from slot 1.
ok('another column deals from slot 1 again', drawChart('segment', ['Consumer'])[0] === 'chart-1');
ok('…and the first column is untouched', project.region.East === 'chart-1' && Object.keys(project.region).length === 5);
// The renderer's cache is dealt the same way, so its answer IS main's.
ok('a stale cache dealing the same values reaches the same map',
  same(cm.assignColors(cm.sanitizeColorMap({ region: { East: 'chart-1', West: 'chart-2', North: 'chart-3', South: 'chart-4' } }).region,
    ['South', 'Central', 'East']).colors, project.region));

// ── Apply palette / reset / set ────────────────────────────────────────────
ok('applyPalette re-deals from slot 1 in the given order',
  same(cm.applyPalette(['South', 'East']), { South: 'chart-1', East: 'chart-2' }));
ok('setColor pins one value', cm.setColor(project.region, 'East', 'chart-8').East === 'chart-8');
ok('setColor with null forgets it', !('East' in cm.setColor(project.region, 'East', null)));
ok('a token off the ramp forgets the value rather than storing it', cm.setColor(project.region, 'East', '#ff0000').East === undefined);
ok('sameColumn compares order and slots', cm.sameColumn({ a: 'chart-1', b: 'chart-2' }, { a: 'chart-1', b: 'chart-2' })
  && !cm.sameColumn({ a: 'chart-1', b: 'chart-2' }, { b: 'chart-2', a: 'chart-1' }));

// Keys: numbers colour by their text, null and objects are never stored.
const keyed = cm.assignColors(null, [2023, '2023', null, { x: 1 }, 'x'.repeat(cm.MAX_COLOR_KEY + 1)]);
ok('2023 and "2023" are one value', keyed.tokens[0] === keyed.tokens[1] && Object.keys(keyed.colors).length === 1);
ok('null, objects and over-long values are not dealt',
  keyed.tokens[2] === null && keyed.tokens[3] === null && keyed.tokens[4] === null);

// The per-column cap: past it a value is drawn by position and not stored.
const many = Array.from({ length: cm.MAX_COLOR_VALUES + 5 }, (_, i) => 'k' + i);
const capped = cm.assignColors(null, many);
ok('a column stores at most MAX_COLOR_VALUES values', Object.keys(capped.colors).length === cm.MAX_COLOR_VALUES);
ok('…and the values past the cap come back unassigned', capped.tokens.slice(cm.MAX_COLOR_VALUES).every((t) => t === null));

// ── The sanitizer ──────────────────────────────────────────────────────────
const dirty = JSON.parse(JSON.stringify({
  region: { East: 'chart-1', West: '#ff0000', North: 'chart-9', South: 3, Central: 'chart-8' },
  '': { a: 'chart-1' },
  empty: {},
  list: ['chart-1'],
  junk: 'chart-2',
  ['y'.repeat(cm.MAX_COLOR_KEY + 1)]: { a: 'chart-1' },
}));
// JSON.parse makes "__proto__" an OWN key, which is exactly what a hostile file does.
const hostile = JSON.parse('{"__proto__": {"polluted": "chart-1"}, "ok": {"__proto__": "chart-2", "v": "chart-3"}}');
const clean = cm.sanitizeColorMap(dirty);
ok('bad tokens are dropped, good ones kept', same(clean.region, { East: 'chart-1', Central: 'chart-8' }), JSON.stringify(clean.region));
ok('empty, unnamed, over-long and non-object columns are dropped', same(Object.keys(clean), ['region']), JSON.stringify(Object.keys(clean)));
const cleanHostile = cm.sanitizeColorMap(hostile);
ok('a "__proto__" column is stored as data, never as a prototype',
  Object.getPrototypeOf(cleanHostile) === null && ({} as any).polluted === undefined);
ok('…and a "__proto__" value too', cleanHostile.ok && cleanHostile.ok.v === 'chart-3'
  && Object.getPrototypeOf(cleanHostile.ok) === null);
for (const junk of [null, undefined, 42, 'x', [], [1, 2], true]) {
  let threw = false;
  let out: unknown = null;
  try { out = cm.sanitizeColorMap(junk); } catch (_) { threw = true; }
  ok(`sanitizeColorMap(${JSON.stringify(junk)}) is an empty map, never a throw`, !threw && same(out, {}));
}
const wide: Record<string, Record<string, string>> = {};
for (let i = 0; i < cm.MAX_COLOR_COLUMNS + 10; i++) wide['c' + i] = { v: 'chart-1' };
ok('at most MAX_COLOR_COLUMNS columns survive', Object.keys(cm.sanitizeColorMap(wide)).length === cm.MAX_COLOR_COLUMNS);
ok('a sanitized map round-trips through JSON unchanged',
  same(cm.sanitizeColorMap(JSON.parse(JSON.stringify(clean))), clean));

// ── Through main: the project record and the format IPC ─────────────────────
// The real projects.ts and ipc/format.ts over a temp userData, set the way
// scripts/test-visuals.ts does; the handlers land in the RPC
// registry, so each channel is called exactly as the renderer's invoke is.
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-colormap-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (e: unknown, arg: any) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
require('../src/ipc/format').register();
const call = (name: string, arg: any) => handlers.get('format:colors:' + name)!(null, arg);

async function main(): Promise<void> {
  await projects.init();
  const p = await projects.createProject('Colours');
  // Three charts on one dashboard deal at once — two over region, one over
  // segment. Every deal is a read-modify-write of project.json; unserialized,
  // the last writer would drop the others' columns.
  const [r1, , r3] = await Promise.all([
    call('assign', { projectId: p.id, column: 'region', values: ['East', 'West'] }),
    call('assign', { projectId: p.id, column: 'segment', values: ['Consumer'] }),
    call('assign', { projectId: p.id, column: 'region', values: ['South', 'East'] }),
  ]);
  const stored = (await projects.getProject(p.id))!.colorMap || {};
  ok('overlapping deals for two columns both reach the project record',
    same(stored, { region: { East: 'chart-1', West: 'chart-2', South: 'chart-3' }, segment: { Consumer: 'chart-1' } }),
    JSON.stringify(stored));
  ok('a deal answers with the STORED column', r1.changed === true && same(r3.colors, stored.region));
  const r4 = await call('assign', { projectId: p.id, column: 'region', values: ['West', 'East'] });
  ok('a deal of known values writes nothing', r4.changed === false);

  // The map survives the project's other writes (they spread the normalized record).
  await projects.renameProject(p.id, 'Renamed');
  await projects.touchOpened(p.id);
  await projects.setArchived(p.id, false);
  ok('rename, open and archive keep the colour map',
    same((await projects.getProject(p.id))!.colorMap, stored));
  ok('projects:open hands the map to the renderer with the record',
    same((await projects.listProjects()).find((x) => x.id === p.id)!.colorMap, stored));

  const set = await call('set', { projectId: p.id, column: 'region', value: 'West', token: 'chart-7' });
  ok('set pins a value', set.colors.West === 'chart-7' && (await projects.getProject(p.id))!.colorMap!.region.West === 'chart-7');
  const pal = await call('palette', { projectId: p.id, column: 'region', values: ['South', 'West', 'East'] });
  ok('Apply palette re-deals in the given order', same(pal.colors, { South: 'chart-1', West: 'chart-2', East: 'chart-3' }));
  await call('reset', { projectId: p.id, column: 'region' });
  const afterReset = (await projects.getProject(p.id))!.colorMap || {};
  ok('Reset removes the column and leaves the others', !('region' in afterReset) && afterReset.segment.Consumer === 'chart-1');
  await call('reset', { projectId: p.id, column: 'segment' });
  ok('an empty map is not written at all', !('colorMap' in (await projects.getProject(p.id))!));

  // Untrusted input: a bad project id, a bad column, junk values.
  ok('an id that is not a UUID is refused', (await call('assign', { projectId: '../x', column: 'region', values: ['a'] })) === null);
  ok('a missing column name is refused', (await call('assign', { projectId: p.id, column: '', values: ['a'] })) === null);
  ok('a non-list of values deals nothing', (await call('assign', { projectId: p.id, column: 'c', values: 'abc' })).changed === false);
  ok('get of an unknown project is an empty map', same(await call('get', { projectId: 'nope' }), {}));

  // A hand-edited project.json is sanitized on read, never trusted.
  const file = path.join(tmpUserData, 'projects', p.id, 'project.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.colorMap = { region: { East: 'chart-2', West: 'url(evil)' }, bad: 'x' };
  fs.writeFileSync(file, JSON.stringify(raw));
  ok('a corrupt map on disk reads back clean',
    same((await projects.getProject(p.id))!.colorMap, { region: { East: 'chart-2' } }));
  ok('…and the next deal carries on from it',
    (await call('assign', { projectId: p.id, column: 'region', values: ['North'] })).colors.North === 'chart-1');

  fs.rmSync(tmpUserData, { recursive: true, force: true });
}

main().then(() => {
  finish();
  if (failureCount()) process.exit(1);
}).catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
