// Self-check for the Share policy — src/app/sharePolicy.ts, src/app/privacyStore.ts
// and the IPC that carries them — driven through the REAL handlers, every file
// an export offers read back from its download token, against a real project
// on disk:
//
//   1. The policy file: defaults to mask, sanitised on every read.
//   2. The salt: created on first use, 0600, stable, never for a missing project.
//   3. Every export path, under each of mask / drop / include:
//        rows      `visual:rowsDownload` (the drill CSV)
//        charts    `visual:data` with `share` (dashboard/report/story exports)
//        bundles   `projects:export` → a masked bundle that still IMPORTS
//        publish   applyToChart / applyToTable / policySummary (the API the
//                  publish feature calls)
//   4. Proposals: a scan, a decision, a dismissal remembered, and a REFRESH
//      that surfaces a newly sensitive column as pending.
//   5. THE SALT NEVER LEAVES THE PROJECT FOLDER: not in any IPC reply, dataset
//      record, CSV, bundle entry or log line, and on disk nowhere but
//      projects/<pid>/privacy/salt.key.
//
//   npm run build:ts && node scripts/test-sharePolicy.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-out-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (...a: any[]) => any> = require('../src/server/rpc').handlers;
let savePath = '';

// Every line the modules under test print, to prove the salt is never logged.
const logged: string[] = [];
for (const k of ['log', 'error', 'warn', 'info'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
}

process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the real modules.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const share: typeof import('../src/app/sharePolicy') = require('../src/app/sharePolicy');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const mask: typeof import('../src/data/maskSteps') = require('../src/data/maskSteps');
const { refreshDataset }: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
require('../src/ipc/visuals').register();
require('../src/ipc/visualsServer').register();
const files: typeof import('../src/server/files') = require('../src/server/files');
/** A file a handler offered as a download, copied to `savePath` — what the browser would save. */
function keep(r: { downloadToken?: string } | null): void {
  const p = r && r.downloadToken ? files.downloadPathForTest(r.downloadToken) : null;
  if (p) fs.copyFileSync(p, savePath);
}
require('../src/ipc/privacy').register();
require('../src/ipc/projects').register({});

const replies: unknown[] = [];
async function call(ch: string, payload: unknown): Promise<any> {
  const fn = handlers.get(ch);
  if (!fn) throw new Error('no handler for ' + ch);
  const r = await fn({}, payload);
  replies.push(r);
  return r;
}

const COLS = [
  { name: 'name', type: 'text' as const },
  { name: 'email', type: 'text' as const },
  { name: 'card', type: 'text' as const },
  { name: 'region', type: 'text' as const },
  { name: 'amount', type: 'number' as const },
];
const ROWS: (string | number | null)[][] = [
  ['Grace Hopper', 'grace@example.com', '4111111111111111', 'North', 10],
  ['Alan Turing', 'alan@example.com', '5555555555554444', 'South', 20],
  ['Ada Lovelace', 'ada@example.com', '378282246310005', 'North', 30],
  ['Linus Torvalds', 'linus@example.com', '6011111111111117', 'East', 40],
];
const RAW = ['grace@example.com', 'alan@example.com', '4111111111111111', '5555555555554444'];

function csvRows(file: string): string[][] {
  return fs.readFileSync(file, 'utf8').trim().split(/\r\n/).map((l) => l.split(','));
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Share project');
  const pid = proj.id;
  const ds = await datasets.saveDataset(pid, { name: 'Customers', sourceKind: 'csv', columns: COLS, rows: ROWS });
  const did = ds!.id;

  // ── 1. The policy file ────────────────────────────────────────────────────
  ok('policy defaults to mask on every path', JSON.stringify(await store.getPolicy(pid)) === JSON.stringify({ export: 'mask', report: 'mask', publish: 'mask', bundle: 'mask' }));
  const set = await call('privacy:setPolicy', { projectId: pid, policy: { export: 'drop', report: 'nonsense', sneaky: 'include' } });
  ok('setPolicy keeps known paths/actions only', set.ok && set.policy.export === 'drop' && set.policy.report === 'mask' && !('sneaky' in set.policy), JSON.stringify(set));
  const policyFile = path.join(tmpUserData, 'projects', pid, 'privacy', 'policy.json');
  fs.writeFileSync(policyFile, '{ corrupt');
  ok('a corrupt policy file reads as the default', (await store.getPolicy(pid)).export === 'mask');
  fs.writeFileSync(policyFile, JSON.stringify({ export: 'include', bundle: 42 }));
  ok('a hand-edited policy is sanitised on read', (await store.getPolicy(pid)).export === 'include' && (await store.getPolicy(pid)).bundle === 'mask');
  await store.setPolicy(pid, { export: 'mask', report: 'mask', publish: 'mask', bundle: 'mask' });
  ok('setPolicy refuses a project that does not exist', (await store.setPolicy('11111111-1111-4111-8111-111111111111', { export: 'drop' })) === null);

  // ── 2. The salt ───────────────────────────────────────────────────────────
  const ghost = '22222222-2222-4222-8222-222222222222';
  ok('no salt is minted for a project that does not exist', (await store.getSalt(ghost)) === null && !fs.existsSync(path.join(tmpUserData, 'projects', ghost)));
  ok('no salt for an invalid id', (await store.getSalt('../etc')) === null);
  const [s1, s2] = await Promise.all([store.getSalt(pid), store.getSalt(pid)]);
  const salt = s1 as string;
  ok('the salt is 32 random bytes, hex', /^[0-9a-f]{64}$/.test(salt));
  ok('two concurrent first uses agree on ONE salt', s1 === s2);
  const saltFile = store.saltPath(pid);
  ok('it lives at projects/<pid>/privacy/salt.key', saltFile === path.join(tmpUserData, 'projects', pid, 'privacy', 'salt.key') && fs.readFileSync(saltFile, 'utf8') === salt);
  ok('the file is 0600 (owner read/write only)', process.platform === 'win32' || (fs.statSync(saltFile).mode & 0o777) === 0o600, (fs.statSync(saltFile).mode & 0o777).toString(8));
  ok('it is stable', (await store.getSalt(pid)) === salt);

  // Mark two columns — a proposal is not sensitive until accepted.
  ok('nothing is sensitive before the user marks it', (await share.sensitiveColumns(pid, did)).size === 0);
  await catalog.setColumn(pid, did, 'email', { sensitivity: 'personal' });
  await catalog.setColumn(pid, did, 'card', { sensitivity: 'financial' });
  const sens = await share.sensitiveColumns(pid, did);
  ok('marked columns are sensitive', sens.get('email') === 'personal' && sens.get('card') === 'financial' && sens.size === 2);

  // ── Summaries ─────────────────────────────────────────────────────────────
  const sum = await call('privacy:summary', { projectId: pid, path: 'export', datasetIds: [did] });
  ok('summary: "2 sensitive columns will be masked"', sum.ok && sum.count === 2 && sum.line === '2 sensitive columns will be masked', JSON.stringify(sum));
  ok('summary names the dataset of each column', sum.columns.every((c: any) => c.datasetName === 'Customers'));
  ok('summary lines for drop / include', share.summaryLine(1, 'drop') === '1 sensitive column will be dropped' && share.summaryLine(3, 'include') === '3 sensitive columns will be included as they are' && share.summaryLine(0, 'mask') === '');
  ok('summary over the whole project when no ids are given', (await call('privacy:summary', { projectId: pid, path: 'bundle' })).count === 2);
  ok('summary refuses an unknown path', (await call('privacy:summary', { projectId: pid, path: 'email-it' })).ok === false);

  // ── 3a. Rows: the drill CSV ───────────────────────────────────────────────
  const drill = { projectId: pid, datasetId: did, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [], mark: null, page: {} };
  savePath = path.join(outDir, 'mask.csv');
  let r = await call('visual:rowsDownload', drill);
  keep(r);
  let csv = csvRows(savePath);
  ok('rows/mask: the export ran', r.ok === true && r.rows === 4, JSON.stringify(r));
  ok('rows/mask: header keeps the columns', csv[0].join(',') === 'name,email,card,region,amount');
  ok('rows/mask: every email and card cell is its project token', csv.slice(1).every((row, i) => row[1] === mask.maskToken(salt, String(ROWS[i][1])) && row[2] === mask.maskToken(salt, String(ROWS[i][2]))));
  ok('rows/mask: no raw value is in the file', !RAW.some((v) => fs.readFileSync(savePath, 'utf8').includes(v)));
  ok('rows/mask: other columns untouched', csv[1][3] === 'North' && csv[1][4] === '10' && csv[1][0] === 'Grace Hopper');
  await store.setPolicy(pid, { export: 'drop' });
  savePath = path.join(outDir, 'drop.csv');
  keep(await call('visual:rowsDownload', drill));
  csv = csvRows(savePath);
  ok('rows/drop: the sensitive columns are gone from header and rows', csv[0].join(',') === 'name,region,amount' && csv.every((row) => row.length === 3), csv[0].join(','));
  await store.setPolicy(pid, { export: 'include' });
  savePath = path.join(outDir, 'include.csv');
  keep(await call('visual:rowsDownload', drill));
  ok('rows/include: raw values pass through', fs.readFileSync(savePath, 'utf8').includes('grace@example.com'));
  await store.setPolicy(pid, { export: 'mask' });

  // ── 3b. Charts: visual:data with `share` ──────────────────────────────────
  const byEmail = { category: 'email', values: [{ column: 'amount', aggregation: 'sum' }] };
  const inApp = await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail });
  ok('chart/in-app: WITHOUT share the labels are the real values (inside the app nothing changes)', inApp.ok && inApp.data.labels.includes('grace@example.com'));
  const masked = await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail, share: 'export' });
  ok('chart/mask: labels drawn from a sensitive column are tokens, in the same order',
    masked.ok && JSON.stringify(masked.data.labels) === JSON.stringify(inApp.data.labels.map((l: string) => mask.maskToken(salt, l))), JSON.stringify(masked.data && masked.data.labels));
  ok('chart/mask: the figures are unchanged', JSON.stringify(masked.data.series[0].values) === JSON.stringify(inApp.data.series[0].values));
  const bySeries = await call('visual:data', { projectId: pid, datasetId: did, encoding: { category: 'region', series: 'card', values: [{ column: 'amount', aggregation: 'sum' }] }, share: 'report' });
  ok('chart/mask: series names from a sensitive column are tokens; the category is not',
    bySeries.ok && bySeries.data.series.every((s: any) => /^#[0-9a-f]{12}$/.test(s.name)) && bySeries.data.labels.includes('North'), JSON.stringify(bySeries.data && bySeries.data.series.map((s: any) => s.name)));
  const plain = await call('visual:data', { projectId: pid, datasetId: did, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, share: 'export' });
  ok('chart/mask: a chart that touches no sensitive column is untouched', plain.ok && plain.data.labels.includes('North'));
  const countEmail = await call('visual:data', { projectId: pid, datasetId: did, encoding: { category: 'region', values: [{ column: 'email', aggregation: 'count' }] }, share: 'export' });
  ok('chart/mask: a sensitive MEASURE is an aggregate and passes', countEmail.ok && countEmail.data.labels.includes('North'));
  const pivot = await call('visual:data', { projectId: pid, datasetId: did, share: 'export', encoding: {
    category: 'email', values: [{ column: 'amount', aggregation: 'sum' }],
    pivot: { rows: [{ column: 'email' }], columns: [{ column: 'region' }], values: [{ column: 'amount', aggregation: 'sum' }], totals: { rows: false, columns: false, grand: false } },
  } });
  ok('chart/mask: pivot row headers from a sensitive column are tokens, column headers are not',
    pivot.ok && pivot.data.pivot && pivot.data.pivot.rowHeaders.every((h: string[]) => /^#/.test(h[0])) && pivot.data.pivot.colHeaders.some((h: string[]) => h[0] === 'North'), JSON.stringify(pivot.data && pivot.data.pivot && pivot.data.pivot.rowHeaders));
  await store.setPolicy(pid, { export: 'drop', report: 'include' });
  const dropped = await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail, share: 'export' });
  ok('chart/drop: a chart using a sensitive column is replaced by "Hidden by the share policy"', dropped.ok === false && dropped.hiddenByPolicy === true && dropped.error === 'Hidden by the share policy');
  ok('chart/drop: …in ANY role, a measure included', (await call('visual:data', { projectId: pid, datasetId: did, encoding: { category: 'region', values: [{ column: 'email', aggregation: 'count' }] }, share: 'export' })).hiddenByPolicy === true);
  const incl = await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail, share: 'report' });
  ok('chart/include: passes through (the renderer confirmed first)', incl.ok && incl.data.labels.includes('grace@example.com'));
  ok('chart: an unknown share value is ignored, never trusted', (await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail, share: 'bundle' })).data.labels.includes('grace@example.com'));
  await store.setPolicy(pid, { export: 'mask', report: 'mask' });
  const copied = await call('privacy:shareReply', { projectId: pid, datasetId: did, encoding: byEmail, reply: { ok: true, data: inApp.data }, path: 'export' });
  ok('Copy data: a reply the renderer holds comes back masked', copied.ok && copied.data.labels.every((l: string) => /^#/.test(l)));

  // A column masked in Prepare is not masked again, and not counted.
  const stepped = await datasets.updateSteps(pid, did, [{ type: 'mask_hash', column: 'email' }]);
  ok('fixture: a Prepare hash step on email', !!stepped);
  ok('a column masked in Prepare is not counted by the policy', (await share.policySummary(pid, [did], 'export')).count === 1);
  const prepMasked = await call('visual:data', { projectId: pid, datasetId: did, encoding: byEmail, share: 'export' });
  ok('…and its labels are the Prepare tokens, not tokens of tokens', prepMasked.ok && prepMasked.data.labels.includes(mask.maskToken(salt, 'grace@example.com')));

  // A mark survives a LATER rename: catalog keys are the name at marking time.
  const renamedDs = await datasets.saveDataset(pid, { name: 'Renamed', sourceKind: 'csv', columns: [{ name: 'mail', type: 'text' }, { name: 'n', type: 'number' }], rows: [['x@example.com', 1], ['y@example.com', 2]] });
  await catalog.setColumn(pid, renamedDs!.id, 'mail', { sensitivity: 'personal' });
  await datasets.updateSteps(pid, renamedDs!.id, [{ type: 'rename_column', from: 'mail', to: 'contact' }]);
  ok('rename: the mark follows mail → contact', (await share.sensitiveColumns(pid, renamedDs!.id)).get('contact') === 'personal');
  const renamedRows = await share.applyToTable(pid, renamedDs!.id, { columns: [{ name: 'contact', type: 'text' }, { name: 'n', type: 'number' }], rows: [['x@example.com', 1]] }, 'export');
  ok('rename: …so the renamed column is still masked on the way out', renamedRows.rows[0][0] === mask.maskToken(salt, 'x@example.com'));
  ok('rename: …and withheld from the Assistant under its new name', (await share.withheldColumns(pid, renamedDs!.id)).has('contact')
    && (await share.assistantColumnDocs(pid, renamedDs!.id)).contact.sensitivity === 'personal');
  await datasets.deleteDataset(pid, renamedDs!.id);

  // ── 3c. Publish: the API the publish feature calls ────────────────────────
  const table = { columns: COLS, rows: ROWS };
  const pub = await share.applyToTable(pid, did, table, 'publish');
  ok('publish/table: card is masked (email is already masked in Prepare, so it passes)', pub.masked.join() === 'card' && pub.rows[0][2] === mask.maskToken(salt, '4111111111111111') && pub.columns[2].type === 'text');
  ok('publish/table: the input table is not mutated', ROWS[0][2] === '4111111111111111');
  await store.setPolicy(pid, { publish: 'drop' });
  const pubDrop = await share.applyToTable(pid, did, table, 'publish');
  ok('publish/table drop: the column is gone', pubDrop.columns.map((c) => c.name).join() === 'name,email,region,amount' && pubDrop.rows[0].length === 4 && pubDrop.dropped.join() === 'card');
  const pubChart = await share.applyToChart(pid, did, { category: 'card', values: [{ column: 'amount', aggregation: 'sum' }] }, { ok: true, data: { labels: ['x'], series: [] } }, 'publish');
  ok('publish/chart drop: hidden', (pubChart as { hiddenByPolicy?: boolean }).hiddenByPolicy === true);
  ok('publish/summary', (await share.policySummary(pid, [did], 'publish')).line === '1 sensitive column will be dropped');
  await store.setPolicy(pid, { publish: 'mask' });

  // ── 3d. Bundles ───────────────────────────────────────────────────────────
  await versions.record(pid, 'dataset', { id: did, steps: [{ type: 'mask_hash', column: 'email' }] });
  // Colours keyed by raw values of marked columns, and of an unmarked one — as
  // charts over them would have dealt (analysis/colorMap.ts).
  await projects.setColorMap(pid, {
    card: { '4111111111111111': 'chart-1' }, email: { 'grace@example.com': 'chart-2' }, region: { North: 'chart-3' },
  });
  const raw = await bundle.exportProject(pid);
  const rawNames = bundle.readZip(raw!.bytes).map((e) => e.name);
  ok('fixture: a raw export carries the source Parquet and a dataset version', rawNames.includes(`datasets/${did}.source.parquet`) && rawNames.some((n) => n.startsWith(`history/dataset/${did}/`)));
  savePath = path.join(outDir, 'project.ordinate');
  const exp = await call('projects:export', { id: pid });
  keep(exp);
  ok('bundle/mask: the export ran', exp.ok === true, JSON.stringify(exp));
  const bytes = fs.readFileSync(savePath);
  const entries = bundle.readZip(bytes);
  const names = entries.map((e) => e.name);
  ok('bundle/mask: the source Parquet (raw values) is left behind', !names.includes(`datasets/${did}.source.parquet`));
  ok('bundle/mask: so is the dataset\'s prepare history', !names.some((n) => n.startsWith(`history/dataset/${did}/`)));
  const rec = JSON.parse(entries.find((e) => e.name === `datasets/${did}.json`)!.data.toString('utf8'));
  ok('bundle/mask: the record has no source and no steps', rec.source === undefined && Array.isArray(rec.steps) && rec.steps.length === 0);
  const pq = path.join(outDir, 'bundled.parquet');
  fs.writeFileSync(pq, entries.find((e) => e.name === `datasets/${did}.parquet`)!.data);
  const bundled = pqSync.readTable(pq, rec.columns)!;
  ok('bundle/mask: card is masked in the table that travels', bundled.rows[0][2] === mask.maskToken(salt, '4111111111111111') && rec.columns[2].type === 'text');
  ok('bundle/mask: email travels as its Prepare token', bundled.rows[0][1] === mask.maskToken(salt, 'grace@example.com'));
  ok('bundle/mask: no raw value is anywhere in the bundle', !entries.some((e) => RAW.some((v) => e.data.includes(v))));
  const pjColors = JSON.parse(entries.find((e) => e.name === 'project.json')!.data.toString('utf8')).colorMap;
  ok('bundle/mask: the colour map leaves marked columns behind, keeps the rest',
    !!pjColors && pjColors.region && pjColors.region.North === 'chart-3' && !pjColors.card && !pjColors.email, JSON.stringify(pjColors));
  // The share POLICY travels (a restored backup keeps its rules); the salt and
  // the pending-review file never do.
  ok('bundle: only privacy/policy.json travels — never the salt or the review file',
    names.filter((n) => n.startsWith('privacy/')).every((n) => n === 'privacy/policy.json')
    && !names.some((n) => /salt/.test(n)), names.filter((n) => n.startsWith('privacy/')).join(','));
  const imported = await bundle.importBundle(bytes);
  ok('bundle/mask: the shaped bundle still IMPORTS (manifest counts follow)', imported.ok === true, JSON.stringify(imported.error));
  if (imported.ok && imported.project) {
    const list = await datasets.listDatasets(imported.project.id);
    const back = await datasets.getDataset(imported.project.id, list[0].id);
    ok('bundle/mask: the imported dataset opens, masked', !!back && back.rows[0][2] === mask.maskToken(salt, '4111111111111111') && back.rows.length === 4);
    const importedColors = (await projects.getProject(imported.project.id))!.colorMap;
    ok('bundle: the imported project keeps the colours that travelled',
      JSON.stringify(importedColors) === JSON.stringify({ region: { North: 'chart-3' } }), JSON.stringify(importedColors));
  }
  await store.setPolicy(pid, { bundle: 'drop' });
  savePath = path.join(outDir, 'project-drop.ordinate');
  keep(await call('projects:export', { id: pid }));
  const dropRec = JSON.parse(bundle.readZip(fs.readFileSync(savePath)).find((e) => e.name === `datasets/${did}.json`)!.data.toString('utf8'));
  ok('bundle/drop: the column is dropped from the record', !dropRec.columns.some((c: any) => c.name === 'card'));
  ok('bundle/drop: the dropped bundle imports too', (await bundle.importBundle(fs.readFileSync(savePath))).ok === true);
  await store.setPolicy(pid, { bundle: 'include' });
  savePath = path.join(outDir, 'project-include.ordinate');
  keep(await call('projects:export', { id: pid }));
  const inclNames = bundle.readZip(fs.readFileSync(savePath)).map((e) => e.name);
  ok('bundle/include: the source Parquet travels unchanged', inclNames.includes(`datasets/${did}.source.parquet`));
  await store.setPolicy(pid, { bundle: 'mask' });

  // ── 4. Proposals ──────────────────────────────────────────────────────────
  const found = await store.scanDataset(pid, await datasets.getDataset(pid, did));
  ok('scan: proposes the unmarked name column, not the marked ones', found.map((p) => p.column).join() === 'name', JSON.stringify(found));
  const review = await call('privacy:review', { projectId: pid, datasetId: did });
  ok('review: the pending proposal, the levels and the policy', review.pending.length === 1 && review.levels.card === 'financial' && review.policy.export === 'mask');
  ok('decide: "none" is remembered', (await call('privacy:decide', { projectId: pid, datasetId: did, column: 'name', level: 'none' })).ok === true);
  ok('…and never proposed again', (await store.scanDataset(pid, await datasets.getDataset(pid, did))).length === 0 && (await store.getReview(pid, did)).dismissed.includes('name'));
  ok('decide refuses a bogus level', (await call('privacy:decide', { projectId: pid, datasetId: did, column: 'name', level: 'secret' })).ok === false);
  // A REFRESH that brings a newly sensitive column makes it pending.
  const csvFile = path.join(outDir, 'people.csv');
  fs.writeFileSync(csvFile, 'id,city\n1,Oslo\n2,Rome\n3,Lima\n');
  const withOrigin = await datasets.saveDataset(pid, { name: 'People', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'city', type: 'text' }], rows: [['1', 'Oslo'], ['2', 'Rome'], ['3', 'Lima']], origin: { kind: 'file', path: csvFile } });
  fs.writeFileSync(csvFile, 'id,city,phone\n1,Oslo,+47 22 12 34 56\n2,Rome,+39 06 1234 5678\n3,Lima,+51 1 234 5678\n');
  const refreshed = await refreshDataset(pid, withOrigin!.id);
  ok('refresh: the refresh succeeded', refreshed.ok === true, JSON.stringify(refreshed));
  const after = await store.getReview(pid, withOrigin!.id);
  ok('refresh: the new phone column is PENDING, not applied', after.pending.map((p) => p.column).join() === 'phone' && (await share.sensitiveColumns(pid, withOrigin!.id)).size === 0, JSON.stringify(after));
  const ov = await call('privacy:overview', { projectId: pid });
  ok('overview: both datasets, marked and pending', ov.ok && ov.datasets.length === 2 && ov.datasets.some((d: any) => d.sensitive.some((c: any) => c.column === 'email' && c.maskedInPrepare)), JSON.stringify(ov.datasets));

  // ── 5. The salt never leaves the project folder ───────────────────────────
  ok('salt: in no IPC reply', !JSON.stringify(replies).includes(salt));
  ok('salt: in no log line', !logged.some((l) => l.includes(salt)));
  ok('salt: in no exported file', fs.readdirSync(outDir).every((f) => !fs.readFileSync(path.join(outDir, f)).includes(salt)));
  const bundles = fs.readdirSync(outDir).filter((f) => f.endsWith('.ordinate'));
  ok('salt: in no bundle entry', bundles.every((f) => bundle.readZip(fs.readFileSync(path.join(outDir, f))).every((e) => !e.data.includes(salt) && !e.name.includes('salt'))));
  const holders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(salt)) holders.push(path.relative(tmpUserData, p));
    }
  };
  walk(tmpUserData);
  ok('salt: on disk ONLY at projects/<pid>/privacy/salt.key', holders.length === 1 && holders[0] === path.join('projects', pid, 'privacy', 'salt.key'), holders.join(', '));
  const leftover = fs.readdirSync(path.join(tmpUserData, 'projects', pid, 'privacy'));
  ok('bundle shaping leaves no scratch files behind', leftover.every((n) => ['salt.key', 'policy.json', 'review.json'].includes(n)), leftover.join());
}

main()
  .then(() => {
    for (const d of [tmpUserData, outDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    if (failureCount()) { console.error('\n' + failureCount() + ' share-policy check(s) FAILED'); process.exit(1); }
    console.log('\nAll share-policy checks passed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
