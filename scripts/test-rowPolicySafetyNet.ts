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
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import { TREATMENT } from './rowPolicyReaders';

const api: typeof import('../src/api/index') = require('../src/api/index');
const contractMod: typeof import('../src/api/contract') = require('../src/api/contract');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
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
    for (const d of [orders, east]) {
      const v = await W.call('boss', 'visual:save', { projectId: P, datasetId: d, name: 'Sales', chartType: 'bar', encoding: enc });
      const m = await W.call('boss', 'metric:save', { projectId: P, input: { name: `Sales ${d.slice(0, 4)}`, datasetId: d, definition: { column: 'sales', aggregation: 'sum' } } });
      const visualId = String(v.body?.visual?.id ?? v.body?.id ?? '');
      const metricId = String(m.body?.metric?.id ?? m.body?.id ?? '');
      const a = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [{ id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId }] }] });
      recs[d] = { visualId, metricId, dash: String(a.body?.id ?? a.body?.analysis?.id ?? '') };
    }
    ok('setup: a visual, a metric and a dashboard on each twin', [orders, east].every((d) => /^[0-9a-f-]{36}$/.test(recs[d].visualId) && /^[0-9a-f-]{36}$/.test(recs[d].metricId) && /^[0-9a-f-]{36}$/.test(recs[d].dash)), JSON.stringify(recs));

    type Payload = (d: string) => unknown;
    const spec = (d: string, extra: Record<string, unknown> = {}) => ({ datasetId: d, category: 'customer', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], ...extra });
    // ── 2. The doors and the locked readers: east on Orders ≡ the editor on East ──
    const DIFFERENTIAL: [string, string, Payload][] = [
      ['chart', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: enc })],
      ['chart by month', 'visual:data', (d) => ({ projectId: P, datasetId: d, encoding: byMonth })],
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
    const q = await W.call('east', 'quality:list', { projectId: P, datasetId: orders });
    const qEd = await W.call('ed', 'quality:list', { projectId: P, datasetId: orders });
    eastReplies.push(q.text);
    ok('redact: east reads the rules but no run (its sample rows are every region\'s)', q.body?.ok === true && q.body.latest === null && q.body.rules.length === 1);
    ok('NEGATIVE CONTROL: the editor reads the run', qEd.body?.latest !== null);
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
    for (const [label, channel, payload] of DIFFERENTIAL.slice(0, 1).concat(DIFFERENTIAL.filter(([l]) => l === 'grid page' || l === 'KPI sum'))) {
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
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
