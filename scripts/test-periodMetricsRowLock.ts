// A row-restricted viewer's period figure is computed inside their lock (semantic layer part 5, step 05), as real
// users with real grants in a scratch Postgres (scripts/rowPolicyHarness.ts). East's "Sales, quarter to date" and
// its % change on the previous period over Orders equal the boss's same metrics over the physical East subset, with
// Object.is: the base resolves under the window INSIDE the viewer's lock, never over every row.
//
// NEGATIVE CONTROL: the boss's figure over all of Orders is a different one. A period CHART is refused them (step 06),
// as every chart with a metric measure is (part 1).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-periodMetricsRowLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

process.env.ORDINATE_TODAY = '2024-11-03';

void (async () => {
  const W = await H.world('period metrics under a row lock');
  if (!W) return finish();
  try {
    const { P, orders, east } = W;
    const save = async (datasetId: string, name: string, definition: unknown, timeColumn?: string): Promise<string> => {
      const r = await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId, definition, ...(timeColumn ? { timeColumn } : {}) } });
      if (r.body?.ok !== true) throw new Error(`save ${name}: ${r.text}`);
      return r.body.metric.id;
    };
    const pair = async (datasetId: string, tag: string): Promise<{ qtd: string; vs: string }> => {
      const base = await save(datasetId, `Sales ${tag}`, { column: 'sales', aggregation: 'sum' }, 'day');
      return {
        qtd: await save(datasetId, `Sales QTD ${tag}`, { base, window: { to_date: 'quarter' } }),
        vs: await save(datasetId, `Sales QTD vs ${tag}`, { base, window: { to_date: 'quarter' }, compare: { vs: 'previous_period', show: 'pct_change' } }),
      };
    };
    const all = await pair(orders, 'all');
    const sub = await pair(east, 'east');
    const AUG = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-08-01', to: '2024-08-31' } }];
    const value = async (who: string, id: string): Promise<unknown> => {
      const r = await W.call(who, 'metric:values', { projectId: P, ids: [id], filters: AUG }); // the picker's batch: metric:value per id
      return r.body?.[0]?.ok === true ? r.body[0].value : r.text;
    };
    for (const k of ['qtd', 'vs'] as const) {
      const mine = await value('east', all[k]);
      const theirs = await value('boss', sub[k]);
      ok(`east: ${k} over Orders is the boss's over the East subset`, typeof mine === 'number' && Object.is(mine, theirs), JSON.stringify([mine, theirs]));
      const boss = await value('boss', all[k]);
      ok(`NEGATIVE CONTROL: the boss's ${k} over every row of Orders is another figure`, typeof boss === 'number' && !Object.is(boss, mine), JSON.stringify([boss, mine]));
    }
    // Step 06: the sparkline is a resolution per month, each inside the viewer's lock.
    const spark = async (who: string, id: string): Promise<unknown> => (await W.call(who, 'metric:table', { projectId: P })).body?.rows?.[id]?.series ?? null; // the Data model's Trend cell
    const mine = await spark('east', all.qtd);
    ok('east: the QTD sparkline over Orders is the boss\'s over the East subset', Array.isArray(mine) && mine.length > 0 && JSON.stringify(mine) === JSON.stringify(await spark('boss', sub.qtd)), JSON.stringify([mine, await spark('boss', sub.qtd)]));
    ok('NEGATIVE CONTROL: the boss\'s over every row of Orders is another', JSON.stringify(await spark('boss', all.qtd)) !== JSON.stringify(mine));
    // Step 06: a chart with a metric measure is refused a restricted viewer (part 1, rowDoors.reachesOther), a period one too.
    const chart = (who: string, category: string) => W.call(who, 'visual:data', { projectId: P, datasetId: orders, encoding: { category, grain: 'month', values: [{ column: 'sales', aggregation: 'sum', metricId: all.qtd }] }, filters: AUG });
    for (const category of ['day', 'region']) {
      const r = await chart('east', category);
      ok(`east: a period chart by ${category} is refused, never drawn over every row`, r.body?.ok === false && r.body?.code === 'row_policy', r.text.slice(0, 300));
      ok(`NEGATIVE CONTROL: the boss draws it by ${category}`, (await chart('boss', category)).body?.ok === true);
    }
  } finally {
    await W.close();
  }
  finish();
})();
