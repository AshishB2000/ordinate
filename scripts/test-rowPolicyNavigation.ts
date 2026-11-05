// Part 6's navigation readers under row access rules (semantic layer part 6), over the real RPC route, as real users
// in a scratch Postgres (scripts/rowPolicyHarness): *Orders* has rules; `east` is a restricted viewer, `ed` an editor.
// Split out of scripts/test-rowPolicySafetyNet.ts, whose coverage check still classifies these channels.
//
// - model:navigation (META): level names and the calendar's ladder, never a value; east's reply is the editor's.
// - topic:get and model:navigation's topics (META): a topic listing a term that quotes a West value hands east no
//   value; topic:save is an editor's (east 403).
// - visual:drillDown (DOOR): east's drilled chart is east's own visual:data for the same question, cell by cell;
//   the editor's differs (NEGATIVE CONTROL).
// - Nothing east was given carries a West value.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyNavigation.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

(async () => {
  const W = await H.world('row policy navigation');
  if (!W) return finish();
  try {
    const { P, orders } = W;
    const replies: string[] = [];
    // model:navigation (META): level NAMES and the calendar's ladder, never a value. east gets the editor's reply, hierarchy included.
    const hs = await W.call('boss', 'catalog:setTable', { projectId: P, datasetId: orders, patch: { hierarchies: [{ name: 'Who', levels: ['customer', 'region'] }] } });
    const [navEast, navEd] = [await W.call('east', 'model:navigation', { projectId: P }), await W.call('ed', 'model:navigation', { projectId: P })];
    replies.push(navEast.text);
    ok('setup: boss saves a hierarchy over Orders', hs.body?.ok === true, hs.text.slice(0, 160));
    ok('meta: model:navigation — east reads no value a lock hides', navEast.body?.ok === true && !H.leaks(navEast.text), navEast.text.slice(0, 240));
    ok('NEGATIVE CONTROL: …and it is the editor\'s reply, hierarchy included (nothing was withheld, because nothing was a value)', navEast.text === navEd.text && /"Who"/.test(navEd.text) && navEd.body?.tables?.[0]?.datasetId === orders, navEd.text.slice(0, 240));
    // topic:get and model:navigation's topics (META, part 6 step 07): ids and names only. A topic listing a term whose filter
    // quotes a West value hands east no value; a topic is never a way round the lock, nor a narrowing of what east reads.
    const westTerm = String((await W.call('boss', 'term:save', { projectId: P, input: { name: 'Top west', datasetId: orders, filters: [{ type: 'filter', column: 'customer', op: '=', value: H.W_CANARY }] } })).body?.term?.id ?? '');
    const topicBody = { name: 'Sales', datasets: [{ id: orders, fields: ['customer', 'region'] }], metricIds: [], termIds: [westTerm] };
    const tpEd = await W.call('ed', 'topic:save', { projectId: P, topic: topicBody });
    const tpEast = await W.call('east', 'topic:save', { projectId: P, topic: { ...topicBody, name: 'Mine' } });
    ok('write: east (a viewer) gets 403 from topic:save', tpEast.status === 403, `${tpEast.status} ${tpEast.text.slice(0, 120)}`);
    ok('NEGATIVE CONTROL: the editor\'s topic:save is 200', tpEd.status === 200 && tpEd.body?.ok === true, tpEd.text.slice(0, 160));
    const topicId = String(tpEd.body?.topic?.id ?? '');
    const [tgEast, tgEd] = [await W.call('east', 'topic:get', { projectId: P, id: topicId }), await W.call('ed', 'topic:get', { projectId: P, id: topicId })];
    const [tnEast, tnEd] = [await W.call('east', 'model:navigation', { projectId: P }), await W.call('ed', 'model:navigation', { projectId: P })];
    replies.push(tgEast.text, tnEast.text);
    ok('meta: topic:get and model:navigation\'s topics — east reads no value a lock hides, through a topic listing a term that quotes one',
      tgEast.body?.ok === true && !H.leaks(tgEast.text) && !H.leaks(tnEast.text) && tgEast.body.topic.termIds[0] === westTerm && tnEast.body?.topics?.[0]?.name === 'Sales', `${tgEast.text.slice(0, 200)} | ${tnEast.text.slice(0, 200)}`);
    ok('NEGATIVE CONTROL: …the term itself holds the value (the editor reads it), and east\'s topic replies are the editor\'s',
      H.leaks((await W.call('ed', 'term:get', { projectId: P, id: westTerm })).text) && tgEast.text === tgEd.text && tnEast.text === tnEd.text, tgEd.text.slice(0, 200));
    // visual:drillDown (DOOR): east drills Orders' customer c3 down to region; the drilled chart is east's own visual:data for it.
    const byCustomer = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
    const drilledBy = async (who: string): Promise<{ d: H.Reply; chart: H.Reply | null }> => {
      const d = await W.call(who, 'visual:drillDown', { projectId: P, datasetId: orders, encoding: byCustomer, mark: { category: 'c3' } });
      return { d, chart: d.body?.available ? await W.call(who, 'visual:data', { projectId: P, datasetId: orders, encoding: d.body.encoding, filters: d.body.steps }) : null };
    };
    const [drEast, drEd] = [await drilledBy('east'), await drilledBy('ed')];
    const byHand = await W.call('east', 'visual:data', { projectId: P, datasetId: orders, encoding: { ...byCustomer, category: 'region' }, filters: [{ type: 'filter', column: 'customer', op: '=', value: 'c3' }] });
    replies.push(drEast.d.text, drEast.chart?.text ?? '');
    const cellsOf = (r: H.Reply | null): unknown[][] | null => (r?.body?.ok ? [r.body.data.labels, ...r.body.data.series.map((x: { values: unknown[] }) => x.values)] : null);
    const sameCells = (a: unknown[][] | null, b: unknown[][] | null): boolean => !!a && !!b && a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((v, j) => Object.is(v, b[i][j])));
    ok('door: visual:drillDown — east\'s drilled chart is east\'s own visual:data for the same question, cell by cell', drEast.d.body?.available === true && drEast.d.body.encoding.category === 'region'
      && sameCells(cellsOf(drEast.chart), cellsOf(byHand)) && JSON.stringify(cellsOf(drEast.chart)?.[0]) === '["East"]', `${drEast.d.text.slice(0, 200)} | ${drEast.chart?.text.slice(0, 200)}`);
    ok('NEGATIVE CONTROL: the editor\'s drilled chart differs (c3 is in more regions than East)', drEd.d.body?.available === true && !sameCells(cellsOf(drEd.chart), cellsOf(drEast.chart)) && (cellsOf(drEd.chart)?.[0].length ?? 0) > 1, drEd.chart?.text.slice(0, 200));
    ok('nothing east was given carries a West value', replies.length > 0 && !replies.some((t) => H.leaks(t)), replies.find((t) => H.leaks(t))?.slice(0, 200));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
