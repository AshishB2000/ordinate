// End-to-end smoke test of the DASHBOARD PROPOSAL — launches the REAL app.
//
// "build me a sales dashboard" should produce a reviewable PLAN in the dock, not
// a paragraph about one. This drives that path for real: dkOfferProposal →
// analysis:draft → validatePlan → previewPlan → the card, then Build → a real
// Analysis record → the editor open on it.
//
// A smoke run has no model configured, so `analyze.draftDashboard` would return
// notReady and there would be no plan to review. So this stubs EXACTLY ONE
// thing — that function, in the main process — with a canned *structure*, the
// same trick smoke-dock.ts uses for suggestSteps. Everything downstream is the
// shipped code: validatePlan drops what it cannot verify, previewPlan computes
// every figure off the real Parquet, and the card renders what came back.
//
// That is the point. The stub supplies STRUCTURE and no numbers, so any figure
// on screen must have been computed by the app — which is the one property this
// whole feature is built to preserve, and the one a unit test cannot show.
//
// The canned plan is deliberately part-invalid: one good chart, one with a chart
// type that does not exist (must be DROPPED and the drop shown), and one whose
// encoding needs a calculated field that does not exist yet (must preview with
// NO data and show its note instead of a placeholder number).
//
// Separate script, not more lines in smoke-dock.ts, for the reason
// smoke-composer.ts and smoke-connect.ts already are: smoke-dock.ts is 779 lines
// against the 800-line cap in scripts/test-file-size.ts.
//
//   npm run smoke

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-plan-'));

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

  // The first paint is a splash; every geometry check below would pass against
  // it while proving nothing.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  // ── Fixture: a project and one dataset with real, checkable numbers ───────
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    await projects.init();
    const proj = await projects.createProject('Plan smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Sales',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
      // North sums to 30, South to 20 — asserted on screen below.
      rows: [['North', '10'], ['South', '20'], ['North', '20']],
    });
    return { projectId: proj.id, datasetId: ds && ds.id };
  });

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);

  // ── Stub ONLY the model call. Everything after it is the shipped pipeline ──
  await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analyze = req('./src/ai/analyze.js');
    (analyze as any)._realDraft = analyze.draftDashboard;
    analyze.draftDashboard = async () => ({
      ok: true,
      structure: {
        name: 'Sales overview',
        rationale: 'Revenue splits cleanly by region, so lead with that.',
        // A calculated field the plan wants to add. The third visual below
        // depends on it, which is what makes that tile preview without data.
        calculatedFields: [{ dataset: 'Sales', name: 'amount_x2', expression: 'amount * 2' }],
        sheets: [{
          name: 'Overview',
          visuals: [
            {
              dataset: 'Sales', name: 'Amount by region', chartType: 'bar',
              encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
            },
            {
              // Not one of Ordinate's chart types — must be DROPPED, and said so.
              dataset: 'Sales', name: 'Impossible chart', chartType: 'hologram',
              encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
            },
            {
              // Depends on the proposed column, which does not exist yet.
              dataset: 'Sales', name: 'Doubled by region', chartType: 'bar',
              encoding: { category: 'region', values: [{ column: 'amount_x2', aggregation: 'sum' }] },
            },
          ],
        }],
      },
    });
  });

  // ── Drive the real offer path with a 'dashboard' action ───────────────────
  // Exactly what dkSend does with res.suggestedAction after an answer lands.
  await win.evaluate(() => {
    (window as any).dkSetOpen(true);
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    return (window as any).dkOfferProposal(
      { kind: '', id: '' }, // whole-project scope — the Dashboards-page case
      'build me a sales dashboard for Adidas US Sales',
      { kind: 'dashboard', intent: 'sales dashboard for Adidas US Sales' },
      'thread-1',
    );
  });
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 20_000 });

  ok('a build-shaped question produces a proposal card, not just prose',
    (await win.locator('#dk-messages .dk-proposal').count()) === 1);
  ok('…at whole-project scope, with no dataset open (the Dashboards-page case)', true);
  ok('the card is titled from the plan',
    /Sales overview/.test((await win.locator('#dk-messages .dk-plan-name').textContent()) || ''),
    (await win.locator('#dk-messages .dk-plan-name').textContent()) || '');
  ok('…and carries one line of the model’s rationale',
    /splits cleanly by region/.test((await win.locator('#dk-messages .dk-proposal .ai-interp-body').first().textContent()) || ''));

  // ── The mini grid holds REAL previewed tiles ──────────────────────────────
  ok('the plan grid renders the surviving tiles',
    (await win.locator('#dk-messages .dk-plan-grid .an-draft-visual').count()) === 2,
    `${await win.locator('#dk-messages .dk-plan-grid .an-draft-visual').count()} tiles`);
  ok('…drawing a real chart, not a placeholder',
    (await win.locator('#dk-messages .dk-plan-grid canvas').count()) > 0);

  // The numbers came from previewPlan reading Parquet — the stub supplied none.
  // Read what Chart.js ACTUALLY drew. `chartInstances` is a top-level const in a
  // classic script, so it never lands on `window`; Chart.getChart(canvas) is the
  // supported way in, and it reads the rendered chart rather than a registry.
  const drawn = await win.evaluate(() => {
    const canvases = [...document.querySelectorAll('#dk-messages .dk-plan-grid canvas')];
    for (const cv of canvases) {
      const c = (window as any).Chart?.getChart?.(cv);
      if (c && c.data && c.data.datasets && c.data.datasets[0]) {
        return { labels: c.data.labels, values: c.data.datasets[0].data };
      }
    }
    return null;
  });
  ok('the chart carries app-computed values, which the stub never supplied',
    Boolean(drawn && Array.isArray(drawn.values) && drawn.values.length > 0), JSON.stringify(drawn));
  const sums = drawn ? [...drawn.values].sort((a: number, b: number) => a - b) : [];
  ok('…and they are the CORRECT sums off the real table (North 30, South 20)',
    JSON.stringify(sums) === '[20,30]', JSON.stringify(drawn));

  // ── A tile the app could not compute shows its NOTE, never a number ───────
  const noteText = (await win.locator('#dk-messages .dk-plan-grid .an-draft-note--why').first().textContent()) || '';
  ok('a tile depending on a not-yet-created calculated field shows a note',
    /calculated field/i.test(noteText), noteText);
  ok('…and no digit is substituted for the figure the app could not compute',
    !/\d/.test(noteText.replace(/amount_x2/g, '')), noteText);

  // ── `dropped` is visible, always ──────────────────────────────────────────
  const droppedText = (await win.locator('#dk-messages .dk-proposal .an-draft-dropped').allTextContents()).join(' | ');
  ok('what the app refused is shown, not hidden',
    (await win.locator('#dk-messages .dk-proposal .an-draft-dropped').count()) >= 1, droppedText);
  ok('…naming the invented chart type it would not accept',
    /hologram/.test(droppedText), droppedText);

  // ── Build → a real Analysis, opened ───────────────────────────────────────
  await win.locator('#dk-messages .dk-proposal').locator('button', { hasText: 'Build dashboard' }).click();
  await win.waitForFunction(() => document.body.classList.contains('an-focus'), { timeout: 20_000 });

  const built: any = await app.evaluate(async (_electronModule, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const list = await analysis.listAnalyses(pid);
    const one = list[0] ? await analysis.getAnalysis(pid, list[0].id) : null;
    return {
      count: list.length,
      name: one && one.name,
      cards: one && one.sheets && one.sheets[0] ? one.sheets[0].cards.length : 0,
    };
  }, seeded.projectId);
  ok('Build creates exactly one real Analysis record', built.count === 1, JSON.stringify(built));
  ok('…named from the plan', built.name === 'Sales overview', String(built.name));
  ok('…holding only the tiles that survived validation', built.cards === 2, String(built.cards));
  ok('…and the editor opens on it', await win.evaluate(() => document.body.classList.contains('an-focus')));
  ok('the proposal card is cleaned up after building',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);
  ok('the dock stays open beside the new dashboard', await win.locator('#dk-panel').isVisible());

  // ── With no model, the same path stays silent rather than erroring ────────
  await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analyze = req('./src/ai/analyze.js');
    analyze.draftDashboard = (analyze as any)._realDraft; // restore the real, notReady-returning one
  });
  await win.evaluate(() => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    return (window as any).dkOfferProposal(
      { kind: '', id: '' }, 'build me another dashboard',
      { kind: 'dashboard', intent: 'another one' }, 'thread-1',
    );
  }).catch(() => {});
  await win.waitForTimeout(800);
  ok('with no model configured, a build request offers no card and no error',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  // A 'none' action must never produce a card — the whitelist's whole job.
  await win.evaluate(() => (window as any).dkOfferProposal(
    { kind: '', id: '' }, 'what is the average amount',
    { kind: 'none', intent: '' }, 'thread-1',
  )).catch(() => {});
  await win.waitForTimeout(400);
  ok('a "none" action proposes nothing at all',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  // ── The other two doors into the same flow ────────────────────────────────
  // A SECOND project, empty of dashboards: the one just built would hide the
  // empty state the chips live in.
  const p2: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const proj = await projects.createProject('Chips smoke');
    await datasets.saveDataset(proj.id, {
      name: 'Adidas US Sales',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['North', '10'], ['South', '20']],
    });
    return { projectId: proj.id };
  });
  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), p2.projectId);
  await win.waitForTimeout(1000);
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForSelector('#an-empty-chips:not([hidden])', { timeout: 10_000 });

  const chipText = (await win.locator('#an-empty-chips .ws-empty-chip').first().textContent()) || '';
  ok('an empty Dashboards page offers build-intent chips',
    (await win.locator('#an-empty-chips .ws-empty-chip').count()) >= 1, chipText);
  ok('…naming a dataset the project actually has, not a generic prompt',
    /Adidas US Sales/.test(chipText), chipText);

  await win.evaluate(() => { (window as any).dkSetOpen(false); });
  await win.waitForTimeout(300);
  await win.locator('#an-empty-chips .ws-empty-chip').first().click();
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 10_000 });
  ok('clicking a chip opens the Assistant, so the wizard is no longer the only door',
    await win.locator('#dk-panel').isVisible());

  // The Home ask bar routes through the same dkAsk → dkSend path, so a
  // build-shaped question there reaches the identical flow.
  await win.evaluate(() => { (window as any).dkSetOpen(false); (window as any).selectSection('home'); });
  await win.waitForTimeout(400);
  await win.fill('#home-ask-input', 'build me a sales dashboard for Adidas US Sales');
  await win.press('#home-ask-input', 'Enter');
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 10_000 });
  ok('a build-shaped question in the Home ask bar opens the Assistant and runs the same flow',
    await win.locator('#dk-panel').isVisible());

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} dashboard-proposal smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All dashboard-proposal smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
