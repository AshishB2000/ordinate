// The Visuals builder end to end, the type-aware filter dialog, the saved-card
// menu (including a map round-trip), and the drill panel behind a bar.
//
// Split out of smoke-app.ts (see that file's banner).
//
// The encoding form is a mounted <template> clone (encodingForm.ts) rather than
// markup addressed by id. That refactor is invisible when it works and total
// when it does not — a mis-scoped querySelector yields a builder whose controls
// are simply inert, which nothing outside a running window can see. So: open
// it, read the controls, CHANGE one, save it, and reopen it.
//
// A MILLION rows, because two assertions here stand on the real number. The
// filter dialog's value list is fetched through main and narrowed server-side
// over the whole table; and the drill panel's row total is checked against a
// count derived from the FIXTURE'S OWN DEFINITION rather than any code path the
// app uses — region = 'region' + (i % 7) over 1,000,000 rows makes region0
// 142,858 rows and every other region 142,857. Nothing but a faithful filter
// chain lands on that number.
//
//   npm run build:ts && node scripts/smoke-viz-builder.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedProject, seedAnalysis, openProject,
  domDriver, finishSmoke,
} from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// A renderer script-global (chartRender.js). Classic-script `const`s live in the
// global LEXICAL scope, not on `window`, so a page-context callback reaches it by
// bare name — but this file's own program has never seen it. Declared, not
// eval'd: the hub CSP is `script-src 'self'`, which blocks eval outright.
declare const chartInstances: { get(el: unknown): any };

async function main(): Promise<void> {
  const smoke = await launchSmoke('viz-builder');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: 1_000_000 });
  // One analysis on disk, so the card menu's "Add to dashboard" picker has a
  // real destination to list beside its "New dashboard…" entry.
  await seedAnalysis(smoke.app, r.projectId, {
    name: 'Smoke analysis',
    sheets: [{ name: 'Sheet 1', cards: [] }],
  });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const { clickExact, clickId, fillPrompt, pickFirstOption } = domDriver(win);

  // ── The Visuals builder, end to end ───────────────────────────────────────
  // The encoding form is now a mounted <template> clone (encodingForm.ts) rather
  // than markup addressed by id. That refactor is invisible when it works and
  // total when it does not — a mis-scoped querySelector yields a builder whose
  // controls are simply inert, which nothing outside a running window can see.
  // So: open it, read the controls, CHANGE one, and save.
  ok('the Visuals section opens', await clickExact('Visuals'));
  await win.waitForTimeout(1200);
  // "+ New visual" opens the create popup first (step 1 dataset, step 2 how),
  // and only "Build it myself" reaches the builder. A popup that renders but
  // whose rows are inert looks identical from outside — so pick a REAL row.
  ok('+ New visual opens the create popup', await clickId('viz-new-btn'));
  await win.waitForTimeout(1200);
  const popup = await win.evaluate(() => {
    const modal = document.querySelector('.vn-modal') as HTMLElement | null;
    const rows = [...document.querySelectorAll('.vn-row')] as HTMLElement[];
    return {
      open: !!modal,
      rows: rows.length,
      // Step 2 must still be hidden: nothing is chosen yet.
      step2Hidden: (document.querySelector('.js-vn-step2') as HTMLElement)?.hidden === true,
      meta: rows[0]?.textContent || '',
    };
  });
  ok('…listing the project datasets with rows × columns', popup.open && popup.rows > 0
     && /rows ×/.test(popup.meta) && popup.step2Hidden, JSON.stringify(popup));

  // The focus trap must only ever offer VISIBLE controls. Steps 2 and 3 are in
  // the DOM but display:none, and focus() on a display:none element is a no-op
  // that strands focus outside the dialog.
  const trap = await win.evaluate(() => {
    const box = document.querySelector('.vn-modal') as HTMLElement;
    const insideDialog = box.contains(document.activeElement);
    const hiddenFocusable = [...box.querySelectorAll('button, input, select, textarea')]
      .filter((el) => (el as HTMLElement).getClientRects().length === 0).length;
    return {
      role: box.getAttribute('role'),
      modal: box.getAttribute('aria-modal'),
      labelled: !!box.getAttribute('aria-label'),
      insideDialog,
      hiddenFocusable,
    };
  });
  ok('…as a labelled aria-modal dialog with focus landing inside it',
     trap.role === 'dialog' && trap.modal === 'true' && trap.labelled && trap.insideDialog,
     JSON.stringify(trap));
  ok('…and the later steps really are display:none, so the trap has to skip them',
     trap.hiddenFocusable > 0, `${trap.hiddenFocusable} offscreen controls`);

  ok('…picking a dataset advances to step 2', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find(
      (r) => /Sales/i.test(r.textContent || ''),
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return (document.querySelector('.js-vn-step2') as HTMLElement)?.hidden === false;
  }));

  ok('…and "Build it myself" closes the popup and opens the builder', await win.evaluate(() => {
    (document.querySelector('.js-vn-manual') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(2500);
  ok('…with the popup gone and the gallery swapped out for the builder',
     await win.evaluate(() => !document.querySelector('.vn-modal')
       && (document.getElementById('viz-builder') as HTMLElement).hidden === false
       && (document.getElementById('viz-gallery') as HTMLElement).hidden === true));

  // Pick a KNOWN dataset rather than whichever the select defaulted to, so the
  // column assertions below mean something.
  await win.evaluate(() => {
    const sel = document.getElementById('viz-dataset-select') as HTMLSelectElement;
    const sales = [...sel.options].find((o) => /Sales/.test(o.textContent || ''));
    if (sales) {
      sel.value = sales.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await win.waitForTimeout(2500);

  const form = await win.evaluate(() => {
    // Scoped to the Visuals section: since phase C the analysis workbench mounts
    // a SECOND encoding form, which is exactly what phase B made possible. A
    // bare document.querySelector here would read whichever mounted first.
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const enc = box.querySelector('.viz-encoding') as HTMLElement | null;
    const cat = box.querySelector('.js-enc-cat') as HTMLSelectElement | null;
    const ser = box.querySelector('.js-enc-series') as HTMLSelectElement | null;
    const geo = box.querySelector('.js-enc-geo') as HTMLSelectElement | null;
    const label = box.querySelector('.viz-encoding label[for]') as HTMLLabelElement | null;
    const agg = box.querySelector('.viz-value-agg') as HTMLSelectElement | null;
    return {
      mounted: !!enc && enc.offsetParent !== null,
      // Exactly ONE form is mounted. <template> content is inert and must not
      // be counted by a querySelectorAll, which is itself worth pinning.
      instances: box.querySelectorAll('.viz-encoding').length,
      catOptions: cat ? [...cat.options].map((o) => o.value) : [],
      seriesFirst: ser && ser.options[0] ? ser.options[0].textContent : '',
      geoOptions: geo ? geo.options.length : 0,
      measures: box.querySelectorAll('.viz-value-row').length,
      aggOptions: agg ? [...agg.options].map((o) => o.textContent) : [],
      // The per-instance id rewrite: a label must still point at a control that
      // EXISTS, or clicking it focuses nothing.
      labelFor: label?.htmlFor || '',
      labelResolves: !!(label && document.getElementById(label.htmlFor)),
      labelSuffixed: /-ef\d+$/.test(label?.htmlFor || ''),
    };
  });
  ok('the encoding form mounts, exactly once', form.mounted && form.instances === 1,
     JSON.stringify({ mounted: form.mounted, instances: form.instances }));
  ok("…with the dataset's columns, text before numbers",
     JSON.stringify(form.catOptions) === JSON.stringify(['region', 'sku', 'note', 'amount']),
     JSON.stringify(form.catOptions));
  ok('…one default measure, and the full aggregation list',
     form.measures === 1 &&
       JSON.stringify(form.aggOptions) ===
         JSON.stringify(['Sum', 'Average', 'Count', 'Min', 'Max', 'Raw (no aggregation)']),
     JSON.stringify(form.aggOptions));
  // Six bundled levels, then lat/long points, world cities and "Import boundaries…".
  ok('…Split by defaulting to None, and all nine geo options',
     form.seriesFirst === 'None' && form.geoOptions === 9,
     `series="${form.seriesFirst}" geo=${form.geoOptions}`);
  ok('…and every label still resolves to its own control after the id rewrite',
     form.labelResolves && form.labelSuffixed, form.labelFor);

  // Drive it: add a measure, switch an aggregation. This is what proves the
  // form's single onChange is actually wired to the recompute.
  await win.evaluate(() =>
    (document.querySelector('#ws-visuals .js-enc-add-value') as HTMLElement).click());
  await win.waitForTimeout(1800);
  const added = await win.evaluate(() => ({
    measures: document.querySelectorAll('#ws-visuals .viz-value-row').length,
    // At two measures the delete buttons un-disable; at one they are disabled,
    // because the form keeps at least one measure.
    firstDelEnabled: !(document.querySelector('#ws-visuals .viz-value-del') as HTMLButtonElement)?.disabled,
  }));
  ok('+ Add measure adds a row and frees the delete buttons',
     added.measures === 2 && added.firstDelEnabled, JSON.stringify(added));

  await win.evaluate(() => {
    const agg = document.querySelector('#ws-visuals .viz-value-agg') as HTMLSelectElement;
    agg.value = 'avg';
    agg.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win
    .waitForFunction(() => !!document.querySelector('#viz-area canvas, #viz-area svg'), undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  ok('changing an aggregation recomputes and redraws the preview',
     await win.evaluate(() => !!document.querySelector('#viz-area canvas, #viz-area svg')));

  const filterAdded = await win.evaluate(() => {
    (document.querySelector('#ws-visuals .js-enc-add-filter') as HTMLElement).click();
    return document.querySelectorAll('#ws-visuals .viz-filter-row').length;
  });
  ok('+ Add filter adds a filter row', filterAdded === 1, String(filterAdded));

  // ── The type-aware filter dialog ─────────────────────────────────────────
  // A dialog nobody drives is untested UI, and untested UI is how a blocked
  // inline style once shipped past 2,400 green assertions. This opens it on a
  // TEXT column and checks the thing that makes it type-aware: a real checkbox
  // list of that column's distinct values, fetched through main.
  //
  // The fresh row is also asserted INERT. It used to be `{op:'=', value:''}`,
  // which matches EMPTY cells — so adding a filter blanked the chart before you
  // had typed anything, while a comment here claimed it "changes nothing".
  ok('…and that row is inert until a condition is set',
     await win.evaluate(() => {
       const b = document.querySelector('#ws-visuals .viz-filter-cond') as HTMLButtonElement;
       return !!b && /set a condition/.test(b.textContent || '');
     }));

  await win.evaluate(() =>
    (document.querySelector('#ws-visuals .viz-filter-cond') as HTMLElement).click());
  // The value list is an IPC round trip against a 1M-row Parquet.
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length > 0, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  const dlg = await win.evaluate(() => {
    const opts = [...document.querySelectorAll('.fd-list .fd-opt')];
    return {
      open: !!document.querySelector('.fd-modal'),
      // A text column gets Values + Condition; a number column would get Range.
      tabs: [...document.querySelectorAll('.fd-tab')].map((t) => (t.textContent || '').trim()),
      sub: (document.querySelector('.fd-sub')?.textContent || '').trim(),
      options: opts.length,
      // The smoke dataset has exactly 7 regions, so this is the column's REAL
      // distinct values rather than a placeholder.
      first: (opts[0]?.textContent || '').trim(),
      applyDisabled: (document.querySelector('.fd-modal .btn-primary') as HTMLButtonElement)?.disabled,
    };
  });
  ok('the filter dialog opens with a real value list for a text column',
     dlg.open && dlg.options === 7 && /^region/.test(dlg.first), JSON.stringify(dlg));
  ok('…adapting to the column type (Values + Condition, not a range)',
     dlg.sub === 'Text column' && JSON.stringify(dlg.tabs) === JSON.stringify(['Values', 'Condition']),
     JSON.stringify(dlg.tabs));
  ok('…with Apply disabled until something is actually selected', dlg.applyDisabled === true);

  // The search must narrow the list through MAIN, not by filtering an
  // already-fetched array in the renderer.
  await win.evaluate(() => {
    const s = document.querySelector('.fd-search') as HTMLInputElement;
    s.value = 'region3';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length === 1, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  ok('searching narrows the list (server-side, over 1M rows)',
     await win.evaluate(() => document.querySelectorAll('.fd-list .fd-opt').length === 1));

  const dialogShot = path.join(shotDir, 'filter-dialog.png');
  await win.screenshot({ path: dialogShot });
  ok('filter dialog screenshot captured',
     fs.existsSync(dialogShot) && fs.statSync(dialogShot).size > 5000,
     `${Math.round(fs.statSync(dialogShot).size / 1024)} KB -> ${dialogShot}`);

  // Tick three values and apply → ONE `in` step carrying all three.
  await win.evaluate(() => {
    const s = document.querySelector('.fd-search') as HTMLInputElement;
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length === 7, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  await win.evaluate(() => {
    [...document.querySelectorAll('.fd-list .fd-opt input')].slice(0, 3)
      .forEach((el) => (el as HTMLInputElement).click());
  });
  ok('selecting values enables Apply and counts them',
     await win.evaluate(() => {
       const note = document.querySelector('.fd-note')?.textContent || '';
       const btn = document.querySelector('.fd-modal .btn-primary') as HTMLButtonElement;
       return !btn.disabled && /3 selected/.test(note);
     }));
  await win.evaluate(() =>
    (document.querySelector('.fd-modal .btn-primary') as HTMLElement).click());
  await win.waitForTimeout(1200);
  ok('Apply closes the dialog and writes ONE `in` step onto the row',
     await win.evaluate(() => {
       const open = !!document.querySelector('.fd-modal');
       const b = document.querySelector('#ws-visuals .viz-filter-cond') as HTMLElement;
       return !open && /is any of/.test(b?.textContent || '');
     }));

  const builderShot = path.join(shotDir, 'visual-builder.png');
  await win.screenshot({ path: builderShot });
  ok('visual builder screenshot captured',
     fs.existsSync(builderShot) && fs.statSync(builderShot).size > 5000,
     `${Math.round(fs.statSync(builderShot).size / 1024)} KB -> ${builderShot}`);

  // Save prompts for a name — answer it, or the write never happens and the
  // list silently stays as it was.
  ok('Save asks for a name', await clickId('viz-save-btn'));
  await win.waitForTimeout(600);
  ok('…and takes one', await fillPrompt('Encoding form check'));
  await win.waitForTimeout(2500);
  const saved = await win.evaluate(() => ({
    count: document.querySelectorAll('#viz-grid > *').length,
    names: [...document.querySelectorAll('#viz-grid')]
      .map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).join('').slice(0, 120),
    builderClosed: (document.getElementById('viz-builder') as HTMLElement)?.hidden === true,
  }));
  ok('…the visual is written and appears in the saved list',
     saved.count >= 3 && /Encoding form check/.test(saved.names), JSON.stringify(saved));
  ok('…and saving closes the builder', saved.builderClosed);

  // Reopen it. The restore path runs the SAME setColumns(cols, preset) call as a
  // fresh build, so a preset that silently fails to apply shows up right here —
  // as the two measures we just saved coming back as one.
  // The card's own actions. Favourite writes and re-sorts (favourites first), so
  // the starred card must come back at the front — a star that only repaints
  // itself would pass a "did it toggle" check and lose the state on refresh.
  const starred = await win.evaluate(async () => {
    const cards = [...document.querySelectorAll('.viz-card')] as HTMLElement[];
    const target = cards.find((c) => /Encoding form check/.test(c.textContent || ''));
    if (!target) return { found: false };
    (target.querySelector('.viz-card-star') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 1500));
    const first = document.querySelector('.viz-card') as HTMLElement;
    return {
      found: true,
      firstIsStarred: /Encoding form check/.test(first?.textContent || ''),
      pressed: first?.querySelector('.viz-card-star')?.getAttribute('aria-pressed'),
    };
  });
  ok('the star favourites a visual and sorts it to the front',
     starred.found === true && starred.firstIsStarred === true && starred.pressed === 'true',
     JSON.stringify(starred));

  // The ⋯ menu is a real button with honest aria-expanded, and every row is
  // enabled — "Add to analysis" and "Export" shipped disabled in Phase 1.
  // Scoped to .viz-card-pop: hub.ts keeps ONE permanent .chart-menu[role=menu]
  // element in the document for the per-graph ⋯ cluster, so a bare `.chart-menu`
  // here reads that static one and its rows instead of this popover's.
  const menu = await win.evaluate(() => {
    const btn = document.querySelector('.viz-card-menu') as HTMLButtonElement;
    btn.click();
    const items = [...document.querySelectorAll('.viz-card-pop button')] as HTMLButtonElement[];
    return {
      expanded: btn.getAttribute('aria-expanded'),
      labels: items.map((i) => (i.textContent || '').trim()),
      disabled: items.filter((i) => i.disabled).map((i) => i.textContent || ''),
    };
  });
  ok('the ⋯ menu opens with every action enabled',
     menu.expanded === 'true' && menu.labels.length === 8 && menu.disabled.length === 0
     && menu.labels.indexOf('Add to dashboard') >= 0 && menu.labels.indexOf('Export') >= 0
     && menu.labels.indexOf('History') >= 0 && menu.labels.indexOf('Lineage') >= 0,
     JSON.stringify(menu));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  ok('…and Escape closes it, resetting aria-expanded',
     await win.evaluate(() => !document.querySelector('.viz-card-pop')
       && document.querySelector('.viz-card-menu')?.getAttribute('aria-expanded') === 'false'));

  // ── A saved MAP round-trips through the card menu ────────────────────────
  // A map is the type most likely to be quietly unreachable from a new surface:
  // it needs geo on the computed data, WebGL, and the VISIBLE window. Drive it
  // through the card's own Export and Add-to-analysis rather than the builder.
  const openCardMenu = (nameRe: string) =>
    win.evaluate((src: string) => {
      const rx = new RegExp(src, 'i');
      const card = [...document.querySelectorAll('.viz-card')].find(
        (c) => rx.test(c.textContent || ''),
      ) as HTMLElement | undefined;
      if (!card) return false;
      (card.querySelector('.viz-card-menu') as HTMLElement).click();
      return true;
    }, nameRe);
  const clickMenuRow = (label: string) =>
    win.evaluate((l: string) => {
      const row = [...document.querySelectorAll('.viz-card-pop button')].find(
        (b) => (b.textContent || '').trim() === l,
      ) as HTMLElement | undefined;
      if (!row) return false;
      row.click();
      return true;
    }, label);

  ok('the map visual has a card in the gallery', await openCardMenu('Revenue by state'));
  ok('…whose menu offers Export', await clickMenuRow('Export'));
  await win.waitForTimeout(3000);
  const mapExport = await win.evaluate(() => {
    const overlay = document.getElementById('export-overlay');
    const chips = [...document.querySelectorAll('#export-overlay .viz-chip, #export-overlay [class*=chip]')]
      .map((c) => (c.textContent || '').trim()).filter(Boolean);
    return { open: !!overlay, chips: chips.slice(0, 8) };
  });
  ok('…and Export opens the dialog for a saved map, offering the region map first',
     mapExport.open && mapExport.chips.some((c) => /Region map/i.test(c)),
     JSON.stringify(mapExport));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(600);
  ok('…and the export dialog closes again',
     await win.evaluate(() => !document.getElementById('export-overlay')));

  // Add to analysis: a real write to a real analysis record, from the gallery.
  ok('the map card menu offers Add to dashboard', await openCardMenu('Revenue by state'));
  ok('…and it opens the dashboard picker', await clickMenuRow('Add to dashboard'));
  await win.waitForTimeout(900);
  ok('…listing the existing dashboards plus a New dashboard… entry',
     await win.evaluate(() => {
       const sel = [...document.querySelectorAll('.ws-modal-overlay')]
         .filter((o) => (o as HTMLElement).getClientRects().length > 0)
         .map((o) => o.querySelector('select.ws-modal-input'))[0] as HTMLSelectElement;
       return !!sel && [...sel.options].some((o) => /New dashboard/.test(o.textContent || ''));
     }));
  ok('…and picking one confirms', await pickFirstOption());
  await win.waitForTimeout(2500);
  ok('…the visual is filed away with a toast, and the gallery stays put',
     await win.evaluate(() => {
       const toast = document.getElementById('hub-toast');
       return !!toast && toast.hidden === false && /Added to/.test(toast.textContent || '')
         && (document.getElementById('viz-gallery') as HTMLElement).hidden === false;
     }));

  // Unstar again so the ordering the reopen check below relies on is restored.
  await win.evaluate(() => (document.querySelector('.viz-card-star') as HTMLElement).click());
  await win.waitForTimeout(1500);

  ok('the saved visual reopens', await win.evaluate(() => {
    const el = [...document.querySelectorAll('#viz-grid button, #viz-grid [role=button]')]
      .find((b) => /Encoding form check/.test(b.textContent || '')) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  }));
  await win.waitForTimeout(3000);
  const restored = await win.evaluate(() => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    return {
      instances: box.querySelectorAll('.viz-encoding').length,
      measures: box.querySelectorAll('.viz-value-row').length,
      firstAgg: (box.querySelector('.viz-value-agg') as HTMLSelectElement)?.value || '',
    };
  });
  ok('…into the same single form, with both measures and the aggregation restored',
     restored.instances === 1 && restored.measures === 2 && restored.firstAgg === 'avg',
     JSON.stringify(restored));

  // ── Drill-down: the rows behind a bar, on the real app ────────────────────
  //
  // THE assertion this feature stands on. Reopen the saved visual (which carries
  // an `in` filter on region), click a real bar, and check the panel's row total
  // against a count derived from the FIXTURE'S OWN DEFINITION rather than from
  // any code path the app uses: the generator writes region = 'region' + (i % 7)
  // over 1,000,000 rows, so region0 has 142,858 rows and every other region has
  // 142,857. Nothing but a faithful filter chain produces that number over a
  // million rows — an off-by-one in the mark filter, a dropped visual filter or
  // a lost `in` step all land somewhere else.
  //
  // This rides on the reopen just above rather than doing its own: the builder
  // is already showing that visual's chart, and an extra navigation here
  // perturbed the gallery assertions that follow.
  //
  // Wait for the CHART INSTANCE, not for a canvas. Closing the builder leaves
  // the previous chart's canvas in #viz-area, so `querySelector('canvas')` is
  // satisfied instantly by a canvas that is about to be cleared — and the click
  // below then lands on an emptied area.
  await win
    .waitForFunction(() => {
      const area = document.getElementById('viz-area');
      return !!area && !!area.querySelector('canvas') && !!chartInstances.get(area);
    }, undefined, { timeout: 60_000 })
    .catch(() => {});

  // Click a bar the way a user does — a real MouseEvent at that bar's own
  // coordinates, hit-tested by Chart.js. Calling the handler directly would skip
  // `chartMarkAt`, which is the part that decides which bar was clicked.
  //
  // Pick the TALLEST bar across every dataset, not data[0]. This visual carries
  // two measures on one axis — avg(amount) ≈ 38 beside sum(amount) ≈ 5.5M — so
  // the avg series draws as a half-pixel sliver on the baseline, and a click at
  // its centre lands outside the hit region. The tallest bar is a real target
  // whichever measure happens to be first.
  const clicked = await win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const canvas = area.querySelector('canvas') as HTMLCanvasElement;
    const chart: any = chartInstances.get(area);
    if (!chart || !canvas) return { ok: false };

    // FINAL positions, not current ones. Bars animate up from the baseline and
    // `chartMarkAt` hit-tests with useFinalPosition=true, so a click aimed at a
    // mid-animation bar misses the region it is tested against — which made this
    // step pass or fail depending on how fast the machine drew.
    const bars: { x: number; cy: number; i: number; h: number }[] = [];
    chart.data.datasets.forEach((_: unknown, d: number) => {
      chart.getDatasetMeta(d).data.forEach((el: any, i: number) => {
        const p = el.getProps(['x', 'y', 'base'], true);
        if (typeof p.base !== 'number') return;
        bars.push({ x: p.x, cy: (p.y + p.base) / 2, i, h: Math.abs(p.base - p.y) });
      });
    });
    bars.sort((a, b) => b.h - a.h);
    const best = bars[0];
    if (!best || best.h < 2) return { ok: false, h: best ? best.h : -1 };

    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + best.x,
      clientY: rect.top + best.cy,
      bubbles: true,
    }));
    return {
      ok: true,
      label: String(chart.data.labels[best.i]),
      bars: chart.data.labels.length,
      barPx: Math.round(best.h),
      // openDrillPanel is synchronous up to its first fetch, so the panel is
      // already visible here if the hit-test found the bar.
      opened: !!document.querySelector('.drill-backdrop:not([hidden])'),
    };
  });
  ok('clicking a bar opens the drill panel', clicked.ok === true && clicked.opened === true,
     JSON.stringify(clicked));

  await win
    .waitForFunction(() => {
      const n = document.querySelector('.js-drill-count');
      return !!n && /\d/.test(n.textContent || '');
    }, undefined, { timeout: 30_000 })
    .catch(() => {});

  const drill = await win.evaluate(() => {
    const panel = document.querySelector('.drill-panel') as HTMLElement | null;
    const back = document.querySelector('.drill-backdrop') as HTMLElement | null;
    return {
      open: !!panel && back?.hidden === false,
      count: (document.querySelector('.js-drill-count')?.textContent || '').trim(),
      chips: [...document.querySelectorAll('.drill-chip')].map((c) => (c.textContent || '').trim()),
      rows: document.querySelectorAll('.drill-scroll tbody tr').length,
      headers: [...document.querySelectorAll('.drill-scroll thead th')].map((t) => (t.textContent || '').trim()),
      noteShown: (document.querySelector('.js-drill-note') as HTMLElement)?.hidden === false,
      modal: panel?.getAttribute('aria-modal'),
      focusInside: !!panel && panel.contains(document.activeElement),
    };
  });
  // region0 → 142,858; every other region → 142,857 (1,000,000 = 7 × 142,857 + 1).
  const expected = clicked.label === 'region0' ? 142_858 : 142_857;
  ok('the panel is a focused, labelled dialog over the chart',
     drill.open && drill.modal === 'true' && drill.focusInside && !drill.noteShown,
     JSON.stringify({ open: drill.open, modal: drill.modal, focusInside: drill.focusInside }));
  ok(`…and its row total is the independently derived count for ${clicked.label}`,
     drill.count === expected.toLocaleString() + ' rows',
     `panel="${drill.count}" expected="${expected.toLocaleString()} rows"`);
  // Two chips: the visual's own filter, then the clicked mark. The mark chip is
  // the exact one asserted — it is what turns a bar into a row set. (The
  // reopened visual's `in` step comes back without its value list, so it selects
  // nothing and the count above is unchanged either way: `region in (…)` is a
  // superset of `region = region0`. That restore is a pre-existing bug in
  // openSavedVisual, not this panel's, so it is not encoded as an expectation.)
  ok('…with the visual\'s own filter AND the clicked mark shown as chips',
     drill.chips.length === 2 && /^region in/.test(drill.chips[0])
       && drill.chips[1] === `region = ${clicked.label}`,
     JSON.stringify(drill.chips));
  ok('…and it draws one page of that dataset\'s columns, not the whole set',
     drill.rows === 100 && JSON.stringify(drill.headers) === JSON.stringify(['region', 'sku', 'amount', 'note']),
     JSON.stringify({ rows: drill.rows, headers: drill.headers }));

  const drillShot = path.join(shotDir, 'drill-panel.png');
  await win.screenshot({ path: drillShot });
  ok('drill panel screenshot captured',
     fs.existsSync(drillShot) && fs.statSync(drillShot).size > 5000,
     `${Math.round(fs.statSync(drillShot).size / 1024)} KB -> ${drillShot}`);

  await win.keyboard.press('Escape');
  await win.waitForTimeout(500);
  ok('Escape closes the panel and returns focus to the chart',
     await win.evaluate(() => {
       const back = document.querySelector('.drill-backdrop') as HTMLElement | null;
       return !!back && back.hidden === true
         && document.getElementById('viz-area')?.getAttribute('aria-expanded') === 'false';
     }));


  await clickId('viz-cancel-btn');
  await win.waitForTimeout(600);

  // Leave the app on the Data section, where the rest of this file expects
  // to find it. (The Datasets nav item is labelled "Data" now.)
  await clickExact('Data');
  await win.waitForTimeout(800);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('viz-builder', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
