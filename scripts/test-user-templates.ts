// Self-check for USER TEMPLATES (r7:templates): capture a dashboard as roles +
// a body, apply it through the gallery's own mapper, and the trust boundary a
// shared `.ordinate-template` file crosses.
//
// Pure — records as literals in, plans out. The fixture is the bundled SAMPLE
// dashboard as the seeder builds it (src/app/sampleProject.ts): four KPI tiles
// over saved metrics, a Month calculated field, three charts (one a state map)
// and the note — plus a region control, a dashboard filter, a list parameter,
// an edited phone layout and a `{{Margin %}}` token, so every kind of reference
// the template rewrites is on the sheet.
//
//   npm run build:ts && node scripts/test-user-templates.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import type { ParsedColumn } from '../src/data/parse';
import type { PlanDataset } from '../src/analysis/analysisPlan';
import { sanitizePages } from '../src/analysis/dashboards';
import { mapRoles, mappingOf } from '../src/analysis/templateRoles';
import { captureTemplate, type CaptureInput, type UserTemplate } from '../src/analysis/userTemplate';
import { planApply, bindIds } from '../src/analysis/userTemplateApply';
import { formulaToRefs, formulaFromRefs, type RefNames } from '../src/analysis/userTemplateRefs';
import { fromTemplateFile, sanitizeUserTemplate, toTemplateFile } from '../src/analysis/userTemplateFile';
import { compile } from '../src/formula/formula';
import { lodColumnRefs } from '../src/formula/lod';

// ── The sample dashboard ────────────────────────────────────────────────────

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const DS = uuid();
const OTHER_DS = uuid();

const COLUMNS: ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'state', type: 'text' },
  { name: 'category', type: 'text' }, { name: 'sub_category', type: 'text' }, { name: 'customer_segment', type: 'text' },
  { name: 'units', type: 'number' }, { name: 'unit_price', type: 'number' }, { name: 'discount', type: 'number' },
  { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' }, { name: 'ship_days', type: 'number' },
  { name: 'Month', type: 'date' },
];
const STEPS = [{ type: 'calculated_field', name: 'Month', expression: "datetrunc('month', order_date)" }];
const DISTINCT: Record<string, number> = { order_date: 731, region: 5, state: 25, category: 3, sub_category: 12, customer_segment: 3, Month: 24 };
const SUMMARIES = COLUMNS.map((c) => ({ name: c.name, type: c.type, nonEmpty: 1_000_000, ...(DISTINCT[c.name] ? { distinct: DISTINCT[c.name] } : {}) }));

const money = { kind: 'currency', decimals: 0, compact: true };
const METRICS = [
  { id: uuid(), name: 'Revenue', datasetId: DS, definition: { column: 'revenue', aggregation: 'sum' }, filters: [], format: money },
  { id: uuid(), name: 'Profit', datasetId: DS, definition: { column: 'profit', aggregation: 'sum' }, filters: [], format: money },
  { id: uuid(), name: 'Units', datasetId: DS, definition: { column: 'units', aggregation: 'sum' }, filters: [], format: money },
  { id: uuid(), name: 'Orders', datasetId: DS, definition: { column: 'order_date', aggregation: 'count' }, filters: [], format: money },
  { id: uuid(), name: 'Avg order value', datasetId: DS, definition: { formula: '[Revenue] / [Orders]' }, filters: [], format: money },
  { id: uuid(), name: 'Margin %', datasetId: DS, definition: { formula: '[Profit] / [Revenue]' }, filters: [], format: money },
];
const mid = (name: string): string => METRICS.find((m) => m.name === name)!.id;

const VISUALS = [
  { id: uuid(), name: 'Revenue by month', datasetId: DS, chartType: 'line',
    encoding: { category: 'Month', values: [{ column: 'revenue', aggregation: 'sum', metricId: mid('Revenue') }] },
    overrides: { title: 'Revenue {{Revenue}}', smooth: true }, filters: [] },
  { id: uuid(), name: 'Revenue by category', datasetId: DS, chartType: 'column',
    encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] }, overrides: {},
    filters: [{ type: 'filter', column: 'category', op: '!=', value: 'region' }] },
  { id: uuid(), name: 'Profit by state', datasetId: DS, chartType: 'map_choropleth',
    encoding: { category: 'state', values: [{ column: 'profit', aggregation: 'sum' }], geo: { level: 'us_state' } }, overrides: {}, filters: [] },
  { id: uuid(), name: 'Elsewhere', datasetId: OTHER_DS, chartType: 'bar',
    encoding: { category: 'x', values: [{ column: 'y', aggregation: 'sum' }] }, overrides: {}, filters: [] },
];
const vid = (name: string): string => VISUALS.find((v) => v.name === name)!.id;

const kpi = (label: string, column: string, aggregation: string, metric: string, x: number): Record<string, unknown> => ({
  id: uuid(), type: 'metric', layout: { x, y: 0, w: 3, h: 2 },
  metric: { datasetId: DS, column, aggregation, label, metricId: mid(metric) },
});
const CARDS: Record<string, unknown>[] = [
  { id: uuid(), type: 'control', layout: { x: 0, y: 0, w: 0, h: 0 }, control: { kind: 'dropdown', label: 'Region', datasetId: DS, column: 'region' } },
  kpi('Revenue', 'revenue', 'sum', 'Revenue', 0),
  kpi('Profit', 'profit', 'sum', 'Profit', 3),
  kpi('Units sold', 'units', 'sum', 'Units', 6),
  kpi('Orders', 'order_date', 'count', 'Orders', 9),
  { id: uuid(), type: 'visual', layout: { x: 0, y: 2, w: 6, h: 6 }, visualId: vid('Revenue by month') },
  { id: uuid(), type: 'visual', layout: { x: 6, y: 2, w: 6, h: 6 }, visualId: vid('Revenue by category') },
  { id: uuid(), type: 'visual', layout: { x: 0, y: 8, w: 12, h: 6 }, visualId: vid('Profit by state') },
  { id: uuid(), type: 'text', layout: { x: 0, y: 14, w: 12, h: 2 }, heading: 'This is sample data',
    text: 'Margin is **{{Margin %}}** at {{Target}}.', action: 'delete-sample' },
  { id: uuid(), type: 'visual', layout: { x: 0, y: 16, w: 6, h: 6 }, visualId: vid('Elsewhere') },
];
const SHEET_ID = uuid();
const PARAM_ID = uuid();
const SOURCE_SHEETS = sanitizePages([{
  id: SHEET_ID, name: 'Overview', cards: CARDS,
  layouts: { phone: { items: [{ id: CARDS[1].id as string, h: 3 }, { id: CARDS[7].id as string, hidden: true }] } },
}]);
const ANALYSIS: CaptureInput['analysis'] = {
  id: uuid(), name: 'Retail overview', sheets: SOURCE_SHEETS,
  filters: [{ type: 'filter', column: 'customer_segment', op: '!=', value: 'Internal' }],
  style: { theme: 'auto', density: 'compact', accent: 'teal' },
  parameters: [{ id: PARAM_ID, name: 'Target', kind: 'list', value: 'West', list: { datasetId: DS, column: 'region' } }],
};
const INPUT: CaptureInput = {
  analysis: ANALYSIS, visuals: VISUALS,
  dataset: { id: DS, columns: COLUMNS, steps: STEPS, summaries: SUMMARIES },
  metrics: METRICS,
};

const cap = captureTemplate(INPUT);
const tpl: UserTemplate = {
  id: uuid(), name: 'Retail overview', description: '', createdAt: '2026-10-01T00:00:00.000Z',
  roles: cap.roles.map(({ column: _c, uses: _u, where: _w, ...r }) => r), body: cap.body, thumbnail: '',
};
/** JSON with sorted keys — key ORDER is not structure. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const json = JSON.stringify(cap.body);

// ── §1 role inference on the sample dashboard ───────────────────────────────

const roleOf = (col: string) => cap.roles.find((r) => r.column === col);
ok('capture: one role per column the dashboard reads, in the dataset\'s order — never the calculated Month',
  cap.roles.map((r) => r.column).join(',') === 'order_date,region,state,category,customer_segment,units,revenue,profit',
  cap.roles.map((r) => r.column).join(','));
ok('…kinds from declared type and usage: date, dimension, geo (it is a map\'s region), measure',
  JSON.stringify(cap.roles.map((r) => r.kind)) === JSON.stringify(['date', 'dimension', 'geo', 'dimension', 'dimension', 'measure', 'measure', 'measure']),
  cap.roles.map((r) => r.kind).join(','));
ok('…labelled from the column ("order_date" → "Order date"), required by default, hints from its words',
  roleOf('order_date')!.label === 'Order date' && roleOf('order_date')!.required
  && JSON.stringify(roleOf('order_date')!.hints) === JSON.stringify(['order date', 'order', 'date']));
ok('…with usage counted and named: revenue is in a KPI, two charts and a metric',
  roleOf('revenue')!.uses === 4 && ['Revenue', 'Revenue by month', 'Revenue by category', 'Metric Revenue'].every((w) => roleOf('revenue')!.where.includes(w)),
  JSON.stringify(roleOf('revenue')));
ok('…and order_date is used through the Month calculated field, which is named as such',
  roleOf('order_date')!.where.includes('Calculated field Month'), roleOf('order_date')!.where.join(' | '));
ok('capture: Month travels as a calculated field, its formula rewritten at token level',
  cap.body.calcFields.length === 1 && cap.body.calcFields[0].expression === "datetrunc('month', [$r1])", JSON.stringify(cap.body.calcFields));
ok('capture: the five metrics the sheet names — KPI ids, a measure chip and a {{token}} — dependencies first',
  cap.body.metrics.map((m) => m.name).join(',') === 'Revenue,Profit,Units,Orders,Margin %', cap.body.metrics.map((m) => m.name).join(','));
ok('…and a formula metric names the others by ref', JSON.stringify(cap.body.metrics[4].spec.definition) === JSON.stringify({ formula: '[$m2] / [$m1]' }));
ok('capture: no column name survives in a column slot', !/"(column|category|series)":"/.test(json), json.slice(0, 400));
ok('capture: a tile on another dataset is left out and counted', cap.skipped === 1 && cap.tiles === 9 && cap.body.visuals.length === 3);
ok('capture: the sample note\'s delete button does not travel', !json.includes('delete-sample'));
ok('capture: text tokens become metric refs, parameters stay by name', json.includes('{{$m5}}') && json.includes('{{Target}}'));
ok('capture: a filter VALUE that happens to equal a column name is data, not a reference', json.includes('"value":"region"'));

// ── §2 round trip: applied back to its own dataset ──────────────────────────

const SAMPLE_DS: PlanDataset = { id: DS, name: 'Retail orders', rowCount: 1_000_000, columns: COLUMNS, resident: true, summaries: SUMMARIES };
const { matches, missingRequired } = mapRoles(tpl.roles, SAMPLE_DS);
const selfMap = mappingOf(matches);
ok('round trip: the gallery\'s mapper maps every role straight back onto its own column',
  missingRequired.length === 0 && cap.roles.every((r) => selfMap[r.id] === r.column), JSON.stringify(selfMap));

// newId hands back the source's own ids in the order planApply asks, so the
// rebuilt sheet can be compared with the source byte for byte.
const sourceIds = [SHEET_ID, ...SOURCE_SHEETS[0].cards.filter((c) => c.type !== 'visual' || c.visualId !== vid('Elsewhere')).map((c) => c.id), PARAM_ID];
let k = 0;
const self = planApply(tpl, selfMap, { datasetId: DS, columns: COLUMNS, steps: STEPS, metrics: METRICS }, { newId: () => sourceIds[k++] });
ok('round trip: nothing dropped, every tile kept', self.dropped.length === 0 && self.tiles === 9 && self.total === 9, self.dropped.join(' | '));
ok('round trip: Month already exists with the same formula, so no step is added', self.newSteps.length === 0);
ok('round trip: every metric is the existing one, reused by id — no "Revenue 2"',
  self.metrics.every((m) => m.reuseId === mid(cap.body.metrics.find((x) => x.ref === m.ref)!.name)));
const ids = new Map<string, string>(self.metrics.map((m) => [m.ref, m.reuseId!]));
cap.body.visuals.forEach((v, i) => ids.set(v.ref, VISUALS[i].id));
const rebuiltVisuals = self.visuals.map((v) => bindIds(v.input, ids));
ok('round trip: each chart\'s spec is the source\'s exactly — encoding, metric chip, overrides, filters',
  rebuiltVisuals.every((v, i) => canon(v) === canon((({ id: _i, ...rest }) => rest)(VISUALS[i]))),
  JSON.stringify(rebuiltVisuals[0]));
const rebuilt = sanitizePages(bindIds(self.analysis, ids).sheets);
const expected = SOURCE_SHEETS.map((p) => ({
  ...p,
  cards: p.cards.filter((c) => c.visualId !== vid('Elsewhere')).map((c) => {
    const { action: _a, ...rest } = c;
    return rest;
  }),
}));
ok('round trip: the sheet is the source sheet — cards, layouts, the phone layout, the note (without its button)',
  JSON.stringify(rebuilt) === JSON.stringify(expected), JSON.stringify(rebuilt).slice(0, 600));
ok('round trip: filters, style and parameters come back as they were',
  JSON.stringify(self.analysis.filters) === JSON.stringify(ANALYSIS.filters)
  && JSON.stringify(self.analysis.style) === JSON.stringify(ANALYSIS.style)
  && JSON.stringify(self.analysis.parameters) === JSON.stringify(ANALYSIS.parameters));

// ── §3 a renamed-columns dataset ─────────────────────────────────────────────

const RENAME: Record<string, string> = {
  order_date: 'Order Date', region: 'Sales Region', state: 'Ship State', category: 'Product Category',
  customer_segment: 'Segment', units: 'Qty', revenue: 'Sales Amount', profit: 'Net Profit',
};
const RENAMED_COLS: ParsedColumn[] = COLUMNS.filter((c) => c.name !== 'Month').map((c) => ({ ...c, name: RENAME[c.name] || c.name }));
const T2 = uuid();
const renamedDs: PlanDataset = { id: T2, name: 'Export', rowCount: 10, columns: RENAMED_COLS, resident: false };
const auto = mappingOf(mapRoles(tpl.roles, renamedDs).matches);
ok('renamed: the mapper still finds the date by type and Net Profit by its words',
  auto[roleOf('order_date')!.id] === 'Order Date' && auto[roleOf('profit')!.id] === 'Net Profit', JSON.stringify(auto));
const userMap: Record<string, string> = {};
for (const r of cap.roles) userMap[r.id] = RENAME[r.column];
const OTHER_METRIC = { id: uuid(), name: 'Revenue', datasetId: uuid(), definition: { column: 'x', aggregation: 'sum' } };
const ren = planApply(tpl, userMap, { datasetId: T2, columns: RENAMED_COLS, steps: [], metrics: [OTHER_METRIC] }, { newId: uuid });
const renJson = JSON.stringify(ren);
ok('renamed: everything built, nothing dropped', ren.dropped.length === 0 && ren.tiles === 9, ren.dropped.join(' | '));
ok('renamed: Month is created on the target, reading the renamed date column',
  ren.newSteps.length === 1 && ren.newSteps[0].name === 'Month' && ren.newSteps[0].expression === "datetrunc('month', [Order Date])",
  JSON.stringify(ren.newSteps));
ok('renamed: metrics are recreated on the new columns; a name another dataset holds is not reused but numbered',
  ren.metrics.every((m) => !m.reuseId) && ren.metrics[0].input!.name === 'Revenue 2'
  && JSON.stringify(ren.metrics[0].input!.definition) === JSON.stringify({ column: 'Sales Amount', aggregation: 'sum' }),
  JSON.stringify(ren.metrics[0]));
ok('…and a formula metric follows the renamed metric it reads',
  JSON.stringify(ren.metrics[4].input!.definition) === JSON.stringify({ formula: '[Profit] / [Revenue 2]' }),
  JSON.stringify(ren.metrics[4].input));
ok('…and the note\'s {{token}} names the metric by its new name', renJson.includes('{{Margin %}}') && !renJson.includes('{{$m'));
ok('renamed: no source column name is left in any column slot',
  !Object.keys(RENAME).some((c) => new RegExp(`"(column|category|series)":"${c}"`).test(renJson)) && !/order_date/.test(renJson));
ok('renamed: charts, the control, the filter and the list parameter all point at the target dataset',
  ren.visuals.every((v) => v.input.datasetId === T2) && renJson.includes(`"datasetId":"${T2}"`) && !renJson.includes(DS));
ok('renamed: the KPI preview reads the renamed columns', ren.kpis.map((x) => x.column).join(',') === 'Sales Amount,Net Profit,Qty,Order Date');

// ── §4 optional roles left unmapped are dropped, with everything that needs them ─

const optionalIds = [roleOf('state')!.id, roleOf('order_date')!.id];
const optional: UserTemplate = { ...tpl, roles: tpl.roles.map((r) => (optionalIds.includes(r.id) ? { ...r, required: false } : r)) };
const partial = { ...userMap };
delete partial[roleOf('state')!.id];
delete partial[roleOf('order_date')!.id];
const drop = planApply(optional, partial, { datasetId: T2, columns: RENAMED_COLS, steps: [], metrics: [] }, { newId: uuid });
const said = drop.dropped.join(' | ');
ok('optional: the map that needs State is skipped, and says so', said.includes('Chart “Profit by state” — needs State'), said);
ok('optional: Month needs Order date, so it goes — and the chart and KPI that read it, and the Orders metric',
  drop.newSteps.length === 0 && said.includes('Calculated field “Month” — needs Order date')
  && said.includes('Chart “Revenue by month” — needs the calculated field Month') && said.includes('Metric “Orders”')
  && said.includes('Tile “Orders”'), said);
ok('optional: "N tiles skipped" is exact', drop.total === 9 && drop.tiles === 6, `${drop.tiles}/${drop.total}`);
ok('optional: everything that does not need them is still built', drop.visuals.length === 1 && drop.metrics.length === 4);

// ── §5 formulas: token level, LOD included ─────────────────────────────────

const names: RefNames = { columns: new Map([['region', 'r2'], ['category', 'r4'], ['revenue', 'r7'], ['Order Date', 'r1']]), metrics: new Map(), ids: new Map() };
const lod = '{FIXED [region], category : SUM([revenue])} / sum(revenue)';
ok('formula: column refs inside an LOD rewrite like any other, braces and colon passed through',
  formulaToRefs(lod, names, 'calc') === '{FIXED [$r2], [$r4] : SUM([$r7])} / sum([$r7])', formulaToRefs(lod, names, 'calc'));
ok('…and back', formulaFromRefs('{FIXED [$r2], [$r4] : SUM([$r7])}', (id) => ({ r2: 'Sales Region', r4: 'cat', r7: 'Sales Amount' } as Record<string, string>)[id])
  === '{FIXED [Sales Region], cat : SUM([Sales Amount])}');
// With the LOD engine in (src/formula/lod.ts): an LOD rewritten onto a renamed
// dataset still COMPILES, and keeps its dimensions — the round trip is a formula,
// not just a string that looks like one.
{
  const back = formulaFromRefs(formulaToRefs('[revenue] / {FIXED [region] : SUM([revenue])}', names, 'calc'),
    (id) => ({ r2: 'Sales Region', r7: 'Sales Amount' } as Record<string, string>)[id]) || '';
  const c = compile(back);
  ok('formula: a rewritten LOD compiles against the renamed columns', c.ok, `${back} → ${c.ok ? 'ok' : (c as { error: string }).error}`);
  ok('…and names the renamed dimension', lodColumnRefs(back).includes('Sales Region'), JSON.stringify(lodColumnRefs(back)));
}
ok('formula: a string literal and a function name are never touched',
  formulaToRefs("if([category] = 'revenue', category(1), 0)", names, 'calc') === "if([$r4] = 'revenue', category(1), 0)");
ok('formula: a [[parameter]] is not a column', formulaToRefs('[[region]] + [Order Date]', names, 'calc') === '[[region]] + [$r1]');
ok('formula: an unresolvable ref fails the formula rather than writing a hole', formulaFromRefs('[$r9] + 1', () => null) === null);

// ── §6 the .ordinate-template trust boundary ─────────────────────────────────

const file = toTemplateFile({ ...tpl, sourceAnalysisId: uuid(), thumbnail: 'data:image/png;base64,iVBORw0KGgo=' });
const back = fromTemplateFile(file, uuid);
ok('file: a template survives its own export', back.ok && JSON.stringify({ ...back.template, sourceAnalysisId: undefined })
  === JSON.stringify({ ...tpl, thumbnail: 'data:image/png;base64,iVBORw0KGgo=', sourceAnalysisId: undefined }));
ok('file: the source dashboard id stays home', !file.includes('sourceAnalysisId'));
ok('file: not JSON is refused', !fromTemplateFile('{nope', uuid).ok);
ok('file: another format is refused', !fromTemplateFile(JSON.stringify({ format: 'ordinate-project', formatVersion: 1, template: tpl }), uuid).ok);
ok('file: a newer version is refused', !fromTemplateFile(JSON.stringify({ format: 'ordinate-template', formatVersion: 2, template: tpl }), uuid).ok);
const junk = sanitizeUserTemplate(JSON.parse(JSON.stringify({
  id: '../../etc', name: 'x', roles: [{ id: 'r1', label: 'A', kind: 'evil', hints: ['A', 3] }, { id: '../r2' }],
  thumbnail: 'data:image/svg+xml;base64,PHN2Zz4=',
  body: {
    sheets: [{ name: 'S', cards: [{ type: 'text', text: 'data:text/html,<script>', heading: 'ok', ['__proto__']: { polluted: 1 },
      layout: { x: Infinity }, metric: { column: { $ref: 'r1; drop' } }, n: { $ref: 'r1', extra: 1 } }] }],
    visuals: [{ ref: 'zz', spec: {} }, { ref: 'v1', spec: { name: 'ok' } }],
    calcFields: [{ ref: 'c1', name: '', expression: '1' }],
  },
})), () => 'fresh');
const junkJson = JSON.stringify(junk);
ok('file: junk is whitelisted, not trusted — a bad id is replaced, a bad kind clamped, a bad role dropped',
  !!junk && junk.id === 'fresh' && junk.roles.length === 1 && junk.roles[0].kind === 'dimension' && JSON.stringify(junk.roles[0].hints) === '["a"]', junkJson);
ok('file: only a PNG thumbnail; no other data: URL anywhere', !!junk && junk.thumbnail === '' && !junkJson.includes('data:'));
ok('file: malformed refs and ref-shaped objects with extras are dropped; a bad visual ref is dropped',
  !junkJson.includes('r1; drop') && !junkJson.includes('"extra"') && junk!.body.visuals.length === 1 && junk!.body.calcFields.length === 0, junkJson);
ok('file: no prototype key survives', !Object.prototype.hasOwnProperty.call((junk!.body.sheets[0] as { cards: object[] }).cards[0], '__proto__')
  && (Object.prototype as Record<string, unknown>).polluted === undefined);

finish();
