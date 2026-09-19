// Control cards on the authoring sheet, and reading the dashboard they sit on:
// the add-control dialog's three kinds, the write invariant a live control must
// never break, the dashboards list, re-opening, Present mode and Export.
//
// Split out of smoke-app.ts (see that file's banner).
//
// THE INVARIANT is why this file drives the AUTHORING side. dashControls.ts's
// contract is that a control's live value is `controlState`, a renderer-only
// Map that must never itself trigger a write. On the PUBLISHED (read-only)
// side persistDashboard's own early-return makes that trivially true; the path
// a real regression would break is authoring, where markDashDirty() and
// anScheduleWrite() DO reach disk on a real edit. So: prove a chart redraws
// (a real effect), then prove the record file did not move — same mtime, same
// bytes.
//
// The analysis is SEEDED through main; the wizard that creates one for real is
// smoke-analysis-create.ts's subject.
//
//   npm run build:ts && node scripts/smoke-dashboard-controls.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedProject, seedAnalysis, openProject,
  openSeededAnalysis, domDriver, finishSmoke,
} from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// A renderer script-global (chartRender.js). Classic-script `const`s live in the
// global LEXICAL scope, not on `window`, so a page-context callback reaches it by
// bare name — but this file's own program has never seen it. Declared, not
// eval'd: the hub CSP is `script-src 'self'`, which blocks eval outright.
declare const chartInstances: { get(el: unknown): any };
// dashboards.js's module-local `let dashCurrent` — same lexical-global trick,
// used below only to read the open dashboard record's own id (never mutated
// from here).
declare const dashCurrent: any;

async function main(): Promise<void> {
  const smoke = await launchSmoke('dashboard-controls');
  const { app, win, errors, shotDir, userData } = smoke;

  const r = await seedProject(app, { rows: 5_000 });
  await seedAnalysis(app, r.projectId, {
    name: 'Smoke analysis',
    sheets: [{
      name: 'Sheet 1',
      cards: [
        // A KPI over the same column the chart sums, so a control's effect is
        // visible on a NUMBER as well as on a redrawn canvas — the figure is
        // what a reader actually reads off a filtered dashboard.
        { type: 'metric', metric: { datasetId: r.datasetId, column: 'amount', aggregation: 'sum', label: 'Revenue' },
          layout: { x: 0, y: 0, w: 3, h: 2 } },
        { type: 'visual', visualId: r.mapVisualId, layout: { x: 0, y: 2, w: 6, h: 6 } },
        // Grouped by 'region' — the same column the dropdown control below
        // filters, which is what makes "the chart redraws" a real effect.
        { type: 'visual', visualId: r.visualId, layout: { x: 0, y: 10, w: 6, h: 6 } },
      ],
    }],
  });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  // Playwright dismisses dialogs by default, which would silently answer "no"
  // to a window.confirm(). Accept them, and keep the text so an UNEXPECTED
  // alert is visible rather than swallowed.
  const dialogs: string[] = [];
  win.on('dialog', (d) => {
    dialogs.push(d.type() + ': ' + d.message());
    d.accept().catch(() => {});
  });

  const { clickExact, clickId } = domDriver(win);

  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  ok('the seeded dashboard opens from the list', await openSeededAnalysis(win, 'Smoke analysis'));
  await win.waitForTimeout(2500);

  // ── + Control: the author adds a control card, all three kinds touched ─────
  // Task 4's single dialog: three kind tiles, dataset, column, label, and a
  // live preview that becomes the default. One kind (dropdown, on 'region' —
  // the same column the 'Sales by region' visual card is grouped by) gets a
  // REAL card, which the safety-guarantee and drill-chip checks right after
  // publish depend on. Multi and date_range get a lighter DOM-presence check
  // of their preview shape, per the task-6 brief — this dialog is the only
  // place all three kinds are on screen at once.
  ok('+ Control opens the add-control dialog', await clickId('dash-add-control'));
  await win.waitForTimeout(500);
  const dcOpen = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal');
    return {
      open: !!box,
      tiles: box ? [...box.querySelectorAll('.dc-kind-tile')].map((t) => (t as HTMLElement).dataset.kind) : [],
      dropdownOn: !!box?.querySelector('.dc-kind-tile[data-kind="dropdown"].is-on'),
    };
  });
  ok('the dialog offers all three kinds, dropdown selected by default',
     dcOpen.open && JSON.stringify(dcOpen.tiles) === JSON.stringify(['dropdown', 'multi', 'date_range'])
       && dcOpen.dropdownOn, JSON.stringify(dcOpen));

  // Pick the 'Sales' dataset — every kind's preview reads its columns.
  await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const dsSel = box.querySelector('.dm-field select') as HTMLSelectElement;
    const opt = [...dsSel.options].find((o) => o.textContent === 'Sales');
    if (opt) dsSel.value = opt.value;
    dsSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.waitForTimeout(700); // column list load (getDatasetMeta)

  // multi kind → preview is a checkbox list (fd-list, reused from the filter dialog).
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="multi"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the multi kind previews as a checkbox list',
     await win.evaluate(() => !!document.querySelector('.dash-control-modal .dc-preview .fd-list')));

  // date_range kind → preview is two native date inputs.
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="date_range"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the date_range kind previews as two date inputs',
     await win.evaluate(() =>
       document.querySelectorAll('.dash-control-modal .dc-preview input[type=date]').length === 2));

  // Back to dropdown — the kind actually added.
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="dropdown"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the dropdown kind previews as a native select',
     await win.evaluate(() => !!document.querySelector('.dash-control-modal .dc-preview select')));

  const dcColumn = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const colSel = box.querySelectorAll('.dm-field select')[1] as HTMLSelectElement;
    const opt = [...colSel.options].find((o) => o.value === 'region');
    if (!opt) return { ok: false, options: [...colSel.options].map((o) => o.value) };
    colSel.value = 'region';
    colSel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('the region column is selectable for the dropdown control', dcColumn.ok === true, JSON.stringify(dcColumn));
  await win.waitForTimeout(500); // preview options load, label auto-fills to "Filter by region"

  const dcAdded = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const label = (box.querySelector('.dm-field input[type=text]') as HTMLInputElement | null)?.value || '';
    const btn = [...box.querySelectorAll('.ws-modal-actions .btn')]
      .find((b) => (b.textContent || '').trim() === 'Add') as HTMLButtonElement | undefined;
    if (!btn || btn.disabled) return { ok: false, label };
    btn.click();
    return { ok: true, label };
  });
  ok('Add creates the control card, auto-labelled from the column',
     dcAdded.ok === true && dcAdded.label === 'Filter by region', JSON.stringify(dcAdded));
  await win.waitForTimeout(2500); // render + debounced autosave

  // THE BUG THIS BRANCH FIXES. `dashFindSlot(cards, 3, 1)` placed the control as
  // a 3x1 TILE in the first free cell — on a full sheet, the row below the last
  // card — and the card body's `overflow` clipped the <select> inside it. It is
  // a chip in the filter bar between the page tabs and the grid now.
  const withControlCard = await win.evaluate(() => {
    const bar = document.getElementById('dash-control-bar') as HTMLElement | null;
    const chip = document.querySelector('.dash-filter-bar .dash-fb-chip') as HTMLElement | null;
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLElement | null;
    const grid = document.getElementById('dash-grid') as HTMLElement | null;
    const cr = chip ? chip.getBoundingClientRect() : null;
    const gr = grid ? grid.getBoundingClientRect() : null;
    const sr = sel ? sel.getBoundingClientRect() : null;
    return {
      tiles: document.querySelectorAll('#dash-grid .dash-card').length,
      inGrid: document.querySelectorAll('#dash-grid .dash-card--control').length,
      barVisible: !!bar && !bar.hidden && bar.getBoundingClientRect().height > 0,
      chipLabel: chip ? (chip.querySelector('.dash-fb-chip-label')?.textContent || '') : '',
      select: !!sel,
      // Above the grid, not below it — the whole point of the move.
      aboveGrid: !!cr && !!gr && cr.bottom <= gr.top + 1,
      // And the widget is not clipped by whatever contains it.
      selectVisible: !!sr && sr.width > 40 && sr.height > 10,
    };
  });
  ok('the control renders as a chip in the filter bar, not as a grid tile',
     withControlCard.barVisible && withControlCard.select && withControlCard.inGrid === 0,
     JSON.stringify(withControlCard));
  ok('…labelled, above the grid, and not clipped',
     withControlCard.chipLabel === 'Filter by region' && withControlCard.aboveGrid
       && withControlCard.selectVisible, JSON.stringify(withControlCard));
  ok('…and the grid still holds exactly the three real tiles',
     withControlCard.tiles === 3, String(withControlCard.tiles));

  // multi and date_range each get a REAL card too, not just a dialog preview —
  // the dropdown above already proved the dialog mechanics (three tiles,
  // dataset/column pick, auto-label, Add), so these two just reopen it and
  // submit; a chart/drill walk this thorough for all three would be
  // redundant with controlSteps' per-kind node coverage, but a real card is
  // what proves the multi popover and the date-range widget actually render
  // and can be interacted with as a READER (below, on the published
  // dashboard) — a bug unique to either widget's DOM (a CSP violation, a
  // rendering crash) is exactly what a dialog-preview-only check would miss.
  const addControlCard = async (
    kind: 'multi' | 'date_range', column: string,
  ): Promise<{ ok: boolean; label?: string }> => {
    if (!(await clickId('dash-add-control'))) return { ok: false };
    await win.waitForTimeout(400);
    await win.evaluate(() => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const dsSel = box.querySelector('.dm-field select') as HTMLSelectElement;
      const opt = [...dsSel.options].find((o) => o.textContent === 'Sales');
      if (opt) dsSel.value = opt.value;
      dsSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await win.waitForTimeout(600); // column list load
    await win.evaluate((k: string) => {
      (document.querySelector(`.dash-control-modal .dc-kind-tile[data-kind="${k}"]`) as HTMLElement).click();
    }, kind);
    await win.waitForTimeout(300);
    const picked = await win.evaluate((col: string) => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const colSel = box.querySelectorAll('.dm-field select')[1] as HTMLSelectElement;
      const opt = [...colSel.options].find((o) => o.value === col);
      if (!opt) return false;
      colSel.value = col;
      colSel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, column);
    if (!picked) return { ok: false };
    await win.waitForTimeout(400); // label auto-fills
    const result = await win.evaluate(() => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const label = (box.querySelector('.dm-field input[type=text]') as HTMLInputElement | null)?.value || '';
      const btn = [...box.querySelectorAll('.ws-modal-actions .btn')]
        .find((b) => (b.textContent || '').trim() === 'Add') as HTMLButtonElement | undefined;
      if (!btn || btn.disabled) return { ok: false, label };
      btn.click();
      return { ok: true, label };
    });
    await win.waitForTimeout(2000);
    return result;
  };

  const multiAdded = await addControlCard('multi', 'region');
  ok('a real multi control card is added too', multiAdded.ok === true, JSON.stringify(multiAdded));
  const dateAdded = await addControlCard('date_range', 'sku');
  ok('a real date_range control card is added too', dateAdded.ok === true, JSON.stringify(dateAdded));

  const withAllControlCards = await win.evaluate(() => ({
    tiles: document.querySelectorAll('#dash-grid .dash-card').length,
    inGrid: document.querySelectorAll('#dash-grid .dash-card--control').length,
    chips: document.querySelectorAll('.dash-filter-bar .dash-fb-chip').length,
    dropdown: !!document.querySelector('.dash-filter-bar .dash-ctrl-select'),
    multiChip: !!document.querySelector('.dash-filter-bar .dash-ctrl-chip'),
    dateInputs: document.querySelectorAll('.dash-filter-bar .dash-ctrl-date').length,
  }));
  ok('all three control kinds sit in the bar as chips, none in the grid',
     withAllControlCards.tiles === 3 && withAllControlCards.inGrid === 0 &&
       withAllControlCards.chips === 3 && withAllControlCards.dropdown &&
       withAllControlCards.multiChip && withAllControlCards.dateInputs === 2,
     JSON.stringify(withAllControlCards));

  // Snapshot the first live chart's labels+values, to prove a control redraws it.
  const chartSnapshot = async () => {
    await win
      .waitForFunction(() => {
        const areas = [...document.querySelectorAll('#dash-grid .dash-viz-area')] as HTMLElement[];
        return areas.some((a) => !!a.querySelector('canvas') && !!chartInstances.get(a));
      }, undefined, { timeout: 30_000 })
      .catch(() => {});
    return win.evaluate(() => {
      const areas = [...document.querySelectorAll('#dash-grid .dash-viz-area')] as HTMLElement[];
      const area = areas.find((a) => !!chartInstances.get(a));
      const chart: any = area && chartInstances.get(area);
      if (!chart) return null;
      return {
        labels: (chart.data.labels || []).slice(),
        values: ((chart.data.datasets[0] && chart.data.datasets[0].data) || []).slice(),
      };
    });
  };

  /**
   * Pick a value in the bar's dropdown, the way a reader does.
   *
   * THE OPTION LIST IS LAZY (renderDropdownControl): it loads on first
   * focus/mousedown, and every renderDashGrid rebuilds the chip with a fresh
   * <select> that is back to just "All". Assigning a value that is not among
   * the options silently leaves it '' — a pick that does nothing, and an
   * assertion that passes for the wrong reason. So every pick re-opens the list
   * first, and this reports whether the value actually took.
   */
  const pickRegion = async (value: string): Promise<boolean> => {
    await win.evaluate(() => {
      const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
      sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
      sel?.dispatchEvent(new Event('focus', { bubbles: true }));
    });
    await win.waitForTimeout(1000);
    const took = await win.evaluate((v: string) => {
      const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
      if (!sel || ![...sel.options].some((o) => o.value === v)) return false;
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, value);
    await win.waitForTimeout(1800);
    return took;
  };

  // The KPI's rendered text — what a reader actually reads off a dashboard, and
  // the thing a filter is supposed to move.
  const kpiText = () => win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => /Revenue/.test(c.querySelector('.dash-card-title')?.textContent || ''));
    return (card?.querySelector('.dash-metric-value')?.textContent || '').trim();
  });

  // ── THE SAME INVARIANT, on the AUTHORING side ───────────────────────────────
  // The path a future regression would break: the dashboard is open for
  // authoring, where markDashDirty()/anScheduleWrite() DO reach disk on a real
  // edit. dashControls.ts's own contract (see its file banner) is that a
  // control's live value is `controlState`, a renderer-only Map that must
  // never itself trigger a write — even here, even though other edits on this
  // same screen do. Prove a chart redraws (real effect), then prove the record
  // file didn't move.
  const analysisId: string | null = await win.evaluate(() => (dashCurrent && dashCurrent.id) || null);
  ok('the open analysis record has an id to stat on disk',
     typeof analysisId === 'string' && analysisId.length > 0, String(analysisId));
  const anRecordPath = path.join(userData, 'projects', r.projectId, 'analyses', analysisId + '.json');
  ok('the analysis record exists on disk before the interaction', fs.existsSync(anRecordPath), anRecordPath);
  const anStatBefore = fs.statSync(anRecordPath);
  const anBytesBefore = fs.readFileSync(anRecordPath);

  const anChartBefore = await chartSnapshot();
  ok('a chart on the open analysis sheet has rendered data to compare',
     !!anChartBefore && Array.isArray((anChartBefore as any).labels) && (anChartBefore as any).labels.length > 1,
     JSON.stringify(anChartBefore));
  const kpiBefore = await kpiText();
  ok('the Revenue KPI shows an unfiltered figure to compare',
     /\d/.test(kpiBefore), JSON.stringify(kpiBefore));

  // Load the dropdown's real option list the way an author would — on first
  // focus (dashControls.ts's renderDropdownControl loads lazily).
  await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1000);
  // The fixture seeds seven regions ('region0'..'region6'), so the option list
  // is the REAL distinct values off the column plus the "All" placeholder — not
  // a truncated page and not a stale render.
  const options = await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    return sel ? [...sel.options].map((o) => o.value) : null;
  });
  ok('the chip\'s select lists every region in the data, behind All',
     JSON.stringify(options) === JSON.stringify(
       ['', 'region0', 'region1', 'region2', 'region3', 'region4', 'region5', 'region6']),
     JSON.stringify(options));

  const pickedRegion3 = await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    if (!sel) return { ok: false };
    const opt = [...sel.options].find((o) => o.value === 'region3');
    if (!opt) return { ok: false, options: [...sel.options].map((o) => o.value) };
    sel.value = 'region3';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('a control can still be worked while the analysis is open for authoring',
     pickedRegion3.ok === true, JSON.stringify(pickedRegion3));
  await win.waitForTimeout(1800); // renderDashGrid + computeVisualData round trip

  const anChartAfter = await chartSnapshot();
  ok('…and it has a real effect: the chart redraws with different data',
     !!anChartAfter && JSON.stringify(anChartAfter) !== JSON.stringify(anChartBefore),
     `before=${JSON.stringify(anChartBefore)} after=${JSON.stringify(anChartAfter)}`);
  const kpiAfter = await kpiText();
  ok('…and the Revenue KPI narrows with it', /\d/.test(kpiAfter) && kpiAfter !== kpiBefore,
     `before=${kpiBefore} after=${kpiAfter}`);
  const chipOn = await win.evaluate(() => ({
    on: !!document.querySelector('.dash-filter-bar .dash-fb-chip--on'),
    x: !!document.querySelector('.dash-filter-bar .dash-fb-chip-x'),
    clearAll: (document.getElementById('dash-fb-clear') as HTMLElement | null)?.hidden === false,
    fresh: (document.getElementById('dash-fresh')?.textContent || ''),
  }));
  ok('…the chip reads as ON, with a × and a Clear all beside it',
     chipOn.on && chipOn.x && chipOn.clearAll, JSON.stringify(chipOn));
  ok('…and the header says the figures under it are filtered',
     / · filtered$/.test(chipOn.fresh), JSON.stringify(chipOn.fresh));

  const anStatAfter = fs.statSync(anRecordPath);
  const anBytesAfter = fs.readFileSync(anRecordPath);
  ok('THE INVARIANT, authoring side: the analysis record file did not move on disk (same mtime)',
     anStatAfter.mtimeMs === anStatBefore.mtimeMs,
     `before=${anStatBefore.mtimeMs} after=${anStatAfter.mtimeMs}`);
  ok('…and its bytes are byte-for-byte identical (same size, same content)',
     anBytesBefore.equals(anBytesAfter),
     `${anBytesBefore.length}B -> ${anBytesAfter.length}B`);

  // Back to All, so nothing carries into the "add a sheet" edit right below
  // (which SHOULD dirty and write the record — this just keeps that write's
  // diff free of an incidental control pick).
  //
  // Clear all, not Reset controls: none of these controls has a PUBLISHED
  // default, so the two buttons would be the same click and dashControls.ts
  // deliberately shows only this one. Reset controls comes back below, once
  // "Set as default" has given it something to reset to.
  ok('Clear all is the bar\'s reset while no control has a default',
     await clickId('dash-fb-clear'));
  await win.waitForTimeout(2000);
  const cleared = await win.evaluate(() => ({
    on: !!document.querySelector('.dash-filter-bar .dash-fb-chip--on'),
    clearAll: (document.getElementById('dash-fb-clear') as HTMLElement | null)?.hidden === false,
    fresh: (document.getElementById('dash-fresh')?.textContent || ''),
  }));
  ok('…and the KPI returns to its unfiltered figure', (await kpiText()) === kpiBefore,
     `before=${kpiBefore} now=${await kpiText()}`);
  ok('…the chip is back to All, and Clear all goes away with it',
     !cleared.on && !cleared.clearAll, JSON.stringify(cleared));
  ok('…as does the "· filtered" note', !/ · filtered/.test(cleared.fresh), JSON.stringify(cleared.fresh));

  // ── The chip's ⋯ menu: Edit / Set as default / Remove ─────────────────────
  // The actions a control tile's header never carried. `openRowMenu`
  // (projects.js) is reused, so this is the same popup as the dashboards list's
  // ⋯ — positioned fixed against the trigger, which is why "on screen next to
  // its button" is the question, not "does it exist".
  const chipMenu = await win.evaluate(() => {
    const btn = document.querySelector('.dash-filter-bar .dash-fb-chip-menu') as HTMLElement | null;
    if (!btn) return { opened: false };
    btn.click();
    const pop = document.querySelector('.project-card-popup') as HTMLElement | null;
    if (!pop) return { opened: false };
    const pr = pop.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      opened: true,
      items: [...pop.querySelectorAll('.project-card-popup-item')].map((b) => (b.textContent || '').trim()),
      danger: !!pop.querySelector('.project-card-popup-danger'),
      onScreen: pr.width > 0 && pr.height > 0 && pr.top >= 0 && pr.left >= 0 &&
                pr.bottom <= window.innerHeight && pr.right <= window.innerWidth,
      anchored: Math.abs(pr.right - br.right) <= 2 && pr.top >= br.bottom - 1,
    };
  });
  ok('a chip carries a ⋯ menu', chipMenu.opened);
  // "Clear default", not "Set as default": the control is back at All after the
  // Clear all above, and a greyed-out item is not in this popup's vocabulary.
  ok('…with Edit / the default action / Remove in it',
     JSON.stringify(chipMenu.items) === JSON.stringify(['Edit…', 'Clear default', 'Remove']),
     JSON.stringify(chipMenu.items));
  ok('…Remove marked as the destructive one', !!chipMenu.danger);
  ok('…painted on screen and anchored to its chip',
     !!chipMenu.onScreen && !!chipMenu.anchored,
     `onScreen=${chipMenu.onScreen} anchored=${chipMenu.anchored}`);
  await win.evaluate(() => (document.body as HTMLElement).click());
  await win.waitForTimeout(300);

  // Pick a value, then publish it as the control's default — which is what the
  // reload below has to bring back.
  ok('the chip takes a pick again after Clear all rebuilt it', await pickRegion('region3'));
  ok('Set as default is offered once a value is picked', await win.evaluate(() => {
    const btn = document.querySelector('.dash-filter-bar .dash-fb-chip-menu') as HTMLElement | null;
    if (!btn) return false;
    btn.click();
    const items = [...document.querySelectorAll('.project-card-popup-item')] as HTMLElement[];
    const set = items.find((b) => (b.textContent || '').trim() === 'Set as default');
    if (!set) return false;
    set.click();
    return true;
  }));
  await win.waitForTimeout(2500); // renderDashGrid + the debounced record write
  // Still hidden, and correctly so: the live value IS the default now, so there
  // is nothing to go back to. It appears once the reader moves off it.
  ok('Reset controls stays hidden while the pick and the default agree',
     await win.evaluate(() => (document.getElementById('dash-reset-controls') as HTMLElement | null)?.hidden === true));
  ok('the reader can move off the default', await pickRegion('region5'));
  ok('…and Reset controls appears once they do',
     await win.evaluate(() => (document.getElementById('dash-reset-controls') as HTMLElement | null)?.hidden === false));
  ok('Reset controls puts the chip back on the default, not on All',
     await clickId('dash-reset-controls'));
  await win.waitForTimeout(1800);
  ok('…which is region3, the value that was published',
     await win.evaluate(() =>
       (document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null)?.value === 'region3'));

  ok('a sheet can be added to the analysis', await win.evaluate(() => {
    const add = document.querySelector('#dash-pages .dash-page-add') as HTMLElement | null;
    if (!add) return false;
    add.click();
    return true;
  }));
  await win.waitForTimeout(3000); // debounced save
  const twoSheets = await win.evaluate(() => ({
    tabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
  }));
  ok('the dashboard now has two sheets', twoSheets.tabs === 2, String(twoSheets.tabs));

  ok('no unexpected alert during the analysis flow', dialogs.length === 0, dialogs.join(' | '));

  // RELOADED, not just re-opened: the control, its label and its published
  // default have to come back out of the record on disk into a fresh renderer.
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  // The dashboards LIST.
  ok('back to Dashboards', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  const anRow = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list .an-card')].find((r) =>
      /Smoke analysis/.test(r.textContent || ''),
    );
    const vis = (id: string) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null;
    const r = row ? row.getBoundingClientRect() : null;
    return {
      found: !!row,
      text: row ? (row.textContent || '').trim().slice(0, 100) : '',
      // A collapsed card passes every structural check, so measure it.
      box: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : '0x0',
      laidOut: !!r && r.width > 100 && r.height > 100,
      preview: !!row?.querySelector('.an-card-prev .viz-card-tile'),
      tableVisible: vis('an-table'),
      emptyVisible: vis('an-list-empty'),
    };
  });
  ok('the dashboard is listed with its sheet count', !!anRow?.found,
     anRow ? anRow.text : 'not found');
  ok('a populated page shows the grid and hides the empty state',
     !!anRow && anRow.tableVisible && !anRow.emptyVisible, JSON.stringify({
       table: anRow?.tableVisible, empty: anRow?.emptyVisible }));
  ok('the card is laid out, not collapsed', !!anRow?.laidOut, anRow?.box);
  ok('and it carries a preview of the sheet, not just text', !!anRow?.preview);

  // The ⋯ row menu. Rename and Delete used to be two bare glyphs in the row; now
  // they live behind this. A popup is appended to <body> and positioned with
  // fixed coordinates, so "does it exist" is not the question — "is it on screen,
  // next to the button that opened it" is, and only a laid-out page can answer.
  const rowMenu = await win.evaluate(() => {
    const btn = document.querySelector('#an-list .an-row-menu') as HTMLElement | null;
    if (!btn) return { opened: false };
    btn.click();
    const pop = document.querySelector('.project-card-popup') as HTMLElement | null;
    if (!pop) return { opened: false };
    const pr = pop.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      opened: true,
      items: [...pop.querySelectorAll('.project-card-popup-item')].map((b) => (b.textContent || '').trim()),
      danger: !!pop.querySelector('.project-card-popup-danger'),
      onScreen: pr.width > 0 && pr.height > 0 && pr.top >= 0 && pr.left >= 0 &&
                pr.bottom <= window.innerHeight && pr.right <= window.innerWidth,
      // Right-aligned to the trigger, directly under it.
      anchored: Math.abs(pr.right - br.right) <= 2 && pr.top >= br.bottom - 1,
      inlineGlyphs: document.querySelectorAll('#an-list button:not(.an-card-body)').length,
    };
  });
  ok('the ⋯ row menu opens', rowMenu.opened);
  ok('…with Open / Rename / Delete inside it',
     JSON.stringify(rowMenu.items) === JSON.stringify(['Open', 'Rename', 'Delete']),
     JSON.stringify(rowMenu.items));
  ok('…Delete marked as the destructive one', !!rowMenu.danger);
  ok('…painted fully on screen and anchored to its button',
     !!rowMenu.onScreen && !!rowMenu.anchored,
     `onScreen=${rowMenu.onScreen} anchored=${rowMenu.anchored}`);
  // The row's only control is the trigger — the ✎/🗑 pair is gone, not just hidden.
  ok('and the row carries exactly one control, the trigger', rowMenu.inlineGlyphs === 1,
     `${rowMenu.inlineGlyphs} inline buttons`);

  const menuShot = path.join(shotDir, 'analyses-row-menu.png');
  await win.screenshot({ path: menuShot });
  ok('row-menu screenshot captured', fs.existsSync(menuShot) && fs.statSync(menuShot).size > 5000,
     `${Math.round(fs.statSync(menuShot).size / 1024)} KB -> ${menuShot}`);

  // Dismiss it, so the screenshot below and the draft dialog are not taken with
  // a popup floating over them.
  await win.evaluate(() => (document.body as HTMLElement).click());
  await win.waitForTimeout(300);
  ok('an outside click closes the ⋯ menu',
     await win.evaluate(() => !document.querySelector('.project-card-popup')));
  const listShot = path.join(shotDir, 'analyses-list.png');
  await win.screenshot({ path: listShot });
  ok('analyses list screenshot captured', fs.existsSync(listShot) && fs.statSync(listShot).size > 5000,
     `${Math.round(fs.statSync(listShot).size / 1024)} KB -> ${listShot}`);

  // ── Re-open the dashboard ───────────────────────────────────────────────────
  // Re-open the dashboard from the list so Present mode and Export below have an
  // open sheet to act on — and prove the second sheet and all three control
  // cards persisted through the edit and reload.
  ok('open the dashboard from the list', await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list .an-card')]
      .find((r) => /Smoke analysis/.test(r.textContent || '')) as HTMLElement | undefined;
    const openBtn = row?.querySelector('.an-card-body') as HTMLElement | undefined;
    if (!openBtn) return false;
    openBtn.click();
    return true;
  }));
  await win.waitForTimeout(2500);
  const reopened = await win.evaluate(() => ({
    pages: document.querySelectorAll('#dash-pages .dash-page-tab').length,
    tiles: document.querySelectorAll('#dash-grid .dash-card').length,
    inGrid: document.querySelectorAll('#dash-grid .dash-card--control').length,
    chips: document.querySelectorAll('.dash-filter-bar .dash-fb-chip').length,
    labels: [...document.querySelectorAll('.dash-filter-bar .dash-fb-chip-label')]
      .map((e) => (e.textContent || '').trim()),
    selected: (document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null)?.value,
    on: !!document.querySelector('.dash-filter-bar .dash-fb-chip--on'),
  }));
  ok('it reopens with the second sheet and all three tiles intact',
     reopened.pages === 2 && reopened.tiles === 3 && reopened.inGrid === 0,
     JSON.stringify(reopened));
  ok('…and all three chips are back in the bar, still labelled',
     reopened.chips === 3 && reopened.labels.filter((l) => /^Filter by /.test(l)).length === 3,
     JSON.stringify(reopened.labels));
  // The whole point of Set as default: a reader opens the dashboard already
  // narrowed, without touching anything.
  ok('…with the dropdown opened ON its published default, after a full reload',
     reopened.selected === 'region3' && reopened.on, JSON.stringify(reopened));

  // ── Present mode keeps controls usable ──────────────────────────────────────
  // Renderer-only, no window, no IPC (dashShare.ts) — a reader presenting a
  // dashboard must still be able to filter it.
  const presentBefore = await win.evaluate(() => ({
    presenting: document.documentElement.classList.contains('dash-presenting'),
  }));
  ok('Present mode is off at rest', !presentBefore.presenting);
  ok('Present is clickable', await clickId('dash-present-btn'));
  await win.waitForTimeout(800);
  const presenting = await win.evaluate(() => ({
    presenting: document.documentElement.classList.contains('dash-presenting'),
    exitVisible: (document.getElementById('dash-present-exit') as HTMLElement | null)?.hidden === false,
    controlUsable: !!document.querySelector('.dash-filter-bar .dash-ctrl-select'),
    barVisible: (document.getElementById('dash-control-bar') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    menusVisible: [...document.querySelectorAll('.dash-fb-chip-menu')]
      .filter((e) => (e as HTMLElement).offsetParent !== null).length,
    sampleBtnVisible: [...document.querySelectorAll('.dash-sample-delete')]
      .filter((e) => (e as HTMLElement).offsetParent !== null).length,
  }));
  ok('Present mode is on, with an Exit affordance', presenting.presenting && presenting.exitVisible,
     JSON.stringify(presenting));
  ok('…and the control widget is STILL a real, interactive select in Present mode',
     presenting.controlUsable && presenting.barVisible > 0, JSON.stringify(presenting));
  // Presenting is for showing. The bar stays because filtering is the point of
  // it; the authoring affordances on each chip go, like every other chrome.
  ok('…but the chips lose their ⋯ menus, and the sample note its Remove button',
     presenting.menusVisible === 0 && presenting.sampleBtnVisible === 0, JSON.stringify(presenting));
  const presentShot = path.join(shotDir, 'dashboard-present.png');
  await win.screenshot({ path: presentShot });
  ok('present-mode screenshot captured', fs.existsSync(presentShot) && fs.statSync(presentShot).size > 5000,
     `${Math.round(fs.statSync(presentShot).size / 1024)} KB -> ${presentShot}`);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(500);
  ok('Escape exits Present mode',
     await win.evaluate(() => !document.documentElement.classList.contains('dash-presenting')));

  // ── Export: no broken-card placeholder for the control, summary text shown ──
  // assembleExportBundle (dashShare.ts) deliberately gives a control card NO
  // grid-cell entry — it folds into `controlsSummary` instead, and is never
  // "broken" by design. Playwright cannot drive the native save panel, so the
  // main-process `dialog.showSaveDialog` is stubbed (this run's own tmp dir
  // only) to a real path — the export then writes an ACTUAL file, which is
  // read back and inspected. Stronger than the node-level unit test (Task 5),
  // which calls buildSelfContainedHtml directly and never exercises
  // assembleExportBundle or the dashboard:exportHtml IPC round trip.
  const exportPath = path.join(shotDir, 'dashboard-export.html');
  // ElectronApplication#evaluate hands the `electron` module itself as the
  // FIRST argument (unlike win.evaluate/app.evaluate calls elsewhere in this
  // file that ignore it and `process.mainModule.require('electron')` instead)
  // — using it directly here is what makes passing a second, real argument work.
  await app.evaluate((electron, dest: string) => {
    (globalThis as any).__smokeOrigShowSaveDialog = electron.dialog.showSaveDialog;
    electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
  }, exportPath);

  // Give the control an active value first, so the export actually has a
  // summary to show (an unset control contributes nothing, by design).
  await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1000);
  await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement;
    const opt = [...sel.options].find((o) => o.value === 'region3');
    if (opt) { sel.value = 'region3'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await win.waitForTimeout(1000);

  ok('Export… is clickable', await clickId('dash-export-btn'));
  await win.waitForTimeout(600);
  ok('the export dialog offers HTML / PDF / PNG, HTML first', await win.evaluate(() => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0)
      .map((o) => o.querySelector('.ws-modal'))[0] as HTMLElement | undefined;
    const sel = box?.querySelector('select') as HTMLSelectElement | undefined;
    return !!sel && [...sel.options].map((o) => o.value).join(',') === 'html,pdf,png';
  }));
  ok('choosing Export (HTML, the default) triggers the save', await win.evaluate(() => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0)
      .map((o) => o.querySelector('.ws-modal'))[0] as HTMLElement | undefined;
    const btn = box?.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await win.waitForTimeout(2500);

  // Restore the real dialog immediately — nothing later in this run should
  // ever have its save panel silently redirected.
  await app.evaluate((electron) => {
    if ((globalThis as any).__smokeOrigShowSaveDialog) {
      electron.dialog.showSaveDialog = (globalThis as any).__smokeOrigShowSaveDialog;
      delete (globalThis as any).__smokeOrigShowSaveDialog;
    }
  });

  ok('the export actually wrote a file', fs.existsSync(exportPath), exportPath);
  const exportHtml = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, 'utf8') : '';
  ok('…with the control summary rendered as plain text',
     /dash-controls-summary/.test(exportHtml) && /Filter by region/.test(exportHtml),
     `has-class=${/dash-controls-summary/.test(exportHtml)} has-text=${/Filter by region/.test(exportHtml)}`);
  ok('…no broken-card placeholder for the control (it has no grid cell, by design)',
     !/Unknown card/.test(exportHtml));
  ok('…and no live control widget leaked into the export (never a real <select> for it)',
     !/dash-ctrl-select/.test(exportHtml));

  ok('back to Dashboards', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('dashboard-controls', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
