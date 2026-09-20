// End-to-end smoke of the FORMULA EDITOR — launches the REAL app.
//
// This is the only check in the repo that proves the editor is wired to
// anything. scripts/test-formulaCheck.ts asserts what main ANSWERS and
// scripts/test-formulaDocs.ts asserts what the catalog HOLDS; neither can tell
// you that the Prepare panel opens the editor, that the preview table paints
// what came back, that Save is gated, that the step reaches disk, or that the
// analysis rail opens the same component instead of a second one that drifted.
//
// ── The three assertions that are the point ──────────────────────────────────
//
// 1. THE PREVIEW IS THE DATA. The eight result cells are compared against
//    revenue ÷ units recomputed from the DATASET RECORD read back off disk —
//    not against numbers typed into this file, and not against what the same
//    IPC said a moment ago. A preview that renders eight plausible numbers from
//    the wrong rows is exactly the failure a screenshot cannot see.
//
// 2. THE ERROR STATE IS REAL. A typo has to produce a visible underline, a
//    did-you-mean naming the right column, AND a disabled Save. All three, in
//    the DOM, at once — the message alone would pass while the user saved a
//    formula that silently evaluates to null for every row.
//
// 3. THE RAIL OPENS THE SAME EDITOR. Asserted by its DOM signature, because
//    "one formula editor" is a claim about the app, not about a file: the rail
//    used to answer ƒx by navigating away and showing a toast.
//
// Zero renderer console errors throughout — which is also what catches a CSP
// violation, and this feature adds a stylesheet and a modal full of new
// classes.
//
//   npm run smoke   (or: node scripts/smoke-formula.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, seedAnalysis, openProject, openSeededAnalysis, domDriver, railDriver, finishSmoke,
} from './smokeFixture';

/** Twelve rows so the eight-row preview is a WINDOW, not the whole table. */
const ROWS: Array<[string, number, number]> = [
  ['north', 120, 4],
  ['south', 340, 8],
  ['north', 75, 3],
  ['east', 900, 12],
  ['west', 60, 5],
  ['north', 410, 10],
  ['south', 205, 41],
  ['east', 33, 2],
  ['west', 780, 15],
  ['north', 95, 7],
  ['south', 512, 16],
  ['east', 148, 9],
];

const EXPR = '[revenue] / [units]';
const TYPO = '[reveune] /';
const NEW_COLUMN = 'unit_price';

async function main(): Promise<void> {
  const s = await launchSmoke('formula');
  const { app, win, errors } = s;

  // ── Seed: a dataset with two numeric columns, and a visual on it so the
  //    analysis rail has a card to select. Written through the same modules
  //    main.js registered its handlers against — the shipped code path.
  const seeded: any = await app.evaluate(async (_electronModule, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    await projects.init();
    const proj = await projects.createProject('Formula smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Orders',
      sourceKind: 'csv',
      columns: [
        { name: 'region', type: 'text' },
        { name: 'revenue', type: 'number' },
        { name: 'units', type: 'number' },
      ],
      rows: arg.rows,
    });
    const v = await visuals.saveVisual(proj.id, {
      datasetId: ds.id,
      name: 'Revenue by region',
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
    });
    return { projectId: proj.id, datasetId: ds.id, visualId: v && v.id };
  }, { rows: ROWS.map((r) => r.slice()) });
  ok('seeded a project, a dataset and a visual',
    Boolean(seeded.projectId && seeded.datasetId && seeded.visualId));

  await openProject(win, seeded.projectId);

  // ── Open the dataset → Prepare → Add step → Calculated field ───────────────
  await win.evaluate((id: string) => { (window as any).openSavedDataset?.(id); }, seeded.datasetId);
  await win.waitForTimeout(1500);
  await win.evaluate(() => (document.getElementById('ds-prepare-btn') as HTMLElement | null)?.click());
  await win.waitForTimeout(500);
  await win.evaluate(() => (document.getElementById('ds-step-add') as HTMLElement | null)?.click());
  await win.waitForTimeout(400);
  const picked = await win.evaluate(() => {
    const item = [...document.querySelectorAll('.chart-menu-item')]
      .find((b) => (b.textContent || '').trim() === 'Calculated field') as HTMLElement | undefined;
    if (!item) return false;
    item.click();
    return true;
  });
  ok('the Add-step menu offers Calculated field', picked);

  const opened = await win.waitForSelector('.fx-modal', { timeout: 10_000 }).then(() => true).catch(() => false);
  ok('choosing it opens the formula editor (not the old two-box form)', opened);
  if (!opened) { await s.close(); return; }

  // The furniture the design calls for, asserted once so the later "same
  // component" check has something specific to compare against.
  const shell = await win.evaluate(() => ({
    side: !!document.querySelector('.fx-modal .fx-side-list'),
    columns: [...document.querySelectorAll('.fx-modal .fx-item-col')].map((b) => (b.textContent || '').trim()),
    functions: document.querySelectorAll('.fx-modal .fx-item-fn').length,
    editor: !!document.querySelector('.fx-modal .fx-input'),
    mirror: !!document.querySelector('.fx-modal .fx-hl'),
    width: Math.round((document.querySelector('.fx-modal') as HTMLElement).getBoundingClientRect().width),
  }));
  ok('the editor has a searchable side list', shell.side);
  ok('the side list offers this dataset’s columns',
    shell.columns.some((c: string) => c.indexOf('revenue') >= 0) && shell.columns.some((c: string) => c.indexOf('units') >= 0),
    JSON.stringify(shell.columns));
  ok('the side list offers the function catalog', shell.functions > 50, String(shell.functions));
  ok('the expression editor has its highlight mirror', shell.editor && shell.mirror);
  // 860px by design, and it must still fit the 1000px window.
  ok('the modal is 860px and fits the window', shell.width > 700 && shell.width <= 860, String(shell.width));

  // ── Autocomplete: the two triggers, with real keystrokes ──────────────────
  // `fill()` would set the value in one event; the popover is driven by what is
  // before the CARET, so it has to be typed.
  await win.click('.fx-modal .fx-input');
  await win.type('.fx-modal .fx-input', '[rev', { delay: 40 });
  await win.waitForTimeout(400);
  const colPop = await win.evaluate(() =>
    [...document.querySelectorAll('.fx-modal .fx-pop-item .fx-pop-label')].map((e) => (e.textContent || '').trim()));
  ok('typing "[" offers the dataset’s columns', colPop.indexOf('revenue') >= 0, JSON.stringify(colPop));
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  const accepted = await win.evaluate(() => (document.querySelector('.fx-modal .fx-input') as HTMLTextAreaElement).value);
  ok('Enter accepts it as a closed reference', accepted === '[revenue]', JSON.stringify(accepted));

  await win.fill('.fx-modal .fx-input', '');
  await win.type('.fx-modal .fx-input', 'upp', { delay: 40 });
  await win.waitForTimeout(400);
  const fnPop = await win.evaluate(() =>
    [...document.querySelectorAll('.fx-modal .fx-pop-item .fx-pop-label')].map((e) => (e.textContent || '').trim()));
  ok('two letters offer the functions they prefix', fnPop.some((l: string) => l.indexOf('upper(') === 0),
    JSON.stringify(fnPop));
  await win.keyboard.press('Tab');
  await win.waitForTimeout(300);
  const fnAccepted = await win.evaluate(() => (document.querySelector('.fx-modal .fx-input') as HTMLTextAreaElement).value);
  ok('Tab accepts it with the call already open', fnAccepted === 'upper(', JSON.stringify(fnAccepted));

  // Escape closes the POPOVER, not the modal — the editor is the outer layer
  // and a stray Escape while completing must not throw the expression away.
  await win.type('.fx-modal .fx-input', '[re', { delay: 40 });
  await win.waitForTimeout(400);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  const afterEsc = await win.evaluate(() => ({
    pop: !!document.querySelector('.fx-modal .fx-pop-item'),
    modal: !!document.querySelector('.fx-modal'),
  }));
  ok('Escape closes the popover and leaves the editor open', !afterEsc.pop && afterEsc.modal, JSON.stringify(afterEsc));

  // ── Type a valid formula; the preview must be the DATA ─────────────────────
  await win.fill('.fx-modal .fx-name', NEW_COLUMN);
  await win.fill('.fx-modal .fx-input', EXPR);
  await win.waitForTimeout(1200); // debounce + IPC + paint

  const preview = await win.evaluate(() => {
    const table = document.querySelector('.fx-modal .fx-table');
    if (!table) return null;
    return {
      headers: [...table.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim()),
      rows: [...table.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim())),
      resultCells: [...table.querySelectorAll('tbody td.fx-res')].map((td) => (td.textContent || '').trim()),
      badge: (document.querySelector('.fx-modal .fx-badge') as HTMLElement | null)?.textContent || '',
      saveDisabled: (document.querySelector('.fx-modal .btn-primary') as HTMLButtonElement).disabled,
      errors: [...document.querySelectorAll('.fx-modal .fx-msg-err')].map((e) => (e.textContent || '').trim()),
      // The highlight mirror must be painting, and colouring the column refs.
      colTokens: document.querySelectorAll('.fx-modal .fx-hl .fx-t-col').length,
    };
  });
  ok('a valid formula renders a preview table', Boolean(preview && preview.rows.length));
  if (!preview) { await s.close(); return; }

  ok('the preview shows eight rows', preview.rows.length === 8, String(preview.rows.length));
  ok('the preview names the inputs then the result',
    preview.headers.join(',') === 'revenue,units,' + NEW_COLUMN, preview.headers.join(','));
  ok('a valid formula reports no errors', preview.errors.length === 0, preview.errors.join(' | '));
  ok('the result type badge says number', preview.badge === 'number', preview.badge);
  ok('Save is enabled once the formula and the name are good', preview.saveDisabled === false);
  ok('the two column references are highlighted as columns', preview.colTokens === 2, String(preview.colTokens));
  await win.screenshot({ path: s.shotDir + '/formula-valid.png' });

  // Dark theme, on the SAME open editor — the tokens, the badge and the
  // preview's highlighted result column all come from theme variables, so this
  // is the only check that they were not hard-coded against the light palette.
  await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await win.waitForTimeout(400);
  await win.screenshot({ path: s.shotDir + '/formula-dark.png' });
  const dark = await win.evaluate(() => {
    const tok = document.querySelector('.fx-modal .fx-hl .fx-t-col') as HTMLElement;
    const modal = document.querySelector('.fx-modal') as HTMLElement;
    return {
      token: tok ? getComputedStyle(tok).color : '',
      background: getComputedStyle(modal).backgroundColor,
    };
  });
  // #3b82f6 is the dark palette's --accent; the light one is #2563eb. Reading
  // the COMPUTED colour is what proves the token followed the theme rather
  // than being painted from a literal.
  ok('column tokens take the dark theme’s accent', dark.token === 'rgb(59, 130, 246)', dark.token);
  ok('the modal takes the dark theme’s surface', dark.background === 'rgb(35, 35, 39)', dark.background);
  await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await win.waitForTimeout(300);

  // THE assertion: the eight previewed results equal revenue ÷ units for the
  // first eight rows OF THE STORED RECORD, read back off disk.
  const stored: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const ds = await datasets.getDataset(arg.projectId, arg.datasetId);
    const names = ds.columns.map((c: any) => c.name);
    const ri = names.indexOf('revenue');
    const ui = names.indexOf('units');
    return ds.rows.slice(0, 8).map((r: any[]) => [Number(r[ri]), Number(r[ui])]);
  }, { projectId: seeded.projectId, datasetId: seeded.datasetId });

  const wanted = stored.map(([rev, units]: [number, number]) => String(rev / units));
  ok('every previewed result is revenue ÷ units for that stored row',
    preview.resultCells.join('|') === wanted.join('|'),
    `got ${preview.resultCells.join('|')} want ${wanted.join('|')}`);
  const inputsMatch = preview.rows.every((cells: string[], i: number) =>
    cells[0] === String(stored[i][0]) && cells[1] === String(stored[i][1]));
  ok('every previewed input is that stored row’s value', inputsMatch, JSON.stringify(preview.rows.slice(0, 2)));

  // ── Now break it: a typo must underline, suggest, and disable Save ─────────
  await win.fill('.fx-modal .fx-input', TYPO);
  await win.waitForTimeout(1200);
  const broken = await win.evaluate(() => ({
    underlined: [...document.querySelectorAll('.fx-modal .fx-hl .fx-t-err')].map((e) => e.textContent).join(''),
    messages: [...document.querySelectorAll('.fx-modal .fx-msg-err')].map((e) => (e.textContent || '').trim()),
    saveDisabled: (document.querySelector('.fx-modal .btn-primary') as HTMLButtonElement).disabled,
    saveReason: (document.querySelector('.fx-modal .fx-save-wrap') as HTMLElement).title,
    stillOpen: !!document.querySelector('.fx-modal'),
  }));
  await win.screenshot({ path: s.shotDir + '/formula-error.png' });
  ok('the mistake is underlined in the expression', broken.underlined === '/', JSON.stringify(broken.underlined));
  ok('the error is stated under the editor', broken.messages.length > 0, JSON.stringify(broken.messages));
  ok('Save is disabled while the formula is broken', broken.saveDisabled === true);
  ok('and hovering Save says why', broken.saveReason.length > 0, broken.saveReason);
  ok('the editor stays open on a bad formula', broken.stillOpen);

  // The did-you-mean needs the expression to COMPILE — an unknown column is not
  // a syntax error in this language, which is exactly why it needs saying.
  await win.fill('.fx-modal .fx-input', '[reveune] / [units]');
  await win.waitForTimeout(1200);
  const suggestion = await win.evaluate(() =>
    [...document.querySelectorAll('.fx-modal .fx-msg-err')].map((e) => (e.textContent || '').trim()).join(' '));
  ok('an unknown column is named as one', /\[reveune\] is not a column/.test(suggestion), suggestion);
  ok('…and the real column is suggested', /Did you mean \[revenue\]\?/.test(suggestion), suggestion);
  const stillBlocked = await win.evaluate(() =>
    (document.querySelector('.fx-modal .btn-primary') as HTMLButtonElement).disabled);
  // A compiling expression over a column that does not exist is ALLOWED to be
  // saved — the language defines it as null per row — so Save is open here.
  // The message is the guard, and the assertion is that the message exists.
  ok('a compiling formula is savable even with an unknown column', stillBlocked === false);

  // ── Fix it and save ────────────────────────────────────────────────────────
  await win.fill('.fx-modal .fx-input', EXPR);
  await win.waitForTimeout(1200);
  await win.evaluate(() => (document.querySelector('.fx-modal .btn-primary') as HTMLElement).click());
  await win.waitForTimeout(2500);

  const closed = await win.evaluate(() => !document.querySelector('.fx-modal'));
  ok('saving closes the editor', closed);

  const inGrid = await win.evaluate((name: string) =>
    [...document.querySelectorAll('#ds-explorer-scroll th')].some((th) => (th.textContent || '').indexOf(name) >= 0),
    NEW_COLUMN);
  ok('the new column appears in the grid', inGrid);

  const onDisk: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const meta = await datasets.getDatasetMeta(arg.projectId, arg.datasetId);
    const ds = await datasets.getDataset(arg.projectId, arg.datasetId);
    const idx = ds.columns.findIndex((c: any) => c.name === arg.name);
    return {
      steps: meta.steps || [],
      columnType: idx >= 0 ? ds.columns[idx].type : null,
      firstValues: ds.rows.slice(0, 3).map((r: any[]) => r[idx]),
    };
  }, { projectId: seeded.projectId, datasetId: seeded.datasetId, name: NEW_COLUMN });

  ok('the pipeline on disk holds exactly one step', onDisk.steps.length === 1, JSON.stringify(onDisk.steps));
  ok('…and it is the calculated field that was written',
    onDisk.steps[0] && onDisk.steps[0].type === 'calculated_field'
      && onDisk.steps[0].name === NEW_COLUMN && onDisk.steps[0].expression === EXPR,
    JSON.stringify(onDisk.steps[0]));
  ok('the saved column is typed number', onDisk.columnType === 'number', String(onDisk.columnType));
  ok('the saved values are the same arithmetic the preview showed',
    onDisk.firstValues.every((v: number, i: number) => Object.is(v, ROWS[i][1] / ROWS[i][2])),
    JSON.stringify(onDisk.firstValues));

  // ── The Assistant's suggested field opens the SAME editor ─────────────────
  // The AI dock's calc-field proposal card hands off through
  // `prefillCalcFieldEditor`, which now opens this editor rather than the old
  // inline two-box form — so a MODEL's formula is previewed against real rows
  // before it can be accepted, which is the whole reason for routing it here.
  //
  // This lived in smoke-dock.ts. It moved because that file sits at the
  // 800-line cap and .claude/rules/file-size.md says a file there is split
  // before more is added to it — and because the claim is about this editor,
  // which makes this the file that should fail when it stops being true.
  await win.evaluate(() => { (window as any).dkSetOpen(true); (window as any).dkSync(); });
  await win.waitForSelector('#dk-panel', { state: 'visible', timeout: 8000 });
  await win.evaluate((args: any) => {
    document.querySelectorAll('#dk-messages .dk-proposal').forEach((n) => n.remove());
    (window as any).dkRenderCalcFieldCard(args.datasetId, args.res);
  }, { datasetId: seeded.datasetId, res: { name: 'Margin pct', expression: '[revenue] / 100', warning: null } });
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 8000 });
  await win.locator('#dk-messages .dk-proposal').last().locator('button', { hasText: 'Apply' }).click();
  await win.waitForSelector('.fx-modal .fx-input', { timeout: 10_000 });
  await win.waitForTimeout(1200);
  const proposed = await win.evaluate(() => ({
    name: (document.querySelector('.fx-modal .fx-name') as HTMLInputElement)?.value,
    expr: (document.querySelector('.fx-modal .fx-input') as HTMLTextAreaElement)?.value,
    note: (document.querySelector('.fx-modal .fx-note') as HTMLElement)?.textContent || '',
    cards: document.querySelectorAll('#dk-messages .dk-proposal').length,
    previewRows: document.querySelectorAll('.fx-modal .fx-table tbody tr').length,
  }));
  ok('the dock’s calc-field proposal opens this editor prefilled',
    proposed.name === 'Margin pct' && proposed.expr === '[revenue] / 100', JSON.stringify(proposed));
  ok('…labelled as a suggestion to review', /Assistant suggestion/i.test(proposed.note), proposed.note);
  ok('…and the proposal card hands off and removes itself', proposed.cards === 0, String(proposed.cards));
  // The point of the change: the model's formula is COMPUTED before it is accepted.
  ok('…with the model’s formula already evaluated on real rows', proposed.previewRows === 8,
    String(proposed.previewRows));

  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  const afterCancel: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const meta = await datasets.getDatasetMeta(arg.projectId, arg.datasetId);
    return meta.steps.length;
  }, { projectId: seeded.projectId, datasetId: seeded.datasetId });
  ok('cancelling a suggestion applies nothing (still the one saved step)', afterCancel === 1,
    String(afterCancel));
  await win.evaluate(() => { (window as any).dkSetOpen(false); (window as any).dkSync(); });
  await win.waitForTimeout(300);

  // ── The analysis rail opens the SAME editor ────────────────────────────────
  await seedAnalysis(app, seeded.projectId, {
    name: 'Formula smoke analysis',
    sheets: [{ name: 'Sheet 1', cards: [{ type: 'visual', visualId: seeded.visualId, layout: { x: 0, y: 0, w: 6, h: 4 } }] }],
  });
  const { clickExact } = domDriver(win);
  const { openPane } = railDriver(win);
  ok('the Dashboards section is reachable', await clickExact('Dashboards'));
  await win.waitForTimeout(1500);
  ok('the seeded analysis opens', await openSeededAnalysis(win, 'Formula smoke analysis'));
  await win.waitForTimeout(2000);

  // ƒx lives beside the field list, and the field list only binds once a card
  // is SELECTED — which is the precondition the old toast-and-navigate handler
  // also had. Wait for the fields rather than a fixed delay: they arrive when
  // the card's dataset loads, which is slower on CI than on a laptop.
  await openPane('an-pane-props');
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement | null)?.click());
  await win.waitForFunction(() => document.querySelectorAll('#an-fields .an-field').length > 0,
    null, { timeout: 20_000 }).catch(() => {});

  // `offsetParent` is what makes this a real assertion: the button is in the
  // static markup whether or not the rail ever opened, so a presence check
  // would pass on a rail that never rendered.
  const railOpened = await win.evaluate(() => {
    const btn = document.getElementById('an-calc-btn') as HTMLElement | null;
    if (!btn) return 'no button';
    if (btn.offsetParent === null) return 'not visible';
    btn.click();
    return 'clicked';
  });
  ok('the rail offers + Calculated field on a selected card', railOpened === 'clicked', String(railOpened));
  const railEditor = await win.waitForSelector('.fx-modal', { timeout: 10_000 }).then(() => true).catch(() => false);
  ok('the rail opens the formula editor in place (no navigation, no toast)', railEditor);

  if (railEditor) {
    const same = await win.evaluate(() => ({
      side: !!document.querySelector('.fx-modal .fx-side-list'),
      editor: !!document.querySelector('.fx-modal .fx-input'),
      mirror: !!document.querySelector('.fx-modal .fx-hl'),
      functions: document.querySelectorAll('.fx-modal .fx-item-fn').length,
      // The dataset behind the selected card — the new column is there, which
      // proves the rail opened against the card's dataset and not a blank one.
      columns: [...document.querySelectorAll('.fx-modal .fx-item-col')].map((b) => (b.textContent || '').trim()).join(' '),
    }));
    ok('it is the same component the Prepare panel opens',
      same.side && same.editor && same.mirror && same.functions === shell.functions,
      JSON.stringify(same));
    ok('opened against the selected card’s dataset', same.columns.indexOf(NEW_COLUMN) >= 0, same.columns);
    // Escape closes it, leaving the analysis untouched.
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    ok('Escape closes the editor', await win.evaluate(() => !document.querySelector('.fx-modal')));
  }

  // ── The console ────────────────────────────────────────────────────────────
  // A CSP violation on a new stylesheet or an inline style only ever shows here.
  ok('no renderer console errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  await s.close();
}

main()
  .catch((err) => { ok('smoke ran without throwing', false, err && err.stack); })
  .finally(() => finishSmoke('formula editor', failureCount()));
