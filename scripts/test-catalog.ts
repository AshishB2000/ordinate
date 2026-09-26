// Self-check for the catalog — src/app/catalog.ts (the store) and
// src/app/catalogIndex.ts (the cross-record reads).
//
// Same harness as test-reportSpec.ts: stub 'electron' through Module._load so
// userData is a throwaway dir, then run the REAL modules against real disk.
//
// What is pinned, and why each one matters:
//   1. TAG NORMALISATION — '#Sales Q3' and 'sales-q3' must be one tag, or a
//      filter silently misses half the records.
//   2. COLOUR ASSIGNMENT — first free slot, STORED, stable across a reload, and
//      cycling once all eight are taken. A tag that changed colour when another
//      was added would make every chip in the app unreliable.
//   3. SEARCH BY TAG — exact match, prefix as a bonus, unknown → nothing.
//   4. THE STORE — round trip, updatedBy stamped in main, a corrupt file reads
//      as empty, a bad ref or id is refused, `__proto__` is just a tag.
//   5. STALE — scheduled and >30 days only; unscheduled is never stale.
//   6. SENSITIVITY — a report over a dataset with a financial column says so on
//      its cover, and the exported tile data STILL carries that column's values.
//
//   npm run build:ts && node scripts/test-catalog.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-catalog-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData }, net: {} };
  return origLoad.apply(this, [request, ...rest]);
};

const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const index: typeof import('../src/app/catalogIndex') = require('../src/app/catalogIndex');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const { buildVizData }: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { sanitizeBundle }: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');
const { tileCaption }: typeof import('../src/analysis/captions') = require('../src/analysis/captions');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  // ── 1. tag normalisation ───────────────────────────────────────────────────
  const table: Array<[unknown, string]> = [
    ['sales', 'sales'],
    ['#Sales', 'sales'],
    ['  ##Sales  ', 'sales'],
    ['Sales Q3', 'sales-q3'],
    ['sales   q3\tna', 'sales-q3-na'],
    ['Café & Co!', 'caf--co'],
    ['under_score-ok', 'under_score-ok'],
    ['#', ''],
    ['   ', ''],
    ['x'.repeat(40), 'x'.repeat(32)],
    [42, ''],
    [null, ''],
  ];
  for (const [input, want] of table) {
    const got = catalog.normalizeTag(input);
    ok(`normalizeTag(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, got === want, got);
  }
  ok('normalizeTags: dedupes after normalising, keeps first-seen order',
    catalog.normalizeTags(['#Sales', 'EMEA', 'sales', ' emea ', '', '#']).join(',') === 'sales,emea',
    catalog.normalizeTags(['#Sales', 'EMEA', 'sales', ' emea ']).join(','));
  ok('normalizeTags: caps at 12 per record',
    catalog.normalizeTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length === 12);
  ok('normalizeTags: a comma string splits', catalog.normalizeTags('a, #B ,c').join(',') === 'a,b,c');
  ok('normalizeTags: garbage is no tags', catalog.normalizeTags({ nope: 1 }).length === 0);

  // ── 2. colour assignment (pure) ────────────────────────────────────────────
  const tags: Record<string, { color: number }> = {};
  ok('the first tag gets colour 0', catalog.pickTagColor(tags) === 0);
  tags.a = { color: 0 };
  tags.b = { color: 1 };
  tags.c = { color: 3 };
  ok('a new tag takes the FIRST free slot, not the next index', catalog.pickTagColor(tags) === 2);
  const full: Record<string, { color: number }> = {};
  for (let i = 0; i < 8; i += 1) full['t' + i] = { color: i };
  ok('all eight taken → cycle by count (8 % 8 = 0)', catalog.pickTagColor(full) === 0);
  full.t8 = { color: 0 };
  ok('…and the next one after that is 9 % 8 = 1', catalog.pickTagColor(full) === 1);

  // ── 3. search by tag (pure) ────────────────────────────────────────────────
  const recs = [
    { name: 'Retail orders', tags: ['sales', 'retail'] },
    { name: 'Sales pipeline', tags: ['salesforce'] },
    { name: 'HR roster', tags: ['people'] },
  ];
  const names = (xs: Array<{ name: string }>): string => xs.map((x) => x.name).join(',');
  ok("'#sales' → the exact match first, then the prefix match",
    names(index.filterByTag(recs, '#sales')) === 'Retail orders,Sales pipeline', names(index.filterByTag(recs, '#sales')));
  ok("'#sal' prefix-matches both", names(index.filterByTag(recs, '#sal')) === 'Retail orders,Sales pipeline');
  ok("'#SALES' is normalised before matching", names(index.filterByTag(recs, '#SALES')).startsWith('Retail orders'));
  ok('an unknown tag → nothing', index.filterByTag(recs, '#finance').length === 0);
  ok("a bare '#' → nothing (not everything)", index.filterByTag(recs, '#').length === 0);
  ok('a NAME is not a tag — "#hr" finds nothing', index.filterByTag(recs, '#hr').length === 0);

  // ── 4. the store, on disk ──────────────────────────────────────────────────
  await projects.init();
  const proj = await projects.createProject('Catalog project');
  const pid = proj!.id;
  const DS = uuid(1);
  const VIS = uuid(2);
  const dsRef = 'dataset:' + DS;

  const empty = await catalog.getDoc(pid, dsRef);
  ok('an undocumented record reads as empty, not null',
    !!empty && empty.description === '' && empty.tags.length === 0 && empty.owner === '');
  const saved = await catalog.setDoc(pid, dsRef, { description: 'Every order since 2021', tags: ['#Sales', 'EMEA', 'sales'], owner: 'Ana' });
  ok('setDoc normalises tags and keeps the fields', !!saved
    && saved.tags.join(',') === 'sales,emea' && saved.description === 'Every order since 2021' && saved.owner === 'Ana',
    JSON.stringify(saved));
  ok('updatedBy is the OS user, stamped in main', !!saved && saved.updatedBy === catalog.osUser(), saved && saved.updatedBy);
  ok('updatedAt is a real timestamp', !!saved && Number.isFinite(Date.parse(saved.updatedAt)));
  const patched = await catalog.setDoc(pid, dsRef, { owner: 'Ben' });
  ok('a patch changes ONLY the fields present', !!patched && patched.owner === 'Ben'
    && patched.description === 'Every order since 2021' && patched.tags.join(',') === 'sales,emea');

  await catalog.setDoc(pid, 'visual:' + VIS, { tags: ['retail', 'sales'] });
  let file = await catalog.load(pid);
  const colours = JSON.stringify(file.tags);
  ok('colours are assigned first-free in first-use order: sales 0, emea 1, retail 2',
    file.tags.sales.color === 0 && file.tags.emea.color === 1 && file.tags.retail.color === 2, colours);
  await catalog.setDoc(pid, dsRef, { tags: ['emea'] }); // sales leaves this record…
  file = await catalog.load(pid);
  ok('…and a reload keeps every stored colour exactly (stable, never recomputed)',
    file.tags.sales.color === 0 && file.tags.emea.color === 1 && file.tags.retail.color === 2, JSON.stringify(file.tags));

  const proto = await catalog.setDoc(pid, 'visual:' + VIS, { tags: ['__proto__', 'constructor'] });
  file = await catalog.load(pid);
  ok('`__proto__` is just a tag — stored, coloured, no prototype touched',
    !!proto && proto.tags.join(',') === '__proto__,constructor'
    && Object.prototype.hasOwnProperty.call(file.tags, '__proto__') && ({} as any).color === undefined);

  ok('a ref with an unknown kind is refused', (await catalog.setDoc(pid, 'widget:' + DS, { owner: 'x' })) === null);
  ok('a ref with a non-UUID id is refused', (await catalog.setDoc(pid, 'dataset:../../etc', { owner: 'x' })) === null);
  ok('a non-UUID project is refused', (await catalog.setDoc('..', dsRef, { owner: 'x' })) === null);
  ok("'story' is a valid kind already (the Story record lands on another branch)",
    catalog.parseRef('story:' + uuid(3)) !== null);

  // Columns.
  const col = await catalog.setColumn(pid, DS, 'discount', {
    description: 'Share of list price taken off the order', displayName: 'Discount', sensitivity: 'financial',
  });
  ok('setColumn stores description, display name and sensitivity',
    !!col && col.description === 'Share of list price taken off the order' && col.displayName === 'Discount'
    && col.sensitivity === 'financial' && col.updatedBy === catalog.osUser());
  await catalog.setColumn(pid, DS, 'email', { sensitivity: 'nonsense' });
  const cols = await catalog.getColumns(pid, DS);
  ok('an unknown sensitivity is clamped to none', cols.email.sensitivity === 'none');
  ok('displayNames lists only the columns that have one',
    JSON.stringify(await catalog.displayNames(pid, DS)) === JSON.stringify({ discount: 'Discount' }));

  // Corrupt file → empty, never fatal.
  const other = await projects.createProject('Corrupt');
  const corruptPath = path.join(tmpUserData, 'projects', other!.id, 'catalog.json');
  fs.writeFileSync(corruptPath, '{ this is not json');
  const c = await catalog.load(other!.id);
  ok('a corrupt catalog.json reads as empty', Object.keys(c.records).length === 0 && Object.keys(c.tags).length === 0);
  ok('…and the next write replaces it cleanly', !!(await catalog.setDoc(other!.id, dsRef, { owner: 'Cy' }))
    && (await catalog.load(other!.id)).records[dsRef].owner === 'Cy');

  // Concurrent writes (the popover saves on blur AND Enter) must both land.
  await Promise.all([
    catalog.setDoc(pid, 'report:' + uuid(9), { owner: 'Dee' }),
    catalog.setDoc(pid, 'report:' + uuid(9), { description: 'Weekly' }),
  ]);
  const both = await catalog.getDoc(pid, 'report:' + uuid(9));
  ok('two overlapping writes to one file both land', !!both && both.owner === 'Dee' && both.description === 'Weekly');

  // ── 5. stale ───────────────────────────────────────────────────────────────
  const now = Date.parse('2026-09-25T12:00:00Z');
  const ago = (d: number): string => new Date(now - d * DAY).toISOString();
  ok('scheduled, refreshed 29 days ago → fresh', !index.isStale({ autoRefresh: { every: 'daily' }, lastRefreshedAt: ago(29) }, now));
  ok('scheduled, refreshed 31 days ago → stale', index.isStale({ autoRefresh: { every: 'daily' }, lastRefreshedAt: ago(31) }, now));
  ok('unscheduled, untouched for a year → never stale', !index.isStale({ lastRefreshedAt: ago(365), updatedAt: ago(365) }, now));
  ok('no lastRefreshedAt → falls back to updatedAt', index.isStale({ autoRefresh: { every: 'weekly' }, updatedAt: ago(40) }, now));

  // ── 6. sensitivity reaches the report cover; values still export ───────────
  const a = await analysis.saveAnalysis(pid, {
    name: 'Retail overview',
    sheets: [{
      id: uuid(20), name: 'Sheet 1',
      cards: [{
        id: uuid(21), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 },
        metric: { datasetId: DS, column: 'discount', aggregation: 'sum', label: 'Discount' },
      }],
    }],
  });
  const sens = await index.reportSensitivity(pid, a!.id);
  ok('a report over a dataset with a financial column → the cover lists "financial"',
    sens.classes.join(',') === 'financial' && sens.lines.join('|') === 'Contains financial data', JSON.stringify(sens));
  await catalog.setColumn(pid, DS, 'email', { sensitivity: 'personal' });
  const sens2 = await index.reportSensitivity(pid, a!.id);
  ok('…and both classes, in a fixed order, once a personal column is flagged too',
    sens2.lines.join('|') === 'Contains financial data|Contains personal data', JSON.stringify(sens2));
  const clean = await analysis.saveAnalysis(pid, { name: 'Other', sheets: [] });
  ok('a dashboard over undocumented data carries no line', (await index.reportSensitivity(pid, clean!.id)).lines.length === 0);
  ok('a visual card counts through its visual\'s dataset',
    index.analysisDatasetIds({ sheets: [{ cards: [{ type: 'visual', visualId: VIS }] }] } as never, new Map([[VIS, DS]])).join() === DS);

  // The VALUES are not redacted anywhere on the export path.
  const columns = [{ name: 'region', type: 'text' }, { name: 'discount', type: 'number' }] as never;
  const rows = [['West', 0.1], ['East', 0.25], ['West', 0.2]];
  const viz = buildVizData(columns, rows, { category: 'region', values: [{ column: 'discount', aggregation: 'sum' }] } as never);
  const bundle = sanitizeBundle({
    name: 'Retail overview',
    pages: [{ name: 'Sheet 1', cards: [{ kind: 'chart', chartType: 'bar', title: 'Discount by region', data: viz.data, layout: { x: 0, y: 0, w: 6, h: 4 } }] }],
  });
  const exported = bundle.pages[0].cards[0].data!;
  const west = exported.series[0].values[exported.labels.indexOf('West')];
  const east = exported.series[0].values[exported.labels.indexOf('East')];
  ok("a financial column's values are still in the exported tile data, unchanged",
    Math.abs(Number(west) - 0.3) < 1e-12 && east === 0.25, JSON.stringify(exported));

  // Captions say the display name.
  const caption = tileCaption({ chartType: 'column', data: viz.data, names: await catalog.displayNames(pid, DS) });
  ok('a caption uses the column\'s display name', /Discount/.test(caption) && !/discount/.test(caption), caption);
  ok('…and without names, the column name as before', /discount/.test(tileCaption({ chartType: 'column', data: viz.data })));

  // The Assistant is handed the user's words — and any digit in them is in the ledger.
  await catalog.setColumn(pid, DS, 'discount', { description: 'Share of list price taken off, capped at 40 percent' });
  const facts = copilot.datasetFacts(
    { name: 'Orders', rowCount: 3, columns, rows } as never,
    [], [], [], [{ name: 'Revenue', definitionText: 'sum(revenue)', value: 5, display: '5', description: 'Net of refunds' }],
    await catalog.getColumns(pid, DS),
  );
  ok('dataset facts carry the column notes section', facts.text.includes('Column notes (written by the user)')
    && facts.text.includes('discount: called "Discount"; Share of list price taken off, capped at 40 percent; financial data'), facts.text);
  ok('…and the metric description on its defined-metrics line', facts.text.includes('Means: Net of refunds'));
  ok('…and a digit inside a note is in the ledger', facts.ledger.some((e) => e.value === 40));

  // Tag chips on search hits.
  const hits = [{ kind: 'dataset', id: DS, projectId: pid, tags: undefined as any }];
  await index.attachTags(hits);
  ok('attachTags puts coloured chips on a hit', Array.isArray(hits[0].tags) && hits[0].tags[0].name === 'emea'
    && hits[0].tags[0].color === 1, JSON.stringify(hits[0].tags));

  if (!failureCount()) console.log('\nAll catalog checks passed.');
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
