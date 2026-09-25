// Self-check for data-quality ORCHESTRATION — src/analysis/qualityRun.ts and
// src/ipc/quality.ts over the real dataset store (electron stubbed).
//
// What is pinned here, and why each would break quietly:
//   1. RESULTS ARE METADATA. A run writes latest + history onto the record and
//      must NOT bump `updatedAt` (list order, Home's Recent) — asserted.
//   2. THE RESIDENT PATH NEVER HYDRATES. A spy on `datasets.getDataset` proves
//      the table was not read, so a fast path that stops firing fails loudly.
//   3. ONE ALERT PER TRANSITION. A FAIL rule going passing → failing (or
//      never-run → failing) raises exactly one event; staying failing raises
//      none; recovering and failing again raises one more. WARN rules never.
//   4. ALERTS ARE OPTIONAL. With no alerts module the checks still run and keep
//      their results; with the real one, the event lands in alerts.json.
//   5. HISTORY IS CAPPED at 30 runs; a rule on a vanished column is an error
//      result, not a crash; the summary carries the red dot's count.
//   6. THE IPC SURFACE: failing rows are the counted rows, preview stores
//      nothing, the refresh/update/pipeline hooks actually re-run the checks.
//
//   npm run build:ts && node scripts/test-qualityRun.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-quality-run-'));
const handlers = new Map<string, IpcHandler>();
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    class Notification { static isSupported(): boolean { return false; } show(): void {} on(): void {} }
    return {
      app: { getPath: () => tmpUserData, getVersion: () => '0.0.0-test', isPackaged: false },
      ipcMain: { handle: (ch: string, fn: IpcHandler) => { handlers.set(ch, fn); }, on: () => {} },
      Notification, dialog: {}, net: {}, nativeImage: {}, shell: {}, BrowserWindow: class {},
      nativeTheme: { on: () => {} }, safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const qr: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');
const rules: typeof import('../src/analysis/qualityRules') = require('../src/analysis/qualityRules');
require('../src/ipc/datasets').register();
require('../src/ipc/quality').register();

const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const D = (name: string): ParsedColumn => ({ name, type: 'date' });
const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);

const COLS = [T('order_id'), D('order_date'), N('discount'), T('cust')];
const good: Cell[][] = [
  ['A1', '2024-01-02', 0.1, 'C1'],
  ['A2', '2024-01-03', 0.5, 'C2'],
  ['A3', '2024-01-04', 0, 'C1'],
];
const withGaps: Cell[][] = [...good, ['A4', null, 1.5, 'C9'], ['A5', '  ', 0.2, 'C2']];

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  if (!duck.isAvailable()) {
    console.log('#    DuckDB bridge UNAVAILABLE — orchestration is only exercised on the JS path');
  }
  const proj = await projects.createProject('quality');
  const P = proj.id;
  const customers = (await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: [T('cid')], rows: [['C1'], ['C2']] }))!;
  const orders = (await datasets.saveDataset(P, { name: 'Retail orders', sourceKind: 'csv', columns: COLS, rows: good }))!;
  const O = orders.id;

  const recorded: any[] = [];
  const delivered: any[] = [];
  qr.setAlertSinkForTest({
    record: async (_p, ev) => { recorded.push(...ev); },
    deliver: async (_p, ev) => { delivered.push(...ev); },
  });

  // ── 1+2. Save a rule: it runs, it is kept, nothing hydrated, updatedAt still ──
  const realGet = datasets.getDataset;
  let hydrated = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated += 1; return (realGet as any)(...args); };
  const before = await datasets.getDatasetMeta(P, O);
  trace.reset();
  const saved = await qr.saveRule(P, O, { kind: 'not_null', column: 'order_date', args: {}, severity: 'fail' });
  ok('saveRule → ok with a UUID id', saved.ok === true && saved.ok && /^[0-9a-f-]{36}$/.test(saved.rule.id), JSON.stringify(saved));
  if (!saved.ok) return;
  const NN = saved.rule.id;
  ok('saving a rule ran it', saved.quality.latest?.results[0]?.ruleId === NN && saved.quality.latest.results[0].passed === true);
  const after = await datasets.getDatasetMeta(P, O);
  ok('a run does NOT bump updatedAt', !!before && !!after && before.updatedAt === after.updatedAt, `${before?.updatedAt} → ${after?.updatedAt}`);
  if (duck.isAvailable()) {
    ok('the resident path answered', (trace.snapshot().qualityRules || { resident: 0 }).resident >= 1, JSON.stringify(trace.snapshot()));
    ok('the resident path never hydrated the table', hydrated === 0, `getDataset called ${hydrated}x`);
  }
  (datasets as any).getDataset = realGet;
  ok('a passing first run raises nothing', recorded.length === 0);

  // ── 3. One alert per transition ────────────────────────────────────────────
  await datasets.updateDatasetData(P, O, { columns: COLS, rows: withGaps });
  let ev = await qr.runQualityChecks(P, O);
  ok('pass → fail raises exactly one event', ev.length === 1 && recorded.length === 1 && delivered.length === 1, JSON.stringify(ev));
  ok('the event names the rule, the count and the dataset',
    ev[0]?.message === 'Data quality: "not_null(order_date)" failing on 2 rows in Retail orders' && ev[0].value === 2, ev[0]?.message);
  ok('event and rule ids are UUIDs (sanitizeEvent keeps them)', /^[0-9a-f-]{36}$/.test(ev[0]?.id) && ev[0]?.ruleId === NN);
  ev = await qr.runQualityChecks(P, O);
  ok('still failing raises nothing', ev.length === 0 && recorded.length === 1);
  await datasets.updateDatasetData(P, O, { columns: COLS, rows: good });
  ev = await qr.runQualityChecks(P, O);
  ok('recovering raises nothing', ev.length === 0 && recorded.length === 1);
  await datasets.updateDatasetData(P, O, { columns: COLS, rows: withGaps });
  ev = await qr.runQualityChecks(P, O, { deliver: false });
  ok('failing again raises one more — recorded, not delivered, with deliver:false', ev.length === 1 && recorded.length === 2 && delivered.length === 1);

  const warn = await qr.saveRule(P, O, { kind: 'range', column: 'discount', args: { min: 0, max: 1 }, severity: 'warn' });
  ok('a failing WARN rule raises nothing', warn.ok === true && recorded.length === 2);
  const fresh = await qr.saveRule(P, O, { kind: 'references', column: 'cust', args: { datasetId: customers.id, column: 'cid' } });
  ok('a never-run FAIL rule that fails on its first run raises one', fresh.ok === true && recorded.length === 3, `recorded=${recorded.length}`);
  if (!warn.ok || !fresh.ok) return;

  // ── 5. Summary, history cap ────────────────────────────────────────────────
  const summary = (await datasets.listDatasets(P)).find((d) => d.id === O);
  ok('the summary carries the red dot count (FAIL rules only)', summary?.qualityFailing === 2, JSON.stringify(summary));
  ok('a never-checked dataset has no count', (await datasets.listDatasets(P)).find((d) => d.id === customers.id)?.qualityFailing === undefined);
  for (let i = 0; i < 31; i += 1) await qr.runQualityChecks(P, O);
  const q = await qr.listQuality(P, O);
  ok('history is capped at 30 runs', q?.history?.length === rules.MAX_HISTORY, String(q?.history?.length));
  ok('history carries each rule\'s failing count', q?.history?.[29].failing[NN] === 2 && q.history[29].failed === 3);

  // ── 6. The IPC surface ─────────────────────────────────────────────────────
  const list = await call('quality:list', { projectId: P, datasetId: O });
  ok('quality:list returns rules, latest and history', list.ok && list.rules.length === 3 && list.latest && list.history.length === 30);
  const page = await call('quality:failingRows', { projectId: P, datasetId: O, ruleId: NN, offset: 0, limit: 50 });
  ok('quality:failingRows serves exactly the failing rows', page.ok && page.total === 2 && page.rows.map((r: Cell[]) => r[0]).join() === 'A4,A5', JSON.stringify(page));
  const refPage = await call('quality:failingRows', { projectId: P, datasetId: O, ruleId: fresh.rule.id, offset: 0, limit: 50, search: 'a4' });
  ok('failing rows keep the grid search (references anti-join + search)', refPage.ok && refPage.total === 1 && refPage.rows[0][3] === 'C9', JSON.stringify(refPage));
  const rc = await qr.saveRule(P, O, { kind: 'row_count', args: { min: 1 } });
  const rcPage = rc.ok ? await call('quality:failingRows', { projectId: P, datasetId: O, ruleId: rc.rule.id, offset: 0, limit: 5 }) : null;
  ok('a row_count rule has no failing rows to show', rcPage && rcPage.ok === false && /no failing rows/.test(rcPage.error));
  const latestAt = (await qr.listQuality(P, O))?.latest?.at;
  const pv = await call('quality:preview', { projectId: P, datasetId: O, rule: { kind: 'in_set', column: 'cust', args: { values: ['C1'] } } });
  ok('quality:preview counts a draft rule', pv.ok && pv.failing === 3 && pv.passed === false, JSON.stringify(pv));
  ok('quality:preview stores nothing', (await qr.listQuality(P, O))?.latest?.at === latestAt && (await qr.listQuality(P, O))?.rules.length === 4);
  const bad = await call('quality:save', { projectId: P, datasetId: O, rule: { kind: 'regex', column: 'cust', args: { pattern: '\\s+' } } });
  ok('quality:save refuses an unsupported pattern with a reason', bad.ok === false && /whitespace/.test(bad.error));

  // The hooks: the pipeline, a rename, a refresh all re-run the checks.
  let at0 = (await qr.listQuality(P, O))?.latest?.at;
  const steps = await call('dataset:setSteps', { projectId: P, datasetId: O, steps: [{ type: 'filter', column: 'order_date', op: 'not_empty' }] });
  const afterSteps = await qr.listQuality(P, O);
  ok('a pipeline change re-runs the checks', steps.ok && afterSteps?.latest?.at !== at0 &&
    afterSteps?.latest?.results.find((r) => r.ruleId === NN)?.passed === true, JSON.stringify(afterSteps?.latest));
  at0 = afterSteps?.latest?.at;
  const renamed = await call('dataset:update', { projectId: P, datasetId: O, columns: [T('order_id'), D('ordered'), N('discount'), T('cust')] });
  const afterRename = await qr.listQuality(P, O);
  const broken = afterRename?.latest?.results.find((r) => r.ruleId === NN);
  ok('a rename re-runs the checks', renamed.ok && afterRename?.latest?.at !== at0);
  ok('a rule on a vanished column is passed:false with an error, not a crash',
    broken?.passed === false && /"order_date" no longer exists/.test(broken?.error || ''), JSON.stringify(broken));
  ok('…and it counts toward the red dot', (await datasets.listDatasets(P)).find((d) => d.id === O)?.qualityFailing === 2);

  // ── 4. Alerts optional: absent, then the real module ──────────────────────
  const bare = (await datasets.saveDataset(P, { name: 'Bare', sourceKind: 'csv', columns: [T('x')], rows: [['a'], ['b']] }))!;
  qr.setAlertSinkForTest(null);
  const nn = await qr.saveRule(P, bare.id, { kind: 'not_null', column: 'x' });
  await datasets.updateDatasetData(P, bare.id, { columns: [T('x')], rows: [['a'], [null]] });
  let threw = false;
  try { ev = await qr.runQualityChecks(P, bare.id); } catch { threw = true; }
  const kept = await qr.listQuality(P, bare.id);
  ok('with no alerts module a flip raises nothing and throws nothing', !threw && ev.length === 0);
  ok('…and the result is still kept', nn.ok === true && kept?.latest?.results[0]?.failing === 1);

  qr.setAlertSinkForTest(undefined); // feature-detect the real alerts module
  await datasets.updateDatasetData(P, bare.id, { columns: [T('x')], rows: [['a'], ['b']] });
  await qr.runQualityChecks(P, bare.id);
  await datasets.updateDatasetData(P, bare.id, { columns: [T('x')], rows: [[' '], ['b']] });
  ev = await qr.runQualityChecks(P, bare.id);
  const store: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
  const inbox = await store.load(P);
  ok('with the real alerts module the event lands in the inbox, once',
    ev.length === 1 && inbox.events.filter((e) => e.id === ev[0].id && e.ruleName === 'Data quality').length === 1, JSON.stringify(inbox.events));

  // Delete removes the rule, its result and its history column.
  const del = await call('quality:delete', { projectId: P, datasetId: O, ruleId: NN });
  const afterDel = await qr.listQuality(P, O);
  ok('quality:delete removes the rule everywhere', del.ok && !afterDel?.rules.some((r) => r.id === NN) &&
    !afterDel?.latest?.results.some((r) => r.ruleId === NN) && !afterDel?.history?.some((h) => NN in h.failing));
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' quality-run check(s) FAILED'); process.exit(1); }
    console.log('\nAll quality-run checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
