// Self-check for Explore's `explore:suggest` (docs/explore/00-design.md), and
// for the routing item 5's row policy relies on — server mode, the real RPC
// route (Fastify inject), over the live bench (the fake warehouse):
//
//   shape     structure only: NO number anywhere in the reply, every value walked
//             (NEGATIVE CONTROL: the walk finds a planted one); fields by DECLARED type
//   ranking   DIFFERENTIAL against starterPlan's own consumer: the first measures and
//             their aggregates are the starter dashboard's KPI strip, and the first
//             question is its first chart; the sample's ladder, spelled out
//   edges     no measure (counts), no text column (the date stands in), numbers only
//             (none), an id-like number is a dimension, a lone column
//   live      a Live dataset is answered from its declared columns: getDataset and
//             residentSource are never asked — for the extract either
//   access    a project VIEWER is admitted by `authorize` on the real contract
//             (CONTROLS: no grant → refused; the same viewer is refused a write)
//   scope     another project's dataset id → ok:false and no field (CONTROL: its own project answers)
//   route     Explore's question as the web sends it, through `visual:data` on the Live
//             dataset: the warehouse's answer (asOf live) and no hydrate — which only
//             `vizDataFor`'s Live branch gives (CONTROL: the extract answers as an extract)
//
//   npm run build:ts && node scripts/test-exploreSuggest.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, median, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const ex: typeof import('../src/analysis/exploreSuggest') = require('../src/analysis/exploreSuggest');
const starter: typeof import('../src/analysis/starterPlan') = require('../src/analysis/starterPlan');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const api: typeof import('../src/api/index') = require('../src/api/index');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

type Col = import('../src/data/parse').ParsedColumn;
const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);

/** Every number (or bigint) anywhere in `v`, by path. */
function numbersIn(v: unknown, at = '$', out: string[] = []): string[] {
  if (typeof v === 'number' || typeof v === 'bigint') out.push(at);
  else if (Array.isArray(v)) v.forEach((x, i) => numbersIn(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) numbersIn(x, `${at}.${k}`, out);
  return out;
}

/** A suggestion as one comparable line: type, category, grain, measures. */
const line = (s: { chartType: string; encoding: { category: string; grain?: string; values: { column: string; aggregation: string }[] } }): string =>
  `${s.chartType}: ${s.encoding.values.map((m) => `${m.aggregation}(${m.column})`).join(',')} by ${s.encoding.category}${s.encoding.grain ? `@${s.encoding.grain}` : ''}`;

const cols = (spec: string): Col[] => spec.split(',').map((x) => {
  const [name, type] = x.split(':');
  return { name, type: type as Col['type'] };
});

(async () => {
  // ── The pure ladder ──────────────────────────────────────────────────────
  // The sample's columns, typed as an import types them (the real CSV, through the real parser).
  const csv = fs.readFileSync(path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const sampleCols = parse.parseCsv(csv).columns;
  const sample = ex.exploreSuggest(sampleCols);

  ok('shape: no number anywhere in the reply', numbersIn(sample).length === 0, numbersIn(sample).join(' '));
  ok('NEGATIVE CONTROL: the walk finds a planted number (and a bigint)', show(numbersIn({ a: [{ b: 'x' }, { c: 1 }], d: { e: BigInt(2) } })) === show(['$.a[1].c', '$.d.e']));
  ok('fields by declared type: every column once, in its group', sample.dimensions.length + sample.dates.length + sample.measures.length === sampleCols.length
    && sample.dates.every((d) => sampleCols.find((c) => c.name === d.name)?.type === 'date')
    && sample.measures.every((m) => sampleCols.find((c) => c.name === m.name)?.type === 'number')
    && sample.dimensions.every((d) => sampleCols.find((c) => c.name === d.name)?.type === d.type), show(sample));

  // DIFFERENTIAL: the starter dashboard is the ranking's other consumer.
  const plan = starter.buildStarterPlan('kpis', { id: 'd', name: 'Sample', rowCount: 0, columns: sampleCols, resident: false });
  const sheet = plan.sheets[0]!;
  const kpis = sheet.metrics.map((m) => `${m.aggregation}(${m.column})`);
  ok('ranking: the first measures, with their aggregates, ARE the starter dashboard\'s KPI strip',
    kpis.length > 0 && show(sample.measures.slice(0, kpis.length).map((m) => `${m.aggregation}(${m.name})`)) === show(kpis), show({ kpis, measures: sample.measures }));
  const firstChart = sheet.visuals[0] as { encoding: { category: string; values: { column: string; aggregation: string }[] } };
  ok('ranking: the first question IS the starter dashboard\'s first chart (category, measure, aggregate)',
    show({ c: sample.suggestions[0]!.encoding.category, v: sample.suggestions[0]!.encoding.values }) === show({ c: firstChart.encoding.category, v: firstChart.encoding.values }),
    show({ explore: sample.suggestions[0], starter: firstChart }));
  ok('ranking: measures are starterPlan\'s rankedMeasures, every one of them', show(sample.measures.map((m) => m.name)) === show(starter.rankedMeasures({ columns: sampleCols }).map((c) => c.name)));
  ok('a rate, a price or a duration is averaged, never summed (aggregationFor)',
    sample.measures.filter((m) => /price|discount|days/.test(m.name)).every((m) => m.aggregation === 'avg') && sample.measures.find((m) => m.name === 'revenue')?.aggregation === 'sum', show(sample.measures));
  const LADDER = [
    'column: sum(revenue) by region',
    'line: sum(revenue) by order_date@month',
    'column: sum(profit) by region',
    'bar: sum(revenue) by state',
    'area: sum(profit) by order_date@month',
    'bar: sum(revenue) by category',
  ];
  ok('the sample\'s ladder: six questions, in this order', show(sample.suggestions.map(line)) === show(LADDER), show(sample.suggestions.map(line)));

  // Edges.
  const noMeasure = ex.exploreSuggest(cols('region:text,d:date'));
  ok('no measure: the count of rows by the text column, and by month', show(noMeasure.suggestions.map(line)) === show(['column: count(region) by region', 'line: count(d) by d@month']) && noMeasure.measures.length === 0, show(noMeasure));
  const noText = ex.exploreSuggest(cols('amt:number,d:date'));
  ok('no text column: the date stands in (by month)', show(noText.suggestions.map(line)) === show(['line: sum(amt) by d@month']), show(noText));
  const numbers = ex.exploreSuggest(cols('amt:number,qty:number'));
  ok('numbers only: no question to suggest (and the measures still listed)', numbers.suggestions.length === 0 && numbers.measures.length === 2, show(numbers));
  const ids = ex.exploreSuggest(cols('order_id:number,year:number,revenue:number,region:text'));
  ok('an id or a year is a DIMENSION (number-typed), never a measure', show(ids.dimensions) === show([{ name: 'order_id', type: 'number' }, { name: 'year', type: 'number' }, { name: 'region', type: 'text' }])
    && show(ids.measures) === show([{ name: 'revenue', aggregation: 'sum' }]), show(ids));
  const lone = ex.exploreSuggest(cols('region:text'));
  ok('a lone text column: its count, and nothing else', show(lone.suggestions.map(line)) === show(['column: count(region) by region']));
  ok('an empty dataset: empty lists, no throw', show(ex.exploreSuggest([])) === show({ dimensions: [], dates: [], measures: [], suggestions: [] }));

  // ── Over the route: extract and Live ─────────────────────────────────────
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const X = s.extractId;
  const resident: string[] = [];
  const realResident = H.datasets.residentSource;
  (H.datasets as { residentSource: typeof realResident }).residentSource = (projectId: string, id: string) => {
    resident.push(id);
    return realResident(projectId, id);
  };
  const reads = () => ({ hydrated: hydrated.length, resident: resident.length });

  const before = reads();
  const live = await post('explore:suggest', { projectId: P, datasetId: L });
  const extract = await post('explore:suggest', { projectId: P, datasetId: X });
  const after = reads();
  ok('a Live dataset: 200, its declared columns, ranked', live.status === 200 && live.value.ok === true && show(live.value) === show({ ok: true, ...ex.exploreSuggest(H.fx.COLUMNS) }), live.body.slice(0, 300));
  ok('…the extract of the same rows answers the same (declared columns, not data)', extract.status === 200 && show(extract.value) === show(live.value), extract.body.slice(0, 300));
  ok('NO row read: getDataset and residentSource never asked, for either', after.hydrated === before.hydrated && after.resident === before.resident, show({ before, after }));
  ok('the routed reply has no number either', numbersIn(live.value).length === 0, numbersIn(live.value).join(' '));
  ok('a bad id is a 400 (the contract), never a handler call', (await post('explore:suggest', { projectId: P, datasetId: 'x' })).status === 400);
  ok('an extra field is a 400 (strict input)', (await post('explore:suggest', { projectId: P, datasetId: X, rows: true })).status === 400);

  // Scope: another project's dataset.
  const other = await H.as(ORG_A, async () => {
    const p = await H.projects.createProject('Elsewhere');
    const d = await H.datasets.saveDataset(p.id, { name: 'Theirs', sourceKind: 'csv', columns: [{ name: 'secret_col', type: 'text' }], rows: [['a']] });
    if (!d) throw new Error('dataset not saved');
    return { pid: p.id, did: d.id };
  });
  const crossed = await post('explore:suggest', { projectId: P, datasetId: other.did });
  ok('another project\'s dataset id: refused, ok:false, no field and no column name', crossed.status === 200 && crossed.value.ok === false
    && !('dimensions' in crossed.value) && !crossed.body.includes('secret_col') && crossed.value.error === H.msg.liveDatasetMissing(), crossed.body);
  const own = await post('explore:suggest', { projectId: other.pid, datasetId: other.did });
  ok('CONTROL: in its own project it answers', own.value.ok === true && show(own.value.dimensions) === show([{ name: 'secret_col', type: 'text' }]), own.body);

  // Access: the real contract through the real decision, a project viewer's grant stubbed.
  const contract = api.contracts['explore:suggest'];
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const viewer: import('../src/server/context').Identity = { user: { email: 'vi@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  const input = { projectId: P, datasetId: X };
  const asViewer = (c: typeof contract, rank: number, i: unknown = input) => H.as(viewer, () => authz.authorize(c as never, i, viewer, grants(rank)));
  ok('the contract is a `read`, scoped to the input\'s project', contract.access === 'read' && 'project' in contract && contract.project(input) === P);
  ok('a project VIEWER may call it', (await asViewer(contract, 1)).ok === true);
  ok('CONTROL: with no grant on the project the same caller is refused', (await asViewer(contract, 0)).ok === false);
  ok('CONTROL: the viewer is refused a write (visual:save) on the same project',
    (await asViewer(api.contracts['visual:save'], 1, { projectId: P, datasetId: X, name: 'n', chartType: 'column', encoding: { category: 'region', values: [] } })).ok === false);

  // ── The routing item 5 relies on ─────────────────────────────────────────
  // Explore asks exactly this (web/src/features/explore/api.ts): the suggestion's encoding, the spec's filters.
  const q = live.value.suggestions[0] as { encoding: unknown };
  const ask = (datasetId: string) => post('visual:data', { projectId: P, datasetId, encoding: q.encoding, filters: [] });
  const h0 = hydrated.length;
  const onLive = await ask(L);
  const liveHydrated = hydrated.slice(h0).includes(L);
  const onExtract = await ask(X);
  ok('route: Explore\'s question on the Live dataset is the WAREHOUSE\'s answer (asOf live) — vizDataFor\'s Live branch', onLive.status === 200 && onLive.value.ok === true
    && onLive.value.asOf?.mode === 'live' && Array.isArray(onLive.value.data?.labels) && onLive.value.data.labels.length > 0, onLive.body.slice(0, 300));
  ok('…with no hydrate of the Live dataset', !liveHydrated);
  const chartOf = (r: Reply) => ({ labels: r.data.labels, series: r.data.series.map((x: Reply) => ({ name: x.name, values: x.values })) });
  const parity = onExtract.value.ok === true ? cmp.compareCharts(chartOf(onExtract.value), chartOf(onLive.value), () => true, false) : ['no extract answer'];
  ok('CONTROL: the extract answers as an extract — the same rows as the warehouse (the parity comparator)', onExtract.value.asOf?.mode === 'extract' && parity.length === 0,
    parity.join(' | ') || show(onExtract.value.asOf));

  // Measured: one suggestion through the route (one metadata read, records as files).
  const ms: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const t = performance.now();
    const r: Reply = await post('explore:suggest', { projectId: P, datasetId: X });
    if (r.status !== 200) break;
    ms.push(performance.now() - t);
  }
  console.log(`  measured: explore:suggest through the route ${median(ms).toFixed(2)} ms median of ${ms.length}`);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
