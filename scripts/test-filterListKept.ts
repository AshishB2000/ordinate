// A filter list KEEPS a step this pod cannot read (semantic layer, PR 05a). A glossary `term` step is
// a reference; an older pod that drops it on save deletes it, and one that skips it widens a figure.
// So every store that holds a `filters` list sanitizes through ONE function, `sanitizeFilterList`,
// which keeps a `term` and any future step verbatim, in order, within the kept-step limits.
//
//   § stores   visual, dashboard (own + a sheet card's inline visual), metric, story, alert rule,
//              scenario driver, saved view, published copy, Assistant answer: a term and a future
//              step survive save -> get -> an unrelated update -> get; a 3 KB step is dropped
//   § merge    mergeDashboardFilters keeps a term once and never folds it into a filter; the row
//              lock keeps a term; a kept step's key is its whole body
//   § list     the limits (size, name, plain JSON), a refused filter is dropped not kept, via and
//              fromControl still reach a filter, tileSpec / sanitizeStoredSpec carry `{ term }`
//   § control  Prepare (datasets.updateSteps) stores no term
//
//   npm run build:ts && node scripts/test-filterListKept.js

import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-filterlist-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const scenarios: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
const savedViews: typeof import('../src/analysis/savedViews') = require('../src/analysis/savedViews');
const published: typeof import('../src/analysis/publishedCopy') = require('../src/analysis/publishedCopy');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const { sanitizeStoredSpec } = require('../src/ai/answerSpec') as typeof import('../src/ai/answerSpec');
const { tileSpec } = require('../src/ipc/answers') as typeof import('../src/ipc/answers');
const { mergeDashboardFilters } = require('../src/analysis/dashboardFilters') as typeof import('../src/analysis/dashboardFilters');
const { withLockSteps } = require('../src/data/rowAccess') as typeof import('../src/data/rowAccess');
const { lockStep } = require('../src/data/rowLock') as typeof import('../src/data/rowLock');
const cardModel = require('../src/analysis/cardModel') as { carrySteps(action: unknown, ctx: unknown): unknown[] };
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');
const fl: typeof import('../src/data/filterList') = require('../src/data/filterList');
const { sanitizeSteps } = require('../src/data/transforms') as typeof import('../src/data/transforms');

import type { FilterStep } from '../src/data/transforms';
import type { Lock } from '../src/data/rowLock';

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const S = stableStringify;
const F0 = { type: 'filter', column: 'city', op: '=', value: 'Paris' };
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1, nested: { b: [2] } };
const BIG = { type: 'future_big', huge: 'x'.repeat(3000) };
const WANT = S([F0, TERM, FUTURE]);
const has = (v: unknown, what: string): boolean => JSON.stringify(v).includes(what);
const as = (v: unknown): FilterStep[] => v as FilterStep[];

async function main(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Filter list')).id;
  const ds = await datasets.saveDataset(P, {
    name: 'Cities', sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' }, { name: 'pop', type: 'number' }],
    rows: [['Paris', 1], ['Berlin', 2]],
  });
  if (!ds) throw new Error('fixture dataset');
  const D = ds.id;
  const enc = { category: 'city', values: [{ column: 'pop', aggregation: 'sum' as const }] };
  const keeps = (store: string, first: unknown, second: unknown): void =>
    ok(`${store}: a term and a future step survive save -> get -> unrelated update -> get`, S(first) === WANT && S(second) === WANT, `${S(first)} | ${S(second)}`);

  // ── § stores ───────────────────────────────────────────────────────────────
  const v = await visuals.saveVisual(P, { name: 'V', datasetId: D, chartType: 'column', encoding: enc, filters: [F0, TERM, FUTURE] });
  const v1 = v && (await visuals.getVisual(P, v.id));
  const v2 = v && (await visuals.updateVisual(P, v.id, { name: 'V two' })) && (await visuals.getVisual(P, v.id));
  keeps('visuals', v1 && v1.filters, v2 && v2.filters);
  const vBig = await visuals.saveVisual(P, { name: 'B', datasetId: D, chartType: 'column', encoding: enc, filters: [F0, BIG] });
  ok('visuals: a 3 KB unknown step is dropped', !!vBig && !has((await visuals.getVisual(P, vBig.id))!.filters, 'huge') && vBig.filters.length === 1);

  const inline = { datasetId: D, chartType: 'column', encoding: enc, filters: [F0, TERM, FUTURE] };
  const sheets = [{ id: U, name: 'S', cards: [{ id: '11111111-1111-4111-8111-111111111111', type: 'visual', visual: inline, layout: { x: 0, y: 0, w: 4, h: 4 } }] }];
  const a = await analysis.saveAnalysis(P, { name: 'A', sheets, filters: [F0, TERM, FUTURE] });
  const a1 = a && (await analysis.getAnalysis(P, a.id));
  const a2 = a && (await analysis.updateAnalysis(P, a.id, { name: 'A two' })) && (await analysis.getAnalysis(P, a.id));
  keeps('analysis dashboard filters', a1 && a1.filters, a2 && a2.filters);
  keeps('analysis sheet card visual.filters', a1 && a1.sheets[0].cards[0].visual!.filters, a2 && a2.sheets[0].cards[0].visual!.filters);
  const aBig = await analysis.saveAnalysis(P, { name: 'AB', filters: [F0, BIG] });
  ok('analysis: a 3 KB unknown step is dropped', !!aBig && !has((await analysis.getAnalysis(P, aBig.id))!.filters, 'huge'));

  const m = await metrics.saveMetric(P, { name: 'M', datasetId: D, definition: { column: 'pop', aggregation: 'sum' }, filters: [F0, TERM, FUTURE] });
  const m1 = m && (await metrics.getMetric(P, m.id));
  const m2 = m && (await metrics.updateMetric(P, m.id, { name: 'M two' })) && (await metrics.getMetric(P, m.id));
  keeps('metrics', m1 && m1.filters, m2 && m2.filters);
  const mBig = await metrics.saveMetric(P, { name: 'MB', datasetId: D, definition: { column: 'pop', aggregation: 'sum' }, filters: [F0, BIG] });
  ok('metrics: a 3 KB unknown step is dropped', !!mBig && !has((await metrics.getMetric(P, mBig.id))!.filters, 'huge'));

  const block = (filters: unknown[]) => ({ kind: 'visual', visualId: v ? v.id : U, filters });
  const st = await stories.saveStory(P, { name: 'St', blocks: [block([F0, TERM, FUTURE])] });
  const filtersOfStory = (s: Awaited<ReturnType<typeof stories.getStory>>): unknown => s && (s.blocks[0] as { filters: unknown }).filters;
  const st1 = st && (await stories.getStory(P, st.id));
  const st2 = st && (await stories.updateStory(P, st.id, { name: 'St two' })) && (await stories.getStory(P, st.id));
  keeps('stories', filtersOfStory(st1), filtersOfStory(st2));
  const stBig = await stories.saveStory(P, { name: 'SB', blocks: [block([F0, BIG])] });
  ok('stories: a 3 KB unknown step is dropped', !!stBig && !has((await stories.getStory(P, stBig.id))!.blocks, 'huge'));

  const metric = (filters: unknown[]) => ({ column: 'pop', aggregation: 'sum', filters });
  const rule = (filters: unknown[]) => ({ name: 'R', datasetId: D, metric: metric(filters), compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
  const r = await alertStore.saveRule(P, rule([F0, TERM, FUTURE]));
  const r1 = r && (await alertStore.load(P)).rules.find((x) => x.id === r.id);
  const r2 = r && (await alertStore.patchRule(P, r.id, { enabled: false })) && (await alertStore.load(P)).rules.find((x) => x.id === r.id);
  keeps('alertStore.saveRule', r1 && r1.metric.filters, r2 && r2.metric.filters);
  const rBig = await alertStore.saveRule(P, rule([F0, BIG]));
  ok('alertStore.saveRule: a 3 KB unknown step is dropped', !!rBig && !has(rBig.metric.filters, 'huge'));

  const driver = (filter: unknown) => ({ name: 'd', kind: 'pct', value: 5, target: { column: 'pop', filter } });
  const sc = await scenarios.saveScenario(P, { name: 'Sc', baseMetricIds: [], drivers: [driver(TERM), driver(FUTURE), driver(F0)] });
  const targets = (s: Awaited<ReturnType<typeof scenarios.getScenario>>): unknown => s && s.drivers.map((d) => (d.target as { filter?: unknown }).filter);
  const sc1 = sc && (await scenarios.getScenario(P, sc.id));
  const sc2 = sc && (await scenarios.updateScenario(P, sc.id, { name: 'Sc two' })) && (await scenarios.getScenario(P, sc.id));
  ok('scenarios: a driver target keeps a term and a future step (ONE step each) through save -> get -> update -> get',
    S(targets(sc1)) === S([TERM, FUTURE, F0]) && S(targets(sc2)) === S([TERM, FUTURE, F0]), S(targets(sc2)));
  const scBig = await scenarios.saveScenario(P, { name: 'ScB', baseMetricIds: [], drivers: [driver(BIG)] });
  ok('scenarios: a 3 KB unknown step is dropped (the driver stays, unfiltered)', !!scBig && !has((await scenarios.getScenario(P, scBig.id))!.drivers, 'huge'));

  const scope = { sheets: [], parameters: [] };
  const viewOf = (raw: unknown) => savedViews.sanitizeViewState(raw, scope);
  const rawView = { selection: [F0, TERM, FUTURE], tiles: { [U]: [F0, TERM, FUTURE] } };
  const view1 = viewOf(rawView);
  const view2 = viewOf(JSON.parse(JSON.stringify(view1)));
  keeps('savedViews selection', view1.selection, view2.selection);
  keeps('savedViews tile', view1.tiles[U], view2.tiles[U]);

  const copyRaw = { contentHash: 'h', publishedAt: '2026-01-01T00:00:00.000Z', filters: [F0, TERM, FUTURE], sheets: [] };
  const copy1 = published.sanitizePublished(copyRaw, () => U);
  const copy2 = published.sanitizePublished(JSON.parse(JSON.stringify(copy1)), () => U);
  keeps('publishedCopy', copy1 && copy1.filters, copy2 && copy2.filters);

  const answer = { datasetId: D, category: 'city', measures: [{ column: 'pop', aggregation: 'sum' }], chartType: 'column', filters: [{ column: 'city', op: '=', value: 'Paris' }, { term: U }] };
  await copilot.appendTurn(P, { role: 'assistant', text: 'Here.', answer } as never);
  const asked = (await copilot.loadHistory(P)).find((t) => t.answer);
  ok('copilot.appendTurn: an answer filter { term } survives save -> load',
    !!asked && S(asked.answer!.filters) === S(answer.filters), asked && S(asked.answer!.filters));

  // ── § merge ────────────────────────────────────────────────────────────────
  ok('merge keeps a term once and never folds it into a filter', S(mergeDashboardFilters(as([TERM, F0]), as([TERM, F0]))) === S([TERM, F0]));
  ok('merge: two different terms are two steps, a term and a future step are two', S(mergeDashboardFilters(as([TERM]), as([{ type: 'term', term: D }, FUTURE]))) === S([TERM, { type: 'term', term: D }, FUTURE]));
  ok('NEGATIVE CONTROL: merge still drops a non-object and a step with no type', S(mergeDashboardFilters(as([null, 5, { column: 'x' }, F0]), undefined)) === S([F0]));
  const LOCK = { values: { city: ['Paris'] }, steps: [lockStep('city', ['Paris'])], covers: async () => true } as Lock;
  ok('withLockSteps keeps a term after the lock', S(withLockSteps(LOCK, as([TERM]))) === S([...LOCK.steps, TERM]));
  ok('withLockSteps: a lock already first is not doubled, and the term after it stays', S(withLockSteps(LOCK, as([...LOCK.steps, TERM]))) === S([...LOCK.steps, TERM]));
  ok('NEGATIVE CONTROL: withLockSteps still drops a Prepare step and a non-object', S(withLockSteps(LOCK, as([{ type: 'drop_column', column: 'x' }, null, F0]))) === S([...LOCK.steps, F0]));

  const carried = cardModel.carrySteps({ carry: 'all_selection' }, { filters: [F0, TERM], selection: [TERM, FUTURE, { type: 'filter' }] });
  ok('a tile action carries a term and a future step once each, in order', S(carried) === S([F0, TERM, FUTURE]), S(carried));
  ok('NEGATIVE CONTROL: a carried filter with no column is still dropped, and clicked_value carries only the click',
    S(cardModel.carrySteps({ carry: 'all_selection' }, { filters: [{ type: 'filter' }] })) === '[]' && cardModel.carrySteps({ carry: 'clicked_value' }, { filters: [TERM] }).length === 0);

  // ── § list ─────────────────────────────────────────────────────────────────
  const list = fl.sanitizeFilterList;
  ok('a non-array is []', S(list(undefined)) === '[]' && S(list({ type: 'term' })) === '[]' && S(list('x')) === '[]');
  ok('the list keeps order and verbatim bodies', S(list([TERM, F0, FUTURE, TERM])) === S([TERM, F0, FUTURE, TERM]));
  ok('NEGATIVE CONTROL: a filter sanitizeFilterStep refuses is dropped, not kept as an unknown step', list([{ type: 'filter', column: 'a', op: 'nope' }, { type: 'filter' }]).length === 0);
  ok('a filter still gets its whitelist (an unknown field goes, via and fromControl stay)',
    S(list([{ ...F0, evil: 1, via: U, fromControl: true }])) === S([{ ...F0, via: U, fromControl: true }]));
  ok('a term keeps its own fromControl flag', S(list([{ ...TERM, fromControl: true }])) === S([{ ...TERM, fromControl: true }]));
  const bad = [{ type: 'Term' }, { type: '1x' }, { type: 'x-y' }, { type: '' }, { type: 'a'.repeat(65) }, { type: 5 }, { term: U }, null, 7, 'term', [TERM]];
  ok('NEGATIVE CONTROL: a type that is not a lowercase name, or no type, or a non-object is dropped', list(bad).length === 0, S(list(bad)));
  ok('a 64-character type name is kept', list([{ type: 'a'.repeat(64) }]).length === 1);
  const cyclic: Record<string, unknown> = { type: 'future_c' };
  cyclic.self = cyclic;
  ok('NEGATIVE CONTROL: a BigInt or a cycle is dropped (not plain JSON)', list([{ type: 'future_n', n: BigInt(1) }, cyclic]).length === 0);
  const edge = (n: number) => ({ type: 'future_e', pad: 'x'.repeat(n) });
  const base = Buffer.byteLength(JSON.stringify(edge(0)));
  ok('2048 bytes is kept, 2049 is dropped', list([edge(fl.MAX_KEPT_STEP_BYTES - base)]).length === 1 && list([edge(fl.MAX_KEPT_STEP_BYTES - base + 1)]).length === 0);
  ok('the limit is bytes, not characters', list([{ type: 'future_e', pad: '\u00e9'.repeat(1030) }]).length === 0);
  ok('a kept step is a copy, never the caller\'s object', (() => { const o = { type: 'future_x', k: [1] }; const out = list([o]); return out[0] !== (o as unknown) && S(out) === S([o]); })());
  const prepare = [{ type: 'dedupe' }, { type: 'group_aggregate', groupBy: ['a'], aggregations: [] }, { type: 'calculated_field', name: 'x', expression: '1' }, { type: 'drop_column', column: 'a' }];
  ok('NEGATIVE CONTROL: a Prepare step this pod knows is no filter-list step and is dropped, as it always was', list(prepare).length === 0 && prepare.every((p) => !fl.isKeptStep(p)));
  ok('isKeptStep: an object with a string type other than filter', fl.isKeptStep(TERM) && fl.isKeptStep(FUTURE) && !fl.isKeptStep(F0) && !fl.isKeptStep({ type: 5 }) && !fl.isKeptStep(null) && !fl.isKeptStep([TERM]) && !fl.isKeptStep('term'));

  const spec = tileSpec({ datasetId: D, encoding: enc, filters: as([F0, TERM]), chartType: 'column', name: 'T' });
  ok('tileSpec maps a term step to { term } and a filter to its comparison', !!spec && S(spec.filters) === S([{ column: 'city', op: '=', value: 'Paris' }, { term: U }]), spec && S(spec.filters));
  ok('NEGATIVE CONTROL: tileSpec builds no spec for a step it cannot read (never a widened chart)', tileSpec({ datasetId: D, encoding: enc, filters: as([F0, FUTURE]), chartType: 'column', name: 'T' }) === null);
  const stored = (filters: unknown[]) => sanitizeStoredSpec({ ...answer, filters });
  ok('sanitizeStoredSpec keeps { term } only when it is a UUID',
    S(stored([{ term: U }, { term: 'x' }, { term: 5 }])!.filters) === S([{ term: U }]));
  ok('NEGATIVE CONTROL: sanitizeStoredSpec drops any other column-less filter, and keeps nothing extra of a term',
    S(stored([{ op: '=', value: 1 }, { type: 'term', term: U, extra: 1 }, { period: 'last_year' }])!.filters) === S([{ term: U }]));

  const mf = require('../src/analysis/metricFormat') as typeof import('../src/analysis/metricFormat');
  ok('describeFilter names a term by its kind (no "undefined"), a filter as before',
    mf.describeFilter(TERM as unknown as FilterStep) === 'term' && mf.describeFilter(FUTURE as unknown as FilterStep) === 'future x' && mf.describeFilter(F0 as FilterStep) === 'city = Paris');

  // ── § control ──────────────────────────────────────────────────────────────
  ok('NEGATIVE CONTROL: Prepare (sanitizeSteps) drops a term and a future step', sanitizeSteps([TERM, FUTURE]).length === 0);
  ok('NEGATIVE CONTROL: datasets.updateSteps stores no term step', !(await datasets.updateSteps(P, D, [F0, TERM]))!.dataset.steps!.some((s) => (s as { type: string }).type === 'term'));
}

main().then(() => finish(), (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
