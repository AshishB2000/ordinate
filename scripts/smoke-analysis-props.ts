// The Visuals gallery and the Properties flyout — everything that binds to the
// card you selected: the type tiles, the field searches, the Build/Format/
// Interactions tabs, the encoding wells, and the ✨ door that must stay shut.
//
// Split out of smoke-app.ts (see that file's banner). Two things here are only
// observable in a running window. First, SEPARATION: the ✨ button is a model
// call while the "Recommended" tier is app-computed shape eligibility, and a
// smoke run has no model, which is exactly the case that proves they are
// independent — the button off and saying why, the tiers still filled. Second,
// PERSISTENCE: a formatting control that writes nothing looks identical to one
// that works, so each override is read back from the SAVED record through main
// rather than from the DOM that set it, and then put back, because a test that
// mutates shared state has to restore it.
//
//   npm run build:ts && node scripts/smoke-analysis-props.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedProject, seedAnalysis, openProject,
  openSeededAnalysis, domDriver, railDriver, finishSmoke,
} from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('analysis-props');
  const { app, win, errors, shotDir } = smoke;

  const r = await seedProject(app, { rows: 5_000 });
  await seedAnalysis(app, r.projectId, {
    name: 'Smoke analysis',
    sheets: [{
      name: 'Sheet 1',
      cards: [
        // FIRST, deliberately: every panel below binds to this card, and the
        // saved overrides are read back off THIS visual's record.
        { type: 'visual', visualId: r.mapVisualId, layout: { x: 0, y: 0, w: 6, h: 6 } },
        { type: 'visual', visualId: r.visualId, layout: { x: 0, y: 8, w: 6, h: 6 } },
      ],
    }],
  });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const { clickExact } = domDriver(win);
  const { openPane, openProps } = railDriver(win);

  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  ok('the seeded dashboard opens from the list', await openSeededAnalysis(win, 'Smoke analysis'));
  await win.waitForTimeout(2500);

  // SELECT the card. This is the whole binding, and smoke-analysis-workbench.ts
  // is where it is asserted; here it is only the precondition.
  //
  // Wait for the CHIP ROW as well as the field list. They arrive on separate
  // async paths — the fields as soon as the dataset's columns load, the chips
  // only once the visual's data has been computed in main — so waiting on the
  // fields alone leaves `bound.chips` a race that reads 0 on a slow runner.
  await openPane('an-pane-props');
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement).click());
  await win.waitForFunction(
    () => document.querySelectorAll('#an-fields .an-field').length > 0
      && document.querySelectorAll('#an-switcher .an-typerow').length > 0,
    undefined,
    { timeout: 30_000 },
  ).catch(() => {}); // fall through; the assertions below report what is there
  const bound = await win.evaluate(() => ({
    chips: document.querySelectorAll('#an-switcher .an-typerow').length,
    propsRows: document.querySelectorAll('#an-props .an-sec').length,
    title: (document.querySelector('#an-props .an-prop-input') as HTMLInputElement)?.value || '',
  }));
  ok('a selected card binds the Properties panel before anything below reads it',
     bound.chips > 0 || bound.propsRows > 0, JSON.stringify(bound));

  // ── The Visuals gallery ───────────────────────────────────────────────────
  // Built from the SAME vocabulary as the result-view picker, with the same
  // app-computed eligibility. Recommended tiles sort first and are marked.
  await openPane('an-pane-visuals');
  const gallery = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#an-gallery .an-tile')] as HTMLElement[];
    const recIdx = tiles.map((t, i) => (t.classList.contains('is-rec') ? i : -1)).filter((i) => i >= 0);
    const plainIdx = tiles.map((t, i) => (t.classList.contains('is-rec') ? -1 : i)).filter((i) => i >= 0);
    return {
      count: tiles.length,
      allNamed: tiles.every((t) => !!t.querySelector('.an-tile-name')?.textContent),
      allDrawn: tiles.every((t) => !!t.querySelector('.an-tile-ic svg')),
      recommended: recIdx.length,
      // Recommended first: every recommended index below every plain one.
      recFirst: recIdx.length === 0 || plainIdx.length === 0 ||
        Math.max(...recIdx) < Math.min(...plainIdx),
      active: (document.querySelector('#an-gallery .an-tile.is-active .an-tile-name') as HTMLElement | null)
        ?.textContent || '',
    };
  });
  ok('the Visuals gallery is a grid of named, drawn type tiles',
     gallery.count > 20 && gallery.allNamed && gallery.allDrawn, JSON.stringify(gallery));
  ok('…with the app-recommended types marked and sorted first, and the current one active',
     gallery.recommended > 0 && gallery.recFirst && !!gallery.active, JSON.stringify(gallery));

  const galleryShot = path.join(shotDir, 'visuals-gallery.png');
  await win.screenshot({ path: galleryShot });
  ok('visuals gallery screenshot captured',
     fs.existsSync(galleryShot) && fs.statSync(galleryShot).size > 5000,
     `${Math.round(fs.statSync(galleryShot).size / 1024)} KB -> ${galleryShot}`);

  // Clicking a tile really retypes the selected card. Restored afterwards: the
  // map assertions 400 lines below read this same visual.
  const retyped = await win.evaluate(async () => {
    const was = (document.querySelector('#an-gallery .an-tile.is-active') as HTMLElement).dataset.type;
    const other = [...document.querySelectorAll('#an-gallery .an-tile')]
      .find((t) => (t as HTMLElement).dataset.type === 'table') as HTMLElement;
    other.click();
    return { was, now: (document.querySelector('#an-gallery .an-tile.is-active') as HTMLElement)?.dataset.type };
  });
  await win.waitForTimeout(1500);
  ok('…and clicking a tile retypes the selected card',
     retyped.was !== 'table' && retyped.now === 'table', JSON.stringify(retyped));
  await win.evaluate((t) => {
    const back = [...document.querySelectorAll('#an-gallery .an-tile')]
      .find((x) => (x as HTMLElement).dataset.type === t) as HTMLElement;
    back?.click();
  }, retyped.was);
  await win.waitForTimeout(1500);
  await openPane('an-pane-props');
  ok('…the chart-type chips render', bound.chips > 0, `${bound.chips} chips`);
  // Exactly ONE chip row. Selecting a card and writing a well edit both rebuild
  // it, and each clears the mount before its await — two in flight left two rows
  // stacked, which every count-based assertion happily passed.
  ok('…as exactly one row, not one per in-flight rebuild',
     await win.evaluate(() => document.querySelectorAll('#an-switcher .an-typerow').length) === 1,
     await win.evaluate(() =>
       String(document.querySelectorAll('#an-switcher .an-typerow').length) + ' row(s)'));
  // Icons, not text chips — this is what made the panel read as rough.
  const icons = await win.evaluate(() => {
    const row = document.querySelector('#an-switcher .an-typerow') as HTMLElement | null;
    return {
      svg: !!row?.querySelector('.an-typerow-ic svg'),
      name: (row?.querySelector('.an-typerow-name')?.textContent || '').trim(),
      labelled: !!row?.getAttribute('aria-label'),
      // The chip row is still in the DOM (it owns the + More panel) but must not
      // be on screen — two chart-type UIs would be the divergence this avoids.
      chipRowHidden: (document.querySelector('#an-switcher .cv-viz-switcher') as HTMLElement | null)
        ?.getBoundingClientRect().width! <= 2,
    };
  });
  ok('…as an icon + the CURRENT type name + a way into the full picker',
     icons.svg && !!icons.name && icons.labelled && icons.chipRowHidden, JSON.stringify(icons));

  // Search fields — a wide dataset is unusable without it. The Data flyout is
  // the BROWSE render now (its own list, its own search); the canonical,
  // draggable list lives in Properties. Both filter; each is asserted where it
  // lives.
  await openPane('an-pane-data');
  const search = await win.evaluate(() => {
    const box = document.getElementById('an-browse-search') as HTMLInputElement;
    const before = document.querySelectorAll('#an-browse .an-field').length;
    box.value = 'rev';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelectorAll('#an-browse .an-field').length;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { visible: box.offsetParent !== null, before, after,
             restored: document.querySelectorAll('#an-browse .an-field').length,
             // Browse items assign on click but do NOT drag — the wells are in
             // the other flyout, so a drag from here reaches nothing.
             browseDraggable: [...document.querySelectorAll('#an-browse .an-field')]
               .some((f) => (f as HTMLElement).draggable) };
  });
  ok('the Data panel searches its fields',
     search.visible && search.after < search.before && search.restored === search.before,
     JSON.stringify(search));
  ok('…and its browse items are click-to-assign, not draggable', search.browseDraggable === false);

  const propsSearch = await win.evaluate(() => {
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-props"]') as HTMLElement).click();
    const box = document.getElementById('an-field-search') as HTMLInputElement;
    const before = document.querySelectorAll('#an-fields .an-field').length;
    box.value = 'rev';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelectorAll('#an-fields .an-field').length;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { visible: box.offsetParent !== null, before, after,
             restored: document.querySelectorAll('#an-fields .an-field').length };
  });
  ok('the Properties field list searches too',
     propsSearch.visible && propsSearch.after < propsSearch.before
       && propsSearch.restored === propsSearch.before,
     JSON.stringify(propsSearch));
  await openPane('an-pane-data');

  // Properties is closed until a card's ⚙ asks for it — the gear IS the only
  // way in, so opening it here also asserts that button is wired.
  await openProps();
  const propsOpened = await win.evaluate(() =>
    (document.getElementById('an-pane-props') as HTMLElement | null)?.offsetParent != null);
  ok('the ⚙ on a card opens the Properties panel', propsOpened);

  // The formatting controls live in the FORMAT tab, so open it — measuring a
  // panel that is in the DOM but not on screen proves nothing about it.
  await win.evaluate(() => (document.getElementById('an-tab-format') as HTMLElement).click());
  await win.waitForTimeout(150);
  const formatVisible = await win.evaluate(() =>
    (document.querySelector('#an-tabp-format .an-props') as HTMLElement | null)?.offsetParent != null);
  ok('…on the Format tab, which is where the formatting controls are', formatVisible);

  // Format is a list of disclosure sections, not a flat form.
  const secs = await win.evaluate(() => {
    const heads = [...document.querySelectorAll('#an-props .an-sec-head')] as HTMLElement[];
    const first = heads[0];
    const openBefore = !!first?.closest('.an-sec')?.classList.contains('is-open');
    first?.click();
    return {
      titles: heads.map((h) => (h.lastElementChild?.textContent || '').trim()),
      openBefore,
      openAfter: !!first?.closest('.an-sec')?.classList.contains('is-open'),
      aria: first?.getAttribute('aria-expanded'),
    };
  });
  // The sections must be backed by REAL overrides, not styled placeholders: a
  // control that writes nothing looks identical to one that works.
  const props = await win.evaluate(() => {
    const box = document.getElementById('an-props') as HTMLElement;
    const legend = [...box.querySelectorAll('.an-prop-check')]
      .find((l) => /Show legend/.test(l.textContent || ''))?.querySelector('input') as HTMLInputElement | null;
    const before = legend?.checked;
    legend?.click();
    return {
      titleBound: (box.querySelector('.an-prop-input') as HTMLInputElement)?.value || '',
      hadLegend: !!legend,
      toggled: legend?.checked !== before,
    };
  });
  ok('Display settings binds to the visual and to a real override',
     !!props.titleBound && props.hadLegend && props.toggled, JSON.stringify(props));
  await win.waitForTimeout(1800);
  // The write reaches the record the chart draws from — asserted through main,
  // not through the DOM that set it.
  // Read the SAVED record from main, not from the renderer that wrote it — and
  // via app.evaluate, because `currentProjectId` is a top-level `let` in a
  // classic script and therefore lives in the global lexical environment, not on
  // `window`. Reaching for window.currentProjectId silently yields undefined,
  // which is what made this first report "not saved" for a write that worked.
  const persisted = await app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    return { hasOverrides: !!v && !!v.overrides, showLegend: v && v.overrides && v.overrides.showLegend };
  }, { projectId: r.projectId, visualId: r.mapVisualId });
  ok('…and that override is saved on the visual',
     !!persisted && persisted.hasOverrides && persisted.showLegend === false,
     JSON.stringify(persisted));
  // Put it back so later assertions see the resting state.
  await win.evaluate(() => {
    const l = [...document.querySelectorAll('#an-props .an-prop-check')]
      .find((x) => /Show legend/.test(x.textContent || ''))?.querySelector('input') as HTMLInputElement | null;
    l?.click();
  });
  await win.waitForTimeout(1500);

  ok('Properties is a list of collapsible sections',
     secs.titles.length >= 2 && secs.titles[0] === 'Display settings' &&
       secs.openBefore && !secs.openAfter && secs.aria === 'false' &&
       secs.titles.includes('Axes'),
     JSON.stringify(secs));
  await win.evaluate(() =>
    (document.querySelector('#an-props .an-sec-head') as HTMLElement)?.click());

  // ── The Interactions tab ──────────────────────────────────────────────────
  // The tab has to hold REAL behaviour, not disabled placeholders — so assert
  // the controls exist, are enabled, and that toggling one reaches the SAVED
  // visual through main. A tab of dead switches is worse than no tab.
  await win.evaluate(() => (document.getElementById('an-tab-interact') as HTMLElement).click());
  await win.waitForTimeout(200);
  const interact = await win.evaluate(() => {
    const host = document.getElementById('an-interact') as HTMLElement;
    const boxes = [...host.querySelectorAll('.an-prop-check input')] as HTMLInputElement[];
    return {
      visible: host.offsetParent !== null,
      count: boxes.length,
      labels: [...host.querySelectorAll('.an-prop-check')].map((l) => (l.textContent || '').trim()),
      allEnabled: boxes.every((b) => !b.disabled),
      // Defaults: cross-filter OFF (a click that silently refilters every card is
      // a surprise), tooltips ON (every chart before this key had them).
      crossOff: boxes[0] && boxes[0].checked === false,
      tipsOn: boxes[1] && boxes[1].checked === true,
    };
  });
  ok('the Interactions tab holds real, enabled controls',
     interact.visible && interact.count === 2 && interact.allEnabled, JSON.stringify(interact));
  ok('…defaulting to cross-filter off and tooltips on',
     interact.crossOff && interact.tipsOn, JSON.stringify(interact));

  const interactShot = path.join(shotDir, 'interactions-tab.png');
  await win.screenshot({ path: interactShot });
  ok('interactions tab screenshot captured',
     fs.existsSync(interactShot) && fs.statSync(interactShot).size > 5000,
     `${Math.round(fs.statSync(interactShot).size / 1024)} KB -> ${interactShot}`);

  // Turn cross-filter ON and assert it reaches the record, read back through
  // main — not from the DOM that set it.
  await win.evaluate(() => {
    const b = document.querySelector('#an-interact .an-prop-check input') as HTMLInputElement;
    b.click();
  });
  await win.waitForTimeout(1800);
  const savedInteract = await app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    return { crossFilter: v && v.overrides && v.overrides.crossFilter };
  }, { projectId: r.projectId, visualId: r.mapVisualId });
  ok('…and the interaction setting survives sanitizeOverrides into the saved visual',
     savedInteract && savedInteract.crossFilter === true, JSON.stringify(savedInteract));

  // Put it back — later assertions read this same shared visual.
  await win.evaluate(() => {
    const b = document.querySelector('#an-interact .an-prop-check input') as HTMLInputElement;
    b.click();
  });
  await win.waitForTimeout(1800);

  // Back to the wells — everything below measures the encoding form, which now
  // lives in the Properties flyout's BUILD tab.
  await openPane('an-pane-props');
  await win.evaluate(() => (document.getElementById('an-tab-build') as HTMLElement).click());
  await win.waitForTimeout(150);

  // Empty wells must SAY what belongs in them, which is the QuickSight
  // affordance a bare dropdown does not give.
  const zones = await win.evaluate(() => ({
    placeholders: [...document.querySelectorAll('#an-wells .enc-empty')].map((e) => (e.textContent || '').trim()),
    pills: document.querySelectorAll('#an-wells .enc-pill').length,
  }));
  ok('…and an empty well says what belongs in it',
     zones.placeholders.some((t) => /Drop a field here to filter/.test(t)),
     JSON.stringify(zones));

  // The pill has to FIT its field name. At 232px the aggregation select's
  // intrinsic width was winning and clipping "revenue" to "reve" — a bug no
  // count-based assertion sees, so measure the rendered text box instead.
  const pill = await win.evaluate(() => {
    const sel = document.querySelector('#an-wells .enc-pill > .viz-select') as HTMLSelectElement | null;
    if (!sel) return null;
    const span = document.createElement('span');
    span.textContent = sel.options[sel.selectedIndex]?.text || '';
    const cs = getComputedStyle(sel);
    span.style.font = cs.font;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    document.body.appendChild(span);
    const textW = span.getBoundingClientRect().width;
    span.remove();
    return { name: sel.value, textW: Math.ceil(textW), boxW: Math.floor(sel.getBoundingClientRect().width) };
  });
  ok('…and a measure pill is wide enough for its field name',
     !!pill && pill.boxW >= pill.textW, JSON.stringify(pill));

  // EVERY filled well is a pill, not just the JS-rendered ones — Category and
  // Split by were dropdowns while Measures and Filters were pills, which is the
  // inconsistency the reference does not have.
  const singles = await win.evaluate(() => {
    const row = (well: string) =>
      document.querySelector('#an-wells [data-well="' + well + '"]') as HTMLElement | null;
    const cat = row('category');
    const ser = row('series');
    return {
      catPill: (cat?.querySelector('.enc-pill--one .enc-pill-name')?.textContent || '').trim(),
      catSelectHidden: !!(cat?.querySelector('select') as HTMLSelectElement | null)?.hidden,
      // Split by is empty by default, so it must show the placeholder instead.
      serEmpty: (ser?.querySelector('.enc-empty')?.textContent || '').trim(),
      // Category is NOT clearable: a chart with no dimension has nothing to plot.
      catClearable: !!cat?.querySelector('.enc-pill--one .viz-value-del'),
      serClearable: !!ser?.querySelector('.enc-pill--one .viz-value-del'),
    };
  });
  ok('a filled single-value well is a pill, with its select standing down',
     singles.catPill === 'state' && singles.catSelectHidden, JSON.stringify(singles));
  ok('…an empty one says what belongs in it',
     singles.serEmpty === 'Add a dimension', singles.serEmpty);
  ok('…and Category offers no clear, because a chart needs a dimension',
     !singles.catClearable);

  // EXACTLY ONE of {pill | placeholder | select} is visible per single well.
  // Leaving the select up alongside the placeholder painted "None" underneath
  // "Add a dimension" — two controls for one value.
  const doubled = await win.evaluate(() =>
    ['category', 'series'].map((w) => {
      const row = document.querySelector('#an-wells [data-well="' + w + '"]') as HTMLElement;
      const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
      return {
        well: w,
        showing: [
          vis(row.querySelector('.enc-pill--one')),
          vis(row.querySelector('.enc-empty')),
          vis(row.querySelector('select')),
        ].filter(Boolean).length,
      };
    }));
  ok('…and a single-value well shows exactly one control, never two',
     doubled.every((d) => d.showing === 1), JSON.stringify(doubled));

  // Clicking the pill name reveals the select it stands in for — the pill must
  // not be a dead end.
  const reveal = await win.evaluate(() => {
    const cat = document.querySelector('#an-wells [data-well="category"]') as HTMLElement;
    (cat.querySelector('.enc-pill-name') as HTMLElement).click();
    const sel = cat.querySelector('select') as HTMLSelectElement;
    return { hidden: sel.hidden, focused: document.activeElement === sel };
  });
  ok('…clicking the pill reveals the select behind it', !reveal.hidden && reveal.focused,
     JSON.stringify(reveal));
  // …and the pill steps aside when it does. Leaving both up showed the value
  // twice, which is what the screenshot caught.
  const afterReveal = await win.evaluate(() => {
    const cat = document.querySelector('#an-wells [data-well="category"]') as HTMLElement;
    const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
    return {
      pill: vis(cat.querySelector('.enc-pill--one')),
      select: vis(cat.querySelector('select')),
    };
  });
  ok('…and the pill steps aside rather than stacking with it',
     !afterReveal.pill && afterReveal.select, JSON.stringify(afterReveal));
  // Put the pill back so the screenshot below shows the resting state.
  await win.evaluate(() => (document.querySelector('#an-wells [data-well="category"] select') as HTMLElement)?.blur());
  await win.waitForTimeout(300);

  // ── AI in the Visuals panel (phase D) ─────────────────────────────────────
  // The point of this block is the SEPARATION. The ✨ button is a model call;
  // the chips' "Recommended" tier is app-computed shape eligibility. A smoke run
  // has no model, which is exactly the case that proves they are independent:
  // the button must be off and say why, while the chips still work.
  const ai = await win.evaluate(() => {
    const btn = document.getElementById('an-suggest-btn') as HTMLButtonElement | null;
    const note = document.getElementById('an-ai-note') as HTMLElement | null;
    const slot = document.getElementById('an-ai-slot') as HTMLElement | null;
    const switcher = document.getElementById('an-switcher') as HTMLElement | null;
    const sr = slot?.getBoundingClientRect();
    const wr = switcher?.getBoundingClientRect();
    return {
      present: !!btn,
      label: (btn?.textContent || '').trim(),
      disabled: !!btn?.disabled,
      noteVisible: !!note && note.offsetParent !== null,
      noteText: (note?.textContent || '').trim(),
      // Above the chips, and visually separate — nothing here may read as if a
      // model produced the Recommended marks.
      aboveChips: !!(sr && wr) && sr.bottom <= wr.top + 1,
      chips: switcher ? switcher.querySelectorAll('.cv-viz-chip').length : 0,
      activeChip: (switcher?.querySelector('.cv-viz-chip.active')?.textContent || '').trim(),
    };
  });
  ok('the ✨ Suggest a visual button is offered, above the chart types',
     ai.present && /Suggest a visual/.test(ai.label) && ai.aboveChips, JSON.stringify(ai));
  ok('…with no model it is DISABLED and says the one shared sentence',
     ai.disabled && ai.noteVisible && /Execution to use the Assistant/.test(ai.noteText), ai.noteText);
  ok('…while the app-computed chart types still work, and say they are the app\'s',
     ai.chips > 0 && /recommended by the app itself/i.test(ai.noteText) && !!ai.activeChip,
     `${ai.chips} chips, active="${ai.activeChip}"`);

  // The "+ More" panel is where the Recommended TIER is named. It must exist
  // with no model configured — it is shape eligibility, not a suggestion.
  const tiers = await win.evaluate(() => {
    const more = document.querySelector('#an-switcher .an-typerow') as HTMLElement | undefined;
    if (!more) return null;
    more.click();
    // The panel is appended to <body> (renderResult.ts openMorePanel), not into
    // the switcher — so scoping the query to #an-switcher finds nothing.
    const labels = [...document.querySelectorAll('.cv-more-panel .cv-more-group-label')]
      .map((l) => (l.textContent || '').trim());
    return { opened: true, hasRecommended: labels.some((l) => /^Recommended/.test(l)), labels: labels.slice(0, 6) };
  });
  ok('…and “Recommended” is a tier the app fills with no model involved',
     !!tiers && tiers.hasRecommended, JSON.stringify(tiers));
  await win.evaluate(() => document.body.click());
  await win.waitForTimeout(300);
  ok('…and Properties binds to the card', bound.propsRows >= 2 && !!bound.title,
     `${bound.propsRows} rows, title="${bound.title}"`);

  // Layout is DIRECT MANIPULATION. The nine-button stepper cluster
  // (◀▶▲▼ W−W+H−H+ 🗑) is gone from the card header and was NOT replaced by
  // steppers in Properties either — aiming at a target four clicks away is
  // arithmetic, not editing.
  //
  // What the header carries now is ONE ⋯ menu. That is the assertion, not
  // "nothing": a discoverable, keyboard-reachable route to the same functions
  // is the point, and it is one target rather than nine. So the cluster is
  // counted by its CONTENTS — exactly one button, and it is the menu.
  const ctrls = await win.evaluate(() => {
    const visible = [...document.querySelectorAll('#dash-grid .dash-card-ctrls')]
      .filter((c) => (c as HTMLElement).offsetParent !== null);
    return {
      clusters: visible.length,
      buttonsPerCluster: visible.map((c) => c.querySelectorAll('button').length),
      menusPerCluster: visible.map((c) => c.querySelectorAll('.dash-card-menu-btn').length),
      steppers: document.querySelectorAll('#an-props .an-prop-btn').length,
      handles: [...document.querySelectorAll('#dash-grid .dash-card.is-selected .an-resize')]
        .map((h) => [...h.classList].find((c) => c.startsWith('an-resize--'))),
      remove: !!document.querySelector('#an-props .an-prop-del'),
    };
  });
  ok('…the card header carries ONE ⋯, not a stepper cluster',
     ctrls.clusters > 0 && ctrls.buttonsPerCluster.every((n) => n === 1)
       && ctrls.menusPerCluster.every((n) => n === 1),
     JSON.stringify(ctrls));
  ok('…and nothing put steppers in Properties instead, where Remove still lives',
     ctrls.steppers === 0 && ctrls.remove, JSON.stringify(ctrls));
  ok('…the card carries right, bottom and corner resize handles instead',
     JSON.stringify(ctrls.handles) ===
       JSON.stringify(['an-resize--e', 'an-resize--s', 'an-resize--se']),
     JSON.stringify(ctrls.handles));

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('analysis-props', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
