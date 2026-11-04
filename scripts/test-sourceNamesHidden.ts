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
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-sourceNamesHidden.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
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
    const { connId, D, web } = await W.as('boss', async () => {
      const conn = await connections.saveConnection(P, {
        name: 'Warehouse',
        connectorId: 'postgres',
        values: { host: HOST, database: DATABASE, user: DB_USER },
        table: TABLE,
        query: CONN_QUERY,
      });
      if (!conn) throw new Error('saveConnection refused');
      await connections.saveQuery(P, conn.id, { name: 'Q', sql: SAVED_SQL });
      const ds = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'postgres', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'connection', connId: conn.id, table: TABLE } });
      if (!ds) throw new Error('saveDataset refused');
      await datasets.markRefresh(P, ds.id, 'error', REFRESH_ERROR);
      const fromWeb = await datasets.saveDataset(P, { name: 'Web orders', sourceKind: 'url', columns: H.COLUMNS, rows: H.ROWS, origin: { kind: 'url', url: WEB_URL } });
      if (!fromWeb) throw new Error('saveDataset (web) refused');
      return { connId: conn.id, D: ds.id, web: fromWeb.id };
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
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
