// Self-check for src/datasetRefresh.ts — the ONE refresh model.
//
// The file branch runs against REAL temp files rather than a stubbed fs: the
// whole feature is "re-read what is actually on disk now", and a stub that
// returns whatever the test wants would assert nothing about that. Only the two
// network-ish seams are replaced (connectionRun.runConnection and
// ipc/connections.refreshConnectionInto), because neither should dial out from a
// unit test. 'electron' is stubbed to point userData at a temp dir, as in
// test-datasets.ts, so datasets/projects/transforms are all the real modules.
//
// The invariant this file exists to defend: A FAILED REFRESH NEVER DESTROYS
// DATA. Several checks below read the rows back and compare them byte for byte.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-refresh-'));
const tmpFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-refresh-src-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    // ipcMain/dialog are destructured by the ipc modules but only touched inside
    // their register(), which nothing here calls.
    return { app: { getPath: (_name: string) => tmpUserData }, ipcMain: {}, dialog: {} };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const connectionRun: any = require('../src/connectionRun');
const ipcConnections: any = require('../src/ipc/connections');

let failures = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log('ok   ' + label + (detail ? '  ' + detail : ''));
  else {
    console.error('FAIL ' + label + (detail ? '  ' + detail : ''));
    failures++;
  }
}

function writeCsv(name: string, text: string): string {
  const p = path.join(tmpFiles, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// Save a dataset from a real file, exactly as the import path does.
async function importCsv(projectId: string, name: string, filePath: string) {
  const { parseFile } = require('../src/data/fileImport');
  const parsed = await parseFile(filePath, 'csv');
  return datasets.saveDataset(projectId, {
    name,
    sourceKind: 'csv',
    columns: parsed.columns,
    rows: parsed.rows,
    origin: { kind: 'file', path: filePath },
  });
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Refresh project');

  // ── 1. The pipeline survives a refresh ───────────────────────────────────
  // This is the entire reason refresh funnels through updateDatasetData. A
  // refresh that dropped the steps would still "work" and would silently show
  // unfiltered numbers.
  const salesPath = writeCsv('sales.csv', 'region,amount\nnorth,10\nsouth,20\nnorth,30\n');
  const sales = await importCsv(proj.id, 'Sales', salesPath);
  ok('imported a dataset from a real file', sales !== null && sales.rowCount === 3);

  // A filter step: keep only the north rows. This snapshots `source`.
  await datasets.updateSteps(proj.id, sales!.id, [
    { type: 'filter', column: 'region', op: '=', value: 'north' } as any,
  ]);
  let after = await datasets.getDataset(proj.id, sales!.id);
  ok('the filter step applies before any refresh', after !== null && after.rows.length === 2);

  // Rewrite the file with MORE north rows, then refresh.
  fs.writeFileSync(salesPath, 'region,amount\nnorth,10\nsouth,20\nnorth,30\nnorth,40\nsouth,50\n', 'utf8');
  let res = await refresh.refreshDataset(proj.id, sales!.id);
  ok('refreshing a file dataset succeeds', res.ok === true, res.ok ? '' : (res as any).error);
  after = await datasets.getDataset(proj.id, sales!.id);
  ok('…the new file was read (5 source rows)', after !== null && after.source!.rows.length === 5);
  ok('…and the STEP was re-applied to it, not dropped (3 north rows)',
     after !== null && after.rows.length === 3,
     after ? `${after.rows.length} derived rows` : '');
  ok('…lastRefreshedAt + ok status are stamped',
     after !== null && after.lastRefreshStatus === 'ok' && typeof after.lastRefreshedAt === 'string');

  // ── 2. A failed fetch leaves the data byte-identical ─────────────────────
  const before = JSON.stringify(after!.rows);
  const beforeSource = JSON.stringify(after!.source!.rows);
  fs.rmSync(salesPath); // the file moved / was deleted under us
  res = await refresh.refreshDataset(proj.id, sales!.id);
  ok('refreshing a missing file fails cleanly', res.ok === false);
  ok('…with an error naming the path, not an errno',
     res.ok === false && res.error.includes(salesPath), res.ok ? '' : res.error);
  const afterFail = await datasets.getDataset(proj.id, sales!.id);
  ok('…the DERIVED rows are byte-identical', JSON.stringify(afterFail!.rows) === before);
  ok('…the SOURCE rows are byte-identical', JSON.stringify(afterFail!.source!.rows) === beforeSource);
  ok('…lastRefreshStatus flips to error', afterFail!.lastRefreshStatus === 'error');
  ok('…and lastRefreshedAt does NOT move — stale data must not look fresh',
     afterFail!.lastRefreshedAt === after!.lastRefreshedAt);

  // ── 3. Schema drift is a warning, not a crash ────────────────────────────
  // The refreshed file has lost the column the step filters on. applyPipeline
  // skips that step with a warning; the refresh must surface it and survive.
  fs.writeFileSync(salesPath, 'amount,note\n10,a\n20,b\n', 'utf8');
  res = await refresh.refreshDataset(proj.id, sales!.id);
  ok('a refresh that drops a step\'s column still succeeds', res.ok === true,
     res.ok ? '' : (res as any).error);
  ok('…and reports a warning rather than throwing or silently shortening the pipeline',
     res.ok === true && res.warnings.length > 0,
     res.ok ? JSON.stringify(res.warnings) : '');
  const drifted = await datasets.getDataset(proj.id, sales!.id);
  ok('…the steps are still stored, ready for the column to come back',
     drifted !== null && (drifted.steps || []).length === 1);

  // ── 4. Not refreshable ───────────────────────────────────────────────────
  const pasted = await datasets.saveDataset(proj.id, {
    name: 'Pasted', sourceKind: 'paste',
    columns: [{ name: 'a', type: 'text' }], rows: [['1']],
  });
  res = await refresh.refreshDataset(proj.id, pasted!.id);
  ok('a paste dataset returns a clean "not refreshable"', res.ok === false);
  ok('…naming the dataset and saying what to do',
     res.ok === false && /Pasted/.test(res.error) && /Re-import/.test(res.error),
     res.ok ? '' : res.error);
  const pastedAfter = await datasets.getDataset(proj.id, pasted!.id);
  ok('…and its rows are untouched', pastedAfter!.rows.length === 1);

  res = await refresh.refreshDataset(proj.id, '00000000-0000-4000-8000-000000000000');
  ok('a missing dataset is a clean error', res.ok === false);

  // ── 5. A combined A→B→A cycle terminates ─────────────────────────────────
  // Build two datasets and hand-edit each one's origin to combine FROM the
  // other. That is not reachable through the UI, but it is reachable on disk,
  // and an unguarded recursion here would hang the main process.
  const a = await datasets.saveDataset(proj.id, {
    name: 'A', sourceKind: 'combined', columns: [{ name: 'x', type: 'text' }], rows: [['1']],
  });
  const b = await datasets.saveDataset(proj.id, {
    name: 'B', sourceKind: 'combined', columns: [{ name: 'x', type: 'text' }], rows: [['2']],
  });
  const setOrigin = (id: string, origin: unknown): void => {
    const f = path.join(tmpUserData, 'projects', proj.id, 'datasets', id + '.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.origin = origin;
    fs.writeFileSync(f, JSON.stringify(raw, null, 2));
  };
  setOrigin(a!.id, { kind: 'combined', leftId: b!.id, rightId: b!.id, mode: 'append' });
  setOrigin(b!.id, { kind: 'combined', leftId: a!.id, rightId: a!.id, mode: 'append' });

  const cycle = await refresh.refreshDataset(proj.id, a!.id);
  // Reaching this line at all IS the assertion: without the visited-set guard
  // this call never returns.
  ok('an A→B→A combine cycle TERMINATES rather than recursing forever', true);
  ok('…and reports the cycle rather than failing silently',
     cycle.ok === true && cycle.warnings.some((w) => /itself/.test(w)),
     cycle.ok ? JSON.stringify(cycle.warnings) : (cycle as any).error);
  // B legitimately recomputes (append(A, A) over A's one stored row); what the
  // guard refuses is the SECOND visit to A, which is left untouched by it. So
  // the thing to assert is that nothing was emptied — a cycle must never
  // degrade a dataset to zero rows on its way out.
  const aAfter = await datasets.getDataset(proj.id, a!.id);
  const bAfter = await datasets.getDataset(proj.id, b!.id);
  ok('…B recomputed from A rather than being skipped', bAfter !== null && bAfter.rows.length === 2);
  ok('…and neither dataset was emptied',
     aAfter !== null && aAfter.rows.length > 0 && bAfter !== null && bAfter.rows.length > 0,
     `A=${aAfter?.rows.length} B=${bAfter?.rows.length}`);

  // ── 6. A real combine re-runs over refreshed parents ─────────────────────
  const leftPath = writeCsv('left.csv', 'k,v\n1,a\n2,b\n');
  const rightPath = writeCsv('right.csv', 'k,w\n1,x\n2,y\n');
  const left = await importCsv(proj.id, 'Left', leftPath);
  const right = await importCsv(proj.id, 'Right', rightPath);
  const combo = await datasets.saveDataset(proj.id, {
    name: 'Combo', sourceKind: 'combined',
    columns: [{ name: 'k', type: 'text' }], rows: [['1']],
    origin: { kind: 'combined', leftId: left!.id, rightId: right!.id, mode: 'append' },
  });
  fs.writeFileSync(leftPath, 'k,v\n1,a\n2,b\n3,c\n', 'utf8'); // a new row upstream
  res = await refresh.refreshDataset(proj.id, combo!.id);
  ok('refreshing a combined dataset succeeds', res.ok === true, res.ok ? '' : (res as any).error);
  const comboAfter = await datasets.getDataset(proj.id, combo!.id);
  ok('…re-running the combine over PARENTS that were refreshed first',
     comboAfter !== null && comboAfter.rows.length === 5,
     comboAfter ? `${comboAfter.rows.length} rows (3 left + 2 right)` : '');
  const leftAfter = await datasets.getDataset(proj.id, left!.id);
  ok('…and the parent itself was refreshed on the way through',
     leftAfter !== null && leftAfter.rows.length === 3);

  // ── 7. The url + connection branches use the shared seams ────────────────
  let urlCalls = 0;
  connectionRun.runConnection = async (connectorId: string, values: Record<string, unknown>) => {
    urlCalls += 1;
    ok('the url branch goes through the registry connector, not a second fetcher',
       connectorId === 'url' && values.url === 'https://example.com/d.json');
    return {
      ok: true,
      result: { columns: [{ name: 'n', type: 'text' }], rows: [['1'], ['2']], rowCount: 2, warnings: [] },
      truncated: false,
    };
  };
  const fromUrl = await datasets.saveDataset(proj.id, {
    name: 'FromUrl', sourceKind: 'url', columns: [{ name: 'n', type: 'text' }], rows: [['old']],
    origin: { kind: 'url', url: 'https://example.com/d.json' },
  });
  res = await refresh.refreshDataset(proj.id, fromUrl!.id);
  ok('a url dataset refreshes', res.ok === true && urlCalls === 1);
  ok('…storing the fetched rows',
     (await datasets.getDataset(proj.id, fromUrl!.id))!.rows.length === 2);

  connectionRun.runConnection = async () => ({ ok: false, error: 'Request timed out after 30s' });
  res = await refresh.refreshDataset(proj.id, fromUrl!.id);
  ok('a failed fetch surfaces the connector\'s own error',
     res.ok === false && res.error === 'Request timed out after 30s');
  ok('…and leaves the previously fetched rows in place',
     (await datasets.getDataset(proj.id, fromUrl!.id))!.rows.length === 2);

  let connCalls = 0;
  ipcConnections.refreshConnectionInto = async (pid: string, connId: string, dsId: string) => {
    connCalls += 1;
    const updated = await datasets.updateDatasetData(pid, dsId, {
      columns: [{ name: 'n', type: 'text' }], rows: [['a'], ['b'], ['c']],
    });
    return { ok: true, dataset: updated };
  };
  const CONN = '33333333-3333-4333-8333-333333333333';
  const fromConn = await datasets.saveDataset(proj.id, {
    name: 'FromConn', sourceKind: 'postgres', columns: [{ name: 'n', type: 'text' }], rows: [['old']],
    origin: { kind: 'connection', connId: CONN },
  });
  res = await refresh.refreshDataset(proj.id, fromConn!.id);
  ok('a connection dataset DELEGATES to the shared saved-connection run',
     res.ok === true && connCalls === 1);
  ok('…so the secret is never resolved here',
     (await datasets.getDataset(proj.id, fromConn!.id))!.rows.length === 3);
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    try { fs.rmSync(tmpFiles, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' refresh check(s) FAILED'); process.exit(1); }
    console.log('\nAll dataset-refresh checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
