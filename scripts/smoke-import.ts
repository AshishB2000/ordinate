// End-to-end smoke test of the MULTI-SHEET WORKBOOK IMPORT — launches the REAL app.
//
// This is the one import path no other smoke file could reach. smoke-composer.ts
// says so in its own header: "a file import opens a NATIVE dialog that Playwright
// cannot answer", so it drives paste instead. Paste reaches the same hand-off
// but skips the sheet chooser entirely — which is how the chooser shipped with
// no way to confirm the sheet it was already showing. The dialog opened on sheet
// 1, the only wired control was the dropdown's `change`, and a user who wanted
// the first sheet (the common case) had nothing to click but ✕.
//
// So this file answers the native dialog rather than avoiding it: `showOpenDialog`
// is stubbed IN MAIN to return a workbook written here, and everything after that
// is the shipped code path — the real IPC handler, the real xlsx parser, the real
// dialog, the real composer, the real save.
//
//   npm run smoke   (via scripts/run-smokes.ts)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-import-'));

// Two sheets that differ in BOTH their column names and their row counts, so
// "the preview changed" cannot pass on a repaint of the same table.
const SHEETS = {
  Summary: {
    header: ['region', 'total'],
    rows: [['North', 10], ['South', 20], ['East', 30]],
  },
  Detail: {
    header: ['sku', 'qty', 'price'],
    // '007' is here on purpose: the sniffer must leave a leading zero alone, and
    // a workbook is the one source that could hand it over as a number.
    rows: [['007', 1, 9.5], ['A12', 2, 4], ['B33', 3, 7.25], ['C44', 4, 1.5], ['D55', 5, 6]],
  },
};

/** Write the fixture workbook with the exceljs the app already depends on. */
async function writeWorkbook(file: string): Promise<void> {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const [name, spec] of Object.entries(SHEETS)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(spec.header);
    for (const r of spec.rows) ws.addRow(r);
  }
  await wb.xlsx.writeFile(file);
}

async function main(): Promise<void> {
  const xlsxPath = path.join(userData, 'quarterly.xlsx');
  await writeWorkbook(xlsxPath);
  ok('wrote a two-sheet fixture workbook', fs.existsSync(xlsxPath));

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

  // Seed a project, and STUB the native file picker. The stub replaces one method
  // on electron's own `dialog` object — the same object the IPC handler closed
  // over at import time — so `dataset:pickAndParse` runs exactly as shipped,
  // including the `pickedPaths` whitelist a sheet re-parse has to satisfy.
  const seeded: any = await app.evaluate(async (electronModule, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    await projects.init();
    const proj = await projects.createProject('Import smoke');
    // One dataset so the Data section is in its LIST state: the empty state
    // swaps the header's "+ Import file" out for its own copy, and the header
    // button is the entry point this walk is about.
    await datasets.saveDataset(proj.id, {
      name: 'Existing', sourceKind: 'csv',
      columns: [{ name: 'city', type: 'text' }], rows: [['Oslo']],
    });
    (electronModule as any).dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [arg.file] });
    return { projectId: proj.id };
  }, { file: xlsxPath });
  ok('seeded a project and stubbed the native file picker', Boolean(seeded.projectId));

  await win.waitForSelector('#splash[hidden]', { timeout: 30_000 }).catch(() => {});
  // The seeding above is cheap (one empty project), so this file reaches the
  // renderer earlier than the files that save a dataset first — early enough
  // that the hub scripts have not finished defining their globals.
  await win.waitForFunction(() => typeof (window as any).openWorkspace === 'function', null, { timeout: 30_000 });
  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1500);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1500);

  // ── Import file → the sheet chooser ────────────────────────────────────────
  await win.click('#ds-import-open', { timeout: 8000 });
  await win.waitForSelector('#ds-import-modal:not([hidden])', { timeout: 15_000 });
  ok('importing a multi-sheet workbook stops at the chooser instead of guessing',
    await win.locator('#ds-sheet-wrap').isVisible());

  const options = await win.locator('#ds-sheet-select option').allTextContents();
  ok('the chooser lists every sheet in the workbook',
    options.join('|') === 'Summary|Detail', options.join('|'));

  ok('the title names the workbook, not just the task',
    /Choose a sheet · quarterly\.xlsx/.test((await win.locator('#ds-import-title').textContent()) || ''),
    (await win.locator('#ds-import-title').textContent()) || '');

  // THE BUG: there was no such button, and the dialog's only other exit was ✕.
  ok('a "Use this sheet" confirm is on screen',
    await win.locator('#ds-sheet-use').isVisible());
  ok('…labelled so it says what it does',
    ((await win.locator('#ds-sheet-use').textContent()) || '').trim() === 'Use this sheet');
  ok('…and the Save-dataset bar is NOT, because saving is the composer\'s job',
    await win.locator('#ds-save-bar').isHidden());

  // The first sheet is previewed while the dialog waits — nothing is skipped.
  let heads = await win.locator('#ds-table-scroll .ds-th-name').allTextContents();
  ok('the first sheet is previewed under the picker',
    heads.join(',') === 'region,total', heads.join(','));
  ok('…with its size stated above it, so the sheets can be told apart',
    /3 rows × 2 columns/.test((await win.locator('#ds-preview-note').textContent()) || ''),
    (await win.locator('#ds-preview-note').textContent()) || '');

  // ── Changing the sheet RE-PREVIEWS, and only that ──────────────────────────
  await win.selectOption('#ds-sheet-select', 'Detail');
  await win.waitForTimeout(2500); // a real re-parse of the workbook in main

  heads = await win.locator('#ds-table-scroll .ds-th-name').allTextContents();
  ok('picking another sheet re-previews that sheet',
    heads.join(',') === 'sku,qty,price', heads.join(','));
  ok('…and its size line follows it',
    /5 rows × 3 columns/.test((await win.locator('#ds-preview-note').textContent()) || ''),
    (await win.locator('#ds-preview-note').textContent()) || '');
  ok('…leaving the dialog OPEN — a dropdown must not teleport you onward',
    await win.locator('#ds-import-modal').isVisible());
  ok('…with the picker still showing the sheet that was chosen',
    (await win.locator('#ds-sheet-select').inputValue()) === 'Detail',
    await win.locator('#ds-sheet-select').inputValue());

  // ── "Use this sheet" is the one control that leaves ────────────────────────
  await win.click('#ds-sheet-use', { timeout: 8000 });
  await win.waitForSelector('#ds-composer:not([hidden])', { timeout: 20_000 });
  ok('Use this sheet opens the composer and closes the dialog',
    await win.locator('#ds-import-modal').isHidden());

  await win.waitForTimeout(1500); // the first composer preview is a debounced IPC round-trip
  const dcHeads = await win.locator('#dc-grid .dc-th .dc-th-name').allTextContents();
  ok('the composer opens on the CHOSEN sheet\'s columns',
    dcHeads.join(',') === 'sku,qty,price', dcHeads.join(','));
  ok('…and its row/column count is the chosen sheet\'s',
    /5 rows · 3 columns/.test((await win.locator('#dc-count').textContent()) || ''),
    (await win.locator('#dc-count').textContent()) || '');
  ok('the source line names the sheet, so the choice is visible after the hand-off',
    /Detail/.test((await win.locator('#dc-src-import .dc-src-meta').textContent()) || ''),
    (await win.locator('#dc-src-import .dc-src-meta').textContent()) || '');
  ok('a leading zero survived the workbook parse as text',
    (await win.locator('#dc-grid tbody tr:first-child td').allTextContents()).indexOf('007') >= 0,
    (await win.locator('#dc-grid tbody tr:first-child td').allTextContents()).join(','));

  // ── Save, and check what landed on disk ───────────────────────────────────
  await win.fill('#dc-name', 'Quarterly detail');
  await win.click('#dc-save', { timeout: 8000 });
  await win.waitForSelector('#ds-composer', { state: 'hidden', timeout: 20_000 });
  await win.waitForTimeout(700);

  const saved: any = await app.evaluate(async (_electronModule, pid: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const list = await datasets.listDatasets(pid);
    const rec = list.find((d: any) => d.name === 'Quarterly detail');
    if (!rec) return { missing: list.map((d: any) => d.name).join(',') };
    const ds = await datasets.getDataset(pid, rec.id);
    return {
      rowCount: ds.rowCount,
      columns: ds.columns.map((c: any) => c.name),
      sourceKind: ds.sourceKind,
      originKind: ds.origin && ds.origin.kind,
      sheetName: ds.origin && ds.origin.sheetName,
    };
  }, seeded.projectId);

  ok('the dataset is on disk', Boolean(saved && saved.rowCount != null),
    saved && saved.missing ? 'saw: ' + saved.missing : '');
  ok('…with the chosen sheet\'s row count, not the first sheet\'s',
    saved.rowCount === 5, String(saved.rowCount));
  ok('…and the chosen sheet\'s columns',
    (saved.columns || []).join(',') === 'sku,qty,price', (saved.columns || []).join(','));
  ok('…recorded as a file origin so it can be refreshed',
    saved.originKind === 'file', String(saved.originKind));
  // The point of item 2: a refresh re-reads the SAME sheet. Without this name on
  // the record, datasetRefresh.parseFile falls back to worksheet 1 and silently
  // replaces the Detail table with Summary.
  ok('…naming the sheet, so a refresh re-reads THAT sheet',
    saved.sheetName === 'Detail', String(saved.sheetName));

  // ── Refresh proves the stored sheet name is actually used ──────────────────
  const refreshed: any = await app.evaluate(async (_electronModule, pid: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const { refreshDataset } = req('./src/data/datasetRefresh.js');
    const list = await datasets.listDatasets(pid);
    const rec = list.find((d: any) => d.name === 'Quarterly detail');
    const res = await refreshDataset(pid, rec.id);
    const after = await datasets.getDataset(pid, rec.id);
    return { ok: res.ok, error: res.error || '', rowCount: after.rowCount, columns: after.columns.map((c: any) => c.name) };
  }, seeded.projectId);

  ok('refreshing a workbook-backed dataset succeeds', refreshed.ok === true, refreshed.error);
  ok('…and re-reads the same sheet rather than falling back to sheet 1',
    refreshed.rowCount === 5 && refreshed.columns.join(',') === 'sku,qty,price',
    `${refreshed.rowCount} rows: ${refreshed.columns.join(',')}`);

  await win.screenshot({ path: path.join(process.env.SMOKE_ARTIFACT_DIR || userData, 'import-composer.png') })
    .catch(() => { /* artifacts are a convenience */ });

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} import smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All import smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
