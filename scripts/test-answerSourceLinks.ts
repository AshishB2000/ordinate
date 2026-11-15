// "Answered from ▾" and "Also on ▸" on an answer card (docs/assistant/00-design.md, The flow, step 7;
// src/ipc/answerSources.ts). Through the real handlers; no model.
//
// File leg (records as files, no database), as an admin (an editor's view) and a project viewer:
//   1. EXTRACT: `answer:card` names what it reads (`uses`, by display name) and `answeredFrom` its dataset; the card an
//      answer turn keeps carries the same, and `copilot:history` brings it back with today's `answeredFrom`.
//   2. SOURCE NAMES (p2-01): the dataset is copied from a connection whose table is a canary. No viewer reply (card,
//      answer turn, history) carries the canary or an origin. NEGATIVE CONTROL: the editor's names the table.
//   3. LIVE: a Live dataset over the fake warehouse, its table a canary: the card is live-dated, read with no
//      hydration; the editor reads the table, the viewer not (NEGATIVE CONTROL: the editor).
//   4. VERIFIED: a verified question's card says its question, beside `answeredFrom`.
//   5. ALSO ON: the dashboards the caller may open that show the dataset (a chart, a KPI, a published copy's frozen
//      chart), never one on another dataset nor one that only quotes its id in a text card; the editor's drafts marked,
//      a viewer's published copies only; five and how many more; a gone dataset refused. BOUNDED: neither the
//      dashboard list nor the visual list is read, and no table loaded.
// Database leg (DATABASE_URL; real grants, the RPC route: scripts/rowPolicyHarness.ts):
//   6. `ed` (a project editor, not an org admin) reads the canary table; `nobody` (a viewer) does not.
//   7. ALSO ON from the rows: only the records naming the dataset or its visuals leave Postgres (`recordsNaming` hands
//      back those alone; 30 dashboards on another dataset never), no list is called. DIFFERENTIAL: the same reply as
//      the reference that reads every record (`_listPerRecord`), for the editor and the viewer.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-answerSourceLinks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import { Client } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answersources-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each handler's reply (cleared between the legs)
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

type Role = import('../src/server/context').Identity['user']['role'];
const TABLE = 'ANALYTICS.CANARY_RETURNS_7F1';
const LIVE_TABLE = 'live_canary_returns_q7';
const CANARY = /canary/i;
const COLS = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
const ROWS = [['East', 10], ['West', 20], ['North', 5]];
const spec = (datasetId: string, title = 'Amount by region') => ({ datasetId, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title });
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? String(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const card = (type: string, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x: 0, y: 0, w: 4, h: 3 }, ...extra });
const sheet = (...cards: object[]) => [{ name: 'One', cards }];

// The lists "Also on" must never read, and the table it must never load.
const lists = { analyses: 0, visuals: 0, tables: 0 };
const spy = (mod: Record<string, unknown>, name: string, key: keyof typeof lists): void => {
  const real = mod[name] as (...a: unknown[]) => unknown;
  mod[name] = (...a: unknown[]) => { lists[key]++; return real(...a); };
};
spy(analysis as unknown as Record<string, unknown>, 'listAnalyses', 'analyses');
spy(visuals as unknown as Record<string, unknown>, 'listVisuals', 'visuals');
spy(datasets as unknown as Record<string, unknown>, 'getDataset', 'tables');
const quiet = async <T>(fn: () => Promise<T>): Promise<{ out: T; read: number }> => {
  const before = lists.analyses + lists.visuals + lists.tables;
  const out = await fn();
  return { out, read: lists.analyses + lists.visuals + lists.tables - before };
};

// ── the file leg ────────────────────────────────────────────────────────
let req = 0;
async function fileLeg(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  fakeMod.registerLiveFake();
  let P = '';
  const as = <T>(who: 'ana' | 'vic', fn: () => Promise<T>): Promise<T> => {
    const role: Role = who === 'vic' ? 'viewer' : 'admin';
    return context.runInContext({ user: { email: `${who}@acme.test`, role }, org: { id: 'acme' } }, `src${++req}`, async () => {
      if (role === 'viewer' && P) caller.seedRank(P, 1); // what the RPC route seeds for a project viewer
      return fn();
    });
  };
  const call = (who: 'ana' | 'vic', ch: string, payload: object): Promise<any> => as(who, () => handlers.get(ch)!({}, payload)); // any: each handler's reply

  const w = await as('ana', async () => {
    await projects.init();
    const P = (await projects.createProject('Answer sources'))!.id;
    const conn = await connections.saveConnection(P, { name: 'Warehouse', connectorId: 'postgres', values: { host: 'db.internal', database: 'prod' }, table: TABLE });
    await fakeMod.loadWarehouseTable(LIVE_TABLE, COLS, ROWS);
    const fake = await connections.saveConnection(P, { name: 'Fake warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    if (!conn || !fake) throw new Error('fixture: connections');
    const sales = await datasets.saveDataset(P, { name: 'Sales', sourceKind: 'postgres', columns: COLS, rows: ROWS, origin: { kind: 'connection', connId: conn.id, table: TABLE } });
    const other = await datasets.saveDataset(P, { name: 'Other', sourceKind: 'csv', columns: COLS, rows: ROWS });
    const live = await liveRecord.saveLiveRecord(P, { name: 'Returns live', columns: COLS, origin: { kind: 'connection', connId: fake.id, table: LIVE_TABLE } });
    if (!sales || !other || !live) throw new Error('fixture: datasets');
    const vis = async (name: string, datasetId: string) => (await visuals.saveVisual(P, { name, datasetId, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never))!.id;
    return { P, sales: sales.id, other: other.id, live: live.id, s1: await vis('Sales one', sales.id), s2: await vis('Sales two', sales.id), o1: await vis('Other one', other.id) };
  });
  P = w.P;
  const set = await call('ana', 'catalog:setColumn', { projectId: P, datasetId: w.sales, column: 'amount', patch: { displayName: 'Revenue' } });
  ok('fixture: amount is shown as Revenue', set?.ok !== false, show(set));

  // 1. EXTRACT
  const edCard = await call('ana', 'answer:card', { projectId: P, spec: spec(w.sales) });
  ok('1. answer:card names what it reads, by display name: "sum of Revenue", "region"', edCard.ok && same(edCard.uses, ['sum of Revenue', 'region']), show(edCard.uses));
  ok('1. …and answeredFrom names its dataset', edCard.answeredFrom?.datasetId === w.sales && edCard.datasetName === 'Sales', show(edCard.answeredFrom));
  const thread = async (who: 'ana' | 'vic'): Promise<string> => (await call(who, 'copilot:newThread', { projectId: P })).thread.id;
  const T = await thread('ana');
  const turn = (await call('ana', 'answer:rerun', { projectId: P, threadId: T, spec: spec(w.sales) })).turns.at(-1);
  ok('1. the card an answer turn keeps carries the same uses and answeredFrom', same(turn?.card?.uses, edCard.uses) && same(turn?.card?.answeredFrom, edCard.answeredFrom), show(turn?.card));
  const hist = (await call('ana', 'copilot:history', { projectId: P, threadId: T })).turns.at(-1);
  ok('1. reopened, the conversation brings them back', same(hist?.card?.uses, edCard.uses) && same(hist?.card?.answeredFrom, edCard.answeredFrom), show(hist?.card?.answeredFrom));

  // 2. SOURCE NAMES
  ok('2. NEGATIVE CONTROL: the editor reads where the rows come from, the table named', edCard.answeredFrom?.origin === `Connection · Warehouse · ${TABLE}`, show(edCard.answeredFrom));
  const vCard = await call('vic', 'answer:card', { projectId: P, spec: spec(w.sales) });
  ok('2. the viewer is answered, with the dataset\'s name and what it reads', vCard.ok && vCard.datasetName === 'Sales' && same(vCard.uses, edCard.uses), show(vCard));
  ok('2. …and answeredFrom is the dataset alone: no origin', same(vCard.answeredFrom, { datasetId: w.sales }), show(vCard.answeredFrom));
  const VT = await thread('vic');
  const vRerun = await call('vic', 'answer:rerun', { projectId: P, threadId: VT, spec: spec(w.sales) });
  const vHist = await call('vic', 'copilot:history', { projectId: P, threadId: VT });
  const vTexts = [JSON.stringify(vCard), JSON.stringify(vRerun), JSON.stringify(vHist)];
  ok('2. no viewer reply (card, answer turn, history) carries the source table', vRerun.ok && vTexts.every((t) => !CANARY.test(t) && !t.includes('"origin"')), vTexts.find((t) => CANARY.test(t))?.slice(0, 300));
  ok('2. NEGATIVE CONTROL: the editor\'s same replies carry it', [JSON.stringify(edCard), JSON.stringify(turn), JSON.stringify(hist)].every((t) => CANARY.test(t)));

  // 3. LIVE
  const liveCall = (who: 'ana' | 'vic') => quiet(() => call(who, 'answer:card', { projectId: P, spec: spec(w.live, 'Returns by region') }));
  const [edLive, vLive] = [await liveCall('ana'), await liveCall('vic')];
  ok('3. a Live card is live-dated and read with no hydration', edLive.out.ok && edLive.out.asOf?.mode === 'live' && edLive.read === 0 && vLive.read === 0, show([edLive.out.asOf, edLive.read]));
  ok('3. NEGATIVE CONTROL: the editor reads the warehouse table', edLive.out.answeredFrom?.origin === `Connection · Fake warehouse · ${LIVE_TABLE}`, show(edLive.out.answeredFrom));
  ok('3. the viewer reads "Returns live", live, and nothing of its table', vLive.out.ok && vLive.out.datasetName === 'Returns live' && vLive.out.asOf?.mode === 'live' && same(vLive.out.answeredFrom, { datasetId: w.live }) && !CANARY.test(JSON.stringify(vLive.out)), show(vLive.out.answeredFrom));

  // 4. VERIFIED
  const vq = await call('ana', 'verified:save', { projectId: P, input: { question: 'Revenue by region', spec: { datasetId: w.sales, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [] } } });
  ok('fixture: the question is verified', vq.ok === true, show(vq));
  const verified = await call('ana', 'answer:card', { projectId: P, spec: spec(w.sales) });
  ok('4. a verified card says its question, beside answeredFrom', verified.verified?.question === 'Revenue by region' && same(verified.answeredFrom, edCard.answeredFrom), show([verified.verified, verified.answeredFrom]));

  // 5. ALSO ON
  const mk = async (name: string, sheets: object[], publish = false) => {
    const id = (await call('ana', 'analysis:create', { projectId: P, name, sheets })).id as string;
    if (publish) await call('ana', 'analysis:publish', { projectId: P, id });
    return id;
  };
  const kpi = (datasetId: string) => card('metric', { metric: { datasetId, column: 'amount', aggregation: 'sum', label: 'Revenue' } });
  await mk('Chart board', sheet(card('visual', { visualId: w.s1 })), true); // published: both
  await mk('KPI draft', sheet(kpi(w.sales))); // a draft: the editor's
  await mk('Other board', sheet(card('visual', { visualId: w.o1 }), kpi(w.other), card('text', { heading: `see ${w.sales}` })), true); // never: names the id in a text only
  const away = await mk('Moved away', sheet(card('visual', { visualId: w.s2 })), true); // its copy shows Sales; its draft no longer does
  await call('ana', 'analysis:update', { projectId: P, id: away, sheets: sheet(card('visual', { visualId: w.o1 })) });
  const also = (who: 'ana' | 'vic', datasetId = w.sales) => quiet(() => call(who, 'answer:alsoOn', { projectId: P, datasetId }));
  const [edA, vA] = [await also('ana'), await also('vic')];
  ok('5. the editor: the chart board and the KPI draft (marked), none more', edA.out.ok && same(names(edA.out), ['Chart board', 'KPI draft (draft)']) && edA.out.more === 0, show(edA.out));
  ok('5. the viewer: the published copies that show it, the one moved away in its draft included; no draft', vA.out.ok && same(names(vA.out), ['Chart board', 'Moved away']) && vA.out.more === 0, show(vA.out));
  ok('5. never a dashboard on another dataset, nor one that only quotes the id in a text card', ![...names(edA.out), ...names(vA.out)].includes('Other board'));
  const onOther = await also('ana', w.other);
  ok('5. NEGATIVE CONTROL: on the other dataset, the other board and the one whose draft moved to it', same(names(onOther.out), ['Moved away', 'Other board']), show(onOther.out));
  for (let i = 1; i <= 5; i++) await mk(`Board ${i}`, sheet(card('visual', { visualId: w.s2 })), true);
  const [edMany, vMany] = [await also('ana'), await also('vic')];
  const newest = ['Board 1', 'Board 2', 'Board 3', 'Board 4', 'Board 5'];
  ok('5. at most five, the newest, and how many more: the editor 5 + 2', same(names(edMany.out), newest) && edMany.out.more === 2, show(edMany.out));
  ok('5. …the viewer 5 + 2', same(names(vMany.out), newest) && vMany.out.more === 2, show(vMany.out));
  ok('5. BOUNDED: no dashboard list, no visual list, no table loaded', edA.read + vA.read + edMany.read + vMany.read + onOther.read === 0, JSON.stringify(lists));
  const gone = await call('ana', 'answer:alsoOn', { projectId: P, datasetId: crypto.randomUUID() });
  ok('5. a dataset not in the project is refused with a sentence', gone.ok === false && typeof gone.reason === 'string', show(gone));
  const liveAlso = await quiet(() => call('ana', 'answer:alsoOn', { projectId: P, datasetId: w.live }));
  ok('5. a Live dataset: answered from its record, no rows ("Not on any dashboard yet")', liveAlso.out.ok && liveAlso.out.dashboards.length === 0 && liveAlso.read === 0, show(liveAlso.out));
}

// ── the database leg ────────────────────────────────────────────────────
async function dbLeg(): Promise<void> {
  if (process.env.DATABASE_URL) handlers.clear(); // the world registers every handler itself, as the file leg did
  const W = await H.world('the answer sources on rows');
  if (!W) return;
  try {
    const { P } = W;
    const w = await W.as('boss', async () => {
      const conn = await connections.saveConnection(P, { name: 'Warehouse', connectorId: 'postgres', values: { host: 'db.internal', database: 'prod' }, table: TABLE });
      if (!conn) throw new Error('fixture: connection');
      const sales = await datasets.saveDataset(P, { name: 'Sales', sourceKind: 'postgres', columns: COLS, rows: ROWS, origin: { kind: 'connection', connId: conn.id, table: TABLE } });
      if (!sales) throw new Error('fixture: dataset');
      const v = (await visuals.saveVisual(P, { name: 'Sales chart', datasetId: sales.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never))!.id;
      const pv = (await visuals.saveVisual(P, { name: 'Plain chart', datasetId: W.plain, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] } } as never))!.id;
      return { sales: sales.id, v, pv };
    });
    const mk = async (name: string, sheets: object[], publish = false) => {
      const id = (await W.call('boss', 'analysis:create', { projectId: P, name, sheets })).body.id as string;
      if (publish) await W.call('boss', 'analysis:publish', { projectId: P, id });
      return id;
    };
    await mk('Chart board', sheet(card('visual', { visualId: w.v })), true);
    await mk('KPI draft', sheet(card('metric', { metric: { datasetId: w.sales, column: 'amount', aggregation: 'sum' } })));
    for (let i = 0; i < 30; i++) await mk(`Plain ${i}`, sheet(card('visual', { visualId: w.pv })), i % 2 === 0);

    // 6. SOURCE NAMES, real roles
    const answer = (who: string) => W.call(who, 'answer:card', { projectId: P, spec: spec(w.sales) });
    const [ed, nobody] = [await answer('ed'), await answer('nobody')];
    ok('6. NEGATIVE CONTROL: the project editor reads the table', ed.status === 200 && ed.body?.answeredFrom?.origin === `Connection · Warehouse · ${TABLE}`, ed.text.slice(0, 300));
    ok('6. the viewer is answered with the dataset alone, no canary in the reply', nobody.status === 200 && nobody.body?.ok && same(nobody.body.answeredFrom, { datasetId: w.sales }) && !CANARY.test(nobody.text), nobody.text.slice(0, 300));

    // 7. ALSO ON from the rows. Counted: the record rows Postgres sends this process (any query over `records`).
    const handed: number[] = [];
    const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const realQuery = proto.query;
    const realNaming = recordFs.recordsNaming;
    const fsSpy = recordFs as unknown as Record<string, unknown>;
    let rows = 0;
    const spying = async <T>(fn: () => Promise<T>): Promise<{ out: T; rows: number }> => {
      rows = 0;
      handed.length = 0;
      fsSpy.recordsNaming = async (dir: string, needles: readonly string[]) => { const m = await realNaming(dir, needles); handed.push(m.size); return m; };
      proto.query = function (this: unknown, ...a: unknown[]) {
        const r = realQuery.apply(this, a) as Promise<{ rows?: unknown[] }> | undefined;
        if (r && typeof r.then === 'function' && String(a[0]).includes('FROM records')) r.then((x) => { rows += x?.rows?.length ?? 0; }, () => undefined);
        return r;
      };
      try {
        return { out: await fn(), rows };
      } finally {
        proto.query = realQuery;
        fsSpy.recordsNaming = realNaming;
      }
    };
    const also = (who: string) => W.call(who, 'answer:alsoOn', { projectId: P, datasetId: w.sales });
    const edA = await spying(() => quiet(() => also('ed')));
    const edHanded = handed.slice();
    const vA = await spying(() => quiet(() => also('nobody')));
    ok('7. the editor: the chart board and the KPI draft; the viewer: the chart board', same(names(edA.out.out.body), ['Chart board', 'KPI draft (draft)']) && same(names(vA.out.out.body), ['Chart board']), `${edA.out.out.text} ${vA.out.out.text}`);
    ok('7. BOUNDED: Postgres hands back only the records naming it (1 visual, 2 dashboards, of 2 visuals and 32 dashboards), no list read',
      same(edHanded, [1, 2]) && same(handed, [1, 2]) && edA.rows <= 6 && vA.rows <= 6 && edA.out.read + vA.out.read === 0, `${JSON.stringify([edHanded, handed])} rows ${edA.rows}, ${vA.rows} ${JSON.stringify(lists)}`);
    recordFs._listPerRecord(true); // the reference: every record listed and tested in the app
    let edRef, vRef;
    try {
      [edRef, vRef] = [await spying(() => also('ed')), await spying(() => also('nobody'))];
    } finally {
      recordFs._listPerRecord(false);
    }
    ok('7. NEGATIVE CONTROL: the reference reads every record (34 and more rows each), and finds the same ones', edRef.rows >= 34 && vRef.rows >= 34 && same(handed, [1, 2]), `rows ${edRef.rows}, ${vRef.rows} ${JSON.stringify(handed)}`);
    const [edAText, vAText, edRefText, vRefText] = [edA.out.out.text, vA.out.out.text, edRef.out.text, vRef.out.text];
    ok('7. DIFFERENTIAL: the same replies as the reference that reads every record, editor and viewer', edRefText === edAText && vRefText === vAText, `${edRefText} ${vRefText}`);
  } finally {
    await W.close();
  }
}

const names = (r: { dashboards?: Array<{ name: string; draft?: true }> } | null) => (r?.dashboards ?? []).map((d) => d.name + (d.draft ? ' (draft)' : '')).sort();

void (async () => {
  try {
    await fileLeg();
    await dbLeg();
  } catch (err) {
    ok('suite ran to completion', false, err instanceof Error ? err.stack : String(err));
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
