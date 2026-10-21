// Row access rules at the edges (docs/row-policy/00-design.md, Tests 2): what
// fans out, what is derived, what changes under the rules, and Live — over the
// real route, as real users, in a scratch Postgres (scripts/rowPolicyHarness.ts).
//
//   1. FAN-OUT refuses everyone, admins included: publish, its plan, an embed,
//      a subscription, an alert (one rule at a time), a push; a page published
//      before the rules stops being served. Controls: the same without rules.
//   2. DERIVED datasets are closed: SQL, a union step, two hops; a copy keeps the rules.
//   3. The rule column's WRITERS are pinned; the column and the pipeline fail closed.
//   4. B1: a data write never drops or widens rules saved meanwhile.
//   5. Caches: east, the editor, west, east again — each its own answer.
//   6. Live: east's figure ≡ the East subset's; the profile sample is refused.
//   7. MCP: the same doors for a token, the same refusals.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyFanOut.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const asOf: typeof import('../src/data/asOf') = require('../src/data/asOf');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

const enc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 200)}`;

(async () => {
  const W = await H.world('row access fan-out suite');
  if (!W) return finish();
  try {
    const { P, orders, east, plain } = W;
    const chart = (who: string, d: string) => W.call(who, 'visual:data', { projectId: P, datasetId: d, encoding: enc });
    const same = async (who: string, d: string, truth: string, label: string) => {
      const a = await chart(who, d);
      const b = await chart('ed', truth);
      const delta = H.diff(a.body, b.body, { [truth]: d });
      ok(label, a.status === 200 && a.body?.ok === true && delta === '', `${delta} | ${show(a)}`);
    };
    const dashOn = async (d: string, chartType = 'bar'): Promise<string> => {
      const v = await W.call('boss', 'visual:save', { projectId: P, datasetId: d, name: 'Sales', chartType, encoding: enc });
      const a = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [
        { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: String(v.body?.visual?.id ?? v.body?.id) },
        { id: crypto.randomUUID(), type: 'metric', layout: { x: 6, y: 0, w: 3, h: 4 }, metric: { datasetId: d, column: 'sales', aggregation: 'sum', label: 'Sales' } },
      ] }] });
      return String(a.body?.id ?? a.body?.analysis?.id);
    };
    const policy = (d: string, rules: unknown) => W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: rules === null ? null : { column: 'region', rules } });

    // ── 1. Fan-out, for everyone ────────────────────────────────────────
    const onOrders = await dashOn(orders);
    const onPlain = await dashOn(plain);
    const target = (dash: string) => ({ projectId: P, dashboardIds: [dash], storyIds: [], scorecardIds: [], options: { title: 'Site' } });
    const plan = await W.call('boss', 'publish:plan', target(onOrders));
    ok('fan-out: the Publish dialog refuses a dashboard over Orders — for an admin too', H.refused(plan, 'fanout'), show(plan));
    const pub = await W.call('boss', 'publish:run', target(onOrders));
    ok('fan-out: …and so does publishing it', H.refused(pub, 'fanout'), show(pub));
    // The published figures (item 1: a waterfall's levels, a Pareto's share) come off the same doors, in the same scope.
    for (const t of ['waterfall', 'pareto']) {
      const figured = await W.call('boss', 'publish:run', target(await dashOn(orders, t)));
      ok(`fan-out: a ${t} over Orders is refused before its figures reach a /p/ page`, H.refused(figured, 'fanout'), show(figured));
      const plainFig = await W.call('boss', 'publish:plan', target(await dashOn(plain, t)));
      ok(`NEGATIVE CONTROL: a ${t} over the plain dataset is planned`, plainFig.body?.ok === true, show(plainFig));
    }
    const site = await W.call('boss', 'publish:run', target(onPlain));
    const siteId = String(site.body?.site?.id ?? '');
    ok('NEGATIVE CONTROL: a dashboard over a dataset without rules publishes, and records what it read', site.body?.ok === true && JSON.stringify(site.body.site.datasetIds) === JSON.stringify([plain]), show(site));
    const page = async () => (await W.app.inject({ method: 'GET', url: `/p/${siteId}/`, headers: { 'x-forwarded-email': 'boss@acme.test' }, remoteAddress: '127.0.0.1' })).statusCode;
    ok('served: the published page opens', (await page()) === 200);
    const claims = { pub: siteId, exp: Math.floor(Date.now() / 1000) + 600, params: {}, hide: [] };
    const embed = () => H.context.runAsPublished({ user: { email: 'embed', role: 'viewer' }, org: { id: 'acme' } }, 'embed', async () =>
      embedPage.embedHtml((await hosted.getSite(siteId))!, onPlain, claims as never).then((x) => ('html' in x ? 'html' : x.missing), (err: unknown) => (rowAccess.isRowPolicyError(err) ? 'refused' : String(err))));
    ok('NEGATIVE CONTROL: the embed builds (and is cached)', (await embed()) === 'html');
    await policy(plain, [{ teamId: W.team, values: ['East'] }]);
    ok('fan-out: rules set AFTER publishing take the page down (404), on every pod (read per request)', (await page()) === 404);
    ok('fan-out: …and the cached embed refuses on its next view', (await embed()) === 'refused');
    await policy(plain, null);
    ok('NEGATIVE CONTROL: rules removed, the page is served again', (await page()) === 200);
    // An older site (no datasets recorded): worked out ONCE from what it was published with, then kept (round 2, #10).
    const recordFsMod: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
    const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
    await W.as('boss', async () => {
      const { datasetIds: _recorded, ...older } = (await hosted.getSite(siteId))!;
      await recordFsMod.writeFile(require('path').join(appPaths.userData(), 'published', siteId, 'manifest.json') as string, JSON.stringify(older));
    });
    ok('setup: the site now reads as one published before builds were recorded', (await W.as('boss', () => hosted.getSite(siteId)))?.datasetIds === undefined);
    ok('legacy: an older site over the plain dataset is served while Orders has rules — its datasets worked out from its published dashboards', (await page()) === 200);
    const kept = await W.as('boss', () => hosted.getSite(siteId));
    ok('legacy: …and kept on its manifest, so every later fetch reads them there', JSON.stringify(kept?.datasetIds) === JSON.stringify([plain]), JSON.stringify(kept?.datasetIds));
    await policy(plain, [{ teamId: W.team, values: ['East'] }]);
    ok('legacy: …rules on that dataset take it down like any site', (await page()) === 404);
    await policy(plain, null);
    const storySite = { ...kept!, datasetIds: undefined, config: { ...kept!.config, storyIds: [crypto.randomUUID()] } };
    ok('legacy: a site whose datasets cannot be worked out (a story) is not served while the project has a dataset with rules', (await W.as('boss', () => hosted.servable(storySite))) === false);
    // The project-wide check is remembered for a few seconds per pod — and forgotten the moment rules are saved here.
    const P2: string = (await W.call('boss', 'projects:create', { name: 'Second' })).body.id;
    const lone = await W.as('boss', async () => (await datasets.saveDataset(P2, { name: 'Lone', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
    const storyIn2 = { ...storySite, projectId: P2 };
    ok('legacy (not worked out): served in a project with no rules — the answer is now remembered', (await W.as('boss', () => hosted.servable(storyIn2))) === true);
    const set2 = await W.call('boss', 'dataset:setRowPolicy', { projectId: P2, datasetId: lone, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
    ok('legacy (not worked out): rules saved → down at once on this pod (the memory is forgotten, not waited out)', set2.body?.ok === true && (await W.as('boss', () => hosted.servable(storyIn2))) === false, show(set2));
    // ── Subscriptions: ONE door (deliver.ts refuseFanOut), and a save asked from the definition (round 2, #9) ──
    const channelsMod: typeof import('../src/app/channels') = require('../src/app/channels');
    const figMod: typeof import('../src/ipc/subscriptionFigures') = require('../src/ipc/subscriptionFigures');
    const chan = await W.as('boss', () => channelsMod.saveChannel({ name: 'Ops list', kind: 'email', to: { userIds: [W.uid.west], teamIds: [] } }, 'boss@acme.test'));
    const chanId = 'channel' in chan ? chan.channel.id : '';
    const draft = (analysisId: string) => ({ name: 'Send', analysisId, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'daily', at: '08:00' }, timezone: 'UTC', channelIds: [chanId], message: { title: '', note: '', includeLink: false }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false } });
    const realResolve = figMod.resolveFigures;
    let computed = 0;
    (figMod as { resolveFigures: typeof realResolve }).resolveFigures = async (...a) => { computed++; return realResolve(...a); };
    let prev: H.Reply;
    let saveRefused: H.Reply;
    let prevPlain: H.Reply;
    try {
      prev = await W.call('boss', 'subscription:preview', { projectId: P, draft: draft(onOrders) });
      saveRefused = await W.call('boss', 'subscription:save', { projectId: P, subscription: draft(onOrders) });
      ok('fan-out: preview and save over Orders compute no figure (the refusal is read from the definition)', computed === 0, String(computed));
      prevPlain = await W.call('boss', 'subscription:preview', { projectId: P, draft: draft(onPlain) });
      ok('NEGATIVE CONTROL: a preview over the plain dataset computes its figures', computed > 0, String(computed));
    } finally {
      (figMod as { resolveFigures: typeof realResolve }).resolveFigures = realResolve;
    }
    ok('fan-out: the subscription dialog says why, before anything is saved', prev.body?.ok === true && prev.body.code === 'row_policy' && !prev.body.slack && typeof prev.body.empty === 'string', show(prev));
    ok('fan-out: …and the save is refused with the same sentence', saveRefused.body?.ok === false && saveRefused.body.error === prev.body?.empty, show(saveRefused));
    ok('NEGATIVE CONTROL: the plain dashboard previews', prevPlain.body?.ok === true && !!prevPlain.body.slack, show(prevPlain));
    const deliverMod: typeof import('../src/server/subscriptions/deliver') = require('../src/server/subscriptions/deliver');
    const fakeChan = { id: crypto.randomUUID(), name: 'Ops', kind: 'slack' } as never;
    const sendOf = (analysisId: string) => W.as('boss', () => deliverMod.deliver(fakeChan, { kind: 'dashboard', projectId: P, analysisId, message: { title: 'x', subtitle: [], note: '', kpis: [], visuals: [], link: null, footer: '' } as never }));
    const refusedSend = await sendOf(onOrders);
    ok('fan-out: deliver() refuses a send over Orders before any post, whoever owns it — `row_policy`', refusedSend.ok === false && refusedSend.code === 'row_policy' && refusedSend.attempts === 0, JSON.stringify(refusedSend));
    const plainSend = await sendOf(onPlain);
    ok('NEGATIVE CONTROL: …a send over the plain dataset gets past it (to the post itself)', !['row_policy', 'compute_failed'].includes(plainSend.code), JSON.stringify(plainSend));
    const rule = (d: string) => ({ id: crypto.randomUUID(), name: 'Big', datasetId: d, metric: { column: 'sales', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
    ok('fan-out: an alert rule over Orders is refused at save and at test', H.refused(await W.call('boss', 'alerts:save', { projectId: P, rule: rule(orders) }), 'fanout') && H.refused(await W.call('boss', 'alerts:test', { projectId: P, rule: rule(orders) })));
    const fired = await W.as('boss', async () => {
      await alertStore.saveRule(P, rule(orders)); // a rule saved before the rules (straight into the store)
      await alertStore.saveRule(P, rule(plain));
      return alertStore.evaluateProject(P);
    });
    ok('fan-out: evaluating every rule fires the one over the plain dataset and skips the one over Orders (one scope per rule)', fired.length === 1 && fired[0].datasetId === plain, JSON.stringify(fired.map((e) => e.datasetId)));
    const pushed = await W.as('boss', () => alertStore.pushableEvents(P, [{ ...fired[0], datasetId: orders, message: `${H.W_CANARY} 99`, value: 99 }, fired[0]]));
    ok('push: an event about Orders reaches the bells with no figure and no sentence; another keeps its own', pushed[0].value === null && pushed[0].message === '' && pushed[1].value === fired[0].value);

    // ── 2. Derived datasets are closed ──────────────────────────────────
    const derive = (name: string, origin: unknown, rows = H.ROWS) => W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'sql', columns: H.COLUMNS, rows, origin } as never))!.id);
    const sqlOver = await derive('Over orders', { kind: 'sql', sql: 'SELECT * FROM "Orders"', deps: [orders] });
    const twoHops = await derive('Two hops', { kind: 'sql', sql: 'SELECT * FROM "Over orders"', deps: [sqlOver] });
    const unioned = await W.as('boss', async () => {
      const id = (await datasets.saveDataset(P, { name: 'Union', sourceKind: 'csv', columns: H.COLUMNS, rows: H.only('North') }))!.id;
      await datasets.updateSteps(P, id, [{ type: 'union', datasetId: orders }]);
      return id;
    });
    for (const [label, d] of [['a SQL dataset over Orders', sqlOver], ['two hops away', twoHops], ['a union of Orders', unioned]] as const) {
      ok(`derived: ${label} is closed to east`, H.refused(await chart('east', d), 'derived'));
      ok(`derived: …and to a fan-out, for an admin`, H.refused(await W.call('boss', 'publish:plan', target(await dashOn(d))), 'fanout'));
    }
    const sqlPlain = await derive('Over plain', { kind: 'sql', sql: 'SELECT * FROM "Plain"', deps: [plain] }, H.ROWS.map((r) => r.map((c) => (typeof c === 'string' ? c.replace(H.W_CANARY, 'w') : c))));
    ok('NEGATIVE CONTROL: a SQL dataset over a dataset without rules answers east', (await chart('east', sqlPlain)).body?.ok === true);
    await policy(sqlOver, [{ teamId: W.team, values: ['East'] }]);
    ok('derived: a SQL dataset over Orders stays closed with rules of its own (its upstream has rules)', H.refused(await chart('east', sqlOver), 'derived'));
    await policy(sqlPlain, [{ teamId: W.team, values: ['East'] }]);
    ok('ceiling: a SQL dataset with rules of its own over a dataset without any is refused (its rows were mixed before they were stored)', H.refused(await chart('east', sqlPlain), 'pipeline'));
    // A table replayed under a dashboard parameter is memoised per dataset (round 2, #16): never handed to a restricted caller.
    const replay: typeof import('../src/data/paramReplay') = require('../src/data/paramReplay');
    const paramsMod: typeof import('../src/analysis/params') = require('../src/analysis/params');
    const dsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const priced = await W.as('boss', async () => (await dsMod.saveDataset(P, { name: 'Priced', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
    await W.as('boss', () => dsMod.updateSteps(P, priced, [{ type: 'calculated_field', name: 'scaled', expression: '[sales] * [[k]]' }]));
    await policy(priced, [{ teamId: W.team, values: ['East'] }]);
    const kv = paramsMod.paramValues([{ name: 'k', kind: 'number', value: 2 }]);
    const edReplay = await W.as('ed', () => replay.paramTable(P, priced, kv));
    const eastReplay = await W.as('east', () => replay.paramTable(P, priced, kv).then((t) => (t ? 'answered' : 'none'), (err: unknown) => (rowAccess.isRowPolicyError(err) ? 'refused' : String(err))));
    ok('net: a replay the editor memoised is refused to east, typed — the net runs before the memo', eastReplay === 'refused', eastReplay);
    ok('NEGATIVE CONTROL: …the editor\'s replay is the whole table, West included, and memoised', !!edReplay && H.leaks(JSON.stringify(edReplay.rows)));

    // The anomaly keys an alert last told of can name a value (round 2, #16): not in east's dataset list.
    const recMod: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
    const auto = await W.as('boss', () => recMod.setAutoRefresh(P, sqlPlain, { every: 'daily', watch: true, lastAnomalyKeys: [`sales:${H.W_CANARY}_7`] }));
    const listRow = async (who: string) => ((await W.call(who, 'dataset:list', { projectId: P })).body as { id: string; scoped?: boolean; autoRefresh?: { watch?: boolean } }[]).find((x) => x.id === sqlPlain);
    const eastRow = await listRow('east');
    ok('redact: east\'s dataset list keeps the schedule but not the anomaly keys', eastRow?.scoped === true && eastRow.autoRefresh?.watch === true && !H.leaks(JSON.stringify(eastRow)), JSON.stringify(eastRow));
    ok('NEGATIVE CONTROL: the editor\'s list carries them', !!auto && H.leaks(JSON.stringify(await listRow('ed'))));
    const tab = await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: orders });
    ok('the tab lists the datasets built from Orders', [sqlOver, twoHops, unioned].every((id) => (tab.body?.builtFrom ?? []).some((x: { id: string }) => x.id === id)), show(tab));

    // A dataset with rules of its own, built from another with rules: closed all the same (round 2, #4).
    await policy(unioned, [{ teamId: W.team, values: ['East'] }]);
    ok('derived: rules of its own do not open a dataset whose upstream has rules (A union B, both with rules)', H.refused(await chart('east', unioned), 'derived'));

    // New datasets made from a dataset's rows are born with its rules (round 2, #3).
    const rulesOf = async (id: string) => (await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: id })).body?.policy;
    const copied2 = await W.call('ed', 'dataset:composeSave', { projectId: P, name: 'Orders copy', base: { datasetId: orders }, joins: [], steps: [] });
    const copyOf = String(copied2.body?.dataset?.id ?? '');
    ok('saved as a new dataset (composer, no joins): born with Orders\' rules — east sees East only', (await rulesOf(copyOf))?.column === 'region', show(copied2));
    await same('east', copyOf, east, 'saved copy: east on it ≡ the East subset');
    const rfm = await W.call('ed', 'segments:rfmSave', { projectId: P, datasetId: orders, spec: { id: 'customer', date: 'day', amount: 'sales' } });
    const rfmId = String(rfm.body?.dataset?.id ?? '');
    ok('RFM saved from Orders: born with its rules, so closed to east (the RFM table has no rule column)', (await rulesOf(rfmId))?.column === 'region'
      && H.refused(await W.call('east', 'dashboard:metric', { projectId: P, datasetId: rfmId, column: 'monetary', aggregation: 'sum' }), 'column'), show(rfm));
    const rfmPlain = await W.call('ed', 'segments:rfmSave', { projectId: P, datasetId: plain, spec: { id: 'customer', date: 'day', amount: 'sales' } });
    ok('NEGATIVE CONTROL: RFM saved from a dataset without rules has none', (await rulesOf(String(rfmPlain.body?.dataset?.id ?? ''))) === null, show(rfmPlain));
    const fromDerived = await W.call('ed', 'segments:rfmSave', { projectId: P, datasetId: twoHops, spec: { id: 'customer', date: 'day', amount: 'sales' } });
    ok('RFM saved from a DERIVED dataset (no rules of its own) is born closed, never open', H.refused(await W.call('east', 'dashboard:metric', { projectId: P, datasetId: String(fromDerived.body?.dataset?.id ?? ''), column: 'monetary', aggregation: 'sum' })), show(fromDerived));

    // ── A record that cannot be read is closed, never "no rules" (round 2, #1) ──
    const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
    const realRead = recordFs.readFile;
    const failing = (target: string) => {
      (recordFs as { readFile: unknown }).readFile = (async (p: string, ...rest: unknown[]) => {
        if (String(p).endsWith(`${target}.json`)) throw Object.assign(new Error('EIO: the disk is gone'), { code: 'EIO' });
        return (realRead as (...a: unknown[]) => Promise<string>)(p, ...rest);
      }) as typeof recordFs.readFile;
    };
    failing(orders);
    const broken = await chart('east', orders);
    (recordFs as { readFile: unknown }).readFile = realRead;
    ok('unreadable: a failing read of Orders\' record refuses east, typed — never "no rules"', H.refused(broken, 'unreadable') && !H.leaks(broken.text), show(broken));
    ok('…and the failure was not remembered: the next ask (same rules) is locked again', (await chart('east', orders)).body?.ok === true);
    const ghost = await chart('east', crypto.randomUUID());
    ok('NEGATIVE CONTROL: a dataset with no record at all (ENOENT) is "not found", not a row access refusal', !H.refused(ghost) && ghost.body?.ok === false, show(ghost));
    failing(orders);
    const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
    const copyRefused: string = await W.as('boss', () => rec.storedRowPolicy(P, orders).then(() => 'read', (err: Error) => err.message));
    (recordFs as { readFile: unknown }).readFile = realRead;
    ok('unreadable: what a copy is born with cannot be read → the copy refuses (no copy without rules)', /EIO/.test(copyRefused));

    // ── 3. Writers pinned; the column and the pipeline fail closed ──────
    const fresh = async (name: string) => {
      const id = await W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS }))!.id);
      await policy(id, [{ teamId: W.team, values: ['East'] }]);
      return id;
    };
    const pinned = await fresh('Pinned');
    await same('east', pinned, east, 'writers: before any change, east on Pinned ≡ the East subset');
    await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: pinned, steps: [{ type: 'filter', column: 'sales', op: '>', value: -1 }] });
    ok('NEGATIVE CONTROL: a step that does not write the rule column leaves the rules holding', (await chart('east', pinned)).body?.ok === true);
    await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: pinned, steps: [{ type: 'replace_values', column: 'region', mode: 'exact', rules: [{ from: 'West', to: 'East' }] }] });
    ok('writers: an editor\'s replace on the rule column refuses east until an admin saves again', H.refused(await chart('east', pinned), 'pipeline'));
    ok('writers: …and the tab says so', (await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: pinned })).body?.state === 'writers');
    await policy(pinned, [{ teamId: W.team, values: ['East'] }]);
    ok('writers: saved again, the rules hold (over the replaced values, as the admin saw them)', (await chart('east', pinned)).body?.ok === true);
    const retyped = await fresh('Retyped');
    await W.call('boss', 'dataset:update', { projectId: P, datasetId: retyped, columns: H.COLUMNS.map((c) => (c.name === 'region' ? { ...c, type: 'number' } : c)) });
    ok('column: the rule column retyped refuses (never a skipped filter)', H.refused(await chart('east', retyped), 'column'));
    const windowed = await fresh('Windowed');
    await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: windowed, steps: [{ type: 'window', fn: 'running_sum', as: 'cum', column: 'sales' }] });
    ok('pipeline: a running total over every row refuses', H.refused(await chart('east', windowed), 'pipeline'));
    const lockedAsOf = await W.as('east', () => asOf.withAsOf(P, new Date().toISOString(), () => rowAccess.rowLockFor(P, orders)).then(() => 'answered', (err: unknown) => (rowAccess.isRowPolicyError(err) ? err.reason : String(err))));
    ok('asOf: a past read refuses', lockedAsOf === 'asOf', lockedAsOf);

    // ── 4. A data write never drops or widens rules saved meanwhile (B1) ──
    const raced = await fresh('Raced');
    await policy(raced, [{ teamId: W.team, values: ['East', 'West'] }]); // wide
    const stale = await W.as('boss', async () => (await datasets.getDataset(P, raced))!); // a fold starts with these rows…
    await policy(raced, [{ teamId: W.team, values: ['East'] }]); // …an admin narrows the rules meanwhile…
    await W.as('boss', () => datasets.persist(P, stale)); // …and the fold writes back what it held
    const after = await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: raced });
    ok('B1: the stale write kept the NARROWED rules', JSON.stringify(after.body?.policy?.rules) === JSON.stringify([{ teamId: W.team, values: ['East'] }]), show(after));
    await W.call('boss', 'dataset:setSteps', { projectId: P, datasetId: raced, steps: [{ type: 'trim', column: 'customer' }] });
    await W.as('boss', () => datasets.updateDataset(P, raced, { columns: H.COLUMNS }));
    await W.call('boss', 'quality:save', { projectId: P, datasetId: raced, rule: { kind: 'not_null', column: 'sales', severity: 'fail' } });
    ok('B1: the rules survive a step edit, a column update and a quality save', (await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: raced })).body?.policy?.column === 'region');

    // ── 5. Caches: four callers, one question ───────────────────────────
    await same('east', orders, east, 'cache: east (cold)');
    await same('ed', orders, orders, 'cache: the editor, next (the whole table, not east\'s answer)');
    await same('west', orders, W.west, 'cache: west, next (West\'s rows, not east\'s answer)');
    await same('east', orders, east, 'cache: east again (warm, still East\'s)');

    // ── 6. Live ─────────────────────────────────────────────────────────
    fakeMod.registerLiveFake();
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const live = await W.as('boss', async () => {
      const TYPE: Record<string, string> = { text: 'VARCHAR', number: 'DOUBLE', date: 'DATE' };
      await duck.execAsync(`CREATE OR REPLACE TABLE rp_orders (${H.COLUMNS.map((c) => `"${c.name}" ${TYPE[c.type]}`).join(', ')})`);
      const params: unknown[] = [];
      const tuples = H.ROWS.map((r) => `(${H.COLUMNS.map((c, i) => { params.push(r[i]); return `CAST($${params.length} AS ${TYPE[c.type]})`; }).join(', ')})`);
      await duck.queryAsync(`INSERT INTO rp_orders VALUES ${tuples.join(', ')}`, params as (string | number | null)[]);
      const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
      return (await liveRecord.saveLiveRecord(P, { name: 'Orders', columns: H.COLUMNS, origin: { kind: 'connection', connId: conn!.id, table: 'rp_orders' } }))!.id;
    });
    await policy(live, H.RULES(W.team, W.uid.west));
    const liveEast = await chart('east', live);
    const extEast = await chart('ed', east);
    // The warehouse ranks a category by value, the copy keeps first-seen order: compared label by label.
    const pairs = (r: H.Reply): string => JSON.stringify(((r.body?.data?.labels ?? []) as string[]).map((l, i) => [l, r.body.data.series[0].values[i]]).sort());
    ok('Live: east\'s chart from the warehouse ≡ the East subset\'s, label by label (bound, byte-compared lock; `east` excluded)',
      liveEast.body?.ok === true && pairs(liveEast) === pairs(extEast), `${show(liveEast)} | ${show(extEast)}`);
    ok('NEGATIVE CONTROL: the editor\'s Live chart is the whole table', pairs(await chart('ed', live)) !== pairs(extEast));
    ok('Live: the filter picker (a sample of every row) refuses east', H.refused(await W.call('east', 'dataset:distinct', { projectId: P, datasetId: live, column: 'region' })));
    const copy = await W.call('ed', 'dataset:copyLive', { projectId: P, datasetId: live });
    const copyId = String(copy.body?.dataset?.id ?? '');
    const copied = await W.call('boss', 'dataset:rowPolicy', { projectId: P, datasetId: copyId });
    ok('copy: "Make a copy" of a dataset with rules is born with them', copy.body?.ok === true && copied.body?.policy?.column === 'region' && copied.text.includes(H.POLICY_CANARY), `${show(copy)} | ${show(copied)}`);
    await same('east', copyId, east, 'copy: east on the copy ≡ the East subset');

    // ── 7. MCP: a token's tools take the same doors ─────────────────────
    const token = String((await W.call('east', 'tokens:create', { name: 'robot' })).body?.token ?? '');
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await W.app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, remoteAddress: '127.0.0.1', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: P, ...args } } }) });
      return r.body;
    };
    const agg = await tool('aggregate', { dataset: orders, encoding: enc });
    ok('MCP: aggregate is locked — no West value, East\'s figures', !H.leaks(agg) && agg.includes('c3') && !agg.includes('isError":true'), agg.slice(0, 200));
    for (const [name, args] of [['query_sql', { sql: 'SELECT * FROM "Orders"' }], ['insights', { dataset: orders }]] as const) {
      const r = await tool(name, args);
      ok(`MCP: ${name} refuses, with the sentence and no West value`, r.includes('isError":true') && /row access rules|your access/.test(r) && !H.leaks(r), r.slice(0, 200));
    }
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
