// The literal filter values of a column marked personal or financial in a project bundle the Share policy shapes
// (src/app/sharePolicy.ts `applyToBundle`, src/app/bundleFilterValues.ts). Stripping a value is not safe: a value-less
// `=` passes sanitizeFilterStep on import and matches blank rows, a wrong figure. So under mask and drop the export is
// REFUSED while a glossary term, a visual or a metric (its record or any saved version) filters a marked column by
// value: a typed refusal naming the record and the column, and no bundle written. NEGATIVE CONTROLS: the same filters
// on an unmarked column export as before, a value-less step on the marked one exports, and include is unchanged. The
// scanner is then fed one entry of every other kind that holds filter steps.
//
//   npm run build:ts && node scripts/test-sharePolicyFilterValues.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-filtervalues-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const files: typeof import('../src/server/files') = require('../src/server/files');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check
require('../src/ipc/projects').register({});

const show = (v: unknown): string => JSON.stringify(v);
const TERM_CANARY = 'term-canary@acme.test';
const VISUAL_CANARY = 'visual-canary@acme.test';
const METRIC_CANARY = 'metric-canary@acme.test';
const VERSION_CANARY = 'version-canary@acme.test';
const REGION = 'North-canary-region';
const onEmail = (value: string): object[] => [{ type: 'filter', column: 'email', op: '=', value }];
const onRegion = (): object[] => [{ type: 'filter', column: 'region', op: 'in', values: [REGION] }];
type Entry = { name: string; data: Buffer };

async function main(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Filter values share')).id;
  const D = (await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv',
    columns: [{ name: 'email', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
    rows: [['a@b.c', 'North', 1], ['x@y.z', 'West', 2]] }))!.id;
  await catalog.setColumn(P, D, 'email', { sensitivity: 'personal' });
  const term = (await terms.saveTerm(P, { name: 'EU contacts', datasetId: D, filters: onRegion() }))!;
  const visual = (await visuals.saveVisual(P, { name: 'Revenue EU', datasetId: D, chartType: 'bar',
    encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, filters: onRegion() }))!;
  const metric = (await metrics.saveMetric(P, { name: 'EU revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, filters: onRegion() }))!;
  ok('fixture: a term, a visual and a metric filter the unmarked region by value', !!term && !!visual && !!metric);

  const exportsOnDisk = (): string[] => { try { return fs.readdirSync(appPaths.temp()).filter((n) => n.startsWith('export-')).sort(); } catch (_) { return []; } };
  const exportAs = async (action: 'mask' | 'drop' | 'include'): Promise<{ r: any; entries: Entry[] | null }> => { // any: the handler's reply
    await store.setPolicy(P, { bundle: action });
    const r = await handlers.get('projects:export')!(null, { id: P });
    const file = r && r.downloadToken ? files.downloadPathForTest(r.downloadToken) : null;
    return { r, entries: file ? bundle.readZip(fs.readFileSync(file)) : null };
  };
  const carrying = (entries: Entry[] | null, v: string): string[] => (entries ?? []).filter((e) => e.data.includes(v)).map((e) => e.name);
  const exports = async (what: string, canary: string, expect: string[]): Promise<void> => {
    for (const action of ['mask', 'drop'] as const) {
      const { r, entries } = await exportAs(action);
      ok(`${action}: NEGATIVE CONTROL: ${what} exports`, r?.ok === true && !!entries, show(r));
      ok(`${action}: NEGATIVE CONTROL: ${what}: its literal travels where it is stored`, show(carrying(entries, canary)) === show(expect), show(carrying(entries, canary)));
    }
  };
  const refused = async (what: string, canary: string, says: string): Promise<void> => {
    for (const action of ['mask', 'drop'] as const) {
      const before = exportsOnDisk();
      const { r, entries } = await exportAs(action);
      ok(`${action}: ${what}: the export is refused, typed`, r?.ok === false && !entries && r.code === 'share_filter_value', show(r));
      ok(`${action}: ${what}: the refusal names the record and the column`, String(r?.error).includes(says), String(r?.error));
      ok(`${action}: ${what}: the refusal never quotes the value`, !String(r?.error).includes(canary), String(r?.error));
      ok(`${action}: ${what}: no bundle is written`, show(exportsOnDisk()) === show(before), show([before, exportsOnDisk()]));
    }
    const { r, entries } = await exportAs('include');
    ok(`include: NEGATIVE CONTROL: ${what}: exports with its value, as before`, r?.ok === true && carrying(entries, canary).length > 0, show([r, carrying(entries, canary)]));
  };

  await exports('the term, visual and metric on the unmarked region', REGION, [`metrics/${metric.id}.json`, `terms/${term.id}.json`, `visuals/${visual.id}.json`]);

  await terms.updateTerm(P, term.id, { filters: onEmail(TERM_CANARY) });
  await refused('a glossary term filtering the marked email', TERM_CANARY, 'EU contacts filters email by value');
  await terms.updateTerm(P, term.id, { filters: onRegion() });

  await visuals.updateVisual(P, visual.id, { filters: [{ type: 'filter', column: 'email', op: 'in', values: ['West', VISUAL_CANARY] }] });
  await refused('a visual filtering the marked email', VISUAL_CANARY, 'Revenue EU filters email by value');
  await visuals.updateVisual(P, visual.id, { filters: onRegion() });

  await metrics.updateMetric(P, metric.id, { filters: onEmail(METRIC_CANARY) });
  await refused('a metric filtering the marked email', METRIC_CANARY, 'EU revenue filters email by value');
  await metrics.updateMetric(P, metric.id, { filters: onRegion() });

  const old = await visuals.updateVisual(P, visual.id, { filters: onEmail(VERSION_CANARY) });
  ok('fixture: a saved version of the visual filters email', !!(await versions.record(P, 'visual', old)));
  await visuals.updateVisual(P, visual.id, { filters: onRegion() });
  ok('fixture: the visual itself filters region again', show((await visuals.getVisual(P, visual.id))?.filters) === show(onRegion()));
  await refused('only a saved version of the visual filtering email', VERSION_CANARY, 'a saved version of Revenue EU filters email by value');
  await versions.forget(P, 'visual', visual.id);

  await visuals.updateVisual(P, visual.id, { filters: [{ type: 'filter', column: 'email', op: 'is_empty' }, { type: 'filter', column: 'email', op: 'not_empty' }] });
  await exports('a visual with value-less steps on the marked email', REGION, [`metrics/${metric.id}.json`, `terms/${term.id}.json`]);
  ok('the records themselves are untouched by the refusals (the export reads a copy)', show((await terms.getTerm(P, term.id))?.filters) === show(onRegion()));

  // The scanner over one entry of every other kind that holds filter steps, and the step shapes it reads.
  const scan: typeof import('../src/app/bundleFilterValues') = require('../src/app/bundleFilterValues');
  const W = new Set(['email', 'home_lng']);
  const step = { type: 'filter', column: 'email', op: '=', value: 'z@z.z' };
  const id = (): string => randomUUID();
  const entry = (name: string, doc: unknown): Entry => ({ name, data: Buffer.from(JSON.stringify(doc, null, 2), 'utf8') });
  const hits = (e: Entry): string => show(scan.filterValueHits([e], W).map((h) => [h.name, h.column, h.version]));
  const KEY = '2026-11-07T10-00-00-000Z';
  const kinds: Array<[string, Entry, string]> = [
    ['a dashboard\'s filters', entry(`analyses/${id()}.json`, { name: 'Sales board', filters: [step] }), 'Sales board'],
    ['a dashboard card\'s frozen visual, named by its dashboard', entry(`analyses/${id()}.json`, { name: 'Sales board', sheets: [{ cards: [{ visual: { name: 'Inner', filters: [step] } }] }] }), 'Sales board'],
    ['a story block', entry(`stories/${id()}.json`, { name: 'Q3 story', blocks: [{ type: 'visual', filters: [step] }] }), 'Q3 story'],
    ['a report page', entry(`reports/${id()}.json`, { name: 'Weekly', pages: [{ filters: [step] }] }), 'Weekly'],
    ['a scorecard row', entry(`scorecards/${id()}.json`, { name: 'Ops card', rows: [{ filters: [step] }] }), 'Ops card'],
    ['a scenario driver', entry(`scenarios/${id()}.json`, { name: 'Plan B', drivers: [{ filters: [step] }] }), 'Plan B'],
    ['a notebook cell', entry(`notebooks/${id()}.json`, { name: 'NB', cells: [{ steps: [step] }] }), 'NB'],
    ['a metric definition and tree', entry(`metrics/${id()}.json`, { name: 'Nested', definition: { numerator: { filters: [step] } }, tree: { children: [{ filters: [step] }] } }), 'Nested'],
    ['an alert rule, named by the rule', entry('alerts.json', { rules: [{ name: 'Drop alert', filters: [step] }] }), 'Drop alert'],
    ['a user template', entry('templates.json', { templates: [{ name: 'Tpl', dashboard: { filters: [step] } }] }), 'Tpl'],
    ['a verified question, named by its file', entry('verified/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '.json', { question: 'How many?', spec: { filters: [step] } }), 'verified/00000000-0000-0000-0000-000000000000.json'],
  ];
  for (const [what, e, name] of kinds) ok(`scan: ${what} is found`, hits(e) === show([[name, 'email', false]]), hits(e));
  const version = entry(`history/term/${id()}/${KEY}.json`, { savedAt: 'x', summary: 'y', record: { name: 'Old term', filters: [step] } });
  ok('scan: a saved version is found as a version, named by its record', hits(version) === show([['Old term', 'email', true]]), hits(version));
  const shapes: Array<[string, object, string]> = [
    ['a custom period carries dates', { type: 'filter', column: 'email', op: 'period', period: { preset: 'custom', from: '1980-01-01' } }, 'email'],
    ['a radius reads its longitude column too', { type: 'filter', column: 'home_lat', op: 'within_km', radius: { lngColumn: 'home_lng', lat: 1, lng: 2, km: 3 } }, 'home_lng'],
    ['NEGATIVE CONTROL: a relative period carries no literal', { type: 'filter', column: 'email', op: 'period', period: { preset: 'last_n_days', n: 30 } }, ''],
    ['NEGATIVE CONTROL: an empty list', { type: 'filter', column: 'email', op: 'in', values: [] }, ''],
    ['NEGATIVE CONTROL: a null value', { type: 'filter', column: 'email', op: '=', value: null }, ''],
    ['NEGATIVE CONTROL: an unmarked column', { type: 'filter', column: 'region', op: '=', value: 'North' }, ''],
    ['NEGATIVE CONTROL: a glossary term step', { type: 'term', termId: id() }, ''],
  ];
  for (const [what, s, column] of shapes) {
    const got = scan.filterValueHits([entry(`visuals/${id()}.json`, { name: 'V', filters: [s] })], W).map((h) => h.column);
    ok(`scan: ${what}`, show(got) === show(column ? [column] : []), show(got));
  }
  ok('scan: NEGATIVE CONTROL: a dataset record and its versions are left to their own shaping',
    scan.filterValueHits([entry(`datasets/${id()}.json`, { name: 'DS', steps: [step] }), entry(`history/dataset/${id()}/${KEY}.json`, { record: { steps: [step] } })], W).length === 0);
  ok('scan: two steps on one column in one record are one hit', scan.filterValueHits([entry(`visuals/${id()}.json`, { name: 'V', filters: [step, { ...step, value: 'q' }] })], W).length === 1);
  const many = Array.from({ length: 7 }, (_, i) => ({ entry: 'x', name: `Visual ${i}`, column: 'email', version: false }));
  const err = new scan.FilterValueRefusal(many);
  ok('the refusal names the first five and counts the rest', err.message.includes('Visual 4 filters email by value') && !err.message.includes('Visual 5') && err.message.includes('2 more'), err.message);
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
