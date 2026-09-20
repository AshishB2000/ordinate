// Creating a dashboard: the empty state, the three-step wizard, and the two
// routes out of step 2 that a smoke run can actually take.
//
// Split out of smoke-app.ts (see that file's banner). Everything here clicks
// real buttons and fills real modals, which is the point: a panel that renders
// at zero height, or a control hidden by a CSP-blocked style, passes every DOM
// assertion made outside a running window.
//
// This run has NO model configured, which is the case that matters most — the
// AI half of step 2 must be visibly unavailable while the other three routes
// still finish, or "AI is optional" is a claim rather than a behaviour. The AI
// card is then force-enabled so step 3 renders at all, and pressing Draft with
// no model must bounce back to a route that can finish rather than stranding
// the user on a dead step.
//
// A MILLION rows, because step 1 renders the real count and this file asserts
// the rendered "1,000,000".
//
//   npm run build:ts && node scripts/smoke-analysis-create.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, seedProject, openProject, domDriver, finishSmoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('analysis-create');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: 1_000_000 });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  // Playwright dismisses dialogs by default, which would silently answer "no"
  // to a window.confirm(). Accept them, and keep the text so an UNEXPECTED
  // alert (the failure path of every handler in analyses.ts) is visible rather
  // than swallowed.
  const dialogs: string[] = [];
  win.on('dialog', (d) => {
    dialogs.push(d.type() + ': ' + d.message());
    d.accept().catch(() => {});
  });

  const { clickExact, clickId } = domDriver(win);


  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(800);

  // A fresh project has no analyses, so the EMPTY STATE is the real first
  // screen. Asserted by what is painted, not by the hidden attribute: the
  // table's own Create button has no `hidden` of its own — only its container
  // does — so `clickId` would happily click it and report green while the user
  // saw an empty page. offsetParent is the check that can tell.
  const emptyState = await win.evaluate(() => {
    const vis = (id: string) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null;
    const empty = document.getElementById('an-list-empty');
    const r = empty?.getBoundingClientRect();
    return {
      emptyVisible: !!empty && empty.offsetParent !== null,
      h: Math.round(r?.height || 0),
      heading: (document.querySelector('.ws-empty-h')?.textContent || '').trim(),
      createVisible: vis('an-empty-new'),
      aiVisible: vis('an-empty-draft'),
      aiLabel: (document.getElementById('an-empty-draft')?.textContent || '').trim(),
      // The table belongs to the populated state only.
      tableVisible: vis('an-table'),
    };
  });
  ok('an empty Dashboards page shows the empty state, not a bare table',
     emptyState.emptyVisible && emptyState.h > 150 && !emptyState.tableVisible,
     JSON.stringify(emptyState));
  ok('the empty state offers both doors — blank and the Assistant',
     emptyState.createVisible && emptyState.aiVisible && /Assistant/.test(emptyState.aiLabel),
     `"${emptyState.heading}" / "${emptyState.aiLabel}"`);  // one name, everywhere

  const emptyShot = path.join(shotDir, 'analyses-empty.png');
  await win.screenshot({ path: emptyShot });
  ok('empty-state screenshot captured', fs.existsSync(emptyShot) && fs.statSync(emptyShot).size > 5000,
     `${Math.round(fs.statSync(emptyShot).size / 1024)} KB -> ${emptyShot}`);

  // ── The create wizard ─────────────────────────────────────────────────────
  // Two steps: pick a dataset, then optionally let the model draft it. This run
  // has NO model configured, which is the case that matters most here — the AI
  // half must be visibly unavailable while Skip still works, or "AI is optional"
  // is a claim rather than a behaviour.
  ok('Create dashboard opens the wizard', await clickId('an-empty-new'));
  await win.waitForTimeout(700);

  const wiz1 = await win.evaluate(() => {
    const box = document.querySelector('.an-wiz') as HTMLElement | null;
    const r = box?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.an-wiz-row')];
    const cols = [...document.querySelectorAll('.an-wiz-cols span')].map((s) => (s.textContent || '').trim());
    const cellLefts = rows[0] ? [...rows[0].children].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
    const colLefts = [...document.querySelectorAll('.an-wiz-cols span')].map((c) => Math.round(c.getBoundingClientRect().left));
    return {
      open: !!box && box.offsetParent !== null,
      w: Math.round(r?.width || 0),
      h: Math.round(r?.height || 0),
      steps: [...document.querySelectorAll('.an-wiz-step-label')].map((s) => (s.textContent || '').trim()),
      step2Optional: !!document.querySelector('.an-wiz-optional'),
      cols,
      aligned: colLefts.length === cellLefts.length &&
               colLefts.every((x, i) => Math.abs(x - cellLefts[i]) <= 1),
      datasetRows: rows.length,
      rowText: rows.map((r2) => (r2.textContent || '').replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 120),
      // Both fixture datasets are listed, and the single-dataset preselect does
      // NOT fire (there are two), so Next must start disabled... except one gets
      // clicked below.
      selected: document.querySelectorAll('.an-wiz-row.is-selected').length,
      createDatasetOffered: [...document.querySelectorAll('.an-wiz-bar .btn')]
        .some((b) => /Create dataset/.test(b.textContent || '')),
      searchPlaceholder: (document.querySelector('.an-wiz-search') as HTMLInputElement | null)?.placeholder || '',
    };
  });
  ok('the wizard paints at a real size', wiz1.open && wiz1.w > 500 && wiz1.h > 300,
     `${wiz1.w}x${wiz1.h}`);
  ok('…with three steps, the last marked optional',
     JSON.stringify(wiz1.steps) === JSON.stringify(['Choose data', 'Start from', 'Describe it']) &&
       wiz1.step2Optional,
     JSON.stringify(wiz1.steps));
  // Three fixture datasets now: Sales, By state, and the file-backed Refreshable.
  ok('…step 1 lists the project datasets with their columns',
     wiz1.datasetRows === 3 &&
       JSON.stringify(wiz1.cols) === JSON.stringify(['', 'Dataset name', 'Rows', 'Columns', 'Source', 'Last modified']),
     `${wiz1.datasetRows} rows / ${JSON.stringify(wiz1.cols)}`);
  ok('…and those cells line up under their labels', wiz1.aligned);
  ok('…the row shows the real row count', /1,000,000/.test(wiz1.rowText), wiz1.rowText);
  ok('…Create dataset and search are offered',
     wiz1.createDatasetOffered && /Search datasets/.test(wiz1.searchPlaceholder));

  // Next is gated on a selection — two datasets means no preselect.
  const gated = await win.evaluate(() => {
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    return { disabled: !!next?.disabled, label: (next?.textContent || '').trim() };
  });
  ok('Next is disabled until a dataset is chosen', gated.disabled, `"${gated.label}"`);

  // Search narrows the list, then picking prefills the name.
  const searched = await win.evaluate(() => {
    const s = document.querySelector('.an-wiz-search') as HTMLInputElement;
    s.value = 'Sales';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('.an-wiz-row').length;
  });
  ok('search narrows the dataset list', searched === 1, `${searched} row(s) match "Sales"`);

  const picked = await win.evaluate(() => {
    (document.querySelector('.an-wiz-row') as HTMLElement).click();
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement | null;
    return {
      selected: document.querySelectorAll('.an-wiz-row.is-selected').length,
      nextEnabled: !next?.disabled,
      name: nameIn?.value || '',
    };
  });
  ok('picking a dataset selects it and frees Next',
     picked.selected === 1 && picked.nextEnabled, JSON.stringify(picked));
  ok('…and prefills the dashboard name from it', picked.name === 'Sales dashboard', `"${picked.name}"`);

  const wizShot = path.join(shotDir, 'wizard-step1.png');
  await win.screenshot({ path: wizShot });
  ok('wizard step 1 screenshot captured', fs.existsSync(wizShot) && fs.statSync(wizShot).size > 5000,
     `${Math.round(fs.statSync(wizShot).size / 1024)} KB -> ${wizShot}`);

  // Set the name this run asserts on everywhere below, then go to step 2.
  await win.evaluate(() => {
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement;
    nameIn.value = 'Smoke analysis';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click();
  });
  await win.waitForTimeout(600);

  // Step 2 — Start from. Layout and AI are ONE step: three real scaffolds plus
  // the AI route, and picking AI is what reveals step 3.
  const wiz2 = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('.an-wiz-start')] as HTMLButtonElement[];
    const note = document.querySelector('.an-wiz-note') as HTMLElement | null;
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    const rail = [...document.querySelectorAll('.an-wiz-step')];
    return {
      count: cards.length,
      titles: [...document.querySelectorAll('.an-wiz-start-t')].map((t) => (t.textContent || '').trim()),
      doneTick: (document.querySelector('.an-wiz-step.is-done .an-wiz-dot')?.textContent || '').trim(),
      // Blank is the default, so the step is answerable by pressing Enter.
      selected: [...document.querySelectorAll('.an-wiz-start.is-selected .an-wiz-start-t')]
        .map((t) => (t.textContent || '').trim()),
      // No model in a smoke run: the AI CARD is the gate, and it says why.
      aiDisabled: !!cards.find((c) => c.dataset.kind === 'ai')?.disabled,
      othersEnabled: cards.filter((c) => c.dataset.kind !== 'ai').every((c) => !c.disabled),
      noteVisible: !!note && note.offsetParent !== null,
      noteText: (note?.textContent || '').trim(),
      // Nothing left to ask on the three non-AI routes, so step 2 finishes.
      nextLabel: (next?.textContent || '').trim(),
      nextDisabled: !!next?.disabled,
      // Step 3 is dimmed, not hidden — the rail must not reflow on every choice.
      step3Skipped: rail.length === 3 && rail[2].classList.contains('is-skipped'),
      // Skip belongs to step 3 only; on step 2 the primary button IS the finish.
      skipVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Skip/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
      backVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
    };
  });
  ok('step 2 offers four ways to start',
     wiz2.count === 4 &&
       JSON.stringify(wiz2.titles) ===
         // No longer '✨ Let the Assistant design it' — the sparkle is an icon
         // now, so the card's TEXT is just the title.
         JSON.stringify(['Blank sheet', 'KPIs + chart', 'Two-up', 'Let the Assistant design it']),
     JSON.stringify(wiz2.titles));
  ok('…step 1 is ticked off behind it', wiz2.doneTick === '✓', `"${wiz2.doneTick}"`);
  ok('…Blank is preselected, so the step answers itself',
     JSON.stringify(wiz2.selected) === JSON.stringify(['Blank sheet']), JSON.stringify(wiz2.selected));
  ok('…with no model, ONLY the AI card is disabled, and it says why',
     wiz2.aiDisabled && wiz2.othersEnabled && wiz2.noteVisible
       && /^The Assistant isn’t set up yet\./.test(wiz2.noteText),
     wiz2.noteText);
  ok('…and step 3 is dimmed rather than removed', wiz2.step3Skipped);
  ok('…a non-AI route finishes here, so the button says Create',
     wiz2.nextLabel === 'Create dashboard' && !wiz2.nextDisabled, `"${wiz2.nextLabel}"`);
  ok('…Skip is not offered on this step (the primary button is the finish)', !wiz2.skipVisible);
  ok('…and Back is offered', wiz2.backVisible);

  const wizShot2 = path.join(shotDir, 'wizard-step2.png');
  await win.screenshot({ path: wizShot2 });
  ok('wizard step 2 screenshot captured', fs.existsSync(wizShot2) && fs.statSync(wizShot2).size > 5000,
     `${Math.round(fs.statSync(wizShot2).size / 1024)} KB -> ${wizShot2}`);

  // ── The AI route, forced ──────────────────────────────────────────────────
  // With no model the AI card is disabled, so step 3 is unreachable and its
  // whole pane — textarea, example chips, the notReady recovery — would ship
  // never having rendered. Enabling the card drives the REAL handlers from
  // there on. This asserts layout and control flow only; it makes no claim
  // about a model being configured, and the notReady assertion below is exactly
  // the proof that none is.
  await win.evaluate(() => {
    const ai = [...document.querySelectorAll('.an-wiz-start')]
      .find((c) => (c as HTMLElement).dataset.kind === 'ai') as HTMLButtonElement;
    ai.disabled = false;
    ai.click();
  });
  await win.waitForTimeout(300);
  const aiPicked = await win.evaluate(() => ({
    label: ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0]?.textContent || '').trim(),
    step3Live: !document.querySelectorAll('.an-wiz-step')[2].classList.contains('is-skipped'),
  }));
  ok('picking the AI card turns step 3 on and the button back to Next',
     aiPicked.label === 'Next' && aiPicked.step3Live, JSON.stringify(aiPicked));

  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(400);

  const chips = await win.evaluate(() => {
    const row = document.querySelector('.an-wiz-chips') as HTMLElement | null;
    const ta = document.querySelector('.an-wiz-ta') as HTMLTextAreaElement | null;
    const card = document.querySelector('.an-wiz-ai') as HTMLElement | null;
    if (!row || !ta || !card) return null;
    const btns = [...row.querySelectorAll('.an-wiz-chip')] as HTMLElement[];
    const cr = card.getBoundingClientRect();
    btns[0].click();
    return {
      onStep3: card.offsetParent !== null,
      count: btns.length,
      // Each chip must sit inside the card it belongs to — a long example string
      // in a flex row is exactly what overflows a modal.
      inside: btns.every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= cr.left - 1 && r.right <= cr.right + 1 && r.height > 0;
      }),
      wrapped: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      filled: ta.value,
      skipVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Skip/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
    };
  });
  ok('step 3 is the AI step, and its chips lay out inside the card',
     !!chips && chips.onStep3 && chips.count === 3 && chips.inside, JSON.stringify(chips));
  ok('…clicking a chip fills the prompt box',
     !!chips && chips.filled.startsWith('Show revenue by region'), chips?.filled.slice(0, 44) || '');
  ok('…and Skip appears here, so the AI step is genuinely optional', !!chips?.skipVisible);

  const wizShot3 = path.join(shotDir, 'wizard-step3.png');
  await win.screenshot({ path: wizShot3 });
  ok('wizard step 3 screenshot captured', fs.existsSync(wizShot3) && fs.statSync(wizShot3).size > 5000,
     `${Math.round(fs.statSync(wizShot3).size / 1024)} KB -> ${wizShot3}`);

  // Pressing Draft with no model must not strand the user on a dead step.
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(2500);
  const bounced = await win.evaluate(() => {
    const rail = [...document.querySelectorAll('.an-wiz-step')];
    const note = document.querySelector('.an-wiz-note') as HTMLElement | null;
    return {
      stillOpen: !!document.querySelector('.an-wiz'),
      backOnStep2: rail[1].classList.contains('is-active'),
      noteVisible: !!note && note.offsetParent !== null,
      selected: [...document.querySelectorAll('.an-wiz-start.is-selected .an-wiz-start-t')]
        .map((t) => (t.textContent || '').trim()),
    };
  });
  ok('drafting with no model returns to step 2 rather than stranding the user',
     bounced.stillOpen && bounced.backOnStep2 && bounced.noteVisible, JSON.stringify(bounced));
  ok('…and re-selects a route that can still finish',
     JSON.stringify(bounced.selected) === JSON.stringify(['Blank sheet']), JSON.stringify(bounced.selected));

  // Finish on Blank — the downstream assertions expect exactly one empty sheet.
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(2000);
  ok('Create dashboard creates it and closes the wizard',
     await win.evaluate(() => !document.querySelector('.an-wiz')));

  // The editor must be INSIDE the Dashboards panel (id #ws-analyses internally),
  // in analysis mode, and — the check a DOM assertion cannot make — actually
  // have a box on screen.
  const anEditor = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return {
      inAnalysesPanel: !!ed.closest('#ws-analyses'),
      analysisMode: ed.classList.contains('dash-editor--analysis'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      // The head strip is the ONE add path — the rail's + pane went away with the
      // Analyses-v2 dialogs, and removing it meant un-hiding these.
      addVisualVisible:
        (document.getElementById('dash-add-visual') as HTMLElement | null)?.offsetParent != null,
      addAllVisible: ['dash-add-visual', 'dash-add-metric', 'dash-add-text']
        .every((id) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null),
      // Rename stays off the strip: the dashboard NAME is the rename control.
      stripLean: (document.getElementById('dash-rename-btn') as HTMLElement | null)?.offsetParent == null,
      moreVisible: (document.getElementById('an-more-btn') as HTMLElement | null)?.offsetParent != null,
      sheetTabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
      // Clear-all is hidden until a filter exists (asserted by VISIBILITY, since
      // `hidden` on a .btn only wins with hub.css's `.btn[hidden]`).
      clearFiltersVisible: (document.getElementById('dash-clear-filters') as HTMLElement | null)?.offsetParent != null,
    };
  });
  ok('the dashboard editor opened inside the panel',
     !!anEditor && anEditor.inAnalysesPanel && anEditor.analysisMode,
     JSON.stringify(anEditor));
  ok('the dashboard editor has a real box (not zero-height)',
     !!anEditor && anEditor.w > 200 && anEditor.h > 200, `${anEditor?.w}x${anEditor?.h}`);
  ok('the three add buttons are offered on the dashboard',
     !!anEditor && anEditor.addVisualVisible && anEditor.addAllVisible);
  ok('…and the strip sheds Rename (the name is the rename control) but keeps ⋯',
     !!anEditor && anEditor.stripLean && anEditor.moreVisible,
     JSON.stringify({ lean: anEditor?.stripLean, more: anEditor?.moreVisible }));
  ok('the dashboard opens with one sheet', anEditor?.sheetTabs === 1, String(anEditor?.sheetTabs));
  ok('Clear-all stays hidden until there is a filter',
     !!anEditor && !anEditor.clearFiltersVisible, JSON.stringify({ clearFilters: anEditor?.clearFiltersVisible }));

  // Add the saved visual as a card, through the picker — a GALLERY of tiles
  // now, not a name list, with the two create actions above it.
  ok('+ Visual opens the picker', await clickId('dash-add-visual'));
  await win.waitForTimeout(500);
  ok('the picker is a gallery with the create actions above it',
     await win.evaluate(() => {
       const tiles = document.querySelectorAll('.vn-pick-modal .vn-pick-tile').length;
       const labels = [...document.querySelectorAll('.vn-pick-modal .vn-pick-actions .btn')]
         .map((b) => (b.textContent || '').trim());
       // The "+" and the "✨" are icons now, not label text — match the words.
       return tiles > 0 && labels.some((l) => /New visual/.test(l))
         && labels.some((l) => /Suggest with the Assistant/.test(l));
     }));
  ok('the picker adds the saved visual', await win.evaluate(() => {
    const tile = document.querySelector('.vn-pick-modal .vn-pick-tile') as HTMLElement | null;
    if (!tile) return false;
    tile.click();
    return true;
  }));
  await win.waitForTimeout(3000); // render + the 600 ms debounced autosave

  const cardCount = await win.evaluate(() => document.querySelectorAll('#dash-grid .dash-card').length);
  ok('the card lands on the sheet grid', cardCount === 1, String(cardCount));

  // ── Freshness in the analysis header ─────────────────────────────────────
  // The sheet reads one dataset here, so the header must agree with it. The
  // OLDEST rule is what matters and it is asserted directly below, on the
  // dataset ids the sheet actually resolves rather than on wall-clock text.
  const sheetFresh = await win.evaluate(() => {
    const label = document.getElementById('dash-fresh') as HTMLElement | null;
    const btn = document.getElementById('dash-refresh-data') as HTMLElement | null;
    return {
      text: (label?.textContent || '').trim(),
      labelShown: !!label && !label.hidden,
      btnShown: !!btn && !btn.hidden,
    };
  });
  ok('the analysis header reports the freshness of the data it reads',
     sheetFresh.labelShown && /^Data as of /.test(sheetFresh.text), JSON.stringify(sheetFresh));
  // The one card reads the 'Sales' dataset, which was saved with no origin, so
  // there is nothing to refresh and the button must not pretend otherwise.
  ok('…and offers no Refresh data button when nothing on the sheet is refreshable',
     !sheetFresh.btnShown, JSON.stringify(sheetFresh));

  // THE rule: a sheet is only as fresh as its STALEST input. Add a second card
  // reading the backdated 'By state' dataset — the header must follow the 2020
  // stamp, not the one written seconds ago. "Newest" would read as today's time
  // here, which is wrong in the direction that matters: it would tell someone
  // their figures are current when half of them are years old.
  await win.evaluate((vid) => {
    (window as any).pushCard({
      id: window.crypto.randomUUID(),
      type: 'visual',
      visualId: vid,
      layout: { x: 0, y: 8, w: 6, h: 6 },
    });
  }, r.visualId);
  await win.waitForTimeout(3000);
  const twoFresh = await win.evaluate(() => ({
    text: (document.getElementById('dash-fresh')?.textContent || '').trim(),
    title: (document.getElementById('dash-fresh') as HTMLElement | null)?.title || '',
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
  }));
  // The 2020 stamp renders through formatSidebarTime as "Mar 4 · <time>".
  ok('a sheet reading two datasets reports the OLDEST of them, not the newest',
     twoFresh.cards === 2 && /Mar 4/.test(twoFresh.text), JSON.stringify(twoFresh));
  ok('…and says why, so a header that disagrees with one row is explicable',
     /oldest of the 2 datasets/.test(twoFresh.title), `"${twoFresh.title}"`);

  // Back to the list, so the starter route below opens a SECOND wizard from it.
  ok('back to Dashboards after the first analysis', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);

  // ── A starter route actually scaffolds ────────────────────────────────────
  // The whole argument for step 2 is that every card does something. A layout
  // picker whose options all produce the same empty sheet is the thing this was
  // built to avoid, so assert the cards land. Runs LAST in this section and
  // makes a SECOND analysis, which is why it sits below the list-count
  // assertions rather than above them.
  ok('a second Create dashboard opens the wizard', await clickId('an-new-btn'));
  await win.waitForTimeout(700);
  await win.evaluate(() => {
    (document.querySelector('.an-wiz-row') as HTMLElement).click();   // any dataset
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement;
    nameIn.value = 'Starter analysis';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click();
  });
  await win.waitForTimeout(500);
  ok('…and KPIs + chart can be chosen', await win.evaluate(() => {
    const c = [...document.querySelectorAll('.an-wiz-start')]
      .find((x) => (x as HTMLElement).dataset.kind === 'kpis') as HTMLElement | undefined;
    if (!c) return false;
    c.click();
    return true;
  }));
  await win.waitForTimeout(300);
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(1800);
  await win.waitForTimeout(4500); // the build is IPC + saveVisual, not instant
  // "Pick a visual for this slot" was the old picker. It must never come back:
  ok('the starter does not stop to ask for a saved visual', !(await win.evaluate(() =>
     [...document.querySelectorAll('.ws-modal h3')].some((h) => /Pick a visual/i.test(h.textContent || '')))));

  const scaffold = await win.evaluate(() => ({
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
    kinds: [...document.querySelectorAll('#dash-grid .dash-card')]
      .map((c) => [...c.classList].find((k) => k.startsWith('dash-card--')) || '?'),
    name: (document.getElementById('dash-name')?.textContent || '').trim(),
  }));
  ok('KPIs + chart scaffolds a real layout, not an empty sheet',
     scaffold.cards >= 2 && scaffold.kinds.includes('dash-card--metric')
       && scaffold.kinds.includes('dash-card--visual'), JSON.stringify(scaffold));
  ok('…into the analysis the wizard just named', scaffold.name === 'Starter analysis', scaffold.name);

  const starterShot = path.join(shotDir, 'starter-scaffold.png');
  await win.screenshot({ path: starterShot });
  ok('starter scaffold screenshot captured',
     fs.existsSync(starterShot) && fs.statSync(starterShot).size > 5000,
     `${Math.round(fs.statSync(starterShot).size / 1024)} KB -> ${starterShot}`);

  ok('back to Analyses after the starter', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);


  ok('no unexpected alert during the create flow', dialogs.length === 0, dialogs.join(' | '));
  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('analysis-create', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
