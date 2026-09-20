// The authoring workbench: the tool rail, its one-at-a-time flyouts, what binds
// when a card is selected, and DIRECT MANIPULATION of a card on the grid.
//
// Split out of smoke-app.ts (see that file's banner). Every claim here is
// geometric, because that is the only kind a running window can settle: a
// flyout that renders at zero width, a field list in the right node but
// painting at zero height, a well that never accepts a drop, a CSP-blocked drag
// ghost — each of those passes a DOM-presence check and none of them works.
//
// The analysis is SEEDED through main rather than driven through the wizard.
// The wizard is smoke-analysis-create.ts's subject; re-clicking it here would
// make this file a second, weaker test of it, and the state this one needs
// (two visual cards, the map visual first so the Data panel binds to a known
// two-column dataset) is then exact instead of incidental.
//
//   npm run build:ts && node scripts/smoke-analysis-workbench.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedProject, seedAnalysis, openProject,
  openSeededAnalysis, domDriver, railDriver, finishSmoke,
} from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('analysis-workbench');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: 5_000 });
  await seedAnalysis(smoke.app, r.projectId, {
    name: 'Smoke analysis',
    sheets: [{
      name: 'Sheet 1',
      cards: [
        // FIRST, deliberately: the panels below bind to whichever card is
        // clicked first, and this one's dataset has exactly two columns.
        { type: 'visual', visualId: r.mapVisualId, layout: { x: 0, y: 0, w: 6, h: 6 } },
        { type: 'visual', visualId: r.visualId, layout: { x: 0, y: 8, w: 6, h: 6 } },
      ],
    }],
  });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const { clickExact } = domDriver(win);
  const { openPane } = railDriver(win);

  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  ok('the seeded dashboard opens from the list', await openSeededAnalysis(win, 'Smoke analysis'));
  await win.waitForTimeout(2500);

  // ── The authoring workbench ───────────────────────────────────────────────
  // At REST the user sees the top strip, the rail and the sheet — nothing else.
  // Asserted from a laid-out page: a panel that renders at zero width, a well
  // that never accepts a drop, and a CSP-blocked drag indicator all pass any
  // check made elsewhere.

  const bench = await win.evaluate(() => {
    const host = document.getElementById('an-editor-host') as HTMLElement | null;
    const left = document.getElementById('an-side-left') as HTMLElement | null;
    const right = document.getElementById('an-side-right') as HTMLElement | null;
    const rail = document.getElementById('an-rail') as HTMLElement | null;
    const ed = document.getElementById('dash-editor') as HTMLElement | null;
    const r = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
    const N = r(rail), E = r(ed);
    return {
      active: !!host?.classList.contains('is-active'),
      // Closed at rest — and a closed panel must take NO width, or the rail
      // bought nothing.
      leftShut: !left || left.offsetParent === null,
      // The right-hand column was DELETED, not hidden — Properties is a rail
      // flyout now. Asserting absence, because a hidden-but-present panel still
      // binds to a card and still writes.
      rightGone: !right,
      railW: Math.round(N?.width || 0),
      // Source order is rail, flyouts, editor — `order` is what puts the sheet
      // after the rail, so this asserts the CSS actually applied.
      inOrder: !!(N && E) && N.left < E.left,
      // The sheet gets nearly the whole window minus the rail.
      sheetW: Math.round(E?.width || 0),
      winW: window.innerWidth,
    };
  });
  // Focus mode: an open analysis owns the window, so the project nav is gone —
  // the reference has no nav while you author, and four columns competing for
  // the width is what made this read as stuffed.
  const focus = await win.evaluate(() => {
    const nav = document.getElementById('workspace-nav') as HTMLElement | null;
    const head = document.querySelector('.dash-editor-head') as HTMLElement | null;
    const kids = head ? [...head.children] as HTMLElement[] : [];
    const tops = new Set(kids.filter((k) => k.offsetParent !== null)
      .map((k) => Math.round(k.getBoundingClientRect().top)));
    return {
      focusOn: document.body.classList.contains('an-focus'),
      navHidden: !nav || nav.offsetParent === null,
      // "One row" is the HEAD's height, not the children's top edges —
      // align-items:center gives items of different heights different tops
      // while they share a row, which is what this first (wrongly) measured.
      headH: Math.round(head?.getBoundingClientRect().height || 0),
      headRows: tops.size,
      backOffered: kids.some((k) => /Back/.test(k.textContent || '') && k.offsetParent !== null),
    };
  });
  ok('an open analysis takes the window, and the project nav steps aside',
     focus.focusOn && focus.navHidden, JSON.stringify(focus));
  ok('…its toolbar stays on one row', focus.headH > 0 && focus.headH <= 50,
     `head is ${focus.headH}px tall (one row of 26px buttons + padding)`);
  ok('…with Back as the way out, since the nav is gone', focus.backOffered);

  ok('the workbench is a rail beside the sheet, in the right order',
     bench.active && bench.inOrder && bench.railW > 30 && bench.railW < 70,
     JSON.stringify(bench));
  ok('…with the flyout shut at rest, so the sheet has the window',
     bench.leftShut && bench.rightGone && bench.sheetW > bench.winW - 90,
     JSON.stringify({ left: bench.leftShut, rightGone: bench.rightGone,
                      sheet: bench.sheetW, win: bench.winW }));

  // PROBLEM 1: the strip has to span the WINDOW, not just the canvas. It used to
  // live inside #dash-editor — the centre column — so it started to the right of
  // an open flyout and read as a third column header. Measured with a flyout
  // OPEN, because that is the only state where the bug is visible.
  await openPane('an-pane-data');
  const strip = await win.evaluate(() => {
    const head = document.querySelector('.dash-editor-head') as HTMLElement | null;
    const rail = document.getElementById('an-rail') as HTMLElement | null;
    const side = document.getElementById('an-side-left') as HTMLElement | null;
    const H = head?.getBoundingClientRect();
    const R = rail?.getBoundingClientRect();
    const S = side?.getBoundingClientRect();
    return {
      // Outside the editor, above the workbench.
      outsideEditor: !document.querySelector('#dash-editor .dash-editor-head'),
      w: Math.round(H?.width || 0),
      winW: window.innerWidth,
      // Starts at the window's left edge, not after the rail or the flyout…
      startsAtEdge: !!H && H.left <= 2,
      // …and sits ABOVE both of them.
      aboveRail: !!(H && R) && H.bottom <= R.top + 1,
      aboveFlyout: !!(H && S) && H.bottom <= S.top + 1,
    };
  });
  ok('the top strip spans the full window, above the rail and the flyout',
     strip.outsideEditor && strip.w > strip.winW - 4 && strip.startsAtEdge &&
       strip.aboveRail && strip.aboveFlyout, JSON.stringify(strip));
  // Leave it as we found it — the at-rest screenshot below wants nothing open.
  await win.evaluate(() =>
    (document.querySelector('#an-rail .an-rail-btn.is-on') as HTMLElement | null)?.click());
  await win.waitForTimeout(120);

  // The resting state is the claim this whole surface makes — top strip, rail,
  // sheet, nothing else — so photograph it before anything opens a flyout.
  const restShot = path.join(shotDir, 'analysis-at-rest.png');
  await win.screenshot({ path: restShot });
  ok('analysis at-rest screenshot captured',
     fs.existsSync(restShot) && fs.statSync(restShot).size > 5000,
     `${Math.round(fs.statSync(restShot).size / 1024)} KB -> ${restShot}`);

  // Every pane the rail offers, in rail order. ONE list, used twice: it is both
  // what the rail must SHOW and what "exactly one panel at a time" is checked
  // across. Adding a pane to `authoring.ts` and not here fails LOUDLY — which
  // is what happened when feat/insights added `an-pane-insights` and this file
  // was the only thing pinning the old four. So it stays an exhaustive list
  // rather than becoming a prefix match: the failure is the feature.
  const panes = [
    'an-pane-data', 'an-pane-visuals', 'an-pane-filter', 'an-pane-props', 'an-pane-insights',
  ];

  // ── The tool rail ─────────────────────────────────────────────────────────
  // Icon-only chrome is where dead controls hide: nothing labels them, so a
  // button wired to nothing looks identical to one that works. Assert every
  // icon has an accessible name AND a hover title, and that each really opens
  // its panel.
  const rail = await win.evaluate(() => {
    const r = document.getElementById('an-rail') as HTMLElement | null;
    const btns = [...(r?.querySelectorAll('.an-rail-btn') || [])] as HTMLButtonElement[];
    return {
      visible: !!r && r.offsetParent !== null,
      panes: btns.map((b) => b.dataset.pane),
      allLabelled: btns.every((b) => !!b.getAttribute('aria-label') && !!b.getAttribute('title')),
      allSvg: btns.every((b) => !!b.querySelector('svg')),
    };
  });
  ok('the tool rail is on screen, every icon named, titled and drawn',
     rail.visible && rail.allLabelled && rail.allSvg &&
       JSON.stringify(rail.panes) ===
         JSON.stringify(panes),
     JSON.stringify(rail));

  // ONE flyout at a time, and clicking the lit icon closes it. That is the
  // whole point of the rail — two panels stacked is what it replaced.
  await openPane('an-pane-data');
  const flyout = await win.evaluate((ids: string[]) => {
    const shown = () => ids
      .filter((id) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null);
    const afterData = shown();
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-visuals"]') as HTMLElement).click();
    const afterVisuals = shown();
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-visuals"]') as HTMLElement).click();
    const afterClose = shown();
    const sideShut = (document.getElementById('an-side-left') as HTMLElement | null)?.offsetParent == null;
    return { afterData, afterVisuals, afterClose, sideShut };
  }, panes);
  ok('the rail opens exactly one panel, and the next one replaces it',
     JSON.stringify(flyout.afterData) === JSON.stringify(['an-pane-data']) &&
       JSON.stringify(flyout.afterVisuals) === JSON.stringify(['an-pane-visuals']),
     JSON.stringify(flyout));
  ok('…and clicking the lit icon closes the flyout entirely',
     flyout.afterClose.length === 0 && flyout.sideShut, JSON.stringify(flyout.afterClose));

  // The one add path: the head strip's + Text opens its modal directly. (The
  // rail's + pane, which used to delegate to it, no longer exists.)
  const headAdd = await win.evaluate(() => {
    (document.getElementById('dash-add-text') as HTMLElement).click();
    const opened = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0);
    const open = opened.length > 0;
    // Remove only what this click created. The import dialog is part of the
    // page and removing it would break every later import.
    opened.forEach((o) => o.remove());
    return open;
  });
  ok('…and the head strip\'s + Text opens its add-card modal', headAdd);

  // The analysis-wide filter bar really MOVED into the Filters flyout — it is
  // one element with two hosts, so a copy left behind would be a second, dead
  // filter row on the sheet.
  await openPane('an-pane-filter');
  const filterPane = await win.evaluate(() => ({
    inFlyout: !!document.querySelector('#an-filter-body .dash-toolbar'),
    onSheet: !!document.querySelector('#dash-editor > .dash-toolbar'),
    addFilterVisible:
      (document.getElementById('dash-add-filter') as HTMLElement | null)?.offsetParent != null,
  }));
  ok('the filter bar moved into the Filters flyout, leaving none on the sheet',
     filterPane.inFlyout && !filterPane.onSheet && filterPane.addFilterVisible,
     JSON.stringify(filterPane));

  // Nothing is selected yet, so the panels must say so rather than show a stale
  // or half-bound state.
  await openPane('an-pane-data');
  const unboundData = await win.evaluate(() =>
    (document.getElementById('an-data-hint') as HTMLElement)?.offsetParent !== null);
  await openPane('an-pane-props');
  const unboundViz = await win.evaluate(() =>
    (document.getElementById('an-props-inner') as HTMLElement)?.offsetParent == null);
  ok('with nothing selected, the panels say so', unboundData && unboundViz,
     JSON.stringify({ dataHint: unboundData, propsInnerHidden: unboundViz }));

  // SELECT the card. This is the whole binding.
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement).click());
  // Wait for the CHIP ROW as well as the field list. They arrive on separate
  // async paths — the fields as soon as the dataset's columns load, the chips
  // only once the visual's data has been computed in main — so waiting on the
  // fields alone left `bound.chips` a race. It read 0 on a CI runner while
  // passing on a dev machine, and because this single snapshot is asserted
  // again 150 and 480 lines below, the flake surfaced far from its cause.
  await win.waitForFunction(
    () => document.querySelectorAll('#an-fields .an-field').length > 0
      && document.querySelectorAll('#an-switcher .an-typerow').length > 0,
    undefined,
    { timeout: 30_000 },
  ).catch(() => {}); // fall through; the assertions below report what is there
  const bound = await win.evaluate(() => {
    const fields = [...document.querySelectorAll('#an-fields .an-field')] as HTMLElement[];
    const wells = [...document.querySelectorAll('#an-wells [data-well]')] as HTMLElement[];
    return {
      selectedCards: document.querySelectorAll('#dash-grid .dash-card.is-selected').length,
      fields: fields.map((f) => f.dataset.column),
      allDraggable: fields.every((f) => f.draggable),
      wells: wells.map((w) => w.dataset.well),
      wellsVisible: wells.every((w) => w.offsetParent !== null),
      chips: document.querySelectorAll('#an-switcher .an-typerow').length,
      propsRows: document.querySelectorAll('#an-props .an-sec').length,
      title: (document.querySelector('#an-props .an-prop-input') as HTMLInputElement)?.value || '',
    };
  });
  ok('clicking a card selects exactly one', bound.selectedCards === 1, String(bound.selectedCards));
  ok('…and the Data panel lists that visual\'s dataset columns, all draggable',
     JSON.stringify(bound.fields) === JSON.stringify(['state', 'revenue']) && bound.allDraggable,
     JSON.stringify(bound.fields));
  ok('…the wells are mounted and visible',
     JSON.stringify(bound.wells) === JSON.stringify(['category', 'values', 'series', 'filters']) &&
       bound.wellsVisible, JSON.stringify(bound.wells));

  // DRAG NEEDS BOTH ENDS. The field list is the drag source and the wells are
  // the drop target; only one flyout is open, so the list has to have MOVED into
  // the PROPERTIES pane, which is where the wells now live. Asserted by geometry,
  // not by parentage: a list in the right node but painting at zero height is
  // still undraggable.
  const dragReach = await win.evaluate(() => {
    const f = document.querySelector('#an-fields .an-field') as HTMLElement | null;
    const w = document.querySelector('#an-wells [data-well="values"]') as HTMLElement | null;
    return {
      inProps: !!document.querySelector('#an-props-fields #an-fields'),
      // Exactly one field list in the DOM — moved, not copied.
      lists: document.querySelectorAll('#an-fields').length,
      fieldBox: Math.round(f?.getBoundingClientRect().height || 0),
      wellBox: Math.round(w?.getBoundingClientRect().height || 0),
      // The fields sit above the wells, which is what makes the drag a short one.
      above: !!(f && w) && f.getBoundingClientRect().top < w.getBoundingClientRect().top,
      calcTravelled: !!document.querySelector('#an-props-fields #an-calc-btn'),
    };
  });
  ok('…and the field list moved in beside them, so a field can be dragged to a well',
     dragReach.inProps && dragReach.lists === 1 && dragReach.fieldBox > 0 &&
       dragReach.wellBox > 0 && dragReach.above && dragReach.calcTravelled,
     JSON.stringify(dragReach));

  // TABS: what it PLOTS (Build) and how it LOOKS (Format). Exactly one panel is
  // on screen at a time — a "tab" that leaves both mounted is just a heading.
  const tabs = await win.evaluate(() => {
    const has = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return !!el && el.offsetParent !== null;
    };
    const strip = [...document.querySelectorAll('#an-tabs .an-tab')] as HTMLElement[];
    const before = {
      labels: strip.map((t) => (t.textContent || '').trim()),
      // Announceable without icons: role, aria-selected and aria-controls.
      roles: strip.every((t) => t.getAttribute('role') === 'tab' && !!t.getAttribute('aria-controls')),
      listRole: document.getElementById('an-tabs')?.getAttribute('role'),
      buildOn: has('#an-tabp-build .an-wells'),
      formatOff: !has('#an-tabp-format .an-props'),
      selBuild: strip[0]?.getAttribute('aria-selected'),
    };
    // Switch to Format.
    strip[1].click();
    return {
      ...before,
      afterBuildOff: !has('#an-tabp-build .an-wells'),
      afterFormatOn: has('#an-tabp-format .an-props'),
      selFormat: strip[1].getAttribute('aria-selected'),
      stored: localStorage.getItem('anPropsTab'),
    };
  });
  ok('Properties is a tab strip — Build / Format / Interactions, none named after its container',
     JSON.stringify(tabs.labels) === JSON.stringify(['Build', 'Format', 'Interactions']) &&
       tabs.listRole === 'tablist' && tabs.roles, JSON.stringify(tabs));
  ok('…and exactly one panel is mounted at a time, with aria following',
     tabs.buildOn && tabs.formatOff && tabs.afterBuildOff && tabs.afterFormatOn &&
       tabs.selBuild === 'true' && tabs.selFormat === 'true', JSON.stringify(tabs));

  // The active tab must survive re-binding — clicking a different card cannot
  // throw you back to Build mid-edit. Format is open from the switch above.
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement).click());
  await win.waitForTimeout(900);
  const tabKept = await win.evaluate(() => ({
    stillFormat: (document.getElementById('an-tabp-format') as HTMLElement)?.offsetParent !== null,
    lit: (document.querySelector('#an-tabs .an-tab.is-on') as HTMLElement | null)?.textContent?.trim(),
  }));
  ok('…and the active tab survives re-selecting a card', tabKept.stillFormat &&
     tabKept.lit === 'Format', JSON.stringify(tabKept));
  // Back to Build: everything below measures the wells.
  await win.evaluate(() => (document.getElementById('an-tab-build') as HTMLElement).click());
  await win.waitForTimeout(150);

  // Click-to-fill targets the next EMPTY well, so the feature never depends on
  // drag. Checked as a pure mapping against the live encoding (category filled,
  // Split by empty) rather than by clicking, which would mutate the shared visual
  // every later map assertion reads.
  const nextWell = await win.evaluate(() => ({
    enc: (window as any).anNextWell ? 'wired' : 'missing',
    text: (window as any).anNextWell('text'),
    number: (window as any).anNextWell('number'),
  }));
  ok('a clicked field targets the next empty well, by type',
     nextWell.text === 'series' && nextWell.number === 'values', JSON.stringify(nextWell));
  // ── Drag to move, drag an edge to resize ──────────────────────────────────
  // A real pointer gesture: pointerdown on the header, pointermove across the
  // grid, pointerup. Asserted through the LAYOUT the card lands on, because that
  // is the thing being manipulated. The ghost must appear during the drag and
  // the card must NOT move until release — re-laying out mid-drag would
  // re-render the chart on every frame.
  const moved: any = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const head = el.querySelector('.dash-card-head') as HTMLElement;
    const grid = document.getElementById('dash-grid') as HTMLElement;
    const before = el.style.gridColumn;
    const pitch = (grid.getBoundingClientRect().width + 12) / 12;
    const r = head.getBoundingClientRect();
    const opts = (x: number, y: number) =>
      ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 });
    head.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 20, r.top + 8)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 20 + pitch * 2, r.top + 8)));
    const ghost = document.querySelector('.an-ghost') as HTMLElement | null;
    // Left HELD here on purpose: the screenshot below is taken mid-gesture, with
    // the ghost on screen and the card still in its old cell. Released after.
    (window as any).__endDrag = () =>
      window.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 20 + pitch * 2, r.top + 8)));
    return {
      before,
      ghostShown: !!ghost && ghost.getBoundingClientRect().width > 0,
      ghostCol: ghost?.style.gridColumn || '',
      cardUnmoved: el.style.gridColumn === before,
    };
  });

  // What a drag actually looks like: ghost at the target cell, card dimmed in
  // place. Only a held gesture can show this, so it is captured before release.
  const dragShot = path.join(shotDir, 'card-drag.png');
  await win.screenshot({ path: dragShot });
  ok('mid-drag screenshot captured', fs.existsSync(dragShot) && fs.statSync(dragShot).size > 5000,
     `${Math.round(fs.statSync(dragShot).size / 1024)} KB -> ${dragShot}`);

  const landed = await win.evaluate(() => {
    (window as any).__endDrag();
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    return { after: el.style.gridColumn, ghostGone: !document.querySelector('.an-ghost') };
  });
  Object.assign(moved, landed);
  ok('dragging the card shows a ghost at the target cell',
     moved.ghostShown && !!moved.ghostCol, JSON.stringify({ ghost: moved.ghostCol }));
  ok('…and the card itself does not move until the pointer is released',
     moved.cardUnmoved, `${moved.before} throughout the drag`);
  ok('…on release it lands where the ghost was, and the ghost is gone',
     moved.after !== moved.before && moved.after === moved.ghostCol && moved.ghostGone,
     `${moved.before} -> ${moved.after}`);

  const resized = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const handle = el.querySelector('.an-resize--s') as HTMLElement;
    const before = el.style.gridRow;
    const r = handle.getBoundingClientRect();
    const opts = (x: number, y: number) =>
      ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 2 });
    handle.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 2, r.top + 2)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 2, r.top + 2 + (48 + 12) * 2)));
    window.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 2, r.top + 2 + (48 + 12) * 2)));
    return { before, after: el.style.gridRow };
  });
  ok('dragging the bottom edge makes the card taller',
     resized.after !== resized.before, `${resized.before} -> ${resized.after}`);

  // Dragging cannot be the ONLY way to lay out a sheet.
  const keyed = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const before = el.style.gridColumn;
    el.focus();
    const focused = document.activeElement === el;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const afterMove = el.style.gridColumn;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    return { focused, before, afterMove, afterResize: el.style.gridColumn };
  });
  ok('a card is focusable, and arrow keys move it without a mouse',
     keyed.focused && keyed.afterMove !== keyed.before,
     `${keyed.before} -> ${keyed.afterMove}`);
  ok('…and shift+arrow resizes it', keyed.afterResize !== keyed.afterMove,
     `${keyed.afterMove} -> ${keyed.afterResize}`);

  const benchShot = path.join(shotDir, 'authoring-workbench.png');
  await win.screenshot({ path: benchShot });
  ok('workbench screenshot captured', fs.existsSync(benchShot) && fs.statSync(benchShot).size > 5000,
     `${Math.round(fs.statSync(benchShot).size / 1024)} KB -> ${benchShot}`);

  // A REAL drag: dragstart on a field, dragover + drop on a well, carrying a
  // DataTransfer. Playwright cannot synthesise a native HTML5 drag, so the
  // events are dispatched — but they are the same events the browser fires, and
  // they run the same listeners, including the dataTransfer round trip.
  const dropped = await win.evaluate(() => {
    const field = [...document.querySelectorAll('#an-fields .an-field')]
      .find((f) => (f as HTMLElement).dataset.column === 'state') as HTMLElement;
    const well = document.querySelector('#an-wells [data-well="filters"]') as HTMLElement;
    const dt = new DataTransfer();
    field.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const dragging = document.body.classList.contains('an-dragging');
    well.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const highlighted = well.classList.contains('is-drop');
    well.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    field.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return {
      carried: dt.getData('text/plain'),
      dragging,
      highlighted,
      cleared: !well.classList.contains('is-drop'),
      filterRows: document.querySelectorAll('#an-wells .viz-filter-row').length,
      droppedCol: (document.querySelector('#an-wells .viz-filter-row select') as HTMLSelectElement)?.value,
    };
  });
  ok('dragstart carries the column name and marks the drag',
     dropped.carried === 'state' && dropped.dragging, JSON.stringify(dropped));
  ok('…dragover highlights the well, and the highlight clears on drop',
     dropped.highlighted && dropped.cleared);
  ok('…and the drop lands the field in that well',
     dropped.filterRows === 1 && dropped.droppedCol === 'state',
     `${dropped.filterRows} row(s), column=${dropped.droppedCol}`);

  // Click-to-add is the keyboard path; a drag-only well is unreachable.
  await win.evaluate(() => {
    const f = [...document.querySelectorAll('#an-fields .an-field')]
      .find((x) => (x as HTMLElement).dataset.column === 'revenue') as HTMLElement;
    f.click();
  });
  await win.waitForTimeout(1500);
  ok('clicking a numeric field adds it as a measure, no mouse drag needed',
     await win.evaluate(() => document.querySelectorAll('#an-wells .viz-value-row').length >= 1));

  // UNDO both edits. They were written through to the SAVED visual — which is
  // the designed behaviour (a card references a project-level Visual, and
  // publishing denormalises so readers are unaffected) — and the first run of
  // this block proved it the hard way: it left an always-false filter on the map
  // visual and broke every map assertion 400 lines below. A test that mutates
  // shared state has to put it back.
  await win.evaluate(() => {
    document.querySelectorAll('#an-wells .viz-filter-row .viz-value-del')
      .forEach((b) => (b as HTMLElement).click());
  });
  await win.waitForTimeout(1200);
  // A measure is removed through its ⋮ menu now, which is the real user path.
  // The form refuses to go below one measure, so only the extras have a Remove.
  for (let i = 0; i < 3; i++) {
    const removed = await win.evaluate(() => {
      const menus = [...document.querySelectorAll('#an-wells .viz-value-row .enc-pill-menu')] as HTMLElement[];
      if (menus.length <= 1) return false;
      menus[menus.length - 1].click();
      const item = [...document.querySelectorAll('.project-card-popup .project-card-popup-item')]
        .find((b) => /Remove/.test(b.textContent || '')) as HTMLElement | undefined;
      if (!item) return false;
      item.click();
      return true;
    });
    if (!removed) break;
    await win.waitForTimeout(1200);
  }
  await win.waitForTimeout(2000);
  const reverted = await win.evaluate(() => ({
    filters: document.querySelectorAll('#an-wells .viz-filter-row').length,
    measures: document.querySelectorAll('#an-wells .viz-value-row').length,
  }));
  ok('the well edits undo from the same panel, restoring the shared visual',
     reverted.filters === 0 && reverted.measures === 1, JSON.stringify(reverted));

  // Properties closes the way every other flyout does — clicking its lit rail
  // icon. There is no bespoke × any more, because it is no longer a bespoke panel.
  const closedProps = await win.evaluate(() => {
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-props"]') as HTMLElement).click();
    return {
      shut: (document.getElementById('an-pane-props') as HTMLElement | null)?.offsetParent == null,
      sideShut: (document.getElementById('an-side-left') as HTMLElement | null)?.offsetParent == null,
      flyout: localStorage.getItem('anFlyout'),
      lit: (document.querySelector('#an-rail .an-rail-btn.is-on') as HTMLElement | null)?.dataset.pane,
    };
  });
  ok('Properties closes from its own rail icon, like every other flyout',
     closedProps.shut && closedProps.sideShut, JSON.stringify(closedProps));
  ok('…and the closed state is remembered, with no icon left lit',
     closedProps.flyout === '' && !closedProps.lit, JSON.stringify(closedProps));

  const anShot = path.join(shotDir, 'analysis-editor.png');
  await win.screenshot({ path: anShot });
  ok('analysis editor screenshot captured', fs.existsSync(anShot) && fs.statSync(anShot).size > 5000,
     `${Math.round(fs.statSync(anShot).size / 1024)} KB -> ${anShot}`);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('analysis-workbench', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
