// Self-check for `model:navigation` (semantic layer part 6, step 01) and the ladder rules in src/analysis/drillLevels.ts.
//
// 1. The ladders: a date goes year > quarter > month > day (the calendar's week joins under a week calendar), a Gregorian
//    week goes to day, 'month' reads 'period' under a week calendar; a text level goes to the next one, and nothing at the last.
//    NEGATIVE CONTROL: a hierarchy with a missing level is never walked.
// 2. One reply: the hierarchies of the datasets that have them, in dataset:list order, with the date ladder.
// 3. Metadata only: no dataset is hydrated and no warehouse statement is sent.
// 4. A level that is no longer a text column is reported `missing`, still stored; a deleted dataset is absent.
// 5. Topics (step 07): listed by name, each with its deleted datasets dropped (`topics[0].datasets`).
//    (The row-restricted caller is covered in scripts/test-rowPolicySafetyNet.ts.)
//
//   npm run build:ts && node scripts/test-modelNavigation.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';

const { nextGrain, grainWord, nextLevel, levelOf, navHierarchies, dateLadder, DRILL_CHART_TYPES }: typeof import('../src/analysis/drillLevels') = require('../src/analysis/drillLevels');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

const G = dateLadder(false);
const W = dateLadder(true);
const GEO = { id: '5d3b6f0e-6c1f-4a8e-9a3e-0e5a1b2c3d4e', name: 'Geography', levels: ['region', 'state'] };

(async () => {
  ok('ladders', JSON.stringify([nextGrain(G, 'year'), nextGrain(G, 'month'), nextGrain(G, 'week'), nextGrain(G, 'day')]) === '["quarter","day","day",null]' && nextGrain(W, 'month') === 'week' && grainWord('month', W) === 'period' && grainWord('month', G) === 'month');
  ok('nextLevel: the next level, then nothing at the last', nextLevel([GEO], 'region')!.next === 'state' && nextLevel([GEO], 'state') === null && nextLevel([GEO], 'amt') === null);
  ok('NEGATIVE CONTROL: a hierarchy with a missing level is never walked', nextLevel([{ ...GEO, missing: ['state'] }], 'region') === null && levelOf([{ ...GEO, missing: ['state'] }], 'region') === null);
  ok('navHierarchies marks what is not a text column, and only that', JSON.stringify(navHierarchies([GEO], [{ name: 'region', type: 'text' }, { name: 'state', type: 'number' }])[0].missing) === '["state"]' && !('missing' in navHierarchies([GEO], [{ name: 'region', type: 'text' }, { name: 'state', type: 'text' }])[0]));
  ok('pie and column drill; a table does not', DRILL_CHART_TYPES.has('pie') && DRILL_CHART_TYPES.has('column') && !DRILL_CHART_TYPES.has('table'));

  const { projectId: P, extractId: X, liveId: L } = await H.setupOrg(H.ORG_A);
  const nav = async (): Promise<Reply> => (await post('model:navigation', { projectId: P })).value;
  const empty = await nav();
  ok('nothing written: ok, no tables, the Gregorian ladder', empty.ok === true && empty.tables.length === 0 && JSON.stringify(empty.dateLadder) === '["year","quarter","month","day"]', JSON.stringify(empty));

  // T1 and T2: two text columns of the fixture.
  const [T1, T2] = ['cat', 'region'];
  const saved = await post('catalog:setTable', { projectId: P, datasetId: X, patch: { hierarchies: [{ name: 'Geography', levels: [T1, T2] }] } });
  ok('setup: a hierarchy on the extract', saved.value.ok === true, JSON.stringify(saved.value));
  const calls0 = H.fake.calls.length;
  const a = await hydrates(X, nav);
  ok('one table, its hierarchy, the Gregorian ladder', a.value.tables.length === 1 && a.value.tables[0].datasetId === X && JSON.stringify(a.value.tables[0].hierarchies.map((h: Reply) => [h.name, h.levels])) === JSON.stringify([['Geography', [T1, T2]]]) && !('missing' in a.value.tables[0].hierarchies[0]), JSON.stringify(a.value));
  const b = await hydrates(L, nav);
  ok('metadata only: nothing hydrated, no warehouse statement', !a.hydrated && !b.hydrated && H.fake.calls.length === calls0, `${a.hydrated} ${b.hydrated} ${H.fake.calls.length - calls0}`);
  ok('a Live dataset can carry one too (its columns are declared)', (await post('catalog:setTable', { projectId: P, datasetId: L, patch: { hierarchies: [{ name: 'Where', levels: [T1, T2] }] } })).value.ok === true && (await nav()).tables.length === 2);

  const cols = H.fx.COLUMNS.map((c) => ({ name: c.name, type: c.name === T2 ? 'number' : c.type }));
  const retyped = await post('dataset:update', { projectId: P, datasetId: X, columns: cols });
  ok('setup: the extract\'s region is retyped', retyped.status === 200, retyped.body.slice(0, 160));
  const c = await nav();
  ok('a retyped level is reported missing, and the hierarchy is still stored', JSON.stringify(c.tables.find((t: Reply) => t.datasetId === X).hierarchies[0].missing) === JSON.stringify([T2]) && !('missing' in c.tables.find((t: Reply) => t.datasetId === L).hierarchies[0]), JSON.stringify(c));

  await H.as(H.ORG_A, async () => { dateIntel.setCalendar({ weekStart: 0, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' }); });
  const wk = await H.as(H.ORG_A, () => nav());
  ok('under a 4-5-4 calendar the ladder holds the week', JSON.stringify(wk.dateLadder) === '["year","quarter","month","week","day"]', JSON.stringify(wk.dateLadder));
  await H.as(H.ORG_A, async () => { dateIntel.setCalendar({ weekStart: 1, fiscalYearStart: 1 }); });

  ok('no topic yet: topics is []', JSON.stringify((await nav()).topics) === '[]');
  const topic = await post('topic:save', { projectId: P, topic: { name: 'Sales', datasets: [{ id: X }, { id: L, fields: [T1] }], metricIds: [], termIds: [] } });
  ok('setup: a topic over both datasets', topic.value.ok === true, JSON.stringify(topic.value));
  await post('dataset:delete', { projectId: P, id: X });
  const d = await nav();
  ok('a deleted dataset is absent', d.tables.length === 1 && d.tables[0].datasetId === L, JSON.stringify(d));
  ok('…and dropped from the topic, in order, the rest kept', JSON.stringify(d.topics?.[0]?.datasets) === JSON.stringify([{ id: L, fields: [T1] }]) && d.topics[0].name === 'Sales', JSON.stringify(d.topics));
  const bad = await post('model:navigation', { projectId: 'not-a-project' });
  ok('a bad project id is refused by the contract', bad.status === 400, `${bad.status} ${bad.body.slice(0, 120)}`);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
