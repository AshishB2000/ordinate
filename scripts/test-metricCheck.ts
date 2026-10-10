// WHY a metric formula would have no value — analysis/metricCheck.ts.
//
// The resolver degrades every one of these to null on purpose (a typo must not
// read as zero), which is right for a figure and silent for whoever is typing.
// So each refusal is pinned as a SENTENCE with the SPAN of the text it is
// about — the editor underlines exactly that — and each has a NEGATIVE CONTROL:
// the nearest valid formula passes clean.
//
// The second half is the differential: whatever the check passes, the resolver
// (through `metric:check`'s own preview) gives a value; whatever it refuses for
// a circular or unknown reference, the resolver gives none. Two answers to "is
// this a metric" must not disagree.
//
//   npm run build:ts && node scripts/test-metricCheck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metriccheck-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const { checkMetricFormula }: typeof import('../src/analysis/metricCheck') = require('../src/analysis/metricCheck');
const { checkMetric }: typeof import('../src/ipc/metricCheck') = require('../src/ipc/metricCheck');
type Known = import('../src/analysis/metricCheck').KnownMetric;

const DS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const COLUMNS = [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' }, { name: 'day', type: 'date' }];
const known = (list: Known[]): Map<string, Known> => new Map(list.map((m) => [m.name.toLowerCase(), m]));
const METRICS = known([
  { name: 'Revenue', datasetId: DS, refs: [] },
  { name: 'Profit', datasetId: DS, refs: [] },
  { name: 'Margin', datasetId: DS, refs: ['Profit', 'Revenue'] },
  { name: 'Target', datasetId: OTHER, refs: [] },
]);
const check = (expression: string, over: Partial<Parameters<typeof checkMetricFormula>[0]> = {}) =>
  checkMetricFormula({ expression, datasetId: DS, columns: COLUMNS, metrics: METRICS, ...over });
const cut = (expression: string, at?: { start: number; end: number }): string => (at ? expression.slice(at.start, at.end) : '(no span)');

function pure(): void {
  // ── valid: the negative controls for everything below ──
  for (const f of ['[Profit] / [Revenue]', 'sum(profit) / sum(revenue)', 'sum([profit]) - sum([revenue])', 'count(region)', '[Margin] * 100', 'min(revenue) + max(revenue)']) {
    const r = check(f, { self: 'New measure' });
    ok(`valid: ${f}`, r.ok === true && r.error === undefined && r.tokens.length > 0, JSON.stringify(r));
  }

  // ── syntax: the compiler's own error, at its own position ──
  const syn = check('sum(revenue) /');
  ok('syntax: refused with the compiler\'s message and a position', syn.ok === false && syn.code === 'syntax' && !!syn.error && !!syn.at, JSON.stringify(syn));
  ok('syntax: tokens survive, so the highlight does not blink out', syn.tokens.length > 0);

  // ── a bare column: a measure needs a total ──
  // (No metric shares the column's name here: a metric is found by name, case-insensitively, first.)
  const col = check('[profit] / [revenue]', { metrics: known([]) });
  ok('column: a bare column is refused with how to total it', col.ok === false && col.code === 'column' && /sum\(\[profit\]\)/.test(col.error ?? ''), JSON.stringify(col));
  ok('column: the span is the reference as written', cut('[profit] / [revenue]', col.at) === '[profit]');
  ok('NEGATIVE CONTROL: the same text is valid once metrics carry those names', check('[profit] / [revenue]').ok === true);

  // ── unknown metric, with the near miss ──
  const typo = check('[Profit] / [Revenu]');
  ok('unknown: refused, offering the nearest metric', typo.ok === false && typo.code === 'unknown' && /\[Revenue\]/.test(typo.error ?? ''), JSON.stringify(typo));
  ok('unknown: the span is the typo, not the first reference', cut('[Profit] / [Revenu]', typo.at) === '[Revenu]');
  const far = check('[Zzzzzz] + 1');
  ok('unknown: nothing close → no suggestion', far.ok === false && far.code === 'unknown' && !/Did you mean/.test(far.error ?? ''), far.error);

  // ── type: sum over text ──
  const type = check('sum(revenue) / sum(region)');
  ok('type: sum over a text column is refused, offering count', type.ok === false && type.code === 'type' && /count\(\[region\]\)/.test(type.error ?? ''), JSON.stringify(type));
  ok('type: the span is the whole call', cut('sum(revenue) / sum(region)', type.at) === 'sum(region)');
  ok('type: avg over a date is refused too', check('avg(day)').code === 'type');
  ok('NEGATIVE CONTROL: count over text is a real total', check('count(region)').ok === true);

  // ── circular ──
  const self = check('[Margin] * 2', { self: 'margin' });
  ok('circular: a formula naming the metric it defines', self.ok === false && self.code === 'circular' && /refers to itself/.test(self.error ?? ''), JSON.stringify(self));
  // Editing Revenue (so it is not in the map) to depend on Margin, which depends on Revenue.
  const without = known(Array.from(METRICS.values()).filter((m) => m.name !== 'Revenue'));
  const loop = check('[Margin] + 1', { self: 'Revenue', metrics: without });
  ok('circular: round a loop, with the chain spelled out', loop.ok === false && loop.code === 'circular' && (loop.error ?? '').includes('[Revenue] → [Margin] → [Revenue]'), loop.error);
  ok('circular: the span is the reference that closes the loop', cut('[Margin] + 1', loop.at) === '[Margin]');
  const others = known([{ name: 'A', datasetId: DS, refs: ['B'] }, { name: 'B', datasetId: DS, refs: ['A'] }]);
  const existing = check('[A] * 2', { self: 'C', metrics: others });
  ok('circular: a loop between two OTHER metrics is named too', existing.ok === false && existing.code === 'circular' && (existing.error ?? '').includes('[A] → [B] → [A]'), existing.error);
  ok('NEGATIVE CONTROL: the same chain without the loop passes', check('[Margin] + 1', { self: 'Net margin' }).ok === true);

  // ── a chart measure: every operand on this dataset ──
  const foreign = check('[Revenue] / [Target]', { chart: true });
  ok('chart: a metric on another dataset is refused for a chart', foreign.ok === false && foreign.code === 'dataset' && cut('[Revenue] / [Target]', foreign.at) === '[Target]', JSON.stringify(foreign));
  ok('NEGATIVE CONTROL: the same formula is a fine KPI', check('[Revenue] / [Target]').ok === true);
}

async function againstTheResolver(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Metric check')).id;
  const ds = await datasets.saveDataset(P, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' }],
    rows: [['West', 100, 10], ['West', 300, 90], ['East', 200, 20]],
  });
  if (!ds) throw new Error('dataset not saved');
  const revenue = await metrics.saveMetric(P, { name: 'Revenue', datasetId: ds.id, definition: { column: 'revenue', aggregation: 'sum' } });
  await metrics.saveMetric(P, { name: 'Profit', datasetId: ds.id, definition: { column: 'profit', aggregation: 'sum' } });
  await metrics.saveMetric(P, { name: 'Margin', datasetId: ds.id, definition: { formula: '[Profit] / [Revenue]' } });
  if (!revenue) throw new Error('metric not saved');
  const ask = (expression: string, extra: Record<string, unknown> = {}) => checkMetric({ projectId: P, datasetId: ds.id, expression, ...extra });

  const good = await ask('sum(profit) / sum(revenue)', { name: 'Margin %', format: { kind: 'percent', decimals: 1 } });
  ok('a formula the check passes has a value, formatted by the server', good.ok === true && good.preview?.ok === true && Object.is(good.preview.value, 120 / 600) && good.preview.display === '20.0%', JSON.stringify(good));
  // The worked example the dialog shows: 10/100 and 90/300 and 20/200 average to 16.67%, the measure is 20%.
  ok('NEGATIVE CONTROL: the mean of the row margins is not the measure', good.preview?.ok === true && !Object.is(good.preview.value, (10 / 100 + 90 / 300 + 20 / 200) / 3));
  const viaMetrics = await ask('[Profit] / [Revenue]', { name: 'Margin 2' });
  ok('the same figure through metric references (Object.is)', viaMetrics.preview?.ok === true && good.preview?.ok === true && Object.is(viaMetrics.preview.value, good.preview.value));

  const taken = await ask('sum(profit)', { name: 'margin' });
  ok('a taken name is said with the check, in the save\'s own sentence', taken.ok === true && taken.nameError === 'A metric called "margin" already exists.', JSON.stringify(taken));
  ok('NEGATIVE CONTROL: its own name is free while editing it', (await ask('sum(revenue)', { name: 'Revenue', id: revenue.id })).nameError === undefined);

  // What the check refuses, the resolver gives no value for: the two cannot disagree.
  const loop = await ask('[Margin] + 1', { name: 'Revenue', id: revenue.id });
  ok('editing Revenue to depend on Margin is refused as circular, with no preview', loop.ok === false && loop.code === 'circular' && loop.preview === undefined, JSON.stringify(loop));
  await metrics.updateMetric(P, revenue.id, { definition: { formula: '[Margin] + 1' } });
  const { resolveMetric }: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
  ok('… and saved anyway, the resolver gives it no value (never zero)', (await resolveMetric(P, revenue.id))?.value === null);

  const unknown = await ask('[Nope] * 2', { name: 'X' });
  ok('an unknown reference is refused, with no preview', unknown.ok === false && unknown.code === 'unknown' && unknown.preview === undefined);
  const long = await ask('1 + '.repeat(600) + '1', { name: 'Long' });
  ok('an over-long formula is refused by the handler, in a sentence', long.ok === false && /too long/.test(long.error ?? ''), long.error);
  const noDs = await checkMetric({ projectId: P, datasetId: OTHER, expression: 'sum(revenue)' });
  ok('a dataset that is gone is said, not thrown', noDs.ok === false && noDs.error === 'Dataset not found');
}

(async () => {
  pure();
  await againstTheResolver();
  finish();
})().catch((err) => {
  ok('test-metricCheck ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
