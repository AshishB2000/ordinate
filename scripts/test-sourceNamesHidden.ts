// A viewer never reads a dataset's source names (docs/semantic-layer/02-source-tables.md, D13).
//
// The rule is "can open the connection": a project editor or admin sees a
// source's warehouse table, host, database and SQL; a viewer sees what kind of
// source it is and the connection's name, nothing more. This suite plants a
// canary in every source name and reads each reply as a viewer and as the editor.
//
// 1. `dataset:source`: a viewer reads "Connection · Warehouse" and "Web address",
//    the editor "Connection · Warehouse · <table>" and "Web address · <host>".
//    `sourceView(hideNames)` keeps "a query". NEGATIVE CONTROL: the editor still reads the names.
// 2. `seesSourceNames` fails closed on an id that is not a project id.
// 3. `lineage:get` and `pipelines:get`: a viewer's source node says the connector's kind ("postgres") or "Web address",
//    the editor and an org admin read "Table <table>" and the host and get the same bytes. NEGATIVE CONTROL: the editor.
// 4. `dataset:list` and `pipelines:get`: a warehouse driver's refresh error ("relation … does not exist") names the table,
//    so a viewer gets the failure without its text; a dataset not from a connection keeps its text.
//    NEGATIVE CONTROL: the editor reads the text. The runner stores the editor's run under the web import's real id.
//    The same error reaches a viewer a second way, in the alert a failed pipeline run raises (`alerts:list`, the `alerts:fired`
//    push) and in the scheduled refresh's `hub:dataset-refreshed` push: both say it failed, not why.
//    So does the dashboard Summary card's alert sentence (summary:compute, and summary:rewrite, which narrates the same
//    sentences for a model): a viewer, and any page that leaves the app, read the fixed sentence.
//    Channels checked for a refresh or run error: dataset:list, pipelines:get, pipelines:changed, alerts:list, alerts:fired,
//    hub:dataset-refreshed, summary:compute, summary:rewrite.
// 5. `connections:list`: a viewer gets the connection's id, name, kind of source, status and dataset count: no host, port,
//    database, user, table, SQL, saved queries, last failure text or dates. NEGATIVE CONTROL: the editor reads them all.
//    A connection named after its database or host (what a blank name field saves) reads as the connector ("PostgreSQL") for a viewer
//    in connections:list, dataset:source, lineage:get, pipelines:get and the ⌘K search (the index and the reference path).
// 6. `sourceTable:*` (the store's four channels, semantic layer p2-03): each is `write`, so a viewer is refused 403 before a handler
//    and its reply holds no table name. Every channel in the contract file has a viewer case here (a channel a later PR adds
//    must add its payload). NEGATIVE CONTROL: the editor is answered. The store also runs here on Postgres rows: the doc's lock,
//    then the index's inside it, one transaction.
//    `sourceTable:read` (p2-04) is one of them, and its 60-an-hour limit holds across pods: 60 takes through a second pool
//    (another pod) are counted by the first, which refuses before the warehouse is asked. NEGATIVE CONTROL: another connection.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-sourceNamesHidden.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const pipelineStore: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
const pipelineRunner: typeof import('../src/app/pipelineRunner') = require('../src/app/pipelineRunner');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const summary: typeof import('../src/ipc/summary') = require('../src/ipc/summary');
const { randomUUID }: typeof import('crypto') = require('crypto');
const { sourceView }: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const { seesSourceNames }: typeof import('../src/data/sourceNames') = require('../src/data/sourceNames');
const searchMod: typeof import('../src/ipc/search') = require('../src/ipc/search');
const lineageMod: typeof import('../src/ipc/lineage') = require('../src/ipc/lineage');
const sourceDocs: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const { READS_PER_HOUR }: typeof import('../src/ipc/sourceTableRead') = require('../src/ipc/sourceTableRead');
const { factsReadLimit }: typeof import('../src/app/sourceTableMessages') = require('../src/app/sourceTableMessages');
const { Pool }: typeof import('pg') = require('pg');

const HOST = 'canary-host-9f3.internal';
const DATABASE = 'canary_db_9f3';
const DB_USER = 'canary_user_9f3';
const TABLE = 'public.canary_tbl_9f3';
const CONN_QUERY = 'select * from canary_tbl_9f3';
const SAVED_SQL = 'select 1 from canary_tbl_9f3';
const REFRESH_ERROR = `relation "${TABLE}" does not exist`;
const WEB_HOST = 'canary-host-web-9f3.internal';
const NAMED_DB = 'canary_db_named_9f3'; // a connection saved with a blank name is named after its database, its host or its URL
const NAMED_HOST = 'canary-host-named-9f3.internal';
const WEB_URL = `https://${WEB_HOST}/export.csv`;
const T = new Date().toISOString();
const FAILED_SENTENCE = 'A refresh failed. Ask an editor for the details.';
const FIXTURES = [HOST, DATABASE, DB_USER, TABLE, CONN_QUERY, SAVED_SQL, REFRESH_ERROR, WEB_HOST, WEB_URL, NAMED_DB, NAMED_HOST];
/** Every fixture above matches (the hyphenated hosts too): a leak of any of them is visible to a text assert. */
const CANARY = /canary[-_](tbl|db|user|host)/;

(async () => {
  ok('the canary matches every fixture, the hyphenated hosts included', FIXTURES.every((f) => CANARY.test(f)), FIXTURES.filter((f) => !CANARY.test(f)).join(', '));
  ok('sourceView: hideNames keeps "a query"', sourceView('postgres', { kind: 'connection', connId: 'c', sql: 'select 1' }, () => 'W', { hideNames: true }).label === 'Connection · W · a query');
  ok('sourceView: hideNames drops the table', sourceView('postgres', { kind: 'connection', connId: 'c', table: TABLE }, () => 'W', { hideNames: true }).label === 'Connection · W');
  ok('sourceView: hideNames drops a web import\'s host', sourceView('url', { kind: 'url', url: WEB_URL }, () => 'W', { hideNames: true }).label === 'Web address');
  ok('NEGATIVE CONTROL: sourceView without hideNames names the table', sourceView('postgres', { kind: 'connection', connId: 'c', table: TABLE }, () => 'W').label === `Connection · W · ${TABLE}`);
  ok('NEGATIVE CONTROL: …and the host', sourceView('url', { kind: 'url', url: WEB_URL }, () => 'W').label === `Web address · ${WEB_HOST}`);
  ok('seesSourceNames: an empty id is a viewer', (await seesSourceNames('')) === false);
  ok('seesSourceNames: an id that is not a project id is a viewer', (await seesSourceNames('x')) === false);

  const W = await H.world('source names');
  if (!W) return finish();
  try {
    const { P } = W;
    const { connId, byDb, byHost, D, dDb, web, U } = await W.as('boss', async () => {
      const conn = await connections.saveConnection(P, {
        name: 'Warehouse',
        connectorId: 'postgres',
        values: { host: HOST, port: 5432, database: DATABASE, user: DB_USER },
        table: TABLE,
        query: CONN_QUERY,
        lastStatus: 'error',
        lastError: REFRESH_ERROR,
      });
      if (!conn) throw new Error('saveConnection refused');
      await connections.saveQuery(P, conn.id, { name: 'Q', sql: SAVED_SQL });
      // What connection:testAndSave stores for a blank name field (its database, else its host), and a name that holds the host in other case.
      const named = async (name: string, values: Record<string, unknown>) => {
        const c = await connections.saveConnection(P, { name, connectorId: 'postgres', values });
        if (!c) throw new Error('saveConnection (named) refused');
        return c.id;
      };
      const [byDb, byHost] = [await named(NAMED_DB, { host: 'h.internal', database: NAMED_DB }), await named(`Replica of ${NAMED_HOST.toUpperCase()}`, { host: NAMED_HOST })];
      const ds = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId: conn.id, table: TABLE, readsTables: [TABLE] } });
      if (!ds) throw new Error('saveDataset refused');
      await datasets.markRefresh(P, ds.id, 'error', REFRESH_ERROR);
      // A dataset read from the connection named after its database: dataset:source, lineage and pipelines draw that name.
      const fromDb = await datasets.saveDataset(P, { name: 'Named orders', sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId: byDb, table: TABLE } });
      if (!fromDb) throw new Error('saveDataset (named) refused');
      const fromWeb = await datasets.saveDataset(P, { name: 'Web orders', sourceKind: 'url', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'url', url: WEB_URL } });
      if (!fromWeb) throw new Error('saveDataset (web) refused');
      // U: a failed import that is not from a connection ("HTTP 500" names nothing), so a viewer keeps its text.
      const open = await datasets.saveDataset(P, { name: 'Open data', sourceKind: 'url', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'url', url: 'https://api.example.com/x' } });
      if (!open) throw new Error('saveDataset (open) refused');
      await datasets.markRefresh(P, open.id, 'error', 'HTTP 500');
      // The failed runs the pipeline keeps for each (a run's id is a UUID, or the store drops it).
      const failed = (nodeId: string, error: string) => ({ nodeId, id: randomUUID(), runId: randomUUID(), trigger: 'manual' as const, status: 'failed' as const, startedAt: T, finishedAt: T, durationMs: 1, attempts: 1, warnings: [], errors: [error] });
      await pipelineStore.appendRuns(P, [failed('dataset:' + ds.id, REFRESH_ERROR), failed('dataset:' + open.id, 'HTTP 500')]);
      return { connId: conn.id, byDb, byHost, D: ds.id, dDb: fromDb.id, web: fromWeb.id, U: open.id };
    });
    ok('the fixture connection exists', typeof connId === 'string' && connId.length > 0);

    // The project's viewer with no rules on D is `nobody`; `ed` is its editor.
    const src = (who: string, id: string) => W.call(who, 'dataset:source', { projectId: P, id });
    const viewer = await src('nobody', D);
    const editor = await src('ed', D);
    ok('dataset:source: a viewer reads the connection, not the table', viewer.body.label === 'Connection · Warehouse', viewer.text);
    ok('dataset:source: nothing of the source reaches a viewer', !CANARY.test(viewer.text), viewer.text);
    ok('NEGATIVE CONTROL: the editor still reads the table', editor.body.label === `Connection · Warehouse · ${TABLE}`, editor.text);

    const viewerWeb = await src('nobody', web);
    const editorWeb = await src('ed', web);
    ok('dataset:source: a viewer reads "Web address", not its host', viewerWeb.body.label === 'Web address', viewerWeb.text);
    ok('dataset:source: nothing of the web import reaches a viewer', !CANARY.test(viewerWeb.text), viewerWeb.text);
    ok('NEGATIVE CONTROL: the editor still reads the host', editorWeb.body.label === `Web address · ${WEB_HOST}`, editorWeb.text);

    // connections:list carries the address, the picked table, the SQL and the last failure; a viewer gets the card only.
    const conns = (who: string) => W.call(who, 'connections:list', { projectId: P });
    const [connsViewer, connsEditor] = [await conns('nobody'), await conns('ed')];
    // `entry` is {} for an id the reply does not list (or a reply that is not a list), so a regression prints FAIL instead of throwing.
    const list = (r: H.Reply) => (Array.isArray(r.body) ? r.body : []);
    const entry = (r: H.Reply, id: string) => list(r).find((c: { id: string }) => c.id === id) ?? {};
    const [cv, ce] = [entry(connsViewer, connId), entry(connsEditor, connId)];
    const HIDDEN = ['values', 'table', 'query', 'queries', 'lastError', 'secretSet', 'host', 'port', 'database', 'user', 'url', 'ssl', 'kind', 'projectId', 'linkedDatasetId', 'lastRefreshedAt', 'createdAt', 'updatedAt', 'schemaVersion'];
    ok('connections:list: a viewer gets no address, selection, SQL or failure text', list(connsViewer).length === 3 && list(connsViewer).every((e: object) => HIDDEN.every((k) => !(k in e))) && !CANARY.test(connsViewer.text), connsViewer.text);
    ok('connections:list: a viewer gets the card and nothing else', list(connsViewer).every((e: object) => Object.keys(e).sort().join() === 'connectorId,datasetCount,id,lastStatus,name'), connsViewer.text);
    ok('connections:list: …with the connection\'s name, kind of source, status and dataset count', cv.id === connId && cv.name === 'Warehouse' && cv.connectorId === 'postgres' && cv.lastStatus === 'error' && cv.datasetCount === 1, connsViewer.text);
    ok('NEGATIVE CONTROL: the editor gets host, port, the saved SQL, the table and the failure', ce.values?.host === HOST && ce.host === HOST && ce.port === 5432 && ce.queries?.[0]?.sql.includes('canary_tbl_9f3') && ce.table === TABLE && ce.lastError === REFRESH_ERROR && ce.secretSet !== undefined, connsEditor.text);
    // A name that is, or holds, one of the connection's hidden values is the address under another word: a viewer reads the connector's label.
    ok('connections:list: a connection named after its database, or holding its host, reads as the connector for a viewer', entry(connsViewer, byDb).name === 'PostgreSQL' && entry(connsViewer, byHost).name === 'PostgreSQL', connsViewer.text);
    ok('NEGATIVE CONTROL: …a plainly named one keeps its name, and the editor always reads the stored names', cv.name === 'Warehouse' && entry(connsEditor, byDb).name === NAMED_DB && entry(connsEditor, byHost).name === `Replica of ${NAMED_HOST.toUpperCase()}`, connsEditor.text);

    // The same name reaches a viewer wherever a reply names the connection: dataset:source, lineage, pipelines, the ⌘K search.
    const [srcDbViewer, srcDbEditor] = [await src('nobody', dDb), await src('ed', dDb)];
    ok('dataset:source: a connection named after its database reads as the connector for a viewer', srcDbViewer.body.label === 'Connection · PostgreSQL' && !CANARY.test(srcDbViewer.text), srcDbViewer.text);
    ok('NEGATIVE CONTROL: the editor reads the stored name', srcDbEditor.body.label === `Connection · ${NAMED_DB} · ${TABLE}`, srcDbEditor.text);
    const find = (who: string, query: string) => W.call(who, 'search:query', { projectId: P, query });
    const hits = (r: H.Reply): { kind: string; name: string }[] => r.body.results ?? [];
    const [sFind, sFindEditor, sMine] = [await find('nobody', NAMED_DB), await find('ed', NAMED_DB), await find('nobody', 'postgresql')];
    ok('search:query: a viewer cannot find a connection by its database name, and reads it as the connector', hits(sFind).length === 0 && hits(sMine).filter((h) => h.kind === 'connection' && h.name === 'PostgreSQL').length === 2 && !CANARY.test(sFind.text + sMine.text), sMine.text);
    ok('NEGATIVE CONTROL: the editor finds it by the stored name', hits(sFindEditor).some((h) => h.kind === 'connection' && h.name === NAMED_DB), sFindEditor.text);
    // The reference path reads the lists (the index is the other path): searchNames asks the same question.
    const named = async (who: string) => (await W.as(who, () => searchMod.searchNames(P, NAMED_DB))).map((h) => h.name);
    ok('searchNames: a viewer finds nothing by the database name; the editor finds the stored name', (await named('nobody')).length === 0 && (await named('ed')).includes(NAMED_DB));
    // search:query falls back to searchNames when the index answers null, so the search asserts above pass without the index: ask it directly.
    const indexed = async (who: string, viewer: boolean) => W.as(who, () => searchMod.searchIndexed(P, NAMED_DB, viewer, 20));
    const [idxViewer, idxEditor] = [await indexed('nobody', true), await indexed('ed', false)];
    ok('searchIndexed: the index itself answers a viewer with nothing for the database name', idxViewer !== null && idxViewer.length === 0, JSON.stringify(idxViewer));
    ok('NEGATIVE CONTROL: …and answers an editor with the stored name', idxEditor !== null && idxEditor.some((h) => h.name === NAMED_DB), JSON.stringify(idxEditor));

    // Lineage and Pipelines draw the source node from the dataset's origin: `loadInput` trims the table and the web address for a viewer.
    const lin = (who: string, id = D) => W.call(who, 'lineage:get', { projectId: P, type: 'dataset', id });
    const pipe = (who: string) => W.call(who, 'pipelines:get', { projectId: P });
    type N = { kind: string; name: string; sub: string; ref?: { type: string } };
    const srcNode = (r: H.Reply) => r.body.nodes.find((n: N) => n.kind === 'source');
    const connNode = (r: H.Reply, id = connId) => r.body.nodes.find((n: N & { id: string }) => n.id === 'source:conn:' + id);
    const webNode = (r: H.Reply) => r.body.nodes.find((n: N) => n.kind === 'source' && n.sub === 'Web address');
    /** The source node drawn into dataset `id` (the pipeline has one per web dataset). */
    const feeds = (r: H.Reply, id: string) => r.body.nodes.find((n: { id: string }) => n.id === r.body.edges.find((e: { from: string; to: string }) => e.to === 'dataset:' + id)?.from);
    const [linViewer, pipeViewer, linEditor, pipeEditor, linBoss] = [await lin('nobody'), await pipe('nobody'), await lin('ed'), await pipe('ed'), await lin('boss')];
    const [linWebViewer, linWebEditor] = [await lin('nobody', web), await lin('ed', web)];
    ok('lineage:get: a viewer reads the connector kind', srcNode(linViewer).sub === 'postgres' && !CANARY.test(linViewer.text), linViewer.text);
    ok('lineage:get: a viewer reads "Web address", not its host', webNode(linWebViewer).name === 'Web address' && !CANARY.test(linWebViewer.text), linWebViewer.text);
    ok('pipelines:get: a viewer reads the connector kind and "Web address", nothing of a source', connNode(pipeViewer).sub === 'postgres' && feeds(pipeViewer, web).name === 'Web address' && !CANARY.test(pipeViewer.text), pipeViewer.text);
    ok('NEGATIVE CONTROL: the editor reads "Table public.canary_tbl_9f3" in lineage and in pipelines', srcNode(linEditor).sub === `Table ${TABLE}` && connNode(pipeEditor).sub === `Table ${TABLE}`, linEditor.text);
    ok('NEGATIVE CONTROL: the editor reads the web import\'s host in lineage and in pipelines', webNode(linWebEditor).name === WEB_HOST && feeds(pipeEditor, web).name === WEB_HOST, linWebEditor.text);
    const [linDbViewer, linDbEditor] = [await lin('nobody', dDb), await lin('ed', dDb)];
    ok('lineage:get and pipelines:get: a connection named after its database reads as the connector for a viewer', srcNode(linDbViewer).name === 'PostgreSQL' && connNode(pipeViewer, byDb).name === 'PostgreSQL' && !CANARY.test(linDbViewer.text), linDbViewer.text);
    ok('NEGATIVE CONTROL: the editor reads the stored name in lineage and in pipelines', srcNode(linDbEditor).name === NAMED_DB && connNode(pipeEditor, byDb).name === NAMED_DB, linDbEditor.text);
    // The input both read: `readsTables` (spec D11) names warehouse tables, so it is trimmed with `table`.
    const originOf = async (who: string) => JSON.parse(JSON.stringify((await W.as(who, () => lineageMod.loadInput(P))).datasets.find((d) => d.id === D)?.origin));
    const [inViewer, inEditor] = [await originOf('nobody'), await originOf('ed')];
    ok('loadInput: a viewer\'s dataset origin carries neither the table nor readsTables', inViewer.table === undefined && inViewer.readsTables === undefined, JSON.stringify(inViewer));
    ok('NEGATIVE CONTROL: the editor\'s carries both', inEditor.table === TABLE && inEditor.readsTables?.join() === TABLE, JSON.stringify(inEditor));
    const pipeBoss = await pipe('boss');
    const drawn = (r: H.Reply) => JSON.stringify(r.body.nodes.map((n: N & { id: string }) => [n.id, n.name, n.sub]));
    ok('an editor and an org admin get the same bytes', linEditor.text === linBoss.text);
    ok('…and the same pipeline nodes (id, name, sub)', drawn(pipeEditor) === drawn(pipeBoss), drawn(pipeEditor));

    // A refresh error quotes the relation the driver could not find: a viewer gets the failure, not its text.
    const listOf = async (who: string, id: string) => (await W.call(who, 'dataset:list', { projectId: P })).body.find((d: { id: string }) => d.id === id);
    const [vD, eD, vU] = [await listOf('nobody', D), await listOf('ed', D), await listOf('nobody', U)];
    ok('dataset:list: a viewer gets the failure, not its text', vD.lastRefreshStatus === 'error' && !('lastRefreshError' in vD), JSON.stringify(vD));
    ok('dataset:list: …and no `scoped` flag, the dataset is not closed', !('scoped' in vD));
    ok('NEGATIVE CONTROL: the editor reads the text', /canary_tbl_9f3/.test(eD.lastRefreshError), JSON.stringify(eD));
    ok('a dataset not from a connection keeps its text for a viewer', vU.lastRefreshError === 'HTTP 500', JSON.stringify(vU));
    const runsOf = (r: H.Reply, id: string) => r.body.nodes.find((n: { id: string }) => n.id === 'dataset:' + id).runs;
    ok('pipelines:get: no run error text for a viewer, the failure stays', !CANARY.test(pipeViewer.text) && runsOf(pipeViewer, D)[0].status === 'failed' && runsOf(pipeViewer, D)[0].errors.length === 0, JSON.stringify(runsOf(pipeViewer, D)));
    ok('NEGATIVE CONTROL: the editor reads the run error through pipelines:get', /canary_tbl_9f3/.test(runsOf(pipeEditor, D)[0].errors.join()), JSON.stringify(runsOf(pipeEditor, D)));
    ok('pipelines:get: a run of a dataset not from a connection keeps its text for a viewer', runsOf(pipeViewer, U)[0].errors[0] === 'HTTP 500', JSON.stringify(runsOf(pipeViewer, U)));

    // A failed pipeline run raises an alert whose message carries the run's error (pipelineRunner.raiseFailures),
    // for a dataset from a connection (D), one that is not (U), and next to an ordinary rule's alert on D.
    const planted = await W.as('boss', async () => {
      const node = (id: string, name: string) => ({ id: 'dataset:' + id, kind: 'dataset' as const, stage: 1, name, sub: '', ref: { type: 'dataset', id } });
      const failed = (id: string, error: string) => ({ nodeId: 'dataset:' + id, status: 'failed' as const, attempts: 1, startedAt: 0, finishedAt: 1, result: { ok: false, error } });
      await pipelineRunner.raiseFailures(P, { nodes: [node(D, 'Orders'), node(U, 'Open data')], edges: [] }, [failed(D, REFRESH_ERROR), failed(U, 'HTTP 500')]);
      await alertStore.recordEvents(P, [{ id: randomUUID(), ruleId: randomUUID(), ruleName: 'Revenue dips', datasetId: D, at: T, value: 1, previous: 2, delta: -1, deltaPct: -50, message: 'Revenue fell 50%', seen: false }]);
      return (await alertStore.load(P)).events;
    });
    const alertOf = (r: H.Reply, id: string, ruleName: string): string => r.body.events.find((e: { datasetId: string; ruleName: string }) => e.datasetId === id && e.ruleName === ruleName)?.message ?? '';
    const [alertsViewer, alertsEditor] = [await W.call('nobody', 'alerts:list', { projectId: P }), await W.call('ed', 'alerts:list', { projectId: P })];
    ok('alerts:list: a viewer reads a fixed sentence for a failed run, not the driver\'s error', alertOf(alertsViewer, D, 'Pipeline') === FAILED_SENTENCE && !CANARY.test(alertsViewer.text), alertsViewer.text);
    ok('NEGATIVE CONTROL: the editor reads the run error in the alert', /canary_tbl_9f3/.test(alertOf(alertsEditor, D, 'Pipeline')), alertsEditor.text);
    ok('alerts:list: a failure of a dataset not from a connection, and a rule\'s own alert on D, keep their text for a viewer',
      /HTTP 500/.test(alertOf(alertsViewer, U, 'Pipeline')) && alertOf(alertsViewer, D, 'Revenue dips') === 'Revenue fell 50%', alertsViewer.text);
    const pushed: Array<{ channel: string; payload: unknown }> = [];
    await W.as('boss', () => schedules.pushFired(P, planted, (_p, channel, payload) => { pushed.push({ channel, payload }); }));
    const pushedText = JSON.stringify(pushed);
    ok('NEGATIVE CONTROL: the events handed to the push carry the run error', /canary_tbl_9f3/.test(JSON.stringify(planted)));
    ok('alerts:fired: the push carries the fixed sentence, not the run error', pushed.length === 1 && pushed[0].channel === 'alerts:fired' && pushedText.includes(FAILED_SENTENCE) && !CANARY.test(pushedText), pushedText);
    ok('alerts:fired: …and still the failure of a dataset not from a connection and a rule\'s alert', pushedText.includes('HTTP 500') && pushedText.includes('Revenue fell 50%'), pushedText);
    // The Summary card names the newest unseen alert on its datasets, so a fresh failed run of D is the one it names.
    await W.as('boss', () => pipelineRunner.raiseFailures(P, { nodes: [{ id: 'dataset:' + D, kind: 'dataset', stage: 1, name: 'Orders', sub: '', ref: { type: 'dataset', id: D } }], edges: [] }, [{ nodeId: 'dataset:' + D, status: 'failed', attempts: 1, startedAt: 0, finishedAt: 1, result: { ok: false, error: REFRESH_ERROR } }]));
    const pages = [{ cards: [{ id: randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 4, h: 3 }, metric: { datasetId: D, column: 'sales', aggregation: 'sum' } }] }];
    const summaryOf = (who: string) => W.call(who, 'summary:compute', { projectId: P, pages, filters: [] });
    const alertLine = (r: H.Reply): string => (r.body.sentences ?? []).find((x: { kind: string }) => x.kind === 'alert')?.text ?? '';
    const [sumViewer, sumEditor] = [await summaryOf('nobody'), await summaryOf('ed')];
    ok('summary:compute: a viewer\'s alert sentence says a refresh failed, not why', alertLine(sumViewer).includes(FAILED_SENTENCE) && !CANARY.test(sumViewer.text), sumViewer.text);
    ok('NEGATIVE CONTROL: the editor\'s card says the run failed, and why', /canary_tbl_9f3/.test(alertLine(sumEditor)), sumEditor.text);
    // A report, a published site and the model (summary:rewrite) ask outbound; the contract has no such key, the server's own callers do.
    const out = await W.as('ed', () => summary.computeSummary(P, pages, { filters: [], params: new Map(), outbound: true }));
    const outLine = out.find((x) => x.kind === 'alert')?.text ?? '';
    ok('computeSummary: a page that leaves the app (outbound) never quotes it, even for an editor', outLine.includes(FAILED_SENTENCE) && !CANARY.test(JSON.stringify(out)), JSON.stringify(out));

    // A scheduled refresh that fails tells every reader's tabs that it failed (the web reads ok, projectId, datasetId), never why.
    const outcome = { projectId: P, datasetId: D, name: 'Orders', ok: false, error: REFRESH_ERROR, rowsBefore: 1, rowsAfter: 1 };
    const tabs = schedules.failedRefreshPayload(outcome);
    ok('NEGATIVE CONTROL: the outcome a failed scheduled refresh reports carries the error', CANARY.test(JSON.stringify(outcome)));
    ok('hub:dataset-refreshed: a failed refresh\'s push says which dataset, not why', tabs.ok === false && tabs.datasetId === D && tabs.projectId === P && !('error' in tabs) && !CANARY.test(JSON.stringify(tabs)), JSON.stringify(tabs));

    // The runner draws its graph unrestricted: node ids are persisted, so an editor's run is stored under the web import's real id.
    // Run the web source with its dataset paused, so nothing is fetched.
    const paused = await W.call('ed', 'pipelines:setPaused', { projectId: P, nodeId: 'dataset:' + web, paused: true });
    const ran = await W.call('ed', 'pipelines:run', { projectId: P, nodeId: feeds(pipeEditor, web).id });
    const stored = Object.keys((await W.as('boss', () => pipelineStore.load(P))).runs);
    ok('pipelines:run: the editor\'s run is stored under source:url:<url>, not a masked or viewer id', paused.body.ok === true && ran.body.ok === true && stored.includes('source:url:' + WEB_URL) && !stored.some((k) => k.includes('#')), `${ran.text} ${stored.join()}`);

    // 6. Source table docs: the four channels are `write`, so a viewer is refused before a handler, and the refusal names nothing.
    const created = await W.call('ed', 'sourceTable:save', { projectId: P, connId, table: TABLE, patch: { owner: 'Data platform', guide: `Filter on ${TABLE}` } });
    const docId: string = created.body.docId;
    ok('sourceTable:save: the editor creates a doc on Postgres rows', created.status === 200 && created.body.ok === true && created.body.created === true && /^[0-9a-f-]{36}$/.test(docId), created.text);
    const PAYLOAD: Record<string, object> = {
      'sourceTable:list': { projectId: P },
      'sourceTable:get': { projectId: P, connId, docId },
      'sourceTable:save': { projectId: P, connId, table: TABLE, patch: { guide: 'x' } },
      'sourceTable:delete': { projectId: P, connId, docId },
      'sourceTable:read': { projectId: P, connId, docId },
      'sourceTable:lineage': { projectId: P, connId, docId },
      'sourceTable:forDataset': { projectId: P, datasetId: D },
      'dataset:setSourceTables': { projectId: P, datasetId: D, tables: [TABLE] },
      'dataset:sourceTableChoices': { projectId: P, datasetId: D },
      'catalog:suggestions': { projectId: P, datasetId: D },
      'catalog:dismissSuggestion': { projectId: P, datasetId: D, connId, docId, kind: 'table', hash: 'AbCdEf012345' },
    };
    const channels = Object.keys(require('../src/api/sourceTables').sourceTables);
    ok('every source table channel has a viewer case here', channels.every((ch) => ch in PAYLOAD), channels.filter((ch) => !(ch in PAYLOAD)).join());
    for (const ch of channels) {
      const r = await W.call('nobody', ch, PAYLOAD[ch]);
      ok(`${ch}: a viewer is refused 403, and the refusal names no table`, r.status === 403 && !CANARY.test(r.text), r.text);
    }
    ok('…and nothing was changed by the viewer\'s save or delete', (await W.as('boss', () => sourceDocs.listSourceIndex(P, connId))).map((e) => e.table).join() === TABLE);
    const [edList, edGet] = [await W.call('ed', 'sourceTable:list', { projectId: P }), await W.call('ed', 'sourceTable:get', PAYLOAD['sourceTable:get'])];
    ok('NEGATIVE CONTROL: the editor is answered, and reads the table name', edList.status === 200 && edGet.status === 200 && edGet.body.doc.table === TABLE && CANARY.test(edList.text) && edGet.body.datasets.some((d: { id: string }) => d.id === D), `${edList.text} ${edGet.text}`);
    ok('sourceTable:list: the table a dataset is built from is a row, with its doc', ((r) => r?.docId === docId && r.datasetIds.includes(D))(edList.body.connections.find((c: { connId: string }) => c.connId === connId)?.rows.find((r: { table: string }) => r.table === TABLE)), edList.text);
    // The store on Postgres: a stale save is a 409 and changes nothing; the current tag saves; the delete takes the entry with the doc.
    const stale = await W.call('ed', 'sourceTable:save', { projectId: P, connId, docId, patch: { guide: 'lost' }, base: 'stale' });
    ok('sourceTable:save: a stale base is a 409 on Postgres rows, and the doc is unchanged', stale.status === 409 && stale.body.code === 'record_changed' && (await W.call('ed', 'sourceTable:get', PAYLOAD['sourceTable:get'])).body.doc.guide === `Filter on ${TABLE}`, stale.text);
    const next = await W.call('ed', 'sourceTable:save', { projectId: P, connId, docId, patch: { guide: 'second' }, base: edGet.body.tag });
    ok('NEGATIVE CONTROL: the current tag saves, the index follows', next.status === 200 && next.body.tag !== edGet.body.tag && (await W.as('boss', () => sourceDocs.readSourceDoc(P, connId, docId)))?.rec.guide === 'second' && (await W.as('boss', () => sourceDocs.listSourceIndex(P, connId)))[0].hasGuide === true, next.text);
    // The read's limit is in the shared counters: another pod's 60 reads are this pod's refusal, before any warehouse is asked.
    const other = await W.call('ed', 'sourceTable:save', { projectId: P, connId: byDb, table: TABLE, patch: {} });
    const podB = new Pool(W.pool.options);
    podB.on('error', () => undefined);
    counters.useCounterDb(podB);
    for (let i = 0; i < READS_PER_HOUR; i++) await counters.take('acme', [{ key: `sourceRead:${connId}`, limit: READS_PER_HOUR, windowMs: 3_600_000 }]);
    counters.useCounterDb(W.pool);
    await podB.end();
    const limited = await W.call('ed', 'sourceTable:read', PAYLOAD['sourceTable:read']);
    ok('sourceTable:read: the limit holds across pods, and the refusal names no table', limited.status === 200 && limited.body.ok === false && limited.body.error === factsReadLimit(Math.ceil(limited.body.retryAfterSec / 60)) && /Try again in \d+ min/.test(limited.body.error) && !CANARY.test(limited.text), limited.text);
    const free = await W.call('ed', 'sourceTable:read', { projectId: P, connId: byDb, docId: other.body.docId });
    ok('NEGATIVE CONTROL: another connection is not limited (its read goes on to the warehouse and fails there)', free.status === 200 && free.body.ok === false && !/Try again in/.test(free.body.error), free.text);
    const gone = await W.call('ed', 'sourceTable:delete', PAYLOAD['sourceTable:delete']);
    ok('sourceTable:delete: the doc and its entry go together', gone.body.ok === true && (await W.as('boss', () => sourceDocs.listSourceIndex(P, connId))).length === 0 && (await W.as('boss', () => sourceDocs.readSourceDoc(P, connId, docId))) === null, gone.text);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
