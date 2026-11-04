// The row access safety net (docs/row-policy/00-design.md, Tests 2) over the
// real RPC route, as real users with real grants, in a scratch Postgres.
//
// *Orders* has rules: team East → East; user West → West. Viewer `east` is in
// team East; `nobody` has no rule; `ed` is an editor. *East* is a PHYSICAL copy
// of Orders' East rows. So:
//
// 1. COVERAGE: every `read` contract is classified (scripts/rowPolicyReaders.ts).
//    NEGATIVE CONTROL: a planted contract is reported.
// 2. THE DOORS ARE LOCKED: east's reply on Orders is Object.is-equal to the
//    editor's on East, number by number and label by label.
//    NEGATIVE CONTROL: the editor's reply on Orders differs (a leak is visible).
// 3. EVERY OTHER READER REFUSES east, typed; the editor is answered (control).
// 4. NOTHING LEAKS: no reply to east carries a West value or the West rule's
//    value; the editor's replies do (control).
// 5. A PLANTED UNROUTED READER (reads the Parquet by path) is caught by the
//    leak check; one that reads through getDataset is refused by the net.
// 6. `nobody` is refused `none`; the rules themselves are admin-only.
// 7. COLUMN RULES (semantic layer part 4): `columnAccess`, which a newer release writes, planted on Orders
//    closes EVERY door and reader of 2 and 3 to east (named by the row rules) and to `nobody`, each in its own
//    wire form (typed `columns`; the answers carry the sentence; two channels carry no reason and are asserted as
//    "no figure"); the editor and the admin read each as on an identical dataset without it (NEGATIVE CONTROL).
//    Planted on datasets with NO row rules, every REDACT, SKIP and META channel of 3 is redacted, skipped or
//    structure-only for east, shown to east before the key, and shown to the editor (NEGATIVE CONTROLS).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import { TREATMENT } from './rowPolicyReaders';

const api: typeof import('../src/api/index') = require('../src/api/index');
const contractMod: typeof import('../src/api/contract') = require('../src/api/contract');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const rowMessages: typeof import('../src/data/rowAccessMessages') = require('../src/data/rowAccessMessages');
const { z } = require('zod') as typeof import('zod');

/** Read contracts not in the table — the coverage rule, as a function so its negative control can run it. */
const unclassified = (contracts: Record<string, { access: string }>): string[] =>
  Object.entries(contracts).filter(([, c]) => c.access === 'read').map(([ch]) => ch).filter((ch) => !Object.prototype.hasOwnProperty.call(TREATMENT, ch));

(async () => {
  // ── 1. Coverage (no database needed) ────────────────────────────────────
  const missing = unclassified(api.contracts as never);
  ok('coverage: every read contract is classified in scripts/rowPolicyReaders.ts', missing.length === 0, missing.join(', '));
  const stale = Object.keys(TREATMENT).filter((ch) => !(ch in api.contracts) || (api.contracts as Record<string, { access: string }>)[ch].access !== 'read');
  ok('coverage: the table names no channel that is gone or no longer read', stale.length === 0, stale.join(', '));
  ok('NEGATIVE CONTROL: a planted read contract is reported', JSON.stringify(unclassified({ ...(api.contracts as Record<string, { access: string }>), 'rowpolicy:planted': { access: 'read' } })) === '["rowpolicy:planted"]');

  const W = await H.world('row access safety net');
  if (!W) return finish();
  try {
    const { P, orders, east } = W;
    const enc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
    const byMonth = { category: 'day', values: [{ column: 'sales', aggregation: 'sum' }], grain: 'month' };
    // A visual and a metric on each twin: the doors that name a dataset through a record.
    const recs: Record<string, { visualId: string; metricId: string; dash: string }> = {};
    const mkRecs = async (d: string): Promise<void> => {
      const v = await W.call('boss', 'visual:save', { projectId: P, datasetId: d, name: 'Sales', chartType: 'bar', encoding: enc });
      const m = await W.call('boss', 'metric:save', { projectId: P, input: { name: `Sales ${d.slice(0, 4)}`, datasetId: d, definition: { column: 'sales', aggregation: 'sum' } } });
      const visualId = String(v.body?.visual?.id ?? v.body?.id ?? '');
      const metricId = String(m.body?.metric?.id ?? m.body?.id ?? '');
      const a = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [{ id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId }] }] });
      recs[d] = { visualId, metricId, dash: String(a.body?.id ?? a.body?.analysis?.id ?? '') };
      await W.call('boss', 'analysis:publish', { projectId: P, id: recs[d].dash }); // a viewer reads published dashboards only
    };
    for (const d of [orders, east]) await mkRecs(d);
    ok('setup: a visual, a metric and a dashboard on each twin', [orders, east].every((d) => /^[0-9a-f-]{36}$/.test(recs[d].visualId) && /^[0-9a-f-]{36}$/.test(recs[d].metricId) && /^[0-9a-f-]{36}$/.test(recs[d].dash)), JSON.stringify(recs));

    type Payload = (d: string) => unknown;
    const spec = (d: string, extra: Record<string, unknown> = {}) => ({ datasetId: d, category: 'customer', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], ...extra });
    // ── 2. The doors and the locked readers: east on Orders ≡ the editor on East ──
    const DIFFERENTIAL: [string, string, Payload][] = [
      ['chart', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: enc })],
      ['chart by month', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: byMonth })],
      // The drawn figures (item 1) come LAST, off the locked series: a waterfall's levels and a Pareto's order and share.
      ['waterfall figures', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: enc, chartType: 'waterfall', waterfallTotals: [] })],
      ['Pareto figures', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: enc, chartType: 'pareto' })],
      ['pivot', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: { ...enc, pivot: { rows: [{ column: 'customer' }], columns: [], values: [{ column: 'sales', aggregation: 'sum' }] } } })],
      ['cohort', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: { ...enc, cohort: { entity: 'customer', date: 'day', grain: 'month' } } })],
      ['event funnel', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: { ...enc, eventFunnel: { entity: 'customer', event: 'region', time: 'day', steps: ['North', 'East'] } } })],
      ['a filter on top', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: enc, filters: [{ type: 'filter', column: 'sales', op: '>', value: 30 }] })],
      ['chart batch', 'visual:dataBatch', (d) => ({ projectId: P, items: [{ datasetId: d, encoding: enc }, { datasetId: d, encoding: byMonth }] })],
      ['builder preview', 'visual:preview', (d) => ({ projectId: P, datasetId: d, encoding: enc })],
      ['gallery thumbnail', 'visual:thumbs', (d) => ({ projectId: P, ids: [recs[d].visualId] })],
      ['KPI sum', 'dashboard:metric', (d) => ({ projectId: P, datasetId: d, column: 'sales', aggregation: 'sum' })],
      ['KPI count', 'dashboard:metric', (d) => ({ projectId: P, datasetId: d, column: 'customer', aggregation: 'count' })],
      ['KPI average', 'dashboard:metric', (d) => ({ projectId: P, datasetId: d, column: 'qty', aggregation: 'avg' })],
      ['metric preview', 'metric:preview', (d) => ({ projectId: P, datasetId: d, definition: { column: 'sales', aggregation: 'sum' } })],
      ['metric values', 'metric:values', (d) => ({ projectId: P, ids: [recs[d].metricId] })],
      ['metric check', 'metric:check', (d) => ({ projectId: P, datasetId: d, expression: 'sum(sales)', name: 'Sales', chart: true })],
      ['dashboard tiles', 'analysis:tiles', (d) => ({ projectId: P, items: [{ kind: 'visual', datasetId: d, encoding: enc }, { kind: 'metric', datasetId: d, column: 'sales', aggregation: 'sum' }] })],
      ['story figures', 'story:figures', (d) => ({ projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: recs[d].visualId }] })],
      ['answer card', 'answer:card', (d) => ({ projectId: P, spec: spec(d) })],
      ['answer, a value as typed', 'answer:card', (d) => ({ projectId: P, spec: spec(d, { filters: [{ column: 'customer', op: '=', value: 'C3' }] }) })],
      ['answer rerun (loose match)', 'answer:rerun', (d) => ({ projectId: P, spec: spec(d, { filters: [{ column: 'customer', op: '=', value: 'c3 ' }] }) })],
      ['answer, a value not there (nearest values)', 'answer:card', (d) => ({ projectId: P, spec: spec(d, { filters: [{ column: 'customer', op: '=', value: 'zz9' }] }) })],
      ['grid page', 'dataset:page', (d) => ({ projectId: P, datasetId: d, offset: 0, limit: 200 })],
      ['grid search', 'dataset:page', (d) => ({ projectId: P, datasetId: d, offset: 0, limit: 200, search: 'c' })],
      ['filter values, the rule column', 'dataset:distinct', (d) => ({ projectId: P, datasetId: d, column: 'region' })],
      ['filter values, another column', 'dataset:distinct', (d) => ({ projectId: P, datasetId: d, column: 'customer', search: '' })],
      // A cascading picker's parent picks (p6-05a) come AFTER the lock: they narrow what east may see, never widen it.
      ['filter values, narrowed by a parent pick', 'dataset:distinct', (d) => ({ projectId: P, datasetId: d, column: 'customer', filters: [{ type: 'filter', column: 'qty', op: '>=', value: 5 }] })],
      ['filter values, a parent pick outside the lock', 'dataset:distinct', (d) => ({ projectId: P, datasetId: d, column: 'customer', filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] })],
      ['column panel, number', 'dataset:profile', (d) => ({ projectId: P, datasetId: d, column: 'sales' })],
      ['column panel, text', 'dataset:profile', (d) => ({ projectId: P, datasetId: d, column: 'customer' })],
      ['rows behind a mark', 'visual:rows', (d) => ({ projectId: P, datasetId: d, encoding: enc, mark: { category: 'c3' } })],
    ];
    const swap = { [east]: orders, [recs[east].visualId]: recs[orders].visualId, [recs[east].metricId]: recs[orders].metricId, [recs[east].dash]: recs[orders].dash };
    const eastReplies: string[] = [];
    for (const [label, channel, payload] of DIFFERENTIAL) {
      const mine = await W.call('east', channel, payload(orders));
      const truth = await W.call('ed', channel, payload(east));
      const whole = await W.call('ed', channel, payload(orders));
      eastReplies.push(mine.text);
      const d = diff(mine, truth);
      ok(`door: ${label} (${channel}) — east on Orders ≡ the editor on East's rows`, mine.status === 200 && truth.status === 200 && d === '', `${d} | ${mine.status} ${mine.text.slice(0, 200)}`);
      ok(`NEGATIVE CONTROL: ${label} — the editor on Orders sees more`, diff(whole, truth) !== '', `${whole.text.slice(0, 200)} | ${truth.text.slice(0, 200)}`);
    }
    // The pick of a region east is not in: nothing, not West's customers — and not a hint that they exist.
    const westPick = { projectId: P, datasetId: orders, column: 'customer', filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] };
    const outside = await W.call('east', 'dataset:distinct', westPick);
    ok('lock first: east picking West lists nothing — a parent pick cannot widen the lock', outside.status === 200 && JSON.stringify(outside.body) === '{"values":[],"total":0}' && !outside.text.includes(H.W_CANARY), outside.text.slice(0, 200));
    ok('NEGATIVE CONTROL: the same pick by the editor lists West\'s customers', (await W.call('ed', 'dataset:distinct', westPick)).text.includes(H.W_CANARY));
    const noOnes = await W.call('east', 'dataset:distinct', { ...westPick, filters: [{ type: 'filter', column: 'region', op: '=', value: 'east' }] });
    ok('lock first: east picking the lowercase `east` (no one\'s rows) lists nothing', noOnes.status === 200 && JSON.stringify(noOnes.body) === '{"values":[],"total":0}', noOnes.text.slice(0, 200));
    const figs = async (who: string, d: string, chartType: string) => (await W.call(who, 'visual:data', { projectId: P, datasetId: d, encoding: enc, chartType })).body?.data?.figures;
    for (const t of ['waterfall', 'pareto']) {
      const mine = await figs('east', orders, t);
      ok(`figures: east's ${t} carries figures computed over East's rows (compared above, Object.is)`, !!mine && Object.keys(mine).length > 0, JSON.stringify(mine)?.slice(0, 160));
      ok(`NEGATIVE CONTROL: the editor's ${t} figures over Orders differ from East's`, H.diff(await figs('ed', orders, t), await figs('ed', east, t), {}) !== '');
    }
    function diff(a: H.Reply, b: H.Reply): string {
      return H.diff(a.body, b.body, swap);
    }

    // ── 3. Every other reader refuses east, typed; the editor is answered ──
    const REFUSED: [string, string, unknown][] = [
      ['column stats', 'dataset:stats', { projectId: P, datasetId: orders }],
      ['join preview', 'dataset:composePreview', { projectId: P, base: { datasetId: orders }, joins: [], offset: 0, limit: 50 }],
      ['prepare: open (step bodies)', 'prepare:get', { projectId: P, datasetId: orders }],
      ['prepare: step preview', 'prepare:stepPreview', { projectId: P, datasetId: orders, index: -1, step: { type: 'split_column', column: 'customer', mode: 'delimiter', delimiter: '_' } }],
      ['prepare: similar values', 'prepare:similarValues', { projectId: P, datasetId: orders, index: -1, column: 'customer' }],
      ['formula check', 'formula:check', { projectId: P, datasetId: orders, expression: '[sales] * 2' }],
      ['text profile', 'text:profile', { projectId: P, datasetId: orders, column: 'customer' }],
      ['quality: preview a rule', 'quality:preview', { projectId: P, datasetId: orders, rule: { kind: 'not_null', column: 'sales', severity: 'fail' } }],
      ['SQL', 'sql:run', { projectId: P, sql: 'SELECT customer FROM "Orders"' }],
      ['SQL explain', 'sql:explain', { projectId: P, sql: 'SELECT customer FROM "Orders"' }],
      ['statistics', 'stats:run', { projectId: P, spec: { kind: 'distribution', datasetId: orders, columns: ['sales'] } }],
      ['insights', 'insights:list', { projectId: P, datasetId: orders }],
      ['key drivers', 'drivers:explain', { projectId: P, request: { datasetId: orders, metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'latest', column: 'day' }, dimension: 'customer' } }],
      ['segments: features', 'segments:features', { projectId: P, datasetId: orders }],
      ['segments: fit', 'segments:fit', { projectId: P, datasetId: orders, features: ['sales', 'qty'] }],
      ['segments: RFM', 'segments:rfm', { projectId: P, datasetId: orders, spec: { id: 'customer', date: 'day', amount: 'sales' } }],
      ['snapshot diff', 'snapshots:diff', { projectId: P, datasetId: orders, stamp: '2024-01-01T00-00-00-000Z' }],
      ['a dataset version', 'versions:get', { projectId: P, type: 'dataset', id: orders, key: 'k' }],
      ['two dataset versions compared', 'versions:diff', { projectId: P, type: 'dataset', id: orders, from: 'k', to: 'k2' }],
      ['templates', 'template:list', { projectId: P, datasetId: orders }],
      ['Summary card', 'summary:compute', { projectId: P, pages: [{ cards: [{ id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: orders, column: 'sales', aggregation: 'sum' } }] }] }],
      ['export: dashboard HTML', 'dashboard:exportHtml', { projectId: P, id: recs[orders].dash }],
    ];
    for (const [label, channel, payload] of REFUSED) {
      const mine = await W.call('east', channel, payload);
      eastReplies.push(mine.text);
      ok(`refused: ${label} (${channel}) refuses east, typed`, H.refused(mine), `${mine.status} ${mine.text.slice(0, 200)}`);
      const theirs = await W.call('ed', channel, payload);
      ok(`NEGATIVE CONTROL: ${label} — the editor is not refused`, !H.refused(theirs) && !/row_policy/.test(theirs.text), `${theirs.status} ${theirs.text.slice(0, 160)}`);
    }

    // ── SKIP and REDACT ─────────────────────────────────────────────────
    const search = await W.call('east', 'dataSearch:query', { projectId: P, term: H.W_CANARY });
    const searchEd = await W.call('ed', 'dataSearch:query', { projectId: P, term: H.W_CANARY });
    eastReplies.push(search.text);
    ok('skip: a value search skips Orders for east — and still searches the dataset without rules', search.status === 200 && !search.text.includes(orders) && /"hits"/.test(search.text));
    ok('NEGATIVE CONTROL: the editor\'s search finds the West values in Orders', searchEd.text.includes(orders) && searchEd.text.includes(H.W_CANARY));
    const list = await W.call('east', 'dataset:list', { projectId: P });
    eastReplies.push(list.text);
    const row = (r: H.Reply, id: string) => (r.body as { id: string; scoped?: boolean }[]).find((x) => x.id === id);
    ok('scoped: east\'s dataset list says Orders is limited, and nothing about the rules', row(list, orders)?.scoped === true && row(list, W.plain)?.scoped === undefined && !list.text.includes('rowPolicy'));
    ok('NEGATIVE CONTROL: the editor\'s list has no scoped flag', row(await W.call('ed', 'dataset:list', { projectId: P }), orders)?.scoped === undefined);
    // Explore's fields and suggestions are structure only (item 2): east is answered, without tripping the net.
    const sugg = await W.call('east', 'explore:suggest', { projectId: P, datasetId: orders });
    eastReplies.push(sugg.text);
    ok('meta: explore:suggest answers east from the declared columns — suggestions, no refusal', sugg.status === 200 && sugg.body?.ok === true && Array.isArray(sugg.body.suggestions) && sugg.body.suggestions.length > 0, sugg.text.slice(0, 160));
    const header = await W.call('east', 'dataset:columns', { projectId: P, id: orders });
    ok('scoped: the grid header says so too', header.body?.scoped === true);
    await W.call('boss', 'quality:save', { projectId: P, datasetId: orders, rule: { kind: 'not_null', column: 'region', severity: 'fail' } });
    // A rule's args can name values — an allowed set, a whole-table min/max (NV-21).
    await W.call('boss', 'quality:save', { projectId: P, datasetId: orders, rule: { kind: 'in_set', column: 'customer', args: { values: ['c0', `${H.W_CANARY}_0`] }, severity: 'warn' } });
    await W.call('boss', 'quality:save', { projectId: P, datasetId: orders, rule: { kind: 'range', column: 'sales', args: { min: 0, max: 100 }, severity: 'warn' } });
    const q = await W.call('east', 'quality:list', { projectId: P, datasetId: orders });
    const qEd = await W.call('ed', 'quality:list', { projectId: P, datasetId: orders });
    eastReplies.push(q.text);
    ok('redact: east reads the rules but no run (its sample rows are every region\'s) and no rule\'s args', q.body?.ok === true && q.body.latest === null && q.body.rules.length === 3
      && (q.body.rules as { kind: string; args: unknown }[]).every((r) => r.kind && JSON.stringify(r.args) === '{}'), q.text.slice(0, 200));
    ok('NEGATIVE CONTROL: the editor reads the run and the rules\' args', qEd.body?.latest !== null && qEd.text.includes(`${H.W_CANARY}_0`) && /"max":100/.test(JSON.stringify(qEd.body)));

    // A declared key's check counts every row of the table (126), so east, who reads only East's, gets the table notes without it.
    const keyed = await W.call('boss', 'catalog:setTable', { projectId: P, datasetId: orders, patch: { role: 'fact', key: 'customer', guide: 'One row per order.' } });
    const counted = await W.call('boss', 'catalog:checkKey', { projectId: P, datasetId: orders });
    ok('setup: the key is declared and checked over every row', keyed.body?.ok === true && counted.body?.ok === true && counted.body.table.keyCheck?.rows === 126, `${keyed.text.slice(0, 120)} | ${counted.text.slice(0, 160)}`);
    const tEast = await W.call('east', 'catalog:getTable', { projectId: P, datasetId: orders });
    const tEd = await W.call('ed', 'catalog:getTable', { projectId: P, datasetId: orders });
    eastReplies.push(tEast.text);
    ok('redact: catalog:getTable — east gets no keyCheck', tEast.body?.ok === true && !('keyCheck' in tEast.body.table), tEast.text.slice(0, 200));
    ok('…and still gets the key and the guide, which are words, not counts', tEast.body.table.key === 'customer' && tEast.body.table.guide === 'One row per order.');
    ok('NEGATIVE CONTROL: the editor gets it', tEd.body?.ok === true && tEd.body.table.keyCheck?.rows === 126, tEd.text.slice(0, 200));
    // A relationship's stored warning counts every row of its TO dataset (`repeats`): east, closed to Orders, gets the edge without it.
    const edge = await W.call('boss', 'relationship:save', { projectId: P, relationship: { from: { datasetId: east, column: 'customer' }, to: { datasetId: orders, column: 'customer' }, cardinality: 'many_to_one' } });
    const relEast = await W.call('east', 'relationship:list', { projectId: P });
    const relEd = await W.call('ed', 'relationship:list', { projectId: P });
    eastReplies.push(relEast.text);
    ok('setup: an edge into Orders carries a repeats warning', edge.body?.ok === true && edge.body.relationship.warning?.kind === 'repeats', edge.text.slice(0, 200));
    ok('redact: relationship:list — east gets the edge without its warning', relEast.body?.ok === true && relEast.body.relationships.length === 1 && !('warning' in relEast.body.relationships[0]) && relEast.body.relationships[0].to.datasetId === orders, relEast.text.slice(0, 240));
    ok('NEGATIVE CONTROL: the editor gets the warning', relEd.body?.ok === true && relEd.body.relationships[0]?.warning?.kind === 'repeats', relEd.text.slice(0, 240));
    await W.call('boss', 'relationship:delete', { projectId: P, id: edge.body.relationship.id });
    ok('write: east gets 403 from catalog:setTable and catalog:checkKey',
      (await W.call('east', 'catalog:setTable', { projectId: P, datasetId: orders, patch: { key: 'region' } })).status === 403
        && (await W.call('east', 'catalog:checkKey', { projectId: P, datasetId: orders })).status === 403);

    // An alert event found through a caller-chosen analysis id, on Orders: its figures are whole-dataset (NV-17).
    const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
    await W.as('boss', () => alertStore.recordEvents(P, [{ id: crypto.randomUUID(), ruleId: crypto.randomUUID(), ruleName: 'Sales watch', datasetId: orders, at: new Date().toISOString(),
      value: 987654, previous: 881834, delta: 105820, deltaPct: 12, message: `Sales rose 12% to 987,654 on ${H.W_CANARY}_1`, seen: false, analysisId: recs[orders].dash }]));
    const byAnalysis = { projectId: P, analysisId: recs[orders].dash, pages: [] };
    const sumEast = await W.call('east', 'summary:compute', byAnalysis);
    const sumEd = await W.call('ed', 'summary:compute', byAnalysis);
    eastReplies.push(sumEast.text);
    ok('skip: summary:compute names no alert on Orders for east, through the analysis id', sumEast.body?.ok === true && !sumEast.text.includes('987,654'), sumEast.text.slice(0, 200));
    ok('NEGATIVE CONTROL: the editor\'s Summary names it', sumEd.body?.ok === true && sumEd.text.includes('987,654'), sumEd.text.slice(0, 200));

    // A connection's last refresh failure can quote a value, or a relation: east, a viewer, gets the connection's card with no failure text at all (N2, NV-22; the source-names rule widened it).
    const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const datasetsSave: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const feed = async (name: string, lastError: string) => W.as('boss', async () => {
      const c = await conns.saveConnection(P, { name, connectorId: 'postgres', lastStatus: 'error', lastError });
      const d = await datasetsSave.saveDataset(P, { name, sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId: c!.id, table: 'orders' } });
      return { conn: c!.id, ds: d!.id };
    });
    const closedFeed = await feed('Closed feed', `invalid input syntax for type integer: "${H.W_CANARY}_2"`);
    const openFeed = await feed('Open feed', 'OPEN_FEED_ERROR');
    const ruled = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: closedFeed.ds, policy: { column: 'region', rules: H.RULES(W.team, W.uid.west) } });
    const connsEast = await W.call('east', 'connections:list', { projectId: P });
    const connsEd = await W.call('ed', 'connections:list', { projectId: P });
    eastReplies.push(connsEast.text);
    const lastError = (r: H.Reply, id: string) => (r.body as { id: string; lastError: string | null }[]).find((c) => c.id === id)?.lastError;
    ok('redact: connections:list gives east no failure text, where a connection feeds a dataset closed to east', ruled.body?.ok === true && lastError(connsEast, closedFeed.conn) === undefined && (connsEast.body as { id: string }[]).some((c) => c.id === closedFeed.conn), connsEast.text.slice(0, 200));
    ok('…and where nothing it feeds is closed to east', lastError(connsEast, openFeed.conn) === undefined && (connsEast.body as { id: string }[]).some((c) => c.id === openFeed.conn));
    ok('NEGATIVE CONTROL: the editor reads the failure text', String(lastError(connsEd, closedFeed.conn)).includes(H.W_CANARY) && lastError(connsEd, openFeed.conn) === 'OPEN_FEED_ERROR');
    await W.call('boss', 'format:colors:assign', { projectId: P, column: 'customer', values: [`${H.W_CANARY}_1`] });
    const colors = await W.call('east', 'format:colors:get', { projectId: P });
    eastReplies.push(colors.text);
    ok('redact: the colour map is empty for east', colors.status === 200 && JSON.stringify(colors.body) === '{}');
    ok('NEGATIVE CONTROL: the editor\'s colour map holds the West value', (await W.call('ed', 'format:colors:get', { projectId: P })).text.includes(H.W_CANARY));
    const projectsMod: typeof import('../src/app/projects') = require('../src/app/projects');
    await W.as('boss', () => projectsMod.setInsightDismissed(P, `outlier:customer:${H.W_CANARY}_2`, true));
    const projList = await W.call('east', 'projects:list', {});
    const projOpen = await W.call('east', 'projects:open', { id: P });
    eastReplies.push(projList.text, projOpen.text);
    ok('redact: projects:list and projects:open carry no colour map and no dismissed insight ids', projOpen.body?.id === P
      && !/colorMap|dismissedInsights/.test(projList.text + projOpen.text));
    ok('NEGATIVE CONTROL: the stored project holds both, with the West value', H.leaks(JSON.stringify(await W.as('boss', () => projectsMod.getProject(P)))));
    // A run's errors and warnings can quote values (round 2, #14): blank on Orders' dataset and quality nodes for east.
    const pipeStore: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
    const at = new Date().toISOString();
    const run = (nodeId: string) => ({ nodeId, id: crypto.randomUUID(), runId: crypto.randomUUID(), trigger: 'manual' as const, status: 'failed' as const,
      startedAt: at, finishedAt: at, durationMs: 1, attempts: 1, warnings: [`${H.W_CANARY}_5 looks odd`], errors: [`no row for ${H.W_CANARY}_6`] });
    await W.as('boss', () => pipeStore.appendRuns(P, [run(`dataset:${orders}`), run(`quality:${orders}`)]));
    const pipeEast = await W.call('east', 'pipelines:get', { projectId: P });
    const pipeEd = await W.call('ed', 'pipelines:get', { projectId: P });
    eastReplies.push(pipeEast.text);
    const failedRuns = (r: H.Reply) => (r.body?.nodes as { runs: { status: string }[] }[] | undefined ?? []).flatMap((n) => n.runs).filter((x) => x.status === 'failed').length;
    ok('redact: pipelines:get keeps east\'s failed runs on Orders but not their errors or warnings', pipeEast.body?.ok === true && failedRuns(pipeEast) === 2 && !H.leaks(pipeEast.text), pipeEast.text.slice(0, 160));
    ok('NEGATIVE CONTROL: the editor reads both runs\' errors and warnings', failedRuns(pipeEd) === 2 && pipeEd.text.includes(`${H.W_CANARY}_5`) && pipeEd.text.includes(`${H.W_CANARY}_6`));

    // A visual's custom order and series colours name values (round 2, #12): east gets the record without them.
    const vis = recs[orders].visualId;
    const styled = { sort: 'custom', sortOrder: [`${H.W_CANARY}_3`, 'East'], seriesColors: { [`${H.W_CANARY}_4`]: 'chart-2' } };
    await W.call('boss', 'visual:update', { projectId: P, id: vis, overrides: styled });
    const vkeys = ((await W.call('boss', 'versions:list', { projectId: P, type: 'visual', id: vis })).body as { key: string }[]).map((x) => x.key);
    const VIS: [string, unknown][] = [
      ['visual:get', { projectId: P, id: vis }], ['visual:thumbs', { projectId: P, ids: [vis] }], ['analysis:gallery', { projectId: P }],
      ['analysis:open', { projectId: P, id: recs[orders].dash }], ['versions:get', { projectId: P, type: 'visual', id: vis, key: vkeys[0] }],
    ];
    for (const [channel, payload] of VIS) {
      const mine = await W.call('east', channel, payload);
      const theirs = await W.call('ed', channel, payload);
      eastReplies.push(mine.text);
      ok(`redact: ${channel} — east gets the visual without its custom order or series colours`, mine.status === 200 && !H.leaks(mine.text), mine.text.slice(0, 160));
      ok(`NEGATIVE CONTROL: ${channel} — the editor gets them`, H.leaks(theirs.text), `${vkeys.length} ${theirs.text.slice(0, 160)}`);
    }

    // ── The rules are an admin's ────────────────────────────────────────
    for (const who of ['ed', 'east']) {
      ok(`admin only: ${who} gets 403 from dataset:rowPolicy and dataset:setRowPolicy`,
        (await W.call(who, 'dataset:rowPolicy', { projectId: P, datasetId: orders })).status === 403
          && (await W.call(who, 'dataset:setRowPolicy', { projectId: P, datasetId: orders, policy: null })).status === 403);
    }
    const tab = await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: orders });
    ok('admin: the tab reads the rules and that they hold', tab.body?.ok === true && tab.body.state === 'ok' && tab.body.policy.column === 'region' && tab.text.includes(H.POLICY_CANARY));
    const badCol = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: orders, policy: { column: 'sales', rules: H.RULES(W.team, W.uid.west) } });
    const badMember = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: orders, policy: { column: 'region', rules: [{ userId: crypto.randomUUID(), values: ['East'] }] } });
    ok('admin: a number column and a stranger are refused, the rules untouched', badCol.body?.ok === false && badMember.body?.ok === false
      && (await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: orders })).text.includes(H.POLICY_CANARY));

    // ── 6. No entitlement ───────────────────────────────────────────────
    const NOBODY_PICKS = DIFFERENTIAL.slice(0, 1).concat(DIFFERENTIAL.filter(([l]) => l === 'grid page' || l === 'KPI sum'));
    for (const [label, channel, payload] of NOBODY_PICKS) {
      const r = await W.call('nobody', channel, payload(orders));
      ok(`none: a viewer no rule names is refused (${label})`, H.refused(r, 'none'), `${r.status} ${r.text.slice(0, 160)}`);
    }

    // ── 5. Planted readers: one that bypasses the net, one that does not ──
    const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const parquet: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
    const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
    (api.contracts as Record<string, unknown>)['rowpolicy:planted'] = contractMod.rpc({ access: 'read', input: z.strictObject({ projectId: z.string(), datasetId: z.string() }), project: (i: { projectId: string }) => i.projectId });
    (api.contracts as Record<string, unknown>)['rowpolicy:plantedNet'] = contractMod.rpc({ access: 'read', input: z.strictObject({ projectId: z.string(), datasetId: z.string() }), project: (i: { projectId: string }) => i.projectId });
    rpc.registry.handle('rowpolicy:planted', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
      const meta = await datasetsMod.getDatasetMeta(projectId, datasetId);
      const t = await parquet.readTableAsync(rec.tablePath(projectId, datasetId, meta?.storageVersion), meta!.columns);
      return { rows: t ? t.rows : [] };
    });
    rpc.registry.handle('rowpolicy:plantedNet', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => ({ rows: (await datasetsMod.getDataset(projectId, datasetId))?.rows ?? [] }));
    const planted = await W.call('east', 'rowpolicy:planted', { projectId: P, datasetId: orders });
    ok('NEGATIVE CONTROL: a reader that reads the Parquet by path IS caught by the leak check (the suite would fail on it)', H.leaks(planted.text));
    ok('NEGATIVE CONTROL: …and the coverage check names it', unclassified(api.contracts as never).includes('rowpolicy:planted'));
    const net = await W.call('east', 'rowpolicy:plantedNet', { projectId: P, datasetId: orders });
    ok('the storage net refuses a reader nobody listed that reads through getDataset, typed', H.refused(net, 'reader'), `${net.status} ${net.text.slice(0, 160)}`);
    ok('NEGATIVE CONTROL: …the editor reads it whole', H.leaks((await W.call('ed', 'rowpolicy:plantedNet', { projectId: P, datasetId: orders })).text));

    // ── 4. Nothing leaks ────────────────────────────────────────────────
    const leaked = eastReplies.filter(H.leaks);
    ok(`nothing of West's in any of east's ${eastReplies.length} replies (rows, values, the West rule)`, leaked.length === 0, leaked.map((t) => t.slice(0, 120)).join(' | '));
    const edPage = await W.call('ed', 'dataset:page', { projectId: P, datasetId: orders, offset: 0, limit: 200 });
    ok('NEGATIVE CONTROL: the editor\'s grid carries the West canary', H.leaks(edPage.text));

    // ── 7. Column rules: `columnAccess` closes every channel above to a viewer, whatever the row rules give them ──
    const CA = { columns: [{ column: 'sales', visibleTo: [] }], readersHash: 'h', updatedBy: 'boss@acme.test', updatedAt: '2026-11-04T00:00:00.000Z' };
    const setColumns = (id: string, on: boolean) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, id), (r) => { if (on) r.columnAccess = CA; else delete r.columnAccess; return true; }));
    // The twin: the same rows and steps, no rules at all — what the editor's and the admin's replies must equal.
    const twin = await W.as('boss', async () => (await datasetsMod.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
    await mkRecs(twin);
    const swapTwin = { [twin]: orders, [recs[twin].visualId]: recs[orders].visualId, [recs[twin].metricId]: recs[orders].metricId, [recs[twin].dash]: recs[orders].dash };
    await setColumns(orders, true);
    // Each channel refuses in its own wire form. The answer channels carry `code: row_policy` and the sentence in `error`
    // (their `reason` IS the sentence). `metric:values` and `story:figures` carry no reason for ANY row-policy refusal: a
    // bare `{id, ok:false}`, an empty chart — so they are asserted as "no figure", and the key is proved to be the cause below.
    const SENTENCE = rowMessages.rowColumnsMessage();
    const closedByColumns = (channel: string, r: H.Reply): boolean => {
      if (channel === 'metric:values') return r.status === 200 && Array.isArray(r.body) && r.body.length > 0 && r.body.every((x: { ok: boolean; value?: unknown }) => x.ok === false && !('value' in x));
      if (channel === 'story:figures') {
        const blocks = Object.values((r.body?.blocks ?? {}) as Record<string, { chart?: { data: { labels: unknown[]; series: unknown[] } } }>);
        return r.status === 200 && blocks.length > 0 && blocks.every((b) => b.chart?.data.labels.length === 0 && b.chart.data.series.length === 0);
      }
      if (channel.startsWith('answer:')) return r.status === 200 && r.body?.ok === false && r.body.code === 'row_policy' && r.body.error === SENTENCE;
      return H.refused(r, 'columns');
    };
    const columnReplies: string[] = [];
    const channels: [string, string, unknown][] = [...DIFFERENTIAL.map(([l, c, p]): [string, string, unknown] => [l, c, p(orders)]), ...REFUSED];
    for (const [label, channel, payload] of channels) {
      const mine = await W.call('east', channel, payload);
      columnReplies.push(mine.text);
      ok(`columns: ${label} (${channel}) refuses east, whom the row rules name, typed \`columns\``, closedByColumns(channel, mine), `${mine.status} ${mine.text.slice(0, 200)}`);
      for (const who of ['ed', 'boss']) {
        const theirs = await W.call(who, channel, payload);
        ok(`NEGATIVE CONTROL: columns: ${label} — ${who} is not refused`, !H.refused(theirs) && !/row_policy/.test(theirs.text), `${theirs.status} ${theirs.text.slice(0, 160)}`);
      }
    }
    for (const [label, channel, payload] of NOBODY_PICKS) {
      const r = await W.call('nobody', channel, payload(orders));
      ok(`columns: a viewer no rule names is refused \`columns\`, not \`none\` (${label})`, H.refused(r, 'columns'), `${r.status} ${r.text.slice(0, 160)}`);
    }
    // The figures and rows the editor and the admin read are the twin's, number by number (Object.is) — not just "not refused".
    await W.call('boss', 'visual:update', { projectId: P, id: recs[twin].visualId, overrides: styled }); // Orders' visual was styled above
    // A thread grows with every call (compare this call's turns); a timing differs between two runs of one question.
    const tail = (b: { turns?: unknown[]; elapsedMs?: unknown } | null) => (b ? { ...b, ...(Array.isArray(b.turns) ? { turns: b.turns.slice(-2) } : {}), elapsedMs: 0 } : b);
    // Not compared with the twin (all are still asserted not refused above): the Summary card names the alerts and
    // dismissed insights recorded on Orders earlier in this suite; the literal version and snapshot keys name nothing,
    // so the reply is the same null or error for everyone.
    const NOT_ON_TWIN = new Set(['Summary card', 'a dataset version', 'two dataset versions compared', 'snapshot diff']);
    // The refused readers' payloads are literals on Orders: the same payload with the twin's ids is the question on the twin.
    const retarget = (p: unknown): unknown => JSON.parse([[orders, twin], [recs[orders].dash, recs[twin].dash], [recs[orders].visualId, recs[twin].visualId], [recs[orders].metricId, recs[twin].metricId]]
      .reduce((t, [a, b]) => t.split(a).join(b), JSON.stringify(p)));
    const pairs: [string, string, unknown, unknown][] = [...DIFFERENTIAL.map(([l, c, p]): [string, string, unknown, unknown] => [l, c, p(orders), p(twin)]), ...REFUSED.map(([l, c, p]): [string, string, unknown, unknown] => [l, c, p, retarget(p)])];
    let compared = 0;
    for (const [label, channel, payload, twinPayload] of pairs.filter(([l]) => !NOT_ON_TWIN.has(l))) {
      for (const who of ['ed', 'boss']) {
        const got = await W.call(who, channel, payload);
        const want = await W.call(who, channel, twinPayload);
        const d = H.diff(tail(got.body), tail(want.body), swapTwin);
        compared += 1;
        ok(`NEGATIVE CONTROL: columns: ${label} (${channel}) — ${who} reads it as on the dataset without column rules`, got.status === want.status && !H.refused(got) && got.text.length > 20 && d === '', `${d} | ${got.status} ${got.text.slice(0, 120)}`);
      }
    }
    ok(`…${compared} replies of the editor and the admin compared, and the comparison can tell data apart`,
      H.diff((await W.call('ed', 'dataset:page', { projectId: P, datasetId: orders, offset: 0, limit: 200 })).body, (await W.call('ed', 'dataset:page', { projectId: P, datasetId: east, offset: 0, limit: 200 })).body, {}) !== '');
    // ── The REDACT, SKIP and META channels of 3, with column rules on datasets that have NO row rules (Orders is redacted
    // for east by its row rules anyway). Each fact is true while the data is shown: east is shown it before the key (so
    // the fixture carries it), is not with the key, and the editor still is.
    const history: typeof import('../src/app/history') = require('../src/app/history');
    const MARK = { warn: 'PLAIN_RUN_WARN_41', err: 'PLAIN_RUN_ERR_42', style: 'PLAIN_STYLE_43', conn: 'PLAIN_CONN_ERR_44', hw: 731731, alert: 765432 };
    const plainRec = await (async () => { await mkRecs(W.plain); return recs[W.plain]; })();
    await W.call('boss', 'visual:update', { projectId: P, id: plainRec.visualId, overrides: { sort: 'custom', sortOrder: [MARK.style, 'East'], seriesColors: { [`${MARK.style}_b`]: 'chart-2' } } });
    await W.call('boss', 'analysis:publish', { projectId: P, id: plainRec.dash }); // a viewer reads the published copy, frozen at publish: publish it styled
    const plainKeys = ((await W.call('boss', 'versions:list', { projectId: P, type: 'visual', id: plainRec.visualId })).body as { key: string }[]).map((x) => x.key);
    await W.call('boss', 'quality:save', { projectId: P, datasetId: W.plain, rule: { kind: 'range', column: 'sales', args: { min: 0, max: 100 }, severity: 'warn' } });
    await W.call('boss', 'quality:save', { projectId: P, datasetId: W.plain, rule: { kind: 'not_null', column: 'region', severity: 'fail' } });
    const plainRun = (nodeId: string) => ({ nodeId, id: crypto.randomUUID(), runId: crypto.randomUUID(), trigger: 'manual' as const, status: 'failed' as const,
      startedAt: at, finishedAt: at, durationMs: 1, attempts: 1, warnings: [`${MARK.warn} looks odd`], errors: [`no row for ${MARK.err}`] });
    await W.as('boss', () => pipeStore.appendRuns(P, [plainRun(`dataset:${W.plain}`), plainRun(`quality:${W.plain}`)]));
    const feedCols = await feed('Cols feed', MARK.conn); // also the one dataset with an incremental block: only a connection's dataset keeps one
    await W.as('boss', () => datasetsMod.writeIncremental(P, feedCols.ds, () => ({ enabled: false, cursorColumn: 'sales', lookback: 0, highWater: MARK.hw, runsSinceFull: 0,
      log: [{ at, mode: 'full' as const, fetched: 3, inserted: null, updated: null, highWater: MARK.hw, how: 'full' as const }] })));
    const evId = crypto.randomUUID();
    await W.as('boss', () => alertStore.recordEvents(P, [{ id: evId, ruleId: crypto.randomUUID(), ruleName: 'Plain watch', datasetId: W.plain, at: new Date(Date.now() + 5000).toISOString(),
      value: MARK.alert, previous: 700000, delta: 65432, deltaPct: 9, message: 'Plain sales rose to 765,432', seen: false, analysisId: recs[orders].dash }]));
    const capId = `${Date.now()}9`;
    await W.as('boss', () => history.saveThread({ id: capId, projectId: P, datasetId: null, title: 'Captured', createdAt: at, updatedAt: at, cropPath: null, thumb: 'data:image/png;base64,iVBORw0KGgo=',
      result: { title: 'Captured', extractedTable: { columns: [{ id: 'region', label: 'region', type: 'text' }, { id: 'customer', label: 'customer', type: 'text' }], rows: [{ region: 'East', customer: 'e1' }] } } }));
    const capDs = String((await W.call('ed', 'dataset:composeSave', { projectId: P, name: 'Cap', joins: [], steps: [], sourceKind: 'capture', origin: { kind: 'capture', captureId: capId },
      base: { inline: { name: 'Cap', columns: [{ name: 'region', type: 'text' }, { name: 'customer', type: 'text' }], rows: [['East', 'e1']] } } })).body?.dataset?.id ?? '');
    const rowOf = (r: H.Reply, id: string) => (r.body as { id: string }[]).find((x) => x.id === id) as Record<string, unknown> | undefined;
    const observe = async (who: string): Promise<Record<string, boolean>> => {
      const ask = (channel: string, payload: unknown) => W.call(who, channel, payload);
      const f: Record<string, boolean> = {};
      const ql = await ask('quality:list', { projectId: P, datasetId: W.plain });
      f['quality:list — the last run and the rules\' args'] = ql.body?.latest != null && /"max":100/.test(ql.text);
      f['alerts:list — an alert\'s figures'] = ((await ask('alerts:list', { projectId: P })).body?.events as { id: string; value: number | null }[] | undefined ?? []).find((e) => e.id === evId)?.value === MARK.alert;
      f['summary:compute — an alert found through the analysis id'] = (await ask('summary:compute', { projectId: P, analysisId: recs[orders].dash, pages: [] })).text.includes('765,432');
      f['pipelines:get — a failed run\'s errors and warnings'] = ((t) => t.includes(MARK.err) && t.includes(MARK.warn))((await ask('pipelines:get', { projectId: P })).text);
      f['incremental:get — the high-water mark'] = (await ask('incremental:get', { projectId: P, datasetId: feedCols.ds })).text.includes(String(MARK.hw));
      for (const [channel, payload] of [['visual:get', { projectId: P, id: plainRec.visualId }], ['visual:thumbs', { projectId: P, ids: [plainRec.visualId] }], ['analysis:gallery', { projectId: P }],
        ['analysis:open', { projectId: P, id: plainRec.dash }], ['versions:get', { projectId: P, type: 'visual', id: plainRec.visualId, key: plainKeys[0] }]] as const) {
        f[`${channel} — a visual's custom order and series colours`] = (await ask(channel, payload)).text.includes(MARK.style);
      }
      f['captureDataset:list — the thumbnail'] = !!rowOf(await ask('captureDataset:list', { projectId: P }), capId)?.thumb;
      f['captureDataset:get — the extracted table'] = !H.refused(await ask('captureDataset:get', { projectId: P, captureId: capId }));
      f['captureDataset:image — the screenshot'] = !H.refused(await ask('captureDataset:image', { projectId: P, captureId: capId }));
      f['dataSearch:query — the dataset among the hits'] = (await ask('dataSearch:query', { projectId: P, term: 'c3' })).text.includes(W.plain);
      f['dataset:list — no limited flag on its entry'] = rowOf(await ask('dataset:list', { projectId: P }), W.plain)?.scoped === undefined;
      f['dataset:columns — no limited flag on its header'] = (await ask('dataset:columns', { projectId: P, id: W.plain })).body?.scoped !== true;
      return f;
    };
    const carriers = [W.plain, feedCols.ds, capDs];
    ok('setup: three datasets with no row rules carry the fixtures (a visual, rules and a run, an alert, a failing connection, an incremental mark, a capture)', carriers.every((d) => /^[0-9a-f-]{36}$/.test(d)) && plainKeys.length > 0, JSON.stringify([carriers, plainKeys.length]));
    const shown = await observe('east');
    for (const d of carriers) await setColumns(d, true);
    const [withheld, editorSees] = [await observe('east'), await observe('ed')];
    ok(`…${Object.keys(shown).length} facts are observed`, Object.keys(shown).length === 16, Object.keys(shown).length);
    // A viewer gets no refresh failure text at all since the source-names rule (the redact checks above), so it is no fact
    // east is shown before the key; what column rules must not change is that the editor still reads it.
    const connError = async (who: string) => rowOf(await W.call(who, 'connections:list', { projectId: P }), feedCols.conn)?.lastError;
    ok('columns: connections:list — east gets no refresh failure text with column rules either, and the editor still does', (await connError('east')) === undefined && (await connError('ed')) === MARK.conn);
    for (const key of Object.keys(shown)) {
      ok(`columns: ${key} — east is shown it without the key (the fixture carries it)`, shown[key]);
      ok(`columns: ${key} — withheld, skipped or flagged for east with column rules`, !withheld[key]);
      ok(`NEGATIVE CONTROL: columns: ${key} — the editor still gets it`, editorSees[key]);
    }
    const kept = ((await W.call('east', 'pipelines:get', { projectId: P })).body?.nodes as { ref?: { id: string }; runs: { status: string }[] }[] | undefined ?? []).filter((n) => n.ref?.id === W.plain).flatMap((n) => n.runs).filter((x) => x.status === 'failed').length;
    ok('columns: pipelines:get keeps east\'s failed runs on the dataset (status, timing and counts stay)', kept === 2, String(kept));
    // META: structure only. The declared columns, no cell value; the same reply for every caller.
    const sg = await W.call('east', 'explore:suggest', { projectId: P, datasetId: W.plain });
    ok('columns: explore:suggest answers east from the declared columns, carries no cell value, and is the editor\'s reply', sg.body?.ok === true && sg.text === (await W.call('ed', 'explore:suggest', { projectId: P, datasetId: W.plain })).text
      && !H.leaks(sg.text) && !/"(c[0-8]|East|West|North)"/.test(sg.text), sg.text.slice(0, 200));
    for (const d of carriers) await setColumns(d, false);
    ok(`nothing of West's in any of east's ${columnReplies.length} replies on a dataset with column rules`, columnReplies.filter(H.leaks).length === 0);
    await setColumns(orders, false);
    const reopened = await W.call('east', 'visual:data', { projectId: P, datasetId: orders, encoding: enc });
    ok('NEGATIVE CONTROL: with the key removed, east is answered through its row lock again (the refusals above were the key\'s)', reopened.body?.ok === true && !H.refused(reopened), reopened.text.slice(0, 160));
    const [mv, sf] = [await W.call('east', 'metric:values', { projectId: P, ids: [recs[orders].metricId] }), await W.call('east', 'story:figures', { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: recs[orders].visualId }] })];
    ok('NEGATIVE CONTROL: …so are the two channels whose refusal carries no reason (a figure, a drawn chart)', mv.body?.[0]?.ok === true && typeof mv.body[0].value === 'number' && sf.body?.blocks?.b1?.chart?.data?.labels?.length > 0, `${mv.text.slice(0, 120)} | ${sf.text.slice(0, 120)}`);

    // ── Project-wide: the colour map is withheld when ANY dataset is closed to the caller, and Orders' row rules (and the
    // other ruled datasets') would do that alone. They go first, so that only the key on `plain` can.
    for (const d of [orders, east, W.west, closedFeed.ds]) await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: null });
    const colorsOf = (who: string) => W.call(who, 'format:colors:get', { projectId: P });
    const mapShown = await colorsOf('east');
    await setColumns(W.plain, true);
    const [mapWithheld, mapEditor] = [await colorsOf('east'), await colorsOf('ed')];
    ok('columns: format:colors:get — east gets the map without the key, an empty one with it, and the editor keeps it', H.leaks(mapShown.text) && JSON.stringify(mapWithheld.body) === '{}' && H.leaks(mapEditor.text), `${mapShown.text.slice(0, 80)} | ${mapWithheld.text.slice(0, 80)}`);
    const [pl, po] = [await W.call('east', 'projects:list', {}), await W.call('east', 'projects:open', { id: P })];
    ok('columns: projects:list and projects:open carry no colour map and no dismissed insight ids (for any caller)', po.body?.id === P && !/colorMap|dismissedInsights/.test(pl.text + po.text));
    ok('NEGATIVE CONTROL: …the stored project holds both', H.leaks(JSON.stringify(await W.as('boss', () => projectsMod.getProject(P)))));
    await setColumns(W.plain, false);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
