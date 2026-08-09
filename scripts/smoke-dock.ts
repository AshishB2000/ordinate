// End-to-end smoke test of the AI DOCK — launches the REAL app.
//
// Task 3's only test (test-dockReversibility.ts) is a pure-layer check that
// applyPipeline's append/remove math is reversible — it never touches
// dkRenderStepCard's actual DOM/IPC wiring (openSavedDataset → dxSelectTab →
// applyStepResult), the calc-field editor prefill, or the chart draw. Every
// one of those cross-file calls is `typeof x === 'function'`-guarded, so a
// rename anywhere along that chain breaks the Apply button SILENTLY — no
// build error, no lint error, no test failure. This file is that coverage.
//
// A smoke run has no model configured, so the AI-backed suggestion IPCs
// (dataset:suggestSteps, dataset:suggestCalcField, visual:suggest) all return
// `notReady` — there is no way to drive the real heuristic-into-suggestion
// path with a genuine model answer here. Two levels of real coverage instead:
//
//  1. The HANDOFF: dkOfferProposal() → dkOfferStepProposal() →
//     window.hub.suggestDatasetSteps() → dkRenderStepCard() — stubbing ONLY
//     the suggestion IPC (no model needed to answer with a canned response)
//     so the actual call chain between "the answer came back" and "a card
//     renders" runs for real. A rename anywhere in that chain fails this.
//  2. dkRenderStepCard / dkRenderCalcFieldCard / dkRenderChartCard called
//     DIRECTLY with a fixture proposal — real coverage of "render the card,
//     then Apply does the real thing": the pipeline gains exactly one step
//     (not a replace), the calc-field editor opens prefilled, and a chart
//     proposal's "Save as visual" creates a real visual record.
//
// It also exercises the actual notReady path once, for real, with no model
// configured — proving dkOfferProposal stays silent rather than erroring.
//
// This does NOT cover: the heuristic that decides which of the three types to
// offer (dkDecideProposalType — plain regex, no IPC, not worth an Electron
// boot), or "Add to dashboard" (requires a dashboard page already open; "Save
// as visual" is the assertion the plan calls "the regression guard for the
// plan's most dangerous failure mode" and is covered in full).
//
// Separate script, not more lines in smoke-app.ts, for the reason
// smoke-explore.ts/smoke-composer.ts already are: smoke-app.ts is allowlisted
// in scripts/test-file-size.ts and that ratchet only tightens.
//
//   npm run smoke   (runs this last)

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dock-'));

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

  // ── Seed a project + dataset with a REAL two-step pipeline already on it ──
  // (2, not 0 — a replace-the-whole-array bug and an append-one-step fix look
  // IDENTICAL at 0→1. 2→3 is the smallest case that tells them apart, and
  // it's the exact case the plan calls out.)
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/projects.js');
    const datasets = req('./src/datasets.js');
    await projects.init();
    const proj = await projects.createProject('Dock smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Regional sales',
      sourceKind: 'csv',
      columns: [
        { name: 'region', type: 'text' },
        { name: 'amount', type: 'number' },
        { name: 'note', type: 'text' },
      ],
      rows: [
        ['North', 10, 'x'],
        ['South', 20, 'y'],
        ['North', 30, 'z'],
      ],
    });
    const seedSteps = [
      { type: 'rename_column', from: 'amount', to: 'revenue' },
      { type: 'filter', column: 'revenue', op: '>', value: 0 },
    ];
    await datasets.updateSteps(proj.id, ds.id, seedSteps);
    return { projectId: proj.id, datasetId: ds.id };
  });
  ok('seeded a project and a dataset with a real 2-step pipeline', Boolean(seeded.projectId && seeded.datasetId));

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);

  // ── Toggle from the sidebar entry ───────────────────────────────────────
  ok('the toggle starts collapsed (aria-expanded=false)',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'false');

  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  ok('clicking the sidebar button opens the dock', await win.locator('#dk-panel').isVisible());
  ok('…and marks the toggle aria-expanded=true',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'true');
  ok('the panel has an aria-label', Boolean((await win.getAttribute('#dk-panel', 'aria-label') || '').length));
  // No model is configured in a smoke run, so #dk-input starts disabled (the
  // HTML spec refuses focus() on a disabled control) — dock.ts's fallback is
  // to focus the panel itself (tabindex="-1") so keyboard focus lands INSIDE
  // the dock either way, rather than proving nothing by asserting the input
  // specifically only reachable with a model configured.
  ok('opening focuses inside the panel (the input if enabled, else the panel itself)',
    await win.evaluate(() => {
      const a = document.activeElement;
      const panel = document.getElementById('dk-panel');
      return Boolean(a && panel && (a.id === 'dk-input' || a === panel));
    }));

  // ── ⌘L closes it too (the second entry point) ───────────────────────────
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('Cmd/Ctrl+L closes the dock', await win.locator('#dk-panel').isHidden());
  ok('…and clears aria-expanded', (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'false');

  // ── Esc closes and returns focus to the toggle ──────────────────────────
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  await win.keyboard.press('Escape');
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('Escape closes the dock', await win.locator('#dk-panel').isHidden());
  ok('…and returns focus to the toggle',
    await win.evaluate(() => Boolean(document.activeElement && document.activeElement.id === 'side-ai-btn')));

  // ── The resize handle: drag, persist-on-end, min clamp, keyboard ────────
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });

  ok('the handle is a focusable, labelled separator',
    await win.evaluate(() => {
      const h = document.getElementById('dk-handle');
      return Boolean(h && h.getAttribute('role') === 'separator' && h.tabIndex === 0
        && (h.getAttribute('aria-label') || '').length > 0);
    }));

  const before = await win.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-width'), 10));
  const box = (await win.locator('#dk-handle').boundingBox())!;
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 }); // left = wider
  const midDrag = await win.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-width'), 10));
  ok('dragging left widens the panel live', midDrag > before, `${before} -> ${midDrag}`);
  const midDragStored = await win.evaluate(() => localStorage.getItem('dkWidth'));
  ok('localStorage is NOT written mid-drag, only at drag end', midDragStored === null, `mid=${midDragStored}`);
  await win.mouse.up();
  await win.waitForTimeout(150);
  const afterDrag = await win.evaluate(() => localStorage.getItem('dkWidth'));
  ok('drag end persists the (clamped) width to localStorage', Number(afterDrag) === midDrag, `stored=${afterDrag} live=${midDrag}`);

  // Keyboard resize: focus the handle, arrow keys move it, settle persists.
  await win.locator('#dk-handle').focus();
  const beforeKey = await win.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-width'), 10));
  await win.keyboard.press('ArrowLeft');
  await win.keyboard.press('ArrowLeft');
  const liveKey = await win.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-width'), 10));
  ok('ArrowLeft on the focused handle widens the panel', liveKey > beforeKey, `${beforeKey} -> ${liveKey}`);
  await win.waitForTimeout(500); // settle timer (300ms)
  const settledKey = await win.evaluate(() => localStorage.getItem('dkWidth'));
  ok('the keyboard resize settles and persists', Number(settledKey) === liveKey, `stored=${settledKey} live=${liveKey}`);

  // Try to shove it under the 300px minimum with a big rightward drag.
  const box2 = (await win.locator('#dk-handle').boundingBox())!;
  await win.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await win.mouse.down();
  await win.mouse.move(box2.x + 2000, box2.y + box2.height / 2, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(150);
  const clamped = await win.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-width'), 10));
  ok('the width never drops below the 300px minimum', clamped >= 300, `${clamped}px`);

  // The min-vs-max clamp fix itself (Task 1 review item): on a narrow window
  // (40% < 300px), the minimum must win, not the arithmetic max().
  const clampCheck = await win.evaluate(() => {
    const real = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
      return (window as any).dkClampWidth(1000);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: real, configurable: true });
    }
  });
  ok('on a narrow window, the 300px minimum wins over 40%', clampCheck === 300, `got ${clampCheck}`);

  // ── notReady stays silent — driven for REAL, no model configured ────────
  await win.evaluate((args: any) => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    return (window as any).dkOfferProposal(
      { kind: 'dataset', id: args.datasetId },
      'why are there blank rows',
      '412 rows have a blank region',
    );
  }, seeded).catch(() => {});
  await win.waitForTimeout(500);
  ok('with no model configured, a real suggest call offers no card (silent notReady)',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  // ── The offer→render HANDOFF itself ──────────────────────────────────────
  // The three blocks below drive dkRenderStepCard/dkRenderCalcFieldCard/
  // dkRenderChartCard DIRECTLY with a fixture — real coverage of "render the
  // card, then Apply does the real thing", but NOT of the call from
  // dkOfferProposal() INTO those functions (dkOfferProposal →
  // dkOfferStepProposal → window.hub.suggestDatasetSteps → the REAL
  // dataset:suggestSteps IPC → dkRenderStepCard). A rename or signature
  // change anywhere in that handoff would slip past the direct-call tests
  // below undetected.
  //
  // `window.hub.suggestDatasetSteps` itself can't be stubbed from here —
  // contextBridge exposes it non-writable/non-configurable by design (a
  // renderer-side security property, confirmed via
  // Object.getOwnPropertyDescriptor; a plain assignment fails silently, no
  // throw). So the stub goes at the ACTUAL boundary that needs a model: the
  // `dataset:suggestSteps` IPC handler (src/ipc/datasets.ts) calls
  // `analyze.suggestSteps(summaryText)` — reassign THAT function in the main
  // process (same module-cache singleton `require('../analyze')` resolves
  // to), then trigger the real IPC round trip from the renderer with no
  // fakery on the renderer side at all: preload → ipcMain.handle → the
  // stubbed model call → sanitizeSteps → back to dkOfferStepProposal →
  // dkRenderStepCard.
  await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analyze = req('./src/analyze.js');
    (analyze as any)._realSuggestSteps = analyze.suggestSteps;
    analyze.suggestSteps = async () => ({ ok: true, steps: [{ type: 'trim', column: 'region' }] });
  });
  const handoff = await win.evaluate((args: any) => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    return Promise.resolve((window as any).dkOfferProposal(
      { kind: 'dataset', id: args.datasetId },
      'why are there blank rows',
      '412 rows have a blank region',
    )).then(() => ({
      cards: document.querySelectorAll('#dk-messages .dk-proposal').length,
      summary: (document.querySelector('#dk-messages .dk-proposal .ai-interp-body') || {}).textContent || '',
    }));
  }, seeded);
  await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analyze = req('./src/analyze.js');
    analyze.suggestSteps = (analyze as any)._realSuggestSteps; // restore before the next test needs the real thing
  });
  ok('dkOfferProposal → the real dataset:suggestSteps IPC → dkRenderStepCard renders a card (the offer→render handoff)',
    handoff.cards === 1, `${handoff.cards} cards`);
  ok('…summarising the STUBBED suggestion, proving the render used what the IPC actually returned',
    /trim/i.test(handoff.summary), handoff.summary);
  await win.evaluate(() => document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove()));

  // ── 1. Prepare-step proposal: Apply APPENDS, never replaces ─────────────
  const proposedStep = { type: 'drop_column', column: 'note' };
  await win.evaluate((args: any) => {
    (window as any).dkRenderStepCard(args.datasetId, args.step);
  }, { datasetId: seeded.datasetId, step: proposedStep });
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 8000 });
  ok('the step card renders a plain-English summary',
    ((await win.locator('#dk-messages .dk-proposal .ai-interp-body').last().textContent()) || '').length > 0);

  await win.locator('#dk-messages .dk-proposal').last().locator('button', { hasText: 'Apply' }).click();
  await win.waitForSelector('#dk-messages .dk-proposal .ai-interp-hint', { timeout: 10_000 });
  ok('after Apply, the card shows the "Added as step N" confirmation',
    /Added as step 3/.test((await win.locator('#dk-messages .dk-proposal .ai-interp-hint').last().textContent()) || ''));

  const afterStep: any = await app.evaluate(async (_electronModule, args: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/datasets.js');
    const ds = await datasets.getDataset(args.pid, args.did);
    return { steps: ds.steps, columns: ds.columns.map((c: any) => c.name) };
  }, { pid: seeded.projectId, did: seeded.datasetId });
  const steps: any[] = Array.isArray(afterStep.steps) ? afterStep.steps : [];
  ok('the pipeline grew by exactly ONE step (append, not replace)', steps.length === 3,
    `${steps.length} steps: ${JSON.stringify(steps)}`);
  ok('…the two original steps are untouched, in order',
    Boolean(steps[0] && steps[1] && steps[0].type === 'rename_column' && steps[1].type === 'filter'));
  ok('…and the proposed step landed third, exactly as proposed',
    Boolean(steps[2] && steps[2].type === 'drop_column' && steps[2].column === 'note'));
  ok('…so the dropped column is gone from the derived table',
    afterStep.columns.indexOf('note') < 0, afterStep.columns.join(','));

  // ── 2. Calc-field proposal: Apply opens the editor prefilled, doesn't apply ─
  await win.evaluate((args: any) => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    (window as any).dkRenderCalcFieldCard(args.datasetId, args.res);
  }, { datasetId: seeded.datasetId, res: { name: 'Margin pct', expression: 'revenue / 100', warning: null } });
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 8000 });

  await win.locator('#dk-messages .dk-proposal').last().locator('button', { hasText: 'Apply' }).click();
  await win.waitForSelector('#ds-step-editor .ds-step-input', { timeout: 10_000 });
  const editorVals = await win.evaluate(() => {
    const inputs = document.querySelectorAll('#ds-step-editor .ds-step-input');
    return [(inputs[0] as HTMLInputElement)?.value, (inputs[1] as HTMLInputElement)?.value];
  });
  ok('Apply opens the step editor prefilled with the suggested name',
    editorVals[0] === 'Margin pct', JSON.stringify(editorVals));
  ok('…and the suggested expression — nothing is applied without a click',
    editorVals[1] === 'revenue / 100', JSON.stringify(editorVals));
  ok('the dataset pipeline is UNCHANGED by opening the editor (still 3 steps)',
    (await app.evaluate(async (_electronModule, args: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const datasets = req('./src/datasets.js');
      const ds = await datasets.getDataset(args.pid, args.did);
      return ds.steps.length;
    }, { pid: seeded.projectId, did: seeded.datasetId })) === 3);
  ok('the proposal card hands off to the editor and removes itself',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  // ── 3. Chart proposal: real computeVisualData, real Save-as-visual ──────
  const chartData: any = await win.evaluate(async (args: any) => {
    return (window as any).hub.computeVisualData(
      args.pid, args.did,
      { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
      [],
    );
  }, { pid: seeded.projectId, did: seeded.datasetId });
  ok('computeVisualData (app-computed, no model) returned real chart data',
    Boolean(chartData && chartData.data && Array.isArray(chartData.data.labels) && chartData.data.labels.length > 0),
    JSON.stringify(chartData));

  const question = 'Show revenue by region';
  await win.evaluate((args: any) => {
    (window as any).dkRenderChartCard(
      args.did, args.question,
      { encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, why: 'Grouped by region' },
      args.data, 'bar',
    );
  }, { did: seeded.datasetId, question, data: chartData.data });
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 8000 });
  ok('the chart proposal draws a real chart, not a placeholder',
    (await win.locator('#dk-messages .dk-proposal .dk-proposal-chart canvas').count()) > 0);

  await win.locator('#dk-messages .dk-proposal').last().locator('button', { hasText: 'Save as visual' }).click();
  await win.waitForSelector('#hub-toast:not([hidden])', { timeout: 10_000 });
  ok('saving shows a confirmation toast',
    /Saved as visual/i.test((await win.locator('#hub-toast').textContent()) || ''));

  const visuals: any = await app.evaluate(async (_electronModule, args: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visualsMod = req('./src/visuals.js');
    return visualsMod.listVisuals(args.pid);
  }, { pid: seeded.projectId });
  const savedVisual = visuals.find((v: any) => v.datasetId === seeded.datasetId);
  ok('a real visual record was created from the proposal', Boolean(savedVisual), JSON.stringify(visuals));
  ok('…named from the question, and drawn as the proposed chart type',
    Boolean(savedVisual) && savedVisual.name === question && savedVisual.chartType === 'bar',
    savedVisual ? `${savedVisual.name} / ${savedVisual.chartType}` : '');
  ok('the proposal card cleans itself up after saving',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failures) {
      console.error(`${failures} dock smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All dock smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
