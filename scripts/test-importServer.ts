// Self-check for T2.4 — import, composer, captures and input tables on the
// SERVER, over real HTTP:
//
//   · staged imports are bound to org + user: another org's or user's stagedId
//     is refused by dataset:composePreview, dataset:composeSave and dataset:save
//     (never saved from the display slice), and the owner's save works;
//   · CSV, TSV, Parquet uploads and paste parse, stage and save; the composer
//     previews in DataGrid-sized windows;
//   · a screenshot upload is read by the org's model (a stdlib mock provider)
//     on the server: the allow-list and the no-model state are honoured before
//     any call; the capture is a project record whose list never carries a
//     server path; corrected cells save as a 'capture' dataset linked back;
//     another project's capture is not found, not linkable, not deletable;
//   · input tables: create, lookups, save batches (with the check), distinct,
//     edit columns — and every contract refuses a malformed shape.
//
//   npm run build:ts && node scripts/test-importServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const { Writable }: typeof import('stream') = require('stream');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const aiKeys: typeof import('../src/server/aiKeys') = require('../src/server/aiKeys');
const importStage: typeof import('../src/data/importStage') = require('../src/data/importStage');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-import-'));
type Who = import('../src/server/context').Identity;
const as = (org: string, user = `alice@${org}`): Who => ({ user: { email: user, role: 'admin' }, org: { id: org } });
// any: every channel's reply is its own shape; the checks read the fields they assert.
type Reply = { status: number; body: any };

// ── A stdlib stand-in for an OpenAI-compatible provider (the "gateway") ────
const MODEL_REPLY = {
  title: 'Regional sales',
  analysis: 'Sales by region.',
  extractedTable: {
    columns: [
      { id: 'region', label: 'Region', role: 'dimension', type: 'text' },
      { id: 'sales', label: 'Sales', role: 'measure', type: 'number' },
    ],
    rows: [{ region: 'North', sales: 120 }, { region: 'South', sales: 95 }, { region: 'East', sales: 80 }],
  },
  extractionConfidence: 'medium',
};
let modelCalls = 0;
let lastModelBody = '';
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += String(c); });
  req.on('end', () => {
    modelCalls++;
    lastModelBody = body;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL_REPLY) }, finish_reason: 'stop' }] }));
  });
});

/** The org's own config.json with a connected gateway pointing at the mock (re-read, as a Settings save would leave it). */
function connectModel(org: string, port: number): void {
  const dir = path.join(DATA, 'orgs', org, 'userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    version: 2,
    executionMode: 'local', // a desktop setting: the server runs API-key providers whatever it says
    // The gateway needs no key (a server keeps keys only in its secrets store, T2.12); its base URL is the mock.
    byok: { activeProvider: 'gateway', providers: { gateway: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', maxTokens: '', verified: true } } },
  }));
  const config: typeof import('../src/app/config') = require('../src/app/config');
  context.runInContext(as(org), 'cfg', () => config.load());
}

let log = '';
const logSink = new Writable({ write(chunk, _enc, cb) { log += String(chunk); cb(); } });

(async () => {
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const modelPort = (model.address() as import('net').AddressInfo).port;

  context.enterServerMode(DATA);
  appMod.registerHandlers();
  // The stub model is on loopback, which the SSRF guard refuses on a server (T6.1);
  // an operator opens an internal gateway the same way.
  process.env.SSRF_ALLOW = '127.0.0.1/32,::1/128';
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'info', DATA_DIR: DATA }), logSink, (h) =>
    typeof h['x-test-org'] === 'string' ? as(h['x-test-org'], typeof h['x-test-user'] === 'string' ? h['x-test-user'] : undefined) : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const hdr = (org: string, user?: string) => withCsrf({ 'x-test-org': org, ...(user ? { 'x-test-user': user } : {}) });

  const upload = async (org: string, name: string, body: string | Uint8Array, user?: string): Promise<string> => {
    const form = new FormData();
    form.append('file', new Blob([typeof body === 'string' ? body : Uint8Array.from(body)]), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: hdr(org, user) });
    return ((await res.json()) as { fileToken: string }).fileToken;
  };
  const call = async (org: string, channel: string, payload: unknown, user?: string): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST', body: wire.encode({ args: payload === undefined ? [] : [payload] }), headers: { 'content-type': 'application/json', ...hdr(org, user) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? wire.decode(text) : null };
  };

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const history: typeof import('../src/app/history') = require('../src/app/history');
  const project = (org: string, name: string) => context.runInContext(as(org), 'seed', async () => (await projects.createProject(name)).id);
  const PA = await project('org-a', 'A');
  const PA2 = await project('org-a', 'A2');
  const PB = await project('org-b', 'B');
  const getDs = (org: string, pid: string, id: string) => context.runInContext(as(org), 'get', () => datasets.getDataset(pid, id));

  // ── 1. Staged imports belong to org + user ────────────────────────────────
  const ROWS = Array.from({ length: 250 }, (_, i) => [String(i).padStart(3, '0'), i * 2, `r${i}`]);
  const CSV = 'zip,amount,label\n' + ROWS.map((r) => r.join(',')).join('\n') + '\n';
  const parsed = await call('org-a', 'dataset:pickAndParse', { fileToken: await upload('org-a', 'orders.csv', CSV) });
  const S = parsed.body?.preview?.stagedId as string;
  ok('csv upload: parsed and staged', parsed.body?.ok === true && typeof S === 'string' && parsed.body.preview.rowCount === 250, JSON.stringify(parsed.body).slice(0, 200));
  const stagedRef = { inline: { name: 'orders', stagedId: S } };
  const preview = (org: string, pid: string, ref: unknown, offset = 0, limit = 500, user?: string) =>
    call(org, 'dataset:composePreview', { projectId: pid, base: ref, joins: [], offset, limit }, user);
  const save = (org: string, pid: string, ref: unknown, extra: Record<string, unknown> = {}, user?: string) =>
    call(org, 'dataset:composeSave', { projectId: pid, name: 'Orders', base: ref, joins: [], steps: [], ...extra }, user);

  const bPrev = await preview('org-b', PB, stagedRef);
  ok('org-b previewing org-a\'s stagedId: refused, nothing leaks', bPrev.body?.ok === false && bPrev.body.error === importStage.GONE && !('rows' in bPrev.body), JSON.stringify(bPrev.body));
  const bSave = await save('org-b', PB, stagedRef);
  ok('org-b saving org-a\'s stagedId (composeSave): refused', bSave.body?.ok === false && bSave.body.error === importStage.GONE, JSON.stringify(bSave.body));
  const mSave = await save('org-a', PA, stagedRef, {}, 'mallory@org-a');
  ok('another user in org-a (composeSave): refused', mSave.body?.ok === false, JSON.stringify(mSave.body));
  const direct = (who: Who) => context.runInContext(who, 'save', async () => rpc.handlers.get('dataset:save')!({}, {
    projectId: who.org.id === 'org-a' ? PA : PB, name: 'x', sourceKind: 'csv', stagedId: S, columns: [{ name: 'zip', type: 'text' }], rows: [['leak']],
  })) as Promise<{ ok?: boolean; error?: string; id?: string }>;
  const bDirect = await direct(as('org-b'));
  const mDirect = await direct(as('org-a', 'mallory@org-a'));
  ok('dataset:save with org-b / another user: refused, not saved from the payload rows',
    bDirect.ok === false && bDirect.error === importStage.GONE && mDirect.ok === false && !bDirect.id && !mDirect.id, JSON.stringify([bDirect, mDirect]));
  const listedB = (await call('org-b', 'dataset:list', { projectId: PB })).body as unknown[];
  ok('…and org-b has no dataset from any of it', Array.isArray(listedB) && listedB.length === 0, JSON.stringify(listedB));

  const win = await preview('org-a', PA, stagedRef, 100, 50);
  ok('owner: a preview window is the rows asked for, with the true total',
    win.body?.ok === true && win.body.rows.length === 50 && win.body.rows[0][0] === '100' && win.body.total === 250, JSON.stringify(win.body).slice(0, 200));
  ok('composePreview: limit over 500 is a 400', (await preview('org-a', PA, stagedRef, 0, 501)).status === 400);
  const saved = await save('org-a', PA, stagedRef, {
    sourceKind: 'csv',
    steps: [{ type: 'rename_column', from: 'label', to: 'note' }],
    retype: [{ name: 'zip', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'note', type: 'text' }],
  });
  const savedId = saved.body?.dataset?.id as string;
  const full = savedId ? await getDs('org-a', PA, savedId) : null;
  ok('owner: composeSave saves every row with the mapping applied',
    saved.body?.ok === true && full?.rowCount === 250 && full.columns.map((c) => c.name).join() === 'zip,amount,note' && full.rows[7][0] === '007',
    JSON.stringify(saved.body).slice(0, 300));
  ok('…and the staged table is gone once saved', (await save('org-a', PA, stagedRef)).body?.error === importStage.GONE);
  ok('a file origin can never be sent (servers keep no path)', (await save('org-a', PA, stagedRef, { origin: { kind: 'file', path: '/etc/passwd' } })).status === 400);

  // ── 2. TSV, Parquet, paste ──────────────────────────────────────────────────
  const tsv = await call('org-a', 'dataset:pickAndParse', { fileToken: await upload('org-a', 'regions.TSV', 'region\tsales\nNorth\t12\nSouth\t7\n') });
  ok('tsv upload: tab-separated, typed, stored kind csv', tsv.body?.ok === true && tsv.body.sourceKind === 'csv' && tsv.body.preview.columns.map((c: { name: string; type: string }) => c.name + ':' + c.type).join() === 'region:text,sales:number', JSON.stringify(tsv.body).slice(0, 200));
  const pq = path.join(DATA, 'fixture.parquet');
  await duck.execAsync(`COPY (SELECT range AS n, 'r' || range AS s, range * 0.5 AS half FROM range(300)) TO '${pq}' (FORMAT parquet);`);
  const pqRes = await call('org-a', 'dataset:pickAndParse', { fileToken: await upload('org-a', 'facts.parquet', fs.readFileSync(pq)) });
  ok('parquet upload: every row, in file order, typed by the importer\'s rules',
    pqRes.body?.ok === true && pqRes.body.sourceKind === 'parquet' && pqRes.body.preview.rowCount === 300
      && pqRes.body.preview.rows[299].join() === '299,r299,149.5' && pqRes.body.preview.columns.map((c: { type: string }) => c.type).join() === 'number,text,number',
    JSON.stringify(pqRes.body).slice(0, 300));
  const stage = path.join(DATA, 'orgs', 'org-a', 'userData', 'drop-stage');
  ok('…its staging copy is removed', !fs.existsSync(stage) || fs.readdirSync(stage).length === 0);
  const bad = await call('org-a', 'dataset:pickAndParse', { fileToken: await upload('org-a', 'notes.txt', 'hello') });
  ok('unsupported extension: refused with the reason', bad.body?.ok === false && /Unsupported/.test(bad.body.error));

  const paste = await call('org-a', 'dataset:parsePaste', { text: 'x\ty\n1\t2\n3\t4\n' });
  ok('paste: parsed and staged on the server', paste.body?.ok === true && typeof paste.body.preview.stagedId === 'string' && paste.body.preview.rowCount === 2, JSON.stringify(paste.body).slice(0, 200));
  const pSaved = await save('org-a', PA, { inline: { name: 'Pasted', stagedId: paste.body.preview.stagedId } }, { sourceKind: 'paste' });
  ok('paste: saved from the staged rows', pSaved.body?.ok === true && pSaved.body.dataset.rowCount === 2 && pSaved.body.dataset.sourceKind === 'paste', JSON.stringify(pSaved.body).slice(0, 200));
  ok('paste over the RPC cap: 400 from the contract', (await call('org-a', 'dataset:parsePaste', { text: 'x'.repeat(900_001) })).status === 400);

  // ── 3. Captures ──────────────────────────────────────────────────────────────
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const st0 = await call('org-a', 'captureDataset:status', undefined);
  ok('no model configured: status says so', st0.body?.ready === false && st0.body.reason === 'no_model', JSON.stringify(st0.body));
  const noModel = await call('org-a', 'captureDataset:draft', { projectId: PA, fileToken: await upload('org-a', 's.png', PNG) });
  ok('…and a draft is refused as not set up, without a model call', noModel.body?.ok === false && noModel.body.errorType === 'auth' && modelCalls === 0, JSON.stringify(noModel.body));

  connectModel('org-a', modelPort);
  const st1 = await call('org-a', 'captureDataset:status', undefined);
  ok('a connected gateway: ready (a local-CLI execution mode is ignored on the server)', st1.body?.ready === true && st1.body.provider === 'gateway', JSON.stringify(st1.body));
  // The org allows only openai (org_settings.ai_providers, read by T2.12's policy per call): a stand-in pool answers that one query.
  aiKeys.useAiKeys({ query: async () => ({ rows: [{ ai_providers: ['openai'] }] }) } as unknown as import('pg').Pool, null);
  const st2 = await call('org-a', 'captureDataset:status', undefined);
  const blocked = await call('org-a', 'captureDataset:draft', { projectId: PA, fileToken: await upload('org-a', 's.png', PNG) });
  ok('org allows only openai: status not_allowed, draft refused, the model never called',
    st2.body?.reason === 'not_allowed' && blocked.body?.ok === false && /does not allow/.test(blocked.body.message) && modelCalls === 0, JSON.stringify([st2.body, blocked.body]));
  aiKeys.useAiKeys(null, null); // no database: every provider allowed again

  const notPng = await call('org-a', 'captureDataset:draft', { projectId: PA, fileToken: await upload('org-a', 's.png', 'GIF89a…') });
  ok('a non-PNG upload: refused before the model', notPng.body?.ok === false && notPng.body.errorType === 'bad_image' && modelCalls === 0);

  const drafted = await call('org-a', 'captureDataset:draft', { projectId: PA, fileToken: await upload('org-a', 'shot.png', PNG), thumb: THUMB });
  const capId = drafted.body?.captureId as string;
  ok('upload → the model read it on the server → a typed draft',
    drafted.body?.ok === true && modelCalls === 1 && drafted.body.columns.map((c: { name: string; type: string }) => c.name + ':' + c.type).join() === 'Region:text,Sales:number'
      && JSON.stringify(drafted.body.rows) === '[["North",120],["South",95],["East",80]]' && drafted.body.unsure === true,
    JSON.stringify(drafted.body).slice(0, 300));
  ok('…the model was sent the image', lastModelBody.includes('data:image/png;base64,iVBORw0KGgo'));
  const list = await call('org-a', 'captureDataset:list', { projectId: PA });
  ok('capture list: the capture, its thumbnail, no server path anywhere',
    Array.isArray(list.body) && list.body.length === 1 && list.body[0].id === capId && list.body[0].thumb === THUMB && list.body[0].hasImage === true
      && !('cropPath' in list.body[0]) && !JSON.stringify(list.body).includes(DATA), JSON.stringify(list.body).slice(0, 300));
  ok('…another project of the same org lists none of it', (await call('org-a', 'captureDataset:list', { projectId: PA2 })).body.length === 0);
  ok('another project cannot re-draft it', (await call('org-a', 'captureDataset:draft', { projectId: PA2, captureId: capId })).body?.ok === false);
  ok('another org cannot re-draft it', (await call('org-b', 'captureDataset:draft', { projectId: PB, captureId: capId })).body?.ok === false);
  ok('re-draft from the stored capture: the same draft, no model call',
    (await call('org-a', 'captureDataset:draft', { projectId: PA, captureId: capId })).body?.rows?.length === 3 && modelCalls === 1);

  const edited = [['North', 120], ['South', '59'], ['East', 80]]; // the user corrects a mis-read cell
  const capSave = await save('org-a', PA, { inline: { name: 'Regional sales', columns: drafted.body.columns, rows: edited } }, {
    name: 'Regional sales', sourceKind: 'capture', origin: { kind: 'capture', captureId: capId },
  });
  const capDsId = capSave.body?.dataset?.id as string;
  const capDs = capDsId ? await getDs('org-a', PA, capDsId) : null;
  const thread = await context.runInContext(as('org-a'), 'h', () => history.loadThread(capId));
  ok('corrected cells save as a capture dataset, typed by the app',
    capSave.body?.ok === true && capDs?.sourceKind === 'capture' && JSON.stringify(capDs.rows) === '[["North",120],["South",59],["East",80]]', JSON.stringify(capSave.body).slice(0, 300));
  ok('…linked both ways: the dataset to its capture, the capture to its dataset', capDs?.capture?.entryId === capId && thread?.datasetId === capDsId);
  const listed = await call('org-a', 'dataset:list', { projectId: PA });
  const capRow = (listed.body as { id: string; capture?: Record<string, unknown> }[]).find((d) => d.id === capDsId);
  ok('dataset:list: a capture dataset says it has an image, never the crop’s server path',
    capRow?.capture?.hasImage === true && !('cropPath' in (capRow.capture ?? {})) && !JSON.stringify(listed.body).includes(DATA), JSON.stringify(capRow));
  // The strip is in the summary itself, so recent, search, the catalog and every
  // other caller of listDatasets get it too — not just this one channel.
  const summaries = await context.runInContext(as('org-a'), 'h', () => datasets.listDatasets(PA));
  ok('every listDatasets caller on the server: the summary itself carries no crop path',
    !JSON.stringify(summaries).includes(DATA) && summaries.some((d) => d.capture && 'hasImage' in d.capture), JSON.stringify(summaries.find((d) => d.id === capDsId)));
  const crossLink = await save('org-a', PA2, { inline: { name: 'x', columns: drafted.body.columns, rows: edited } }, { sourceKind: 'capture', origin: { kind: 'capture', captureId: capId } });
  const crossDs = crossLink.body?.dataset?.id ? await getDs('org-a', PA2, crossLink.body.dataset.id) : null;
  const threadAfter = await context.runInContext(as('org-a'), 'h', () => history.loadThread(capId));
  ok('a dataset in another project cannot link to this project\'s capture', !!crossDs && !crossDs.capture && !crossDs.origin && threadAfter?.datasetId === capDsId, JSON.stringify(crossDs?.capture));
  const svg = await call('org-a', 'captureDataset:draft', { projectId: PA, fileToken: await upload('org-a', 'b.png', PNG), thumb: 'data:image/svg+xml;base64,PHN2Zz4=' });
  const svgThread = await context.runInContext(as('org-a'), 'h', () => history.loadThread(svg.body.captureId));
  ok('an SVG "thumbnail" is not stored (it could carry script)', svg.body?.ok === true && svgThread?.thumb === null);
  ok('delete from another project: refused', (await call('org-a', 'captureDataset:delete', { projectId: PA2, captureId: capId })).body?.ok === false);
  const del = await call('org-a', 'captureDataset:delete', { projectId: PA, captureId: capId });
  ok('delete: gone from the list', del.body?.ok === true && (await call('org-a', 'captureDataset:list', { projectId: PA })).body.every((c: { id: string }) => c.id !== capId));
  ok('a path-shaped capture id is a 400', (await call('org-a', 'captureDataset:delete', { projectId: PA, captureId: '../x' })).status === 400);

  // ── 4. Input tables ──────────────────────────────────────────────────────────
  const created = await call('org-a', 'input:create', {
    projectId: PA, name: 'Targets',
    columns: [{ name: 'region', type: 'text', required: true, lookup: { datasetId: capDsId, column: 'Region' } }, { name: 'target', type: 'number' }],
  });
  const IT = created.body?.id as string;
  ok('input:create', created.body?.ok === true && typeof IT === 'string', JSON.stringify(created.body));
  const lookups = await call('org-a', 'input:lookups', { projectId: PA, id: IT });
  ok('input:lookups: the other datasets with typed columns, not the table itself',
    lookups.body?.ok === true && lookups.body.datasets.some((d: { id: string; columns: { name: string; type: string }[] }) => d.id === capDsId && d.columns.some((c) => c.name === 'Region' && c.type === 'text'))
      && lookups.body.datasets.every((d: { id: string }) => d.id !== IT), JSON.stringify(lookups.body).slice(0, 300));
  const loaded = await call('org-a', 'input:load', { projectId: PA, id: IT });
  ok('input:load: no rows yet, two columns', loaded.body?.ok === true && loaded.body.rows.length === 0 && loaded.body.columns.length === 2);
  const batches = [
    { label: 'Add row', ops: [{ t: 'ins', at: 0, rows: [['North', '10']] }] },
    { label: 'Edit target', ops: [{ t: 'set', r: 0, c: 1, cells: [['abc']] }] },
    { label: 'Add row', ops: [{ t: 'ins', at: 1, rows: [['Atlantis', '5']] }] },
  ];
  const savedIt = await call('org-a', 'input:save', { projectId: PA, id: IT, batches });
  const issues = (savedIt.body?.check?.issues ?? []) as { r: number; c: number; severity: string }[];
  ok('input:save: replayed, typed text kept and flagged, a value outside the lookup flagged',
    savedIt.body?.ok === true && JSON.stringify(savedIt.body.rows) === '[["North","abc"],["Atlantis",5]]'
      && issues.some((i) => i.r === 0 && i.c === 1) && issues.some((i) => i.r === 1 && i.c === 0) && savedIt.body.versions === 3,
    JSON.stringify(savedIt.body).slice(0, 400));
  const distinct = await call('org-a', 'dataset:distinct', { projectId: PA, datasetId: capDsId, column: 'Region', limit: 200, search: 'or' });
  ok('dataset:distinct: searched in SQL, with the total', distinct.body?.values?.join() === 'North' && distinct.body.total === 1, JSON.stringify(distinct.body));
  ok('dataset:distinct: limit over 200 is a 400', (await call('org-a', 'dataset:distinct', { projectId: PA, datasetId: capDsId, column: 'Region', limit: 201 })).status === 400);
  const cols = await call('org-a', 'input:setColumns', {
    projectId: PA, id: IT, columns: [{ name: 'goal', type: 'number' }, { name: 'area', type: 'text' }], from: [1, 0],
  });
  ok('input:setColumns: renamed and reordered, cells moved with their column',
    cols.body?.ok === true && cols.body.columns.map((c: { name: string }) => c.name).join() === 'goal,area' && JSON.stringify(cols.body.rows[1]) === '[5,"Atlantis"]', JSON.stringify(cols.body).slice(0, 300));
  ok('input:save: a malformed op is a 400 from the contract', (await call('org-a', 'input:save', { projectId: PA, id: IT, batches: [{ label: 'x', ops: [{ t: 'del', at: -1, n: 1 }] }] })).status === 400);
  ok('input:load from another org: 403 (the project is not in its org)', (await call('org-b', 'input:load', { projectId: PA, id: IT })).status === 403);
  ok('input:validate is not reachable over HTTP (the web checks on save)', (await call('org-a', 'input:validate', { projectId: PA, id: IT, rows: [] })).status === 404);

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    model.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    duck.shutdown();
    finish();
  });
