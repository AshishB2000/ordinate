// End-to-end smoke test of the DATASET COMPOSER — launches the REAL app.
//
// The composer replaced the import dialog's confirm step: importing is now
// pick a source → composer → Save, and the old combine dialog is deleted. That
// makes this walk mandatory rather than nice to have — smoke-app.ts saves its
// fixture straight through the datasets module, so without this file nothing in
// the repo would ever cross the surface every import now goes through.
//
// It is a SEPARATE script rather than more lines in smoke-app.ts on purpose.
// smoke-app.ts is 3,544 lines and allowlisted in scripts/test-file-size.ts,
// whose rule is that an oversized file is split before more is added to it —
// growing it to add coverage is exactly what that check exists to refuse. So
// the new coverage starts the split instead of deepening the debt.
//
// The paste path is what gets driven: a file import opens a NATIVE dialog that
// Playwright cannot answer. Paste reaches the identical hand-off
// (handOffToComposer), so the composer, its canvas, its preview grid, the field
// mapper and the save are all exercised for real.
//
//   npm run smoke   (runs this after smoke-app.js)

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-composer-'));

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

const CSV = 'id,region,amount\n1,North,10\n2,South,20\n3,North,30\n';
/** A second table to join to, seeded through the datasets module. */
const LOOKUP = [
  ['North', 'EMEA'],
  ['South', 'APAC'],
];

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // Seed a project and one saved dataset to join against — the same modules
  // main.js registered its handlers with, so this is the shipped code path.
  // NOTE the signature: electronApplication.evaluate calls back with
  // (electronModule, arg) — NOT (arg). Getting that wrong silently seeds every
  // value as undefined, which here meant a lookup table with no rows and an
  // inner join that matched nothing.
  const seeded: any = await app.evaluate(async (_electronModule, arg: any) => {
    const lookup = arg.lookup;
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/projects.js');
    const datasets = req('./src/datasets.js');
    await projects.init();
    const proj = await projects.createProject('Composer smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Regions',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'zone', type: 'text' }],
      rows: lookup,
    });
    return { projectId: proj.id, lookupId: ds && ds.id };
  }, { lookup: LOOKUP });
  ok('seeded a project and a lookup dataset', Boolean(seeded.projectId && seeded.lookupId));

  // Splash first — a screenshot or a click here proves nothing.
  await win.waitForSelector('#splash[hidden]', { timeout: 30_000 }).catch(() => {});
  // openWorkspace is a classic-script global, not a window property — reached by
  // bare name inside the page. The hub CSP forbids eval, so it is declared above.
  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1500);
  // The nav item labelled "Data" opens Connect; the dataset list is reached the
  // way the app reaches it (projects.ts does the same on opening a dataset).
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1500);

  // ── The old combine dialog is gone, not merely unwired ─────────────────────
  ok('#ds-combine-modal no longer exists in the document',
    (await win.locator('#ds-combine-modal').count()) === 0);

  // ── Import → composer ──────────────────────────────────────────────────────
  await win.click('#ds-import-open', { timeout: 8000 });
  await win.waitForSelector('#ds-import-modal:not([hidden])', { timeout: 8000 });
  await win.click('#ds-paste-toggle', { timeout: 8000 });
  await win.fill('#ds-paste-input', CSV);
  await win.click('#ds-paste-parse', { timeout: 8000 });

  await win.waitForSelector('#ds-composer:not([hidden])', { timeout: 15_000 });
  ok('parsing hands off to the composer, and the dialog closes',
    (await win.locator('#ds-import-modal').isHidden()));

  ok('the Data panel is in composing mode, so the list is not also on screen',
    await win.evaluate(() => {
      const panel = document.querySelector('#ws-datasets .ds-panel');
      const saved = document.getElementById('ds-saved');
      return Boolean(panel && panel.classList.contains('is-composing'))
        && Boolean(saved && saved.getClientRects().length === 0);
    }));

  await win.waitForTimeout(900); // the first preview is a debounced IPC round-trip
  ok('the canvas shows the imported table as the base chip',
    (await win.locator('#dc-canvas .dc-chip').count()) === 1);
  ok('the preview grid painted the parsed rows',
    (await win.locator('#dc-grid tbody tr').count()) === 3,
    `${await win.locator('#dc-grid tbody tr').count()} rows`);
  ok('…with a header cell per column', (await win.locator('#dc-grid .dc-th').count()) === 3);
  ok('the row/column count line is app-computed and present',
    /3 rows · 3 columns/.test((await win.locator('#dc-count').textContent()) || ''),
    (await win.locator('#dc-count').textContent()) || '');

  // ── Join a saved dataset onto it ───────────────────────────────────────────
  await win.click('#dc-src-saved .dc-src', { timeout: 8000 });
  // Two round-trips: the dataset is fetched for its columns, THEN the chain is
  // previewed. 900ms was enough for the second but not always the first.
  await win.waitForTimeout(1800);
  ok('clicking a source adds it to the chain', (await win.locator('#dc-canvas .dc-chip').count()) === 2);
  ok('…with a join badge between them', (await win.locator('#dc-canvas .dc-badge').count()) === 1);
  ok('…and the key pair was guessed from the shared column name',
    (await win.locator('#dc-badge-none').count()) === 0
      && (await win.locator('#dc-canvas .dc-badge.dc-badge-warn').count()) === 0);

  const innerRows = await win.locator('#dc-grid tbody tr').count();
  ok('an inner join previews its matched rows', innerRows === 3, `${innerRows} rows`);

  // ── Switch it to a LEFT join and watch the count change ────────────────────
  await win.click('#dc-canvas .dc-badge', { timeout: 8000 });
  await win.waitForSelector('#dc-join-pop:not([hidden])', { timeout: 8000 });
  ok('the join editor offers exactly the three modes the engine runs',
    (await win.locator('#dc-modes .dc-mode').count()) === 3);
  const labels = await win.locator('#dc-modes .dc-mode span').allTextContents();
  ok('…named Inner, Left and Append', labels.join('|') === 'Inner|Left|Append', labels.join('|'));

  // Every row already matches, so switching to Left keeps the same count — what
  // this asserts is that the mode round-trips through the engine and repaints.
  await win.locator('#dc-modes .dc-mode', { hasText: 'Left' }).click();
  await win.waitForTimeout(900);
  ok('switching to Left re-previews through main', (await win.locator('#dc-grid tbody tr').count()) === 3);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  ok('Escape closes the join editor', await win.locator('#dc-join-pop').isHidden());

  // ── The preview header IS the field mapper ─────────────────────────────────
  await win.click('#dc-grid .dc-th:last-child .dc-th-btn', { timeout: 8000 });
  await win.waitForSelector('#dc-col-pop:not([hidden])', { timeout: 8000 });
  await win.fill('#dc-col-name', 'zone_code');
  await win.locator('#dc-col-name').press('Tab');
  await win.waitForTimeout(300);
  ok('renaming a column repaints its header with the new name',
    (await win.locator('#dc-grid .dc-th .dc-th-name').allTextContents()).indexOf('zone_code') >= 0);
  ok('…and marks it as mapped with a dot', (await win.locator('#dc-grid .dc-th-dot').count()) === 1);

  await win.click('#dc-grid .dc-th:nth-child(1) .dc-th-btn', { timeout: 8000 });
  await win.waitForSelector('#dc-col-pop:not([hidden])', { timeout: 8000 });
  await win.click('#dc-col-drop', { timeout: 8000 });
  await win.waitForTimeout(300);
  ok('dropping a column leaves a restore stub, not a hole',
    (await win.locator('#dc-grid .dc-th-dropped .dc-restore').count()) === 1);

  // ── Save ───────────────────────────────────────────────────────────────────
  await win.fill('#dc-name', 'Composed sales');
  await win.click('#dc-save', { timeout: 8000 });
  // `state: 'hidden'` — the default waits for VISIBLE, which a hidden element
  // never becomes, so the plain form would always time out.
  await win.waitForSelector('#ds-composer', { state: 'hidden', timeout: 20_000 });
  ok('saving closes the composer and returns to the list', true);

  await win.waitForTimeout(700);
  const names = await win.locator('#ds-saved-list .ds-saved-name').allTextContents();
  ok('the composed dataset is in the list', names.indexOf('Composed sales') >= 0, names.join(' | '));
  ok('…and so is the import it was built from, so the chain can refresh',
    names.some((n) => /Pasted data/i.test(n)), names.join(' | '));

  // The mapping must have landed as REAL prepare steps on the saved record.
  const saved: any = await app.evaluate(async (_electronModule, pid: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/datasets.js');
    const list = await datasets.listDatasets(pid);
    const summary = list.find((d: any) => d.name === 'Composed sales');
    if (!summary) return { missing: list.map((d: any) => d.name).join(',') };
    const ds = await datasets.getDataset(pid, summary.id);
    return {
      steps: (ds.steps || []).map((s: any) => s.type),
      columns: ds.columns.map((c: any) => c.name),
      origin: ds.origin && ds.origin.kind,
      joins: ds.origin && ds.origin.joins ? ds.origin.joins.length : 0,
      mode: ds.origin && ds.origin.joins && ds.origin.joins[0] && ds.origin.joins[0].mode,
    };
  }, seeded.projectId);

  ok('the saved dataset exists', Boolean(saved && saved.steps), saved && saved.missing ? 'saw: ' + saved.missing : '');
  ok('the field mapping landed as reversible prepare steps',
    Boolean(saved) && saved.steps.indexOf('rename_column') >= 0 && saved.steps.indexOf('drop_column') >= 0,
    saved ? saved.steps.join(',') : '');
  ok('the dropped column is gone from the derived table',
    Boolean(saved) && saved.columns.indexOf('id') < 0, saved ? saved.columns.join(',') : '');
  ok('the renamed column is there under its new name',
    Boolean(saved) && saved.columns.indexOf('zone_code') >= 0, saved ? saved.columns.join(',') : '');
  ok("its origin is a composed chain, so it can be refreshed",
    Boolean(saved) && saved.origin === 'composed' && saved.joins === 1, saved ? String(saved.origin) : '');
  ok("…recording the mode that was chosen, not the default",
    Boolean(saved) && saved.mode === 'left', saved ? String(saved.mode) : '');

  // ── Refresh the composed dataset end to end ────────────────────────────────
  const refreshed: any = await app.evaluate(async (_electronModule, pid: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/datasets.js');
    const { refreshDataset } = req('./src/datasetRefresh.js');
    const list = await datasets.listDatasets(pid);
    const summary = list.find((d: any) => d.name === 'Composed sales');
    const res = await refreshDataset(pid, summary.id);
    const after = await datasets.getDataset(pid, summary.id);
    return { ok: res.ok, error: res.error, columns: after.columns.map((c: any) => c.name), rows: after.rowCount };
  }, seeded.projectId);
  ok('a composed dataset refreshes by re-running the fold over its parents', refreshed.ok === true, refreshed.error || '');
  ok('…and the prepare pipeline survived the refresh',
    refreshed.columns.indexOf('zone_code') >= 0 && refreshed.columns.indexOf('id') < 0,
    refreshed.columns.join(','));

  // ── A missing parent must refuse, and leave the data alone ─────────────────
  const orphaned: any = await app.evaluate(async (_electronModule, arg: any) => {
    const pid = arg.pid; const lookupId = arg.lookupId;
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/datasets.js');
    const { refreshDataset } = req('./src/datasetRefresh.js');
    await datasets.deleteDataset(pid, lookupId);
    const list = await datasets.listDatasets(pid);
    const summary = list.find((d: any) => d.name === 'Composed sales');
    const res = await refreshDataset(pid, summary.id);
    const after = await datasets.getDataset(pid, summary.id);
    return { ok: res.ok, error: res.error || '', rows: after.rowCount, columns: after.columns.length };
  }, { pid: seeded.projectId, lookupId: seeded.lookupId });
  ok('deleting a parent makes the composed dataset refuse to refresh', orphaned.ok === false);
  ok('…with a reason that says what is missing', /missing/i.test(orphaned.error), orphaned.error);
  ok('…and the stored data is left exactly as it was',
    orphaned.rows === refreshed.rows && orphaned.columns === refreshed.columns.length,
    `${orphaned.rows} rows, ${orphaned.columns} cols`);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failures) {
      console.error(`${failures} composer smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All composer smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
