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
    // …plus a real analysis with two half-width visual cards, for the
    // an-focus layout check at the end of this file.
    const analysis = req('./src/analysis.js');
    await analysis.init();
    const visualsMod = req('./src/visuals.js');
    const viz = await visualsMod.saveVisual(proj.id, {
      name: 'Revenue by region',
      datasetId: ds.id,
      chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
      filters: [],
    });
    const an = await analysis.saveAnalysis(proj.id, {
      name: 'Sales review',
      sheets: [{
        name: 'Page 1',
        cards: [
          { type: 'visual', visualId: viz.id, layout: { x: 0, y: 0, w: 6, h: 4 } },
          { type: 'visual', visualId: viz.id, layout: { x: 6, y: 0, w: 6, h: 4 } },
        ],
      }],
    });
    return { projectId: proj.id, datasetId: ds.id, analysisId: an.id };
  });
  ok('seeded a project and a dataset with a real 2-step pipeline', Boolean(seeded.projectId && seeded.datasetId));

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);

  // ── First run opens the dock exactly once ───────────────────────────────
  // Discoverability: a panel nobody opens is a panel nobody knows about, so
  // the first run that can actually use it (a project open, not suppressed)
  // opens it for you and writes the `dkSeen` sentinel. This smoke run boots
  // into a fresh --user-data-dir, so localStorage is genuinely empty and this
  // is genuinely a first run.
  ok('first run opens the dock by itself', await win.locator('#dk-panel').isVisible());
  ok('…and records the sentinel so it never does it again',
    (await win.evaluate(() => localStorage.getItem('dkSeen'))) === '1');
  // The second half of "once": close it, force another full sync, and it must
  // stay closed. This is the assertion that fails if the sentinel check is
  // ever dropped or inverted.
  await win.evaluate(() => { (window as any).dkSetOpen(false); (window as any).dkSync(); });
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('…and a later sync does NOT re-open it', await win.locator('#dk-panel').isHidden());

  // ── The top bar's Agent toggle toggles the DOCK, not Ask ────────────────
  // 498d647 pointed #side-ai-btn at Ask (then named Explore; the section id
  // is still 'explore'), which already has its own nav
  // item — a duplicate door, while the dock had no chrome presence at all.
  // It is the dock's again. These are the assertions that fail if it ever
  // drifts back, or if a second AI door appears beside it.
  //
  // Icon-only, so the accessible name is aria-label — the labelled version
  // asserted the visible text WAS the name (nothing to drift, WCAG 2.5.3);
  // with no visible text, aria-label is the correct mechanism, and the
  // tooltip carries the distinction from the Ask section.
  ok('the Agent toggle is named "Agent" via aria-label (icon-only, no visible text)',
    /agent/i.test((await win.getAttribute('#side-ai-btn', 'aria-label')) || '')
      && !/\S/.test((await win.locator('#side-ai-btn').textContent()) || ''),
    (await win.getAttribute('#side-ai-btn', 'aria-label')) || '(none)');
  ok('…with the works-on-what-you-see tooltip distinguishing it from Ask',
    /looking at/i.test((await win.getAttribute('#side-ai-btn', 'title')) || ''),
    (await win.getAttribute('#side-ai-btn', 'title')) || '(none)');
  ok('…and the Ask nav item (section id \'explore\') still exists as its own separate entry',
    (await win.locator('.as-nav-item[data-section="explore"]').count()) === 1);
  // It lives in the TOP BAR now, not the sidebar — search and the Agent
  // toggle are window-wide tools and the sidebar is the section nav.
  ok('…and it sits in the top bar, not in the section nav',
    (await win.locator('.hub-topbar #side-ai-btn').count()) === 1
      && (await win.locator('#app-sidebar #side-ai-btn').count()) === 0);
  // Was "exactly one SIDEBAR control mentions AI". Widened to the whole
  // persistent chrome, which is the stronger claim and the point of the
  // relayout: #dk-edge was a second door to this same panel that looked
  // nothing like this button, and it is gone. Accessible names count too —
  // the toggle itself is icon-only, so its name lives in aria-label.
  ok('…so exactly one control in the whole chrome names the AI surface',
    (await win.evaluate(() => Array.from(
      document.querySelectorAll('#app-sidebar button, .hub-topbar button, .dk-edge'))
      .filter((b) => /\bai\b|agent/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || ''))).length)) === 1);
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  ok('clicking it OPENS THE DOCK (it must not navigate to the Ask section)',
    await win.locator('#dk-panel').isVisible()
      && (await win.evaluate(() =>
        (document.querySelector('.hub-body') as HTMLElement).dataset.section)) !== 'explore');
  ok('…and reports its state through aria-expanded',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'true');
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('…and closes it again — it is a toggle, not a one-way door',
    await win.locator('#dk-panel').isHidden()
      && (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'false');

  // ── The closed→open→closed cycle and the aria contract ──────────────────
  // These assertions used to run against #dk-edge, the vertical tab that was
  // pinned to the window's right edge. The TAB is gone; the COVERAGE is not —
  // it was only ever the vehicle for this contract, and the top-bar button is
  // the vehicle now.
  //
  // The one behaviour that deliberately CHANGED: #dk-edge hid itself while the
  // dock was open (it was an open-affordance only, so showing it beside
  // #dk-close would have been two controls doing one job at the same edge).
  // A header button cannot do that — vanishing would leave a hole in the bar
  // and reflow its neighbours — so this one stays visible and toggles, which
  // is what aria-expanded promises anyway. Asserted below, not assumed.
  ok('the AI button starts visible and collapsed',
    await win.locator('#side-ai-btn').isVisible());
  ok('…aria-expanded=false',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'false');
  ok('…and points at the panel it controls',
    (await win.getAttribute('#side-ai-btn', 'aria-controls')) === 'dk-panel');
  // Icon-only ON PURPOSE — the panel glyph reads as "collapse/expand the
  // right panel". The old tab's icon-only failure was a MUTED GREY ornament
  // floating at the window edge; a bordered header cell with a divider, a
  // hover state and an accent active state is a control, not a decoration.
  // With no visible text, aria-label is the accessible name (WCAG 4.1.2) and
  // the title carries the long description.
  ok('…and it is icon-only with aria-label as the accessible name',
    !/\S/.test((await win.locator('#side-ai-btn').textContent()) || '')
      && /agent/i.test((await win.getAttribute('#side-ai-btn', 'aria-label')) || ''));
  ok('…and the removed edge tab is really gone, not just hidden',
    (await win.locator('#dk-edge').count()) === 0);

  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  ok('clicking it opens the dock', await win.locator('#dk-panel').isVisible());
  ok('…and marks it aria-expanded=true',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'true');
  ok('…and it STAYS visible while the dock is open (a header button that vanished would leave a hole)',
    await win.locator('#side-ai-btn').isVisible()
      && !(await win.locator('#side-ai-btn').isDisabled()));
  ok('the panel has an aria-label naming the surface',
    /agent/i.test((await win.getAttribute('#dk-panel', 'aria-label')) || ''),
    (await win.getAttribute('#dk-panel', 'aria-label')) || '(none)');
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

  // ── Global search: reachable from the top bar, and NOT clipped by it ─────
  // New coverage for the relayout. In the sidebar the results box was an
  // in-flow block that simply pushed the nav down; in a 48px bar that layout
  // would be clipped by the bar's own height, so it became an absolutely
  // positioned dropdown anchored under the input. Two ways that goes wrong and
  // one of them is invisible to a DOM-only check:
  //   1. it renders INSIDE the bar's box and gets cut off, and
  //   2. it renders BEHIND the content stage or an open dock.
  // Run with the dock still OPEN, because below ~1100px .dk-panel is a fixed
  // overlay at z-index 9950 and the dropdown has to clear it.
  await win.fill('#global-search', 'Regional');
  await win.waitForSelector('#global-search-results:not([hidden])', { timeout: 8000 });
  const searchBox: any = await win.evaluate(() => {
    const bar = document.querySelector('.hub-topbar') as HTMLElement;
    const box = document.getElementById('global-search-results') as HTMLElement;
    const r = box.getBoundingClientRect();
    const barR = bar.getBoundingClientRect();
    // What is actually painted at the dropdown's own top-centre point? If the
    // stage or the dock covers it, this resolves to something outside the box.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 4);
    return {
      visible: r.height > 0 && r.width > 0,
      belowBar: r.top >= barR.bottom - 1,
      overflowsBar: r.bottom > barR.bottom,
      onTop: Boolean(hit && box.contains(hit)),
      hitId: hit ? (hit.id || hit.className || hit.tagName) : '(nothing)',
    };
  });
  ok('typing in the top bar opens the results dropdown', searchBox.visible);
  ok('…anchored BELOW the bar, not laid out inside it', searchBox.belowBar);
  ok('…extending past the 48px bar rather than being clipped to it', searchBox.overflowsBar);
  ok('…and painted ON TOP of the content stage and the open dock, not behind them',
    searchBox.onTop, String(searchBox.hitId));
  await win.fill('#global-search', '');
  // state: 'hidden' — the default waits for VISIBLE, which a hidden box never is.
  await win.waitForSelector('#global-search-results', { state: 'hidden', timeout: 8000 });
  ok('…and clearing the query closes it again', await win.locator('#global-search-results').isHidden());
  // Newly relevant after the relayout: search and the ⌘L target now sit in the
  // same strip of chrome, inches apart. dock.ts's keydown handler bails on
  // INPUT/TEXTAREA/contenteditable so the shortcut cannot hijack typing — which
  // means ⌘L must do NOTHING while the caret is in the search box, even though
  // the button it mirrors is right there. Asserted, then focus is released so
  // the ⌘L checks below run from neutral ground.
  await win.focus('#global-search');
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForTimeout(250);
  ok('⌘L is inert while the caret is in the search box (it must not hijack typing)',
    await win.locator('#dk-panel').isVisible());
  await win.evaluate(() => (document.getElementById('global-search') as HTMLInputElement).blur());

  // ── ⌘L closes it too (the second entry point) ───────────────────────────
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('Cmd/Ctrl+L closes the dock', await win.locator('#dk-panel').isHidden());
  ok('…and clears aria-expanded on the AI button (the shortcut and the button share one state)',
    (await win.getAttribute('#side-ai-btn', 'aria-expanded')) === 'false');
  ok('…which is still there, unchanged, either way',
    await win.locator('#side-ai-btn').isVisible());

  // ── Esc closes and returns focus to the toggle ──────────────────────────
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  await win.keyboard.press('Escape');
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('Escape closes the dock', await win.locator('#dk-panel').isHidden());
  // Focus must land on a control that is actually focusable at that moment.
  // This is why the button staying visible-and-enabled while open matters: the
  // old #dk-edge had to be un-hidden by dkSync() first, and a hidden element
  // silently refuses focus().
  ok('…and returns focus to the AI button',
    await win.evaluate(() => Boolean(document.activeElement && document.activeElement.id === 'side-ai-btn')));

  // ── ⌘L still works WITH FOCUS INSIDE THE COMPOSER ───────────────────────
  // The keydown handler ignores INPUT/TEXTAREA/contenteditable so the shortcut
  // can't hijack typing elsewhere in the app — but #dk-input IS a <textarea>
  // and the dock focuses it on open, so without an explicit exemption for the
  // dock's own subtree the shortcut dies the moment focus is in the composer.
  // A smoke run has no model, so dkRefresh() leaves #dk-input disabled and
  // focus falls to the panel div — which is exactly why the checks above pass
  // either way and cannot see this. Force-enable it so the guard is genuinely
  // exercised; this is the assertion that fails if the exemption is removed.
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  await win.evaluate(() => {
    const i = document.getElementById('dk-input') as HTMLTextAreaElement | null;
    if (i) { i.disabled = false; i.focus(); }
  });
  ok('focus is genuinely inside the composer textarea',
    await win.evaluate(() => Boolean(document.activeElement && document.activeElement.id === 'dk-input')));
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+L' : 'Control+L');
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('Cmd/Ctrl+L closes the dock even when the composer has focus',
    await win.locator('#dk-panel').isHidden());

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
  // By NAME, not by datasetId: the seeded analysis above owns a visual on the
  // same dataset, so datasetId no longer identifies this one.
  const savedVisual = visuals.find((v: any) => v.name === question);
  ok('a real visual record was created from the proposal', Boolean(savedVisual), JSON.stringify(visuals));
  ok('…against the right dataset, and drawn as the proposed chart type',
    Boolean(savedVisual) && savedVisual.datasetId === seeded.datasetId && savedVisual.chartType === 'bar',
    savedVisual ? `${savedVisual.datasetId} / ${savedVisual.chartType}` : '');
  ok('the proposal card cleans itself up after saving',
    (await win.locator('#dk-messages .dk-proposal').count()) === 0);

  // ── dkAllowed(): the suppression table ──────────────────────────────────
  // The dock's safety predicate. Every caller reaches it through
  // `typeof dkSync === 'function'`, so a rename would disable suppression
  // SILENTLY — the same silent-by-construction hazard this whole script
  // exists to guard. Ask (section id 'explore') is the cheapest condition to drive (a plain
  // section switch) and the most absurd to get wrong: two chats side by side.
  //
  // Ask is ALSO the case that matters most now that #side-ai-btn toggles
  // the dock: suppression has to reach EVERY entry point, or the top-bar
  // button becomes a control that visibly does nothing on the one section
  // where the dock refuses to appear. With #dk-edge gone there are two entry
  // points to cover instead of three, and this is the one that has a face.
  await win.evaluate(() => { (window as any).selectSection('explore'); });
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('the dock is suppressed on the Ask section (id \'explore\')', await win.locator('#dk-panel').isHidden());
  // Disabled, NOT hidden — the top bar is fixed chrome and dropping a control
  // out of it would leave a hole and reflow its neighbours on every visit.
  ok('…and the AI button is disabled rather than removed (no hole in the bar)',
    await win.locator('#side-ai-btn').isVisible()
      && await win.locator('#side-ai-btn').isDisabled());
  ok('…so clicking it while suppressed opens nothing',
    await win.evaluate(() => {
      (document.getElementById('side-ai-btn') as HTMLButtonElement).click();
      const p = document.getElementById('dk-panel');
      return Boolean(p && p.hidden);
    }));
  // …and it comes back on leaving Ask, so suppression is a gate, not a kill.
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  ok('…and it returns when the condition lifts', await win.locator('#dk-panel').isVisible());
  // Presentation mode is the other cheap one: a body/documentElement class the
  // predicate reads directly, no dashboard needed to reach it.
  await win.evaluate(() => { document.documentElement.classList.add('dash-presenting'); (window as any).dkSync(); });
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('the dock is suppressed in presentation mode', await win.locator('#dk-panel').isHidden());
  ok('…and its AI button is disabled too, not just the panel hidden',
    await win.locator('#side-ai-btn').isDisabled());
  await win.evaluate(() => { document.documentElement.classList.remove('dash-presenting'); (window as any).dkSync(); });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });

  // ── an-focus is NOT a suppression any more — and the layout proves it ────
  // The dock used to be forced closed inside an open analysis because the plan
  // assumed the workbench owned the full width. It was measured instead (the
  // table in docs/superpowers/plans/2026-08-09-ai-dock.md) and it does not.
  // This is that measurement, reduced to the assertions that would catch a
  // regression: the dock is ALLOWED here, and with its 340px taken at the
  // tightest supported push width nothing overflows and the one-row editor
  // head stays one row.
  //
  // THIS is the case that justified #dk-edge, and the reason deleting it is
  // safe rather than merely tidy. Focus mode hides the whole sidebar, so while
  // the AI button lived down there the edge tab was the only MOUSE way into the
  // dock — losing it would have left ⌘L alone, an undiscoverable single point
  // of entry. The top bar is deliberately NOT hidden in an-focus (hub.css), so
  // the button survives here and takes over that job.
  //
  // The two assertions below therefore INVERT on purpose: this used to assert
  // #side-ai-btn was hidden in focus mode and that the edge tab was the way
  // back in. Both are now the opposite, and that inversion IS the feature.
  // Enter the analysis with the dock ALREADY open — the transition that used
  // to slam it shut.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(400);
  await win.evaluate((id: string) => (window as any).openAnalysis(id), seeded.analysisId);
  await win.waitForFunction(() => document.body.classList.contains('an-focus'), { timeout: 10_000 });
  ok('an analysis really is open in focus mode', await win.evaluate(() => document.body.classList.contains('an-focus')));
  ok('the dock SURVIVES opening an analysis (an-focus is no longer a suppression)',
    await win.locator('#dk-panel').isVisible());
  ok('…and the sidebar really is hidden here (the condition that made an edge tab necessary)',
    await win.locator('#app-sidebar').isHidden());
  ok('…but the top bar is NOT, so the Agent toggle survives focus mode',
    await win.locator('.hub-topbar').isVisible()
      && await win.locator('#side-ai-btn').isVisible());
  // The bar the workbench now sits under is 48px the old sizing did not know
  // about: body.an-focus #ws-analyses was calc(100vh - 40px) — the titlebar
  // alone — which left the workbench's bottom 48px clipped under .win's
  // overflow:hidden. This is the guard for that (100vh - 88px now).
  ok('…and the workbench bottom lands inside the window, not clipped under it',
    await win.evaluate(() => {
      const r = document.getElementById('ws-analyses')!.getBoundingClientRect();
      return Math.round(r.bottom) <= window.innerHeight + 1;
    }));

  // …and it can be re-opened from inside, where the top-bar button and ⌘L are
  // the two entry points left.
  await win.evaluate(() => { (window as any).dkSetOpen(false); });
  await win.waitForSelector('#dk-panel', { state: 'hidden', timeout: 8000 });
  ok('…so with the dock closed inside focus mode the button is still offered, enabled',
    await win.locator('#side-ai-btn').isVisible()
      && !(await win.locator('#side-ai-btn').isDisabled()));
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 });
  ok('…and clicking it opens the dock inside the open analysis',
    await win.locator('#dk-panel').isVisible());

  // 1180px is the tightest width the dock still PUSHES at (below ~1100 it
  // becomes an overlay and takes no layout space at all), and the flyout open
  // is the widest the chrome ever gets. That combination is the worst case.
  // Back to the DEFAULT 340px — the resize tests above left it at the 300px
  // minimum, and 340 is the width the plan doc's table was measured at.
  await win.evaluate(() => { (window as any).dkPersistWidth(340); });
  await app.evaluate(({ BrowserWindow }, _a) => { BrowserWindow.getAllWindows()[0].setContentSize(1180, 900); }, null);
  await win.waitForTimeout(700);
  await win.evaluate(() => {
    const btn = document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-data"]') as HTMLElement | null;
    const side = document.querySelector('.an-side') as HTMLElement | null;
    if (btn && (!side || side.hidden)) btn.click();
  });
  await win.waitForTimeout(600);
  const layout = await win.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el && !el.hidden && el.offsetParent !== null ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    const head = document.querySelector('body.an-focus .dash-editor-head') as HTMLElement | null;
    const grid = document.querySelector('#dash-grid') as HTMLElement | null;
    const doc = document.documentElement;
    return {
      rail: box('#an-rail'),
      flyout: box('.an-side'),
      sheet: box('.an-workbench.is-active > .dash-editor'),
      dock: box('#dk-panel'),
      headH: head ? Math.round(head.getBoundingClientRect().height) : 0,
      headOvf: head ? head.scrollWidth - head.clientWidth : 0,
      gridOvf: grid ? grid.scrollWidth - grid.clientWidth : 0,
      pageOvf: doc.scrollWidth - doc.clientWidth,
      pushed: getComputedStyle(document.getElementById('dk-panel')!).position !== 'fixed',
    };
  });
  ok('…in PUSH mode at 1180px, taking its full 340px of real layout width',
    layout.pushed && layout.dock === 340, JSON.stringify(layout));
  ok('…the 48px rail and 252px flyout are not squeezed by it',
    layout.rail === 48 && layout.flyout === 252, JSON.stringify(layout));
  // 358px in a 1180px window is the sheet width that produced focus mode in
  // the first place (hub.css:6680). The worst case here measured 540px.
  ok('…the sheet absorbs the whole 340px and still clears the 358px that made focus mode',
    layout.sheet > 500, `sheet=${layout.sheet}px`);
  ok('…the editor head stays ONE row (it wrapped Save onto a second line at 665px)',
    layout.headH < 70, `headH=${layout.headH}px`);
  ok('…and nothing overflows horizontally — head, grid or document',
    layout.headOvf <= 0 && layout.gridOvf <= 0 && layout.pageOvf <= 0, JSON.stringify(layout));

  // Leave the analysis: the dock must survive the transition either way.
  await win.evaluate(() => {
    const back = [...document.querySelectorAll('.dash-editor-head button')]
      .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined;
    back?.click();
  });
  await win.waitForFunction(() => !document.body.classList.contains('an-focus'), { timeout: 10_000 });
  ok('closing the analysis leaves the dock open, not stranded',
    await win.locator('#dk-panel').isVisible());

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
