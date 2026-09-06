// End-to-end smoke test of EDITING an open dashboard — launches the REAL app.
//
// "add a line chart of revenue by month" with a dashboard open should change
// THAT dashboard, not draft a second one and not answer in prose. This drives
// the whole path for real: dkContextRef resolving the open dashboard →
// dkOfferProposal('edit') → analysis:editDelta → validateDelta → previewPlan →
// the diff card → Apply through the editor's own mutation functions → Undo.
//
// TWO stubs, both in the main process, both minimal:
//   execConfig.executionReady → true. The handler refuses without a model, and a
//     smoke run has none. Stubbing the PREDICATE (not the model) keeps this
//     deterministic on CI, where no CLI is installed.
//   analyze.dispatch → a canned ops JSON. Everything after it is shipped code:
//     validateDelta resolves the tile titles and drops what it cannot justify,
//     previewPlan computes the new tile's figures off the real Parquet.
//
// So every number on the card came from the app, and every op applied was one
// the validator agreed to — which is the property this feature turns on and
// which a unit test cannot show.
//
// The canned delta is deliberately part-invalid: one new tile, one retype of an
// existing tile BY TITLE, one tile that does not exist (must be DROPPED and the
// drop shown), and one chart type that does not exist (likewise).
//
// UNDO is the assertion that matters most. A sheets-only snapshot would pass a
// naive "the card is gone" check while silently leaving the retyped Visual as a
// line chart and orphaning the Visual the delta created — so this asserts the
// Visual RECORDS too, not just the card count.
//
// Separate script for the reason smoke-composer.ts and smoke-connect.ts are:
// smoke-dock.ts is at the 800-line cap in scripts/test-file-size.ts.
//
//   npm run smoke

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-edit-'));

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  win.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  // ── Fixture: a dashboard with one chart and one metric, both nameable ─────
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    await projects.init();
    const proj = await projects.createProject('Edit smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Sales',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'month', type: 'text' }, { name: 'amount', type: 'number' }],
      // North sums to 30, South to 20.
      rows: [['North', '2024-01', '10'], ['South', '2024-01', '20'], ['North', '2024-02', '20']],
    });
    const vis = await visuals.saveVisual(proj.id, {
      name: 'Amount by region', datasetId: ds.id, chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
      overrides: {}, filters: [],
    });
    const an = await analysis.saveAnalysis(proj.id, {
      name: 'Quarterly review',
      sheets: [{
        name: 'Overview',
        cards: [
          { type: 'visual', visualId: vis.id, layout: { x: 0, y: 0, w: 6, h: 6 } },
          {
            type: 'metric', layout: { x: 6, y: 0, w: 3, h: 2 },
            metric: { datasetId: ds.id, column: 'amount', aggregation: 'sum', label: 'Total amount' },
          },
        ],
      }],
    });
    return { projectId: proj.id, datasetId: ds.id, visualId: vis.id, analysisId: an.id };
  });

  // ── The two stubs ────────────────────────────────────────────────────────
  await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const execConfig = req('./src/app/execConfig.js');
    const analyze = req('./src/ai/analyze.js');
    execConfig.executionReady = () => true;
    (analyze as any)._realDispatch = analyze.dispatch;
    analyze.dispatch = async () => ({
      rawText: JSON.stringify({
        ops: [
          // Valid: a new tile. previewPlan computes its numbers for real.
          {
            op: 'addTile', page: 1, dataset: 'Sales', name: 'Amount by month', chartType: 'line',
            encoding: { category: 'month', values: [{ column: 'amount', aggregation: 'sum' }] },
          },
          // Valid: retype an EXISTING tile, named by its title.
          { op: 'replaceTileEncoding', tile: 'Amount by region', chartType: 'line' },
          // Invalid: no such tile — must be DROPPED and shown.
          { op: 'removeTile', tile: 'Profit by quarter' },
          // Invalid: not one of Ordinate's chart types — likewise.
          {
            op: 'addTile', page: 1, dataset: 'Sales', name: 'Impossible', chartType: 'hologram',
            encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
          },
        ],
      }),
    });
  });

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);
  // Enter the section first, exactly as every real caller does (the Dashboards
  // list click, and openRecentItem). dkContextRef is section-aware by design.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.analysisId);
  await win.waitForFunction(() => document.body.classList.contains('an-focus'), { timeout: 15_000 });

  // ── The dock now scopes to the open dashboard ────────────────────────────
  await win.evaluate(() => { (window as any).dkSetOpen(true); });
  await win.waitForTimeout(500);
  const ctxLine = (await win.locator('#dk-context').textContent()) || '';
  ok('with a dashboard open, the Assistant is scoped to IT, not the whole project',
    /dashboard · Quarterly review/.test(ctxLine), ctxLine);

  // ── Offer the edit, exactly as dkSend does with res.suggestedAction ──────
  await win.evaluate((aid: string) => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    return (window as any).dkOfferProposal(
      { kind: 'analysis', id: aid },
      'add a line chart of amount by month and make the region chart a line too',
      { kind: 'edit', intent: 'add a line chart of amount by month, region chart to a line' },
      'thread-1',
    );
  }, seeded.analysisId);
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 30_000 });

  ok('an instruction with a dashboard open produces an edit card, not a new draft',
    (await win.locator('#dk-messages .dk-proposal').count()) === 1);

  const lines = await win.locator('#dk-messages .dk-delta-row').allTextContents();
  ok('the card shows the change as a diff, one line per op', lines.length === 2, JSON.stringify(lines));
  ok('…naming the new tile and where it lands',
    lines.some((l) => /Amount by month/.test(l) && /line/.test(l)), JSON.stringify(lines));
  ok('…and the retype of the existing tile, resolved from its TITLE',
    lines.some((l) => /Amount by region/.test(l) && /line/.test(l)), JSON.stringify(lines));

  const droppedText = (await win.locator('#dk-messages .dk-proposal').textContent()) || '';
  ok('what the app refused is SHOWN, not hidden', /Profit by quarter/.test(droppedText));
  ok('…including the invented chart type', /hologram/.test(droppedText));

  ok('the new tile is previewed with a real chart, drawn from app-computed data',
    (await win.locator('#dk-messages .dk-proposal canvas').count()) > 0);

  // ── Apply ────────────────────────────────────────────────────────────────
  await win.locator('#dk-messages .dk-proposal').locator('button', { hasText: 'Apply' }).click();
  await win.waitForTimeout(1500); // the 600ms autosave, plus room

  const after: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const a = await analysis.getAnalysis(arg.projectId, arg.analysisId);
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    const list = await visuals.listVisuals(arg.projectId);
    return {
      cards: a.sheets[0].cards.length,
      types: a.sheets[0].cards.map((c: any) => c.type),
      retyped: v && v.chartType,
      visualCount: list.length,
      names: list.map((x: any) => x.name),
    };
  }, { projectId: seeded.projectId, analysisId: seeded.analysisId, visualId: seeded.visualId });

  ok('Apply adds the new tile to the dashboard on disk', after.cards === 3, JSON.stringify(after.types));
  ok('…retypes the existing tile it named by title', after.retyped === 'line', String(after.retyped));
  ok('…and creates the Visual record the new card points at',
    after.visualCount === 2 && after.names.indexOf('Amount by month') >= 0, JSON.stringify(after.names));

  ok('the card stays after Apply, offering the way back', (await win.locator('#dk-messages .dk-proposal').count()) === 1);
  ok('…and says what it did', /Applied 2 changes/.test((await win.locator('#dk-messages .dk-proposal').textContent()) || ''));

  // ── Undo ─────────────────────────────────────────────────────────────────
  await win.locator('#dk-messages .dk-proposal').locator('button', { hasText: 'Undo' }).click();
  await win.waitForTimeout(1500);

  const reverted: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const a = await analysis.getAnalysis(arg.projectId, arg.analysisId);
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    const list = await visuals.listVisuals(arg.projectId);
    return {
      cards: a.sheets[0].cards.length,
      retyped: v && v.chartType,
      visualCount: list.length,
      names: list.map((x: any) => x.name),
    };
  }, { projectId: seeded.projectId, analysisId: seeded.analysisId, visualId: seeded.visualId });

  ok('Undo takes the new tile back off the dashboard', reverted.cards === 2, String(reverted.cards));
  // The two a sheets-only snapshot would have missed.
  ok('…puts the retyped tile back to how it was (the encoding lives on the Visual)',
    reverted.retyped === 'bar', String(reverted.retyped));
  ok('…and deletes the Visual the delta created, rather than orphaning it',
    reverted.visualCount === 1 && reverted.names.indexOf('Amount by month') < 0, JSON.stringify(reverted.names));

  ok('the dashboard is left exactly as it started', reverted.cards === 2 && reverted.retyped === 'bar');

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} dashboard-edit smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All dashboard-edit smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
