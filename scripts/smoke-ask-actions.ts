// End-to-end smoke test of the ASK ACTIONS — launches the REAL app.
//
// Part B's headline: a chat answer that produced a chart can be turned into
// real, saved, editable work with one click. The proposal engine (dockPropose.ts)
// now mounts into Ask's transcript (#xp-messages) as well as the dock, and its
// chart card carries a "Turn into analysis" button that runs saveVisual +
// analysis:create and then NAVIGATES to the new record.
//
// A smoke run has no model, so the model-backed suggestion IPC can never draw a
// card on its own — exactly why the actions must be invisible without a model
// (covered in smoke-explore.ts). Here we drive dkRenderChartCard DIRECTLY with a
// fixture, the same technique smoke-dock.ts uses for the dock's own chart card,
// so the button's REAL wiring runs: saveVisual → analysis:create → openAnalysis.
// The assertion is the house style — assert the real analysis record was written
// to disk, holding the saved visual on one sheet, plus the navigation the user
// sees. Separate boot, not more lines in smoke-dock/smoke-explore, both of which
// are near the file-size cap (.claude/rules/file-size.md).
//
//   npm run smoke   (runs after smoke-dock.js)

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askact-'));

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

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

  // ── Seed a project + dataset ────────────────────────────────────────────
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis.js');
    await projects.init();
    await analysis.init();
    const proj = await projects.createProject('Ask actions smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Revenue by month',
      sourceKind: 'csv',
      columns: [{ name: 'month', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['Jan', 10], ['Feb', 20], ['Mar', 30]],
    });
    return { projectId: proj.id, datasetId: ds.id };
  });
  ok('seeded a project and a dataset', Boolean(seeded.projectId && seeded.datasetId));

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1000);
  // Land on Ask and flip it to transcript mode so #xp-messages is the visible,
  // laid-out scroll region the card mounts into (in hero mode it is collapsed,
  // which would leave the chart canvas at 0×0). A real answer bubble gives it
  // height and stands in for the answer the proposal would sit under.
  const enterAskTranscript = async (): Promise<void> => {
    await win.evaluate(() => { (window as any).selectSection('explore'); });
    await win.waitForTimeout(400);
    await win.evaluate(() => {
      (window as any).xpSetAsked(true);
      (window as any).xpAppendBubble('assistant', 'Amount rises across the three months.', undefined, 'xp-messages');
    });
  };
  await enterAskTranscript();

  const listAnalyses = (pid: string): Promise<any[]> => app.evaluate(async (_m, p: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/analysis.js').listAnalyses(p);
  }, pid);

  // ── The chart data is app-computed, never model text ────────────────────
  const chartData: any = await win.evaluate(async (args: any) =>
    (window as any).hub.computeVisualData(args.pid, args.did,
      { category: 'month', values: [{ column: 'amount', aggregation: 'sum' }] }, []),
  { pid: seeded.projectId, did: seeded.datasetId });
  ok('computeVisualData returned real chart data (app-computed, no model)',
    Boolean(chartData && chartData.data && Array.isArray(chartData.data.labels) && chartData.data.labels.length > 0),
    JSON.stringify(chartData));

  // ── The Ask chart card offers "Turn into analysis", and it works ────────
  const encoding = { category: 'month', values: [{ column: 'amount', aggregation: 'sum' }] };
  const analysisQ = 'Amount by month as an analysis';
  const analysesBefore = (await listAnalyses(seeded.projectId)).length;
  await win.evaluate((args: any) => {
    document.querySelectorAll('#xp-messages .dk-proposal').forEach((n) => n.remove());
    (window as any).dkRenderChartCard(args.did, args.question,
      { encoding: args.encoding, why: 'By month' }, args.data, 'bar', 'xp-messages');
  }, { did: seeded.datasetId, question: analysisQ, encoding, data: chartData.data });
  await win.waitForSelector('#xp-messages .dk-proposal .dk-proposal-chart canvas', { timeout: 8000 });
  ok('the engine mounts a chart card into Ask (#xp-messages), not only the dock',
    (await win.locator('#xp-messages .dk-proposal .dk-proposal-chart canvas').count()) > 0);
  const turnBtn = win.locator('#xp-messages .dk-proposal').last().locator('button', { hasText: 'Turn into analysis' });
  ok('the chart card offers "Turn into analysis" beside Save', (await turnBtn.count()) === 1);

  await turnBtn.click();
  // Success NAVIGATES to Analyses and opens the new record in focus mode
  // (openAnalysis → openAnalysisFrom → body.an-focus): the user SEES the result.
  await win.waitForFunction(() => document.querySelector('.hub-body')?.getAttribute('data-section') === 'analyses'
    && document.body.classList.contains('an-focus'), { timeout: 10_000 });
  ok('…clicking it navigates to Analyses and opens the new analysis (the user SEES it)', true);

  const after = await listAnalyses(seeded.projectId);
  const newAn = after.find((a: any) => a.name === analysisQ);
  ok('a NEW analysis, named from the QUESTION, was written to disk',
    after.length === analysesBefore + 1 && Boolean(newAn),
    `${analysesBefore} -> ${after.length}: ${after.map((a: any) => a.name).join(', ')}`);
  const full: any = newAn ? await app.evaluate(async (_m, args: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/analysis.js').getAnalysis(args.pid, args.id);
  }, { pid: seeded.projectId, id: newAn.id }) : null;
  const card0 = full && full.sheets && full.sheets[0] && full.sheets[0].cards ? full.sheets[0].cards[0] : null;
  ok('…holding exactly one sheet with the saved visual on it',
    Boolean(full) && full.sheets.length === 1 && full.sheets[0].cards.length === 1
      && card0.type === 'visual' && Boolean(card0.visualId), JSON.stringify(full && full.sheets));
  ok('…and the proposal card tore itself down after navigating (no leaked chart)',
    (await win.locator('#xp-messages .dk-proposal').count()) === 0);

  // ── Teardown runs on the Ask mount ──────────────────────────────────────
  // dkClearProposal takes a container now; Ask passes 'xp-messages'. A leaked
  // chart holds a live WebGL context (chartRender.ts) — draw one, clear the
  // mount, prove the card AND its canvas are gone (a bare .remove() would leave
  // the instance registered).
  await enterAskTranscript();
  await win.evaluate((args: any) => {
    document.querySelectorAll('#xp-messages .dk-proposal').forEach((n) => n.remove());
    (window as any).dkRenderChartCard(args.did, 'trend', { encoding: args.encoding }, args.data, 'bar', 'xp-messages');
  }, { did: seeded.datasetId, encoding, data: chartData.data });
  await win.waitForSelector('#xp-messages .dk-proposal .dk-proposal-chart canvas', { timeout: 8000 });
  await win.evaluate(() => (window as any).dkClearProposal('xp-messages'));
  ok('dkClearProposal on the Ask mount tears the card down (teardown ran, no leaked canvas)',
    (await win.locator('#xp-messages .dk-proposal').count()) === 0
      && (await win.locator('#xp-messages .dk-proposal-chart canvas').count()) === 0);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failures) {
      console.error(`${failures} ask-actions smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All ask-actions smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
