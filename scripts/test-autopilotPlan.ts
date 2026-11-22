// Autopilot's decisions (src/server/autopilot/plan.ts, repair.ts), pure: what is moved to Trash, what is repaired exactly, what is only
// listed. Every "never touch" rule has a negative control: the same chart WITHOUT the protecting fact IS moved, so the rule is what held it.
//
//   npm run build:ts && node scripts/test-autopilotPlan.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const plan: typeof import('../src/server/autopilot/plan') = require('../src/server/autopilot/plan');
const repair: typeof import('../src/server/autopilot/repair') = require('../src/server/autopilot/repair');

const TODAY = '2026-06-30';
const old = '2025-01-01T00:00:00.000Z';
const enc = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] };
const vis = (id: string, o: Partial<import('../src/server/autopilot/plan').VisualIn> = {}) => ({ id, name: `chart ${id}`, datasetId: 'd1', createdAt: old, encoding: enc, filters: [], ...o });
const ds = (o: Partial<import('../src/server/autopilot/plan').DatasetIn> = {}) => ({ id: 'd1', name: 'Orders', columns: ['region', 'sales', 'day'], missing: [], live: false, certified: false, ...o });

function input(o: Partial<import('../src/server/autopilot/plan').PlanIn> & { visuals: import('../src/server/autopilot/plan').VisualIn[] }): import('../src/server/autopilot/plan').PlanIn {
  return {
    today: TODAY, settings: { windowDays: 90, slowMs: 5000, trashUnused: true, repairRenames: true }, datasets: new Map([['d1', ds()]]), renames: [],
    usedElsewhere: new Set(), certifiedMetrics: new Set(),
    usage: { firstDay: '2026-01-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set() }, ...o,
  };
}
const ids = (p: Array<{ visualId: string }>): string => p.map((x) => x.visualId).join();

// ── unused ────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('an old chart nobody opened in 90 days, on covered usage, is moved', ids(plan.planRun(input({ visuals: [vis('a')] })).trash) === 'a');
ok('control: opened inside the window, it stays', plan.planRun(input({ visuals: [vis('a')], usage: { firstDay: '2026-01-01', openedSince: new Set(['a']), week: new Map(), trashedBefore: new Set() } })).trash.length === 0);
const guarded: Array<[string, Partial<import('../src/server/autopilot/plan').PlanIn>, Partial<import('../src/server/autopilot/plan').VisualIn>?]> = [
  ['on a dashboard, in a Story, a report or an alert (any record that mentions it)', { usedElsewhere: new Set(['a']) }],
  ['on a certified dataset', { datasets: new Map([['d1', ds({ certified: true })]]) }],
  ['built on a certified metric', { certifiedMetrics: new Set(['m1']) }, { encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum', metricId: 'm1' }] } }],
  ['newer than the window', {}, { createdAt: '2026-05-01T00:00:00.000Z' }],
  ['one Autopilot moved before that came back', { usage: { firstDay: '2026-01-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set(['a']) } }],
  ['usage that does not cover the window yet', { usage: { firstDay: '2026-05-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set() } }],
  ['no usage recorded at all', { usage: { firstDay: null, openedSince: new Set(), week: new Map(), trashedBefore: new Set() } }],
];
for (const [what, extra, v] of guarded) {
  ok(`never moved: ${what}`, plan.planRun(input({ visuals: [vis('a', v)], ...extra })).trash.length === 0);
}
ok('control: the certified-metric chart IS moved without the certified metric', ids(plan.planRun(input({ visuals: [vis('a', { encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum', metricId: 'm1' }] } })] })).trash) === 'a');
// the window's edge: usage must start the day BEFORE the window starts
ok('coverage: first row on 2026-04-01 covers a 90-day window ending 2026-06-30 only from 2026-07-01', plan.planRun(input({ visuals: [vis('a')], usage: { firstDay: '2026-04-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set() } })).covered === false
  && plan.planRun(input({ today: '2026-07-01', visuals: [vis('a')], usage: { firstDay: '2026-04-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set() } })).covered === true);
ok('the window is the admin\'s: 30 days covers sooner', plan.planRun(input({ visuals: [vis('a')], settings: { windowDays: 30, slowMs: 5000, trashUnused: true, repairRenames: true }, usage: { firstDay: '2026-05-01', openedSince: new Set(), week: new Map(), trashedBefore: new Set() } })).trash.length === 1);
ok('a moved chart is not also repaired or flagged', (() => {
  const p = plan.planRun(input({ visuals: [vis('a', { encoding: { category: 'gone', values: [] } })] }));
  return p.trash.length === 1 && p.repair.length === 0 && p.broken.length === 0;
})());

// ── exact repair ───────────────────────────────────────────────────────────────────────────────────────────────────
const used = new Set(['a']); // on a dashboard: never moved, so repair is what is judged
const rn = (from: string, to: string, at: string, seq: number) => ({ datasetId: 'd1', from, to, at, seq });
const brokenIn = (columns: string[], renames: ReturnType<typeof rn>[], o: Partial<import('../src/server/autopilot/plan').PlanIn> = {}) =>
  plan.planRun(input({ visuals: [vis('a')], usedElsewhere: used, datasets: new Map([['d1', ds({ columns })]]), renames, ...o }));
const one = brokenIn(['region', 'revenue', 'day'], [rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 1)]);
ok('a logged rename, its new name present: an exact repair', one.repair.length === 1 && JSON.stringify(one.repair[0].fixes) === JSON.stringify([{ from: 'sales', to: 'revenue' }]) && one.broken.length === 0);
const twice = brokenIn(['region', 'total', 'day'], [rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 1), rn('revenue', 'total', '2026-06-02T00:00:00.000000', 2)]);
ok('renamed again since: not repaired, flagged "again"', twice.repair.length === 0 && twice.broken[0].gone[0].why === 'again');
const targetGone = brokenIn(['region', 'day'], [rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 1)]);
ok('the new name is gone too (re-import, replace): not repaired, flagged "target_missing"', targetGone.repair.length === 0 && targetGone.broken[0].gone[0].why === 'target_missing');
ok('no row (a rename made before the log): flagged "none"', brokenIn(['region', 'day'], []).broken[0].gone[0].why === 'none');
ok('the log orders by the dataset\'s time, not by arrival', brokenIn(['region', 'total', 'day'], [rn('revenue', 'total', '2026-06-02T00:00:00.000000', 1), rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 2)]).repair.length === 0);
ok('negative control: a chart whose columns all exist is neither repaired nor flagged', (() => { const p = plan.planRun(input({ visuals: [vis('a')], usedElsewhere: used })); return p.repair.length + p.broken.length === 0; })());
const off = brokenIn(['region', 'revenue', 'day'], [rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 1)], { settings: { windowDays: 90, slowMs: 5000, trashUnused: true, repairRenames: false } });
ok('repair switched off: listed with the exact suggestion, nothing to apply', off.repair.length === 0 && off.broken[0].gone[0].why === 'repair_off' && off.broken[0].gone[0].suggest === 'revenue');
ok('a Live column missing in the warehouse is "gone" even if the record lists it', plan.planRun(input({ visuals: [vis('a')], usedElsewhere: used, datasets: new Map([['d1', ds({ live: true, missing: ['sales'] })]]) })).broken[0].gone[0].column === 'sales');
ok('a chart joining another dataset is not judged against this one\'s columns', plan.planRun(input({ visuals: [vis('a', { encoding: { category: 'x', categoryDatasetId: 'd2', values: [] } })], usedElsewhere: used })).broken.length === 0);
const partly = plan.planRun(input({ visuals: [vis('a', { encoding: { category: 'region', series: 'zzz', values: [{ column: 'sales', aggregation: 'sum' }] } })], usedElsewhere: used, datasets: new Map([['d1', ds({ columns: ['region', 'revenue'] })]]), renames: [rn('sales', 'revenue', '2026-06-01T00:00:00.000000', 1)] }));
ok('one column exact, another not: the exact one is repaired, the other flagged', partly.repair[0].fixes.length === 1 && partly.broken[0].gone.map((g) => g.column).join() === 'zzz');

// ── the repair rewrites exactly what lineage reads ─────────────────────────────────────────────────────────────────
const rich = {
  encoding: { category: 'sales', series: 'other', values: [{ column: 'sales', aggregation: 'sum' }, { column: 'sales', aggregation: 'sum', metricId: 'm' }], sort: { by: 'sales' },
    pivot: { rows: ['sales', { column: 'x' }], columns: [{ column: 'sales' }], values: [{ column: 'sales', aggregation: 'avg' }] } },
  filters: [{ type: 'filter', column: 'sales', op: '>', value: 1 }, { type: 'sort', column: 'other' }],
};
const fixed = repair.repairedDefinition(rich, new Map([['sales', 'revenue']]));
const cols = (d: { encoding: any; filters: any[] }) => JSON.stringify([d.encoding.category, d.encoding.series, d.encoding.values, d.encoding.pivot, d.filters]); // any: loose shapes
ok('repair: category, measures, pivot fields and filters follow the rename', cols(fixed as never) === cols({ encoding: { category: 'revenue', series: 'other', values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'sales', aggregation: 'sum', metricId: 'm' }], pivot: { rows: ['revenue', { column: 'x' }], columns: [{ column: 'revenue' }], values: [{ column: 'revenue', aggregation: 'avg' }] } }, filters: [{ type: 'filter', column: 'revenue', op: '>', value: 1 }, { type: 'sort', column: 'other' }] }));
ok('repair: a measure that follows a saved metric keeps its own column, and fields lineage does not read (sort) are untouched', (fixed.encoding as any).values[1].column === 'sales' && (fixed.encoding as any).sort.by === 'sales');
ok('repair: the input chart is not changed', JSON.stringify(rich).includes('"category":"sales"'));

// ── slow ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const slow = (computes: number, totalMs: number) => plan.planRun(input({ visuals: [vis('a')], usedElsewhere: used, usage: { firstDay: '2026-01-01', openedSince: new Set(), week: new Map([['a', { computes, totalMs, maxMs: 9000 }]]), trashedBefore: new Set() } })).slow;
ok('slow: a typical time over the threshold is listed with its typical and its slowest', slow(4, 4 * 6000).length === 1 && slow(4, 4 * 6000)[0].avgMs === 6000 && slow(4, 4 * 6000)[0].maxMs === 9000);
ok('slow (control): at or under the threshold, or with fewer than 3 computes, is not', slow(4, 4 * 5000).length === 0 && slow(2, 2 * 60000).length === 0);

// ── order ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const many = [vis('c'), vis('a'), vis('b')];
ok('the plan does not depend on the order the charts were read in', JSON.stringify(plan.planRun(input({ visuals: many }))) === JSON.stringify(plan.planRun(input({ visuals: [...many].reverse() }))));

finish();
