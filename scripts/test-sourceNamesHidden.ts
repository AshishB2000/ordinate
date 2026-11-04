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

const HOST = 'canary-host-9f3.internal';
const DATABASE = 'canary_db_9f3';
const DB_USER = 'canary_user_9f3';
const TABLE = 'public.canary_tbl_9f3';
const CONN_QUERY = 'select * from canary_tbl_9f3';
const SAVED_SQL = 'select 1 from canary_tbl_9f3';
const REFRESH_ERROR = `relation "${TABLE}" does not exist`;
const WEB_HOST = 'canary-host-web-9f3.internal';
const WEB_URL = `https://${WEB_HOST}/export.csv`;
const T = new Date().toISOString();
const FAILED_SENTENCE = 'A refresh failed. Ask an editor for the details.';
const FIXTURES = [HOST, DATABASE, DB_USER, TABLE, CONN_QUERY, SAVED_SQL, REFRESH_ERROR, WEB_HOST, WEB_URL];
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
    const { connId, D, web, U } = await W.as('boss', async () => {
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
      const ds = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId: conn.id, table: TABLE } });
      if (!ds) throw new Error('saveDataset refused');
      await datasets.markRefresh(P, ds.id, 'error', REFRESH_ERROR);
      const fromWeb = await datasets.saveDataset(P, { name: 'Web orders', sourceKind: 'url', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'url', url: WEB_URL } });
      if (!fromWeb) throw new Error('saveDataset (web) refused');
      // U: a failed import that is not from a connection ("HTTP 500" names nothing), so a viewer keeps its text.
      const open = await datasets.saveDataset(P, { name: 'Open data', sourceKind: 'url', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'url', url: 'https://api.example.com/x' } });
      if (!open) throw new Error('saveDataset (open) refused');
      await datasets.markRefresh(P, open.id, 'error', 'HTTP 500');
      // The failed runs the pipeline keeps for each (a run's id is a UUID, or the store drops it).
      const failed = (nodeId: string, error: string) => ({ nodeId, id: randomUUID(), runId: randomUUID(), trigger: 'manual' as const, status: 'failed' as const, startedAt: T, finishedAt: T, durationMs: 1, attempts: 1, warnings: [], errors: [error] });
      await pipelineStore.appendRuns(P, [failed('dataset:' + ds.id, REFRESH_ERROR), failed('dataset:' + open.id, 'HTTP 500')]);
      return { connId: conn.id, D: ds.id, web: fromWeb.id, U: open.id };
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
    const [cv, ce] = [connsViewer.body[0], connsEditor.body[0]];
    const HIDDEN = ['values', 'table', 'query', 'queries', 'lastError', 'secretSet', 'host', 'port', 'database', 'user', 'url', 'ssl', 'kind', 'projectId', 'linkedDatasetId', 'lastRefreshedAt', 'createdAt', 'updatedAt', 'schemaVersion'];
    ok('connections:list: a viewer gets no address, selection, SQL or failure text', connsViewer.body.length === 1 && HIDDEN.every((k) => !(k in cv)) && !CANARY.test(connsViewer.text), connsViewer.text);
    ok('connections:list: a viewer gets the card and nothing else', JSON.stringify(Object.keys(cv).sort()) === JSON.stringify(['connectorId', 'datasetCount', 'id', 'lastStatus', 'name']), Object.keys(cv).join());
    ok('connections:list: …with the connection\'s name, kind of source, status and dataset count', cv.id === connId && cv.name === 'Warehouse' && cv.connectorId === 'postgres' && cv.lastStatus === 'error' && cv.datasetCount === 1, connsViewer.text);
    ok('NEGATIVE CONTROL: the editor gets host, port, the saved SQL, the table and the failure', ce.values.host === HOST && ce.host === HOST && ce.port === 5432 && ce.queries[0].sql.includes('canary_tbl_9f3') && ce.table === TABLE && ce.lastError === REFRESH_ERROR && ce.secretSet !== undefined, connsEditor.text);

    // Lineage and Pipelines draw the source node from the dataset's origin: `loadInput` trims the table and the web address for a viewer.
    const lin = (who: string, id = D) => W.call(who, 'lineage:get', { projectId: P, type: 'dataset', id });
    const pipe = (who: string) => W.call(who, 'pipelines:get', { projectId: P });
    type N = { kind: string; name: string; sub: string; ref?: { type: string } };
    const srcNode = (r: H.Reply) => r.body.nodes.find((n: N) => n.kind === 'source');
    const connNode = (r: H.Reply) => r.body.nodes.find((n: N) => n.kind === 'source' && n.ref?.type === 'connection');
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
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
