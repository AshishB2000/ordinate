// "Add to dashboard" on an answer card — `answer:addToDashboard` (src/ipc/answerDashboard.ts) over the real RPC route.
//
//   no db (dev sign-in, server mode)
//     contract  write, project-scoped, a strict input
//     add       on an existing dashboard: exactly one visual more and one tile more on its DRAFT, and no other dashboard;
//               the tile's figures through THE tile door (analysis:tiles) are the answer card's, Object.is; the
//               published copy is byte-identical and the dashboard reads "edited"
//     twice     the same answer on the same dashboard is the tile already there (`already`: no visual, no tile); NEGATIVE
//               CONTROL: another dashboard gets a second
//     turn      named, the turn keeps the dashboard: its card after a reload says where (`onDashboard`), and a visual it
//               already keeps (Save as visual's) is the one put on; NEGATIVE CONTROL: another turn's card says nothing
//     table     a source table's answer is kept as a Live dataset in the same call and added on it, its turn re-pointed at
//               it; a second click makes neither a second dataset nor a second tile
//     new       no dashboard named: a new one holding just that tile, named as asked (else the card's title)
//     refused   a viewer (403) and an SQL answer (nothing written either way); NEGATIVE CONTROL: the same editor's chart
//               answer goes
//   db (header sign-in, a folder: Ops holds Orders and the Ops board; team Ops views it, team Ops leads edits it)
//     picker    stats:dashboards lists only the dashboards the caller edits
//     folder    an editor who views Ops: 409 `edit` on the Ops board, nothing written; one with nothing on Ops: 409
//               `closed`; NEGATIVE CONTROLS: the Ops lead adds to it, and the first editor adds to a board in Everyone
//     landing   a new dashboard of an Orders answer lands in Ops (E6's rule: with its dataset); refused `edit` to the
//               editor who only views Ops
//     viewer    a project viewer: 403, nothing written
//
//   npm run build:ts && node scripts/test-answerAddToDashboard.js            (and again with DATABASE_URL set)

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { ORG, serverMode, show, withServer, type Bench, type Identity } from './notifyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
const msg: typeof import('../src/ai/answerMessages') = require('../src/ai/answerMessages');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const sourceTables: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');

type Any = any; // any: each channel's own reply, read field by field
type ChartData = import('../src/analysis/vizData').ChartData;
const MEASURES = [{ column: 'net_sales', aggregation: 'sum' }];
const specOn = (datasetId: string) => ({ datasetId, category: 'region', measures: MEASURES, filters: [], chartType: 'column', title: 'Sales by region' });
const COLUMNS = [{ name: 'region', type: 'text' as const }, { name: 'net_sales', type: 'number' as const }];
const ROWS = [['West', 1234.5], ['East', 987.25], ['East', 456.75], ['North', 2468.25], ['West', 0.1]];

/** Every figure of a chart by what it is of, so two charts compare whatever their order. */
const figures = (d: ChartData): Map<string, unknown> => new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, unknown] => [`${s.name}\u0000${String(l)}`, s.values[i]])));
const sameFigures = (a: ChartData, b: ChartData): boolean => {
  const [fa, fb] = [figures(a), figures(b)];
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && Object.is(v, fb.get(k)));
};
const cardsOf = (board: Any): Any[] => (board?.sheets ?? []).flatMap((s: Any) => s.cards);

function contractCases(): void {
  const c = api.contracts['answer:addToDashboard'];
  const P = randomUUID();
  const input = { projectId: P, spec: specOn(randomUUID()), analysisId: randomUUID() };
  ok('contract: write, project-scoped by projectId', c.access === 'write' && 'project' in c && c.project(input) === P);
  ok('contract: a strict input — a dashboard id or a name; steps, sheets or a card beside the spec are refused',
    c.input.safeParse(input).success && c.input.safeParse({ projectId: P, spec: input.spec, name: 'Board' }).success
    && !c.input.safeParse({ ...input, steps: [] }).success && !c.input.safeParse({ ...input, card: {} }).success
    && !c.input.safeParse({ ...input, analysisId: 'x' }).success && !c.input.safeParse({ projectId: P, spec: input.spec, name: '  ' }).success
    && !c.input.safeParse({ projectId: P, spec: { category: 'region' } }).success);
}

async function noDatabase(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answeradd-'));
  const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
  const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  serverMode(DATA);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Keep an answer')).id;
    const ds = await datasetsMod.saveDataset(projectId, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    if (!ds) throw new Error('fixture not saved');
    // A warehouse table (the Live fake) documented on its connection: an answer read straight from it (outcome C).
    fakeMod.registerLiveFake();
    await fakeMod.loadWarehouseTable('canary_sales_add', COLUMNS, ROWS as never);
    const conn = await connections.saveConnection(projectId, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    const doc = conn ? await sourceTables.createSourceDoc(projectId, conn.id, 'canary_sales_add', {}) : null;
    if (!conn || !doc?.ok) throw new Error('fixture: the warehouse table');
    await sourceTables.updateSourceDoc(projectId, conn.id, doc.docId, (d) => ({ ...d, facts: { columns: [{ name: 'region', type: 'VARCHAR' }, { name: 'net_sales', type: 'DOUBLE' }], rowEstimate: 5, readAt: new Date().toISOString(), readBy: 'ana@acme.test' } }));
    return { projectId, datasetId: ds.id, connId: conn.id, docId: doc.docId };
  });
  const P = seed.projectId;
  const SPEC = specOn(seed.datasetId);
  const appFor = (who: Identity) => appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => who);
  const admin = appFor(ADMIN);
  const post = async (channel: string, payload: unknown, app = admin) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as Any };
  };
  const visuals = async (): Promise<number> => ((await post('visual:list', { projectId: P })).value as unknown[]).length;
  const boards = async (): Promise<number> => ((await post('analysis:gallery', { projectId: P })).value as unknown[]).length;
  const draft = async (id: string): Promise<Any> => (await post('analysis:open', { projectId: P, id })).value;
  const copy = async (id: string): Promise<string> => JSON.stringify((await post('analysis:open', { projectId: P, id, published: true })).value.analysis);
  try {
    // A published dashboard with one chart on it already (another chart: the same one would be the answer's tile already).
    const first = (await post('visual:save', { projectId: P, datasetId: seed.datasetId, name: 'First', chartType: 'line', encoding: { category: 'region', values: MEASURES } })).value;
    const D = (await post('analysis:create', { projectId: P, name: 'Sales board', sheets: [{ name: 'One', cards: [{ id: randomUUID(), type: 'visual', visualId: first.id, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] })).value.id as string;
    const pub = await post('analysis:publish', { projectId: P, id: D });
    ok('setup: the dashboard is published with one tile', pub.value.ok === true && cardsOf((await draft(D)).analysis).length === 1, pub.body);
    const [v0, b0, copy0] = [await visuals(), await boards(), await copy(D)];

    // ── add, on the existing dashboard ────────────────────────────────────
    const card = (await post('answer:card', { projectId: P, spec: SPEC })).value;
    const added = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: D });
    const a = added.value;
    ok('add: ok, naming the dashboard and the visual it made', added.status === 200 && a.ok === true && a.dashboard?.id === D && a.dashboard.name === 'Sales board' && /^[0-9a-f-]{36}$/.test(a.visual?.id ?? ''), added.body);
    const after = await draft(D);
    const tiles = cardsOf(after.analysis);
    ok('add: exactly one visual more, one tile more on the draft — that visual, under the tile that was there — and no other dashboard',
      (await visuals()) === v0 + 1 && (await boards()) === b0 && tiles.length === 2 && tiles[1].type === 'visual' && tiles[1].visualId === a.visual.id && tiles[1].layout.y >= 6,
      show(tiles));
    const v = (await post('visual:get', { projectId: P, id: a.visual.id })).value;
    const tile = (await post('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: v.datasetId, encoding: v.encoding, filters: v.filters, chartType: v.chartType }] })).value[0];
    ok('add: the card had figures (the check is not vacuous)', card.ok === true && card.data.labels.length === 3, show(card.data));
    ok('differential: the tile, through the tile door, draws the answer card\'s figures (Object.is)', tile?.ok === true && sameFigures(tile.data, card.data), show([tile?.data, card.data]));
    ok('differential NEGATIVE CONTROL: another answer\'s card is another chart', !sameFigures(tile.data, (await post('answer:card', { projectId: P, spec: { ...SPEC, measures: [{ column: 'net_sales', aggregation: 'max' }] } })).value.data));
    ok('draft: the published copy is unchanged, and the dashboard reads "edited"', (await copy(D)) === copy0 && after.status === 'edited', after.status);

    // ── twice ─────────────────────────────────────────────────────────────
    const board = async (name: string): Promise<string> => (await post('analysis:create', { projectId: P, name })).value.id as string;
    const [v2, b2] = [await visuals(), await boards()];
    const twice = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: D });
    ok('twice: the same answer on the same dashboard is the tile already there — `already`, that visual, no visual and no tile more',
      twice.value.ok === true && twice.value.already === true && twice.value.visual?.id === a.visual.id && twice.value.dashboard?.id === D
      && (await visuals()) === v2 && cardsOf((await draft(D)).analysis).length === 2, twice.body);
    const D2 = await board('Ops board');
    const other = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: D2 });
    ok('twice NEGATIVE CONTROL: another dashboard gets a second tile, of a visual of its own',
      other.value.ok === true && !other.value.already && cardsOf((await draft(D2)).analysis).length === 1 && (await visuals()) === v2 + 1 && (await boards()) === b2 + 1, other.body);

    // ── turn ──────────────────────────────────────────────────────────────
    const rerun = async (spec: object): Promise<{ threadId: string; turnId: string }> => {
      const r = (await post('answer:rerun', { projectId: P, spec })).value;
      if (!r?.ok) throw new Error(`rerun: ${show(r)}`);
      return { threadId: r.threadId, turnId: r.turns.at(-1).id };
    };
    const cardOf = async (t: { threadId: string; turnId: string }): Promise<Any> => {
      const kept = ((await post('copilot:history', { projectId: P, threadId: t.threadId })).value.turns as Any[]).find((x) => x.id === t.turnId);
      return kept?.card ?? (await post('answer:refresh', { projectId: P, ...t })).value;
    };
    const T = await rerun(SPEC);
    const keptVisual = (await post('answer:saveVisual', { projectId: P, spec: SPEC, ...T })).value;
    const D3 = await board('Turn board');
    const v3 = await visuals();
    const onTurn = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: D3, ...T });
    ok('turn: the visual its turn keeps (Save as visual\'s) is the one put on — no second visual',
      onTurn.value.ok === true && onTurn.value.visual?.id === keptVisual.visual?.id && (await visuals()) === v3 && cardsOf((await draft(D3)).analysis)[0]?.visualId === keptVisual.visual.id, onTurn.body);
    const reloaded = await cardOf(T);
    ok('turn: after a reload its card says where it went, from the reply it already gets', reloaded?.ok === true && reloaded.onDashboard?.id === D3 && reloaded.onDashboard.name === 'Turn board', show(reloaded?.onDashboard));
    const T2 = await rerun({ ...SPEC, chartType: 'bar' });
    ok('turn NEGATIVE CONTROL: a turn never added says nothing', (await cardOf(T2))?.ok === true && !('onDashboard' in (await cardOf(T2))));

    // ── table ─────────────────────────────────────────────────────────────
    const TSPEC = { ...specOn(seed.docId), table: seed.connId, title: 'Warehouse sales by region' };
    const datasetsNow = async (): Promise<Any[]> => (await post('dataset:list', { projectId: P })).value as Any[];
    const [d0, v4] = [(await datasetsNow()).length, await visuals()];
    const TT = await rerun(TSPEC);
    const D4 = await board('Warehouse board');
    const fromTable = await post('answer:addToDashboard', { projectId: P, spec: TSPEC, analysisId: D4, ...TT });
    const keptDs = (await datasetsNow()).filter((x) => x.mode === 'live');
    const tVisual = fromTable.value.ok ? (await post('visual:get', { projectId: P, id: fromTable.value.visual.id })).value : null;
    ok('table: a source table\'s answer goes on in one call — one Live dataset made, one visual on it, one tile',
      fromTable.value.ok === true && !fromTable.value.already && (await datasetsNow()).length === d0 + 1 && keptDs.length === 1 && tVisual?.datasetId === keptDs[0].id
      && (await visuals()) === v4 + 1 && cardsOf((await draft(D4)).analysis).length === 1, show([fromTable.value, keptDs]));
    const tTurn = ((await post('copilot:history', { projectId: P, threadId: TT.threadId })).value.turns as Any[]).find((x) => x.id === TT.turnId);
    ok('table: its turn is re-pointed at the kept dataset, as Keep as a dataset leaves it', tTurn?.answer?.datasetId === keptDs[0]?.id && !tTurn.answer.table, show(tTurn?.answer));
    const tAgain = await post('answer:addToDashboard', { projectId: P, spec: TSPEC, analysisId: D4 });
    ok('table: a second click makes neither a second dataset nor a second tile', tAgain.value.ok === true && tAgain.value.already === true
      && (await datasetsNow()).length === d0 + 1 && (await visuals()) === v4 + 1 && cardsOf((await draft(D4)).analysis).length === 1, tAgain.body);
    ok('table: after a reload the card says where it went', (await cardOf(TT))?.onDashboard?.id === D4, show((await cardOf(TT))?.onDashboard));

    // ── new ───────────────────────────────────────────────────────────────
    const b5 = await boards();
    const named = await post('answer:addToDashboard', { projectId: P, spec: SPEC, name: ' Sales review ' });
    const made = named.value.ok ? await draft(named.value.dashboard.id) : null;
    ok('new: a new dashboard named as asked, holding just the tile', named.value.ok === true && named.value.dashboard.id !== D && made?.analysis?.name === 'Sales review'
      && cardsOf(made.analysis).length === 1 && cardsOf(made.analysis)[0].visualId === named.value.visual.id && made.status === 'draft' && (await boards()) === b5 + 1, named.body);
    const untitled = await post('answer:addToDashboard', { projectId: P, spec: SPEC });
    ok('new: no name — the card\'s title', untitled.value.ok === true && untitled.value.dashboard.name === 'Sales by region', untitled.body);

    // ── refused ───────────────────────────────────────────────────────────
    const [v1, b1] = [await visuals(), await boards()];
    const viewerApp = appFor(VIEWER);
    const denied = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: D }, viewerApp);
    await viewerApp.close();
    ok('refused: a viewer gets a 403', denied.status === 403, `${denied.status} ${denied.body}`);
    const sql = await post('answer:addToDashboard', { projectId: P, spec: { datasetId: seed.datasetId, sql: 'SELECT region, sum(net_sales) FROM "Orders" GROUP BY 1' }, analysisId: D });
    ok('refused: an SQL answer, in the catalog\'s words', sql.value.ok === false && sql.value.reason === msg.notAChartAnswer(), sql.body);
    const table = await post('answer:addToDashboard', { projectId: P, spec: { ...SPEC, table: randomUUID() }, analysisId: D });
    ok('refused: a source table that is not there keeps nothing', table.value.ok === false && typeof table.value.reason === 'string', table.body);
    const gone = await post('answer:addToDashboard', { projectId: P, spec: SPEC, analysisId: randomUUID() });
    ok('refused: a dashboard that is not there', gone.value.ok === false && gone.value.reason === msg.dashboardGone(), gone.body);
    ok('refused: none of them wrote a visual, a dashboard or a tile', (await visuals()) === v1 && (await boards()) === b1 && cardsOf((await draft(D)).analysis).length === 2);
    const control = await post('answer:addToDashboard', { projectId: P, spec: { ...SPEC, measures: [{ column: 'net_sales', aggregation: 'max' }] }, analysisId: D });
    ok('refused NEGATIVE CONTROL: a chart answer from the editor goes', control.value.ok === true && !control.value.already && cardsOf((await draft(D)).analysis).length === 3, control.body);
  } finally {
    await admin.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function withFolders(b: Bench): Promise<void> {
  const at = (w: string) => `${w}@acme.test`;
  const me = (w: string): Identity => ({ user: { email: at(w), role: w === 'boss' ? 'admin' : 'viewer' }, org: { id: ORG } });
  await b.provision('lead', 'ev', 'ed', 'viv');
  const P = (await b.as('boss').call('projects:create', { name: 'Sales' })).body.id as string;
  for (const w of ['lead', 'ev', 'ed']) await b.share(P, w, 'editor');
  await b.share(P, 'viv', 'viewer');
  const team = async (name: string, who: string): Promise<string> => {
    const id: string = (await b.as('boss').call('admin:createTeam', { name })).body.id;
    await b.as('boss').call('admin:teamMember', { teamId: id, userId: await b.uid(who), member: true });
    return id;
  };
  const [opsTeam, leadsTeam] = [await team('Ops', 'ev'), await team('Ops leads', 'lead')];
  const { orders, plain } = await b.run(me('boss'), async () => {
    const o = await datasetsMod.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    const p = await datasetsMod.saveDataset(P, { name: 'Plain', sourceKind: 'csv', columns: COLUMNS, rows: ROWS.slice(0, 3) });
    if (!o || !p) throw new Error('seed datasets');
    return { orders: o.id, plain: p.id };
  });
  const board = async (name: string): Promise<string> => (await b.as('boss').call('analysis:create', { projectId: P, name })).body.id;
  const [opsBoard, openBoard] = [await board('Ops board'), await board('Everyone board')];
  const OPS = randomUUID();
  await b.pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', [ORG, P, OPS, 'Ops', at('boss')]);
  await b.pool.query("INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, 'view'), ($1, $2, $3, $5, 'edit')", [ORG, P, OPS, opsTeam, leadsTeam]);
  await b.pool.query("INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, 'dataset', $3, $4, $6), ($1, $2, 'dashboard', $5, $4, $6)",
    [ORG, P, orders.toLowerCase(), OPS, opsBoard.toLowerCase(), at('boss')]);

  const visuals = async (): Promise<number> => ((await b.as('boss').call('visual:list', { projectId: P })).body as unknown[]).length;
  const tiles = async (id: string): Promise<number> => cardsOf((await b.as('boss').call('analysis:open', { projectId: P, id })).body.analysis).length;
  const picker = async (w: string): Promise<string[]> => ((await b.as(w).call('stats:dashboards', { projectId: P })).body as Array<{ id: string }>).map((d) => d.id).sort();
  const add = (w: string, extra: object, on = plain) => b.as(w).call('answer:addToDashboard', { projectId: P, spec: specOn(on), ...extra });
  const refused = (r: { status: number; text: string }, reason: string): boolean => {
    try {
      const j = JSON.parse(r.text) as { code?: string; reason?: string };
      return r.status === 409 && j.code === 'folder' && j.reason === reason;
    } catch {
      return false;
    }
  };

  // ── picker ──────────────────────────────────────────────────────────────
  ok('picker: the Ops lead may add to both dashboards', JSON.stringify(await picker('lead')) === JSON.stringify([opsBoard, openBoard].sort()));
  ok('picker: an editor who only views Ops is offered the Everyone board alone, as is one with nothing on Ops',
    JSON.stringify(await picker('ev')) === JSON.stringify([openBoard]) && JSON.stringify(await picker('ed')) === JSON.stringify([openBoard]));

  // ── folder ──────────────────────────────────────────────────────────────
  const [v0, t0] = [await visuals(), await tiles(opsBoard)];
  const viewOnly = await add('ev', { analysisId: opsBoard });
  ok('folder: an editor who views Ops is refused `edit` on the Ops board', refused(viewOnly, 'edit'), `${viewOnly.status} ${viewOnly.text.slice(0, 200)}`);
  const closed = await add('ed', { analysisId: opsBoard });
  ok('folder: one with nothing on Ops is refused `closed`', refused(closed, 'closed'), `${closed.status} ${closed.text.slice(0, 200)}`);
  ok('folder: neither wrote a visual or a tile', (await visuals()) === v0 && (await tiles(opsBoard)) === t0);
  const lead = await add('lead', { analysisId: opsBoard });
  ok('folder NEGATIVE CONTROL: the Ops lead adds it — one visual, one tile', lead.status === 200 && lead.body.ok === true && (await visuals()) === v0 + 1 && (await tiles(opsBoard)) === t0 + 1, show(lead.body));
  const open = await add('ev', { analysisId: openBoard });
  ok('folder NEGATIVE CONTROL: the editor who views Ops adds to the Everyone board', open.status === 200 && open.body.ok === true && (await tiles(openBoard)) === 1, show(open.body));

  // ── landing ─────────────────────────────────────────────────────────────
  const landed = await add('lead', { name: 'Orders review' }, orders);
  const where = landed.body?.ok ? (await b.pool.query<{ f: string }>("SELECT folder_id::text AS f FROM folder_items WHERE org_id = $1 AND project_id = $2 AND kind = 'dashboard' AND item_id = $3", [ORG, P, landed.body.dashboard.id.toLowerCase()])).rows[0]?.f : null;
  ok('landing: a new dashboard of an Orders answer lands in Ops, with its dataset', where === OPS, `${show(landed.body)} ${where}`);
  const v1 = await visuals();
  const notTheirs = await add('ev', { name: 'Orders mine' }, orders);
  ok('landing: refused `edit` to the editor who only views Ops, and nothing is made', refused(notTheirs, 'edit') && (await visuals()) === v1, `${notTheirs.status} ${notTheirs.text.slice(0, 200)}`);

  // ── viewer ──────────────────────────────────────────────────────────────
  const viewer = await add('viv', { analysisId: openBoard });
  ok('viewer: a project viewer gets a 403, and nothing is written', viewer.status === 403 && (await visuals()) === v1 && (await tiles(openBoard)) === 1, `${viewer.status}`);
}

(async () => {
  contractCases();
  await noDatabase();
  await withServer('answeradd', {}, withFolders);
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : String(err)))
  .finally(finish);
