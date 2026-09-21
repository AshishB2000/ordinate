// The pivot table, end to end, in the REAL app.
//
// A pivot is the one visual whose whole output is DOM rather than a canvas, so
// the things that can silently break it are things no unit test can see: a
// script tag in the wrong place, a CSP violation from an inline style, a
// sticky header that covers the first row, a menu item wired to a function the
// bundle never loaded. Hence: build one in the builder, read the figures off
// the rendered <table>, click its header and its caret, save it, put it on a
// dashboard, filter it and copy it.
//
// The data is the BUNDLED SAMPLE, imported through the real parser, because the
// one figure worth checking against something outside this file is its grand
// total: sum(revenue) over retail-orders.csv is the sample dashboard's Revenue
// KPI, and the smoke asserts the pivot's corner cell and the KPI card render
// the SAME string. Neither number is written down here.
//
//   npm run build:ts && node scripts/smoke-pivot.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedAnalysis, openProject,
  openSeededAnalysis, domDriver, railDriver, finishSmoke,
} from './smokeFixture';

const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('pivot');
  const { app, win, errors, shotDir } = smoke;

  // ── The fixture: the bundled sample, through the real import path ─────────
  const r: any = await app.evaluate(async (_electron, repo: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const fileImport = req('./src/data/fileImport.js');
    const nodePath = req('path');

    await projects.init();
    const proj = await projects.createProject('Pivot smoke');
    const csv = nodePath.join(repo, 'assets', 'samples', 'retail-orders.csv');
    const parsed = await fileImport.parseFile(csv, 'csv');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Retail orders',
      sourceKind: 'csv',
      columns: parsed.columns,
      rows: parsed.rows,
    });
    return { projectId: proj.id, datasetId: ds.id, rowCount: ds.rowCount };
  }, path.resolve(__dirname, '..'));

  ok('the bundled sample imported as a dataset', r.rowCount > 1000, JSON.stringify(r));

  // A dashboard with the Revenue KPI the pivot's grand total must match, and a
  // region dropdown to filter it with. Both are ordinary cards: a pivot has to
  // sit among them, not beside them.
  await seedAnalysis(app, r.projectId, {
    name: 'Pivot smoke board',
    sheets: [{
      name: 'Sheet 1',
      cards: [
        { type: 'metric',
          metric: { datasetId: r.datasetId, column: 'revenue', aggregation: 'sum', label: 'Revenue' },
          layout: { x: 0, y: 0, w: 3, h: 2 } },
        { type: 'control',
          control: { kind: 'dropdown', label: 'Region', datasetId: r.datasetId, column: 'region' },
          layout: { x: 3, y: 0, w: 3, h: 2 } },
      ],
    }],
  });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const dialogs: string[] = [];
  win.on('dialog', (d) => { dialogs.push(d.type() + ': ' + d.message()); d.accept().catch(() => {}); });

  const { clickExact, clickId, fillPrompt, pickFirstOption } = domDriver(win);

  // ── Open the builder on the sample ────────────────────────────────────────
  ok('the Visuals section opens', await clickExact('Visuals'));
  await win.waitForTimeout(1200);
  ok('+ New visual opens the create popup', await clickId('viz-new-btn'));
  await win.waitForTimeout(1200);
  ok('…picking the sample dataset advances to step 2', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find(
      (x) => /Retail orders/i.test(x.textContent || ''),
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return (document.querySelector('.js-vn-step2') as HTMLElement)?.hidden === false;
  }));
  await win.evaluate(() => (document.querySelector('.js-vn-manual') as HTMLElement).click());
  await win.waitForTimeout(3000);
  ok('…and "Build it myself" opens the builder',
     await win.evaluate(() => (document.getElementById('viz-builder') as HTMLElement).hidden === false));

  // ── Switch the chart type to Pivot table ──────────────────────────────────
  //
  // Through the picker the user actually has, not by setting a variable: the
  // whole point of the type being in ALL_CHART_TYPE_IDS is that it is offered.
  const pickType = async (label: string): Promise<boolean> => {
    const direct = await win.evaluate((l: string) => {
      const chip = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip, #viz-switcher-mount button')]
        .find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
      if (chip) { chip.click(); return true; }
      const more = [...document.querySelectorAll('#viz-switcher-mount button')]
        .find((b) => /More/i.test(b.textContent || '')) as HTMLElement | undefined;
      if (more) more.click();
      return false;
    }, label);
    if (direct) return true;
    await win.waitForTimeout(600);
    return win.evaluate((l: string) => {
      const tile = [...document.querySelectorAll('button, [role=button]')]
        .find((b) => (b as HTMLElement).offsetParent !== null
          && (b.textContent || '').trim().startsWith(l)) as HTMLElement | undefined;
      if (!tile) return false;
      tile.click();
      return true;
    }, label);
  };
  ok('the chart-type picker offers Pivot table', await pickType('Pivot table'));
  await win.waitForTimeout(2500);

  ok('…and choosing it swaps Category/Measures for the Rows/Columns/Values shelves',
     await win.evaluate(() => {
       const box = document.getElementById('ws-visuals') as HTMLElement;
       const shelves = [...box.querySelectorAll('.pivot-shelf .viz-build-label')]
         .map((l) => (l.textContent || '').trim());
       const cat = box.querySelector('.viz-build-row[data-well="category"]') as HTMLElement | null;
       const filters = box.querySelector('.js-enc-filters-row') as HTMLElement | null;
       return JSON.stringify(shelves) === JSON.stringify(['Rows', 'Columns', 'Values'])
         && !!cat && cat.hidden === true
         // Filters is NOT a chart field — it means the same thing to a pivot.
         && !!filters && filters.hidden === false;
     }));

  // ── Fill the shelves: Rows category, sub_category · Columns region · Values sum revenue ──
  const addField = async (shelf: string, column: string): Promise<boolean> => {
    const opened = await win.evaluate((s: string) => {
      const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')].find(
        (b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === s,
      ) as HTMLElement | undefined;
      if (!block) return false;
      (block.querySelector('.pivot-add') as HTMLElement).click();
      return true;
    }, shelf);
    if (!opened) return false;
    await win.waitForTimeout(400);
    const picked = await win.evaluate((c: string) => {
      const row = [...document.querySelectorAll('.project-card-popup button')].find(
        (b) => (b.textContent || '').trim() === c,
      ) as HTMLElement | undefined;
      if (!row) return false;
      row.click();
      return true;
    }, column);
    await win.waitForTimeout(1600);
    return picked;
  };

  // The default shelves are the first dimension and the first measure, so the
  // ones that are already right are left alone and the rest are added.
  const before = await win.evaluate(() => {
    const read = (s: string): string[] => {
      const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')].find(
        (b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === s,
      );
      return [...(block?.querySelectorAll('.enc-pill-name') || [])].map((n) => (n.textContent || '').trim());
    };
    return { rows: read('Rows'), columns: read('Columns'), values: read('Values') };
  });
  ok('the shelves open with a sensible default rather than empty',
     before.rows.length === 1 && before.values.length === 1, JSON.stringify(before));

  // Retarget Rows[0] to `category` through the chip's own ⋮ menu, then add the
  // rest — that menu is how a field is changed without deleting it.
  ok('the first row chip retargets to category through its ⋮ menu', await win.evaluate(() => {
    const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')].find(
      (b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === 'Rows',
    ) as HTMLElement;
    (block.querySelector('.enc-pill-menu') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(400);
  ok('…to "Use category"', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.project-card-popup button')].find(
      (b) => (b.textContent || '').trim() === 'Use category',
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return true;
  }));
  await win.waitForTimeout(1800);

  ok('a second row dimension can be added', await addField('Rows', 'sub_category'));
  ok('a column dimension can be added', await addField('Columns', 'region'));

  // Values: retarget the default measure to revenue (sum is already the default
  // aggregation for a numeric column).
  ok('the value chip retargets to revenue', await win.evaluate(() => {
    const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')].find(
      (b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === 'Values',
    ) as HTMLElement;
    (block.querySelector('.enc-pill-menu') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.project-card-popup button')].find(
      (b) => (b.textContent || '').trim() === 'Use revenue',
    ) as HTMLElement | undefined;
    row?.click();
  });
  await win.waitForTimeout(2500);

  const shelves = await win.evaluate(() => {
    const read = (s: string): string[] => {
      const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')].find(
        (b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === s,
      );
      return [...(block?.querySelectorAll('.enc-pill-name') || [])].map((n) => (n.textContent || '').trim());
    };
    return { rows: read('Rows'), columns: read('Columns'), values: read('Values') };
  });
  ok('the shelves hold category · sub_category / region / sum of revenue',
     JSON.stringify(shelves.rows) === JSON.stringify(['category', 'sub_category'])
     && JSON.stringify(shelves.columns) === JSON.stringify(['region'])
     && shelves.values.length === 1 && /revenue/.test(shelves.values[0]),
     JSON.stringify(shelves));

  // ── The rendered grid ─────────────────────────────────────────────────────
  await win.waitForFunction(() => !!document.querySelector('#viz-area .pivot-table tbody tr'),
                            undefined, { timeout: 30_000 }).catch(() => {});

  const readGrid = () => win.evaluate(() => {
    const table = document.querySelector('#viz-area .pivot-table') as HTMLElement | null;
    if (!table) return null;
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => ({
      label: (tr.querySelector('.pivot-row-head')?.textContent || '').trim(),
      kind: tr.classList.contains('is-subtotal') ? 'subtotal' : 'leaf',
      cells: [...tr.querySelectorAll('.pivot-cell')].map((td) => (td.textContent || '').trim()),
    }));
    return {
      head: [...table.querySelectorAll('thead .pivot-col-head')].map((th) => (th.textContent || '').trim()),
      rows,
      grand: [...(table.querySelector('tfoot tr')?.querySelectorAll('.pivot-cell') || [])]
        .map((td) => (td.textContent || '').trim()),
      grandLast: (table.querySelector('tfoot .pivot-total-cell')?.textContent || '').trim(),
    };
  });

  const grid: any = await readGrid();
  ok('the pivot renders as a real <table>, not a canvas', !!grid && grid.rows.length > 0,
     JSON.stringify(grid && grid.rows.slice(0, 3)));
  const subtotals = grid.rows.filter((x: any) => x.kind === 'subtotal').map((x: any) => x.label);
  ok('…with three category groups, each a subtotal row above its own sub-rows',
     subtotals.length === 3
     && subtotals.every((s: string) => ['Furniture', 'Office Supplies', 'Technology'].indexOf(s) >= 0),
     JSON.stringify(subtotals));
  ok('…five region columns plus a Total column',
     grid.head.filter((h: string) => h && h !== 'Total').length === 5
     && grid.head.indexOf('Total') >= 0, JSON.stringify(grid.head));
  ok('…and a grand total in the corner', /\d/.test(grid.grandLast), grid.grandLast);

  // THE cross-check: the corner cell and the dashboard's Revenue KPI are the
  // same app-computed figure, so they must render the same string.
  const pivotGrand = grid.grandLast;

  // ── Click a column header to sort ─────────────────────────────────────────
  const orderNow = async (): Promise<string[]> =>
    (await readGrid() as any).rows.filter((x: any) => x.kind === 'subtotal').map((x: any) => x.label);
  const orderBefore = await orderNow();

  ok('clicking the West column header sorts', await win.evaluate(() => {
    const th = [...document.querySelectorAll('#viz-area .pivot-table thead .pivot-col-head')]
      .find((h) => (h.textContent || '').trim() === 'West') as HTMLElement | undefined;
    if (!th) return false;
    (th.querySelector('.pivot-sort') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(3000);
  const sorted: any = await readGrid();
  const orderAfter = sorted.rows.filter((x: any) => x.kind === 'subtotal').map((x: any) => x.label);
  const westIdx = sorted.head.indexOf('West');
  const num = (s: string): number => Number(String(s).replace(/[^\d.-]/g, ''))
    * (/K$/.test(s) ? 1e3 : /M$/.test(s) ? 1e6 : 1);
  const westVals = sorted.rows.filter((x: any) => x.kind === 'subtotal').map((x: any) => num(x.cells[westIdx]));
  ok('…descending, largest West figure first',
     westVals.length === 3 && westVals[0] >= westVals[1] && westVals[1] >= westVals[2],
     JSON.stringify({ orderBefore, orderAfter, westVals }));
  ok('…and the header says which way it sorted',
     await win.evaluate(() => {
       const th = [...document.querySelectorAll('#viz-area .pivot-table thead .pivot-col-head')]
         .find((h) => /West/.test(h.textContent || ''));
       return /[↑↓]/.test(th?.textContent || '');
     }));

  // ── Collapse a level ──────────────────────────────────────────────────────
  const furnitureSubs = (g: any): number =>
    g.rows.filter((x: any) => x.kind === 'leaf').length;
  const leavesBefore = furnitureSubs(sorted);
  ok('clicking a row header collapses that level', await win.evaluate(() => {
    const btn = [...document.querySelectorAll('#viz-area .pivot-table .pivot-collapse')]
      .find((b) => /Furniture/.test(b.textContent || '')) as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await win.waitForTimeout(900);
  const collapsed: any = await readGrid();
  ok('…hiding its sub-rows and nobody else\'s',
     furnitureSubs(collapsed) < leavesBefore
     && collapsed.rows.some((x: any) => x.label === 'Furniture')
     && !collapsed.rows.some((x: any) => x.kind === 'leaf'
        && /Chairs|Bookcases|Tables|Furnishings/.test(x.label)),
     JSON.stringify({ leavesBefore, after: furnitureSubs(collapsed) }));

  // ── Save it ───────────────────────────────────────────────────────────────
  ok('Save visual is offered', await clickId('viz-save-btn'));
  await win.waitForTimeout(700);
  ok('…and naming it saves', await fillPrompt('Revenue pivot'));
  await win.waitForTimeout(2500);
  ok('…the gallery shows the saved pivot, labelled as one',
     await win.evaluate(() => {
       const card = [...document.querySelectorAll('.viz-card')].find(
         (c) => /Revenue pivot/.test(c.textContent || ''),
       );
       return !!card && /Pivot table/i.test(card.textContent || '');
     }));

  // ── Put it on the dashboard ───────────────────────────────────────────────
  ok('the saved pivot\'s card menu opens', await win.evaluate(() => {
    const card = [...document.querySelectorAll('.viz-card')].find(
      (c) => /Revenue pivot/.test(c.textContent || ''),
    ) as HTMLElement | undefined;
    if (!card) return false;
    (card.querySelector('.viz-card-menu') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(500);
  ok('…offering Add to dashboard', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.viz-card-pop button')].find(
      (b) => (b.textContent || '').trim() === 'Add to dashboard',
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return true;
  }));
  await win.waitForTimeout(900);
  ok('…and picking the seeded dashboard files it away', await pickFirstOption());
  await win.waitForTimeout(2500);

  ok('the Dashboards section opens', await clickExact('Dashboards'));
  await win.waitForTimeout(1500);
  ok('the seeded dashboard opens', await openSeededAnalysis(win, 'Pivot smoke board'));
  await win.waitForTimeout(4000);

  const tile = await win.evaluate(() => {
    const table = document.querySelector('#dash-grid .pivot-table') as HTMLElement | null;
    const kpi = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => /Revenue/.test(c.querySelector('.dash-card-title')?.textContent || ''));
    return {
      drawn: !!table && !!table.querySelector('tbody tr'),
      cols: [...(table?.querySelectorAll('thead .pivot-col-head') || [])]
        .map((th) => (th.textContent || '').trim()),
      grand: (table?.querySelector('tfoot .pivot-total-cell')?.textContent || '').trim(),
      kpiText: (kpi?.querySelector('.dash-metric-value')?.textContent || '').trim(),
    };
  });
  ok('the pivot draws on a dashboard tile the same way', tile.drawn, JSON.stringify(tile.cols));

  // A card has a fixed height and `overflow: hidden`, so a grid that does not
  // scroll INSIDE itself pushes its own Total row out under the card's edge —
  // where it is invisible and every assertion above still passes. Measure it.
  const fits = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find(
      (c) => !!c.querySelector('.pivot-table'),
    ) as HTMLElement | undefined;
    // A CELL of the Total row, not the <tr>: the cells are what carry
    // `position: sticky`, so the row's own box stays at the bottom of the
    // table while what the reader sees is pinned inside the scrollport.
    const foot = card?.querySelector('.pivot-grand .pivot-row-head') as HTMLElement | null;
    if (!card || !foot) return null;
    const cb = card.getBoundingClientRect();
    const fb = foot.getBoundingClientRect();
    return { inside: fb.bottom <= cb.bottom + 1 && fb.top >= cb.top, cardBottom: cb.bottom, footBottom: fb.bottom };
  });
  ok('…with its Total row inside the card, not clipped under its edge',
     !!fits && fits.inside, JSON.stringify(fits));
  ok('the grand total equals the app-computed Revenue KPI, to the character',
     !!tile.grand && tile.grand === tile.kpiText,
     JSON.stringify({ pivotGrand, tileGrand: tile.grand, kpi: tile.kpiText }));

  // ── Filter it from the dashboard's own filter bar ─────────────────────────
  await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1200);
  ok('the filter bar offers the real region values', await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    if (!sel || ![...sel.options].some((o) => o.value === 'West')) return false;
    sel.value = 'West';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }));
  await win.waitForTimeout(4000);
  const filtered = await win.evaluate(() => {
    const table = document.querySelector('#dash-grid .pivot-table') as HTMLElement | null;
    return [...(table?.querySelectorAll('thead .pivot-col-head') || [])]
      .map((th) => (th.textContent || '').trim());
  });
  ok('filtering to West leaves the grid one region column (plus Total)',
     filtered.filter((h) => h && h !== 'Total').length === 1 && filtered.indexOf('West') >= 0,
     JSON.stringify(filtered));

  // ── Copy as table ─────────────────────────────────────────────────────────
  ok('the tile\'s ⋯ menu offers the pivot actions', await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find(
      (c) => !!c.querySelector('.pivot-table'),
    ) as HTMLElement | undefined;
    if (!card) return false;
    (card.querySelector('.dash-card-menu-btn') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(500);
  const menuLabels = await win.evaluate(() =>
    [...document.querySelectorAll('.dash-card-menu .chart-menu-item')].map((b) => (b.textContent || '').trim()));
  ok('…Copy as table and Export CSV, above the layout actions',
     menuLabels[0] === 'Copy as table' && menuLabels[1] === 'Export CSV',
     JSON.stringify(menuLabels.slice(0, 4)));

  ok('…and Copy as table runs', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.dash-card-menu .chart-menu-item')].find(
      (b) => (b.textContent || '').trim() === 'Copy as table',
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return true;
  }));
  await win.waitForTimeout(1200);
  // Read the system clipboard back through MAIN — the renderer has no clipboard
  // permission, and the whole point is that `hub:copyText` actually fired.
  const clip: string = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('electron').clipboard.readText();
  });
  const firstLine = clip.split('\n')[0];
  ok('…putting TSV on the clipboard whose first line is the column header row',
     firstLine.split('\t')[0] === '' && /\bWest\b/.test(firstLine) && /\bTotal\b/.test(firstLine),
     JSON.stringify(firstLine));
  ok('…and whose body carries the category rows',
     /\bFurniture\b/.test(clip) && /\bTechnology\b/.test(clip) && clip.split('\n').length > 3,
     JSON.stringify(clip.split('\n').slice(0, 3)));

  // ── The authoring panel must not be able to downgrade it ─────────────────
  //
  // That panel has ONE encoding form and a pivot needs three ordered shelves,
  // so it cannot author them. The failure it has to be proof against is silent:
  // writing back a form encoding with no `pivot` block turns a saved pivot into
  // a bar chart, on fields the author cannot even see. So: select the card,
  // check the chart fields are hidden and the panel says where to edit them,
  // make an ordinary formatting edit, and read the RECORD back off disk.
  const { openProps } = railDriver(win);
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find(
      (c) => !!c.querySelector('.pivot-table'),
    ) as HTMLElement | undefined;
    card?.click();
  });
  await win.waitForTimeout(800);
  await openProps();
  await win.waitForTimeout(1500);

  const props = await win.evaluate(() => {
    const cat = document.querySelector('#an-props-inner .viz-build-row[data-well="category"]') as HTMLElement | null;
    const filters = document.querySelector('#an-props-inner .js-enc-filters-row') as HTMLElement | null;
    const note = document.getElementById('an-props-note') as HTMLElement | null;
    return {
      catHidden: !!cat && cat.hidden === true,
      filtersShown: !!filters && filters.hidden === false,
      note: (note && !note.hidden && note.textContent) || '',
    };
  });
  ok('the authoring panel hides a pivot\'s chart fields and says where its shelves live',
     props.catHidden && /Visuals builder/.test(props.note), JSON.stringify(props));
  ok('…while leaving Filters, which mean the same thing to a pivot', props.filtersShown);

  const edited = await win.evaluate(() => {
    const box = document.querySelector('#an-props-inner .an-prop-check input[type=checkbox]') as HTMLInputElement | null;
    if (!box) return false;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  ok('a formatting edit in the panel is possible at all', edited);
  await win.waitForTimeout(2500);
  ok('…and the hint survives it — it explains a panel that stays this way',
     await win.evaluate(() => {
       const note = document.getElementById('an-props-note') as HTMLElement | null;
       return !!note && !note.hidden && /Visuals builder/.test(note.textContent || '');
     }));
  const saved: any = await app.evaluate(async (_e, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const list = await visuals.listVisuals(projectId);
    const row = list.find((v: any) => v.name === 'Revenue pivot');
    const v = row ? await visuals.getVisual(projectId, row.id) : null;
    return v ? { chartType: v.chartType, pivot: v.encoding && v.encoding.pivot } : null;
  }, r.projectId);
  ok('…and the saved record is still a pivot, shelves intact',
     !!saved && saved.chartType === 'pivot' && !!saved.pivot
     && saved.pivot.rows.length === 2 && saved.pivot.values.length === 1,
     JSON.stringify(saved));

  await win.screenshot({ path: path.join(shotDir, 'pivot.png') });

  ok('no unexpected dialog was raised', dialogs.length === 0, JSON.stringify(dialogs));
  // A pivot is DOM, so a CSP violation or a missing script is a console error
  // and nothing else — this assertion is the one that catches both.
  ok('no renderer console errors', errors.length === 0, JSON.stringify(errors.slice(0, 5)));

  await smoke.close();
  finishSmoke('pivot', failureCount());
}

main().catch((err) => {
  console.error('FAIL pivot smoke threw:', err);
  process.exit(1);
});
