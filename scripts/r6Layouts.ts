// Round-6 smoke SECTION: layouts for every size, driven through the REAL UI. Not
// a standalone smoke — scripts/smoke-round6.ts calls layoutsSection(s, fx) on its
// one launch and fixture.
//
//   A seeded dashboard — four KPIs, two half-width charts, a note and two
//   filter controls — opens on Desktop; the head stays one row with the size
//   switcher in it (it folds to one button beside the docked Assistant) → the
//   Phone switch shows the derived phone layout: reading order, KPIs two-up,
//   charts full width, the filter bar folded into "Filters (2)", which opens the
//   chips in a sheet →
//   hide a KPI with the card's eye (the rest re-pair, the tray offers it back),
//   drag a chart above the other, drag the note's bottom edge two rows taller,
//   undo and redo that → Desktop is untouched, on screen and on disk, while the
//   record carries the phone layout → the published page, opened offline at
//   phone, tablet and desktop widths, draws each of the three from its CSS
//   alone, with no network and no CSP error → Tablet is still derived (KPIs four-up,
//   charts paired) → Reset to derived (through the app's confirm) → a window
//   narrowed below the tablet breakpoint picks tablet by itself, and so does a
//   split pane beside a dataset; narrower still it is phone with its Filters
//   button, and Present there shows tablet.
//   Leaves the window its size and the app on the project's Data list.

import { ok } from './selfcheck';
import type { Smoke, Fixture, SeedCard } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

interface GridCard { id: string; title: string; col: string; row: string }
interface GridState { size: string; frame: boolean; grid: string; cards: GridCard[] }

/** What the grid draws, in DOM (= reading) order. */
const grid = (win: Win): Promise<GridState> => win.evaluate(() => {
  const ed = document.getElementById('dash-editor') as HTMLElement;
  const g = document.getElementById('dash-grid') as HTMLElement;
  return {
    size: ed.dataset.lySize || '',
    frame: ed.classList.contains('ly-frame'),
    grid: g.className,
    cards: [...g.querySelectorAll(':scope > .dash-card')].filter((el) => !(el as HTMLElement).hidden).map((el) => ({
      id: (el as HTMLElement).dataset.cardId || '',
      title: (el.querySelector('.dash-card-title')?.textContent || '').trim(),
      col: (el as HTMLElement).style.gridColumn,
      row: (el as HTMLElement).style.gridRow,
    })),
  };
});

const box = (win: Win, sel: string): Promise<{ x: number; y: number; w: number; h: number } | null> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);

const segPressed = (win: Win): Promise<string> => win.evaluate(() =>
  [...document.querySelectorAll('#ly-switch .ly-seg')].filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => (b as HTMLElement).dataset.size).join(','));

export async function layoutsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const setContent = (w: number, h: number): Promise<void> => app.evaluate(({ BrowserWindow }, a: number[]) => {
    BrowserWindow.getAllWindows()[0].setContentSize(a[0], a[1]);
  }, [w, h]);
  const size0: number[] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await setContent(1440, 900);
  await win.waitForTimeout(500);

  // ── The dashboard ────────────────────────────────────────────────────────
  const metric = (label: string, aggregation: string, x: number): SeedCard => ({
    type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation, label }, layout: { x, y: 0, w: 3, h: 2 },
  });
  const cards = [
    metric('Total', 'sum', 0), metric('Average', 'avg', 3), metric('Count', 'count', 6), metric('Largest', 'max', 9),
    { type: 'control', control: { kind: 'dropdown', label: 'Region', datasetId: fx.datasetId, column: 'region' }, layout: { x: 0, y: 0, w: 0, h: 0 } },
    { type: 'control', control: { kind: 'dropdown', label: 'SKU', datasetId: fx.datasetId, column: 'sku' }, layout: { x: 1, y: 0, w: 0, h: 0 } },
    { type: 'visual', visualId: fx.visualId, layout: { x: 0, y: 2, w: 6, h: 6 } },
    { type: 'visual', visualId: fx.mapVisualId, layout: { x: 6, y: 2, w: 6, h: 6 } },
    { type: 'text', heading: 'Notes', text: 'Figures are the app\'s.', layout: { x: 0, y: 8, w: 12, h: 2 } } as unknown as SeedCard,
  ] as SeedCard[];
  const aid = await seedAnalysis(app, pid, { name: 'Sizes board', sheets: [{ name: 'Sheet 1', cards }] });
  const record = (): Promise<any> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/analysis/analysis.js').getAnalysis(a.pid, a.aid);
  }, { pid, aid });
  const seeded = await record();
  const byTitle = (t: string): string => {
    const c = seeded.sheets[0].cards.find((x: any) =>
      (x.metric && x.metric.label === t) || (x.heading === t)
      || (t === 'Sales by region' && x.visualId === fx.visualId) || (t === 'Revenue by state' && x.visualId === fx.mapVisualId));
    return c ? c.id : '';
  };
  const ID = {
    total: byTitle('Total'), avg: byTitle('Average'), count: byTitle('Count'), max: byTitle('Largest'),
    sales: byTitle('Sales by region'), map: byTitle('Revenue by state'), notes: byTitle('Notes'),
  };
  const desktopLayouts = JSON.stringify(seeded.sheets[0].cards.map((c: any) => c.layout));

  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(1000);
  ok('layouts: the dashboard opens', await openSeededAnalysis(win, 'Sizes board'));
  await until(win, async () => (await grid(win)).cards.every((c) => c.title && c.title !== 'Visual'));

  // ── The head stays one row with the switcher in it ──────────────────────
  // The focus-mode head is the busiest strip in the app and folds at measured
  // widths; the switcher moves those folds. Checked where they bite: wide, the
  // Assistant docked beside a mid-size window, and beside the default 1180px
  // one (where the switcher itself folds to one button).
  const headFit = (): Promise<{ cw: number; sw: number; h: number; compact: boolean }> => win.evaluate(() => {
    const head = document.querySelector('.dash-editor-head') as HTMLElement;
    const btn = document.getElementById('ly-size-btn') as HTMLElement;
    return { cw: head.clientWidth, sw: head.scrollWidth, h: Math.round(head.getBoundingClientRect().height), compact: btn.getClientRects().length > 0 };
  });
  const fits: string[] = [];
  for (const [w, dock] of [[1440, false], [1320, true], [1180, true], [900, false]] as Array<[number, boolean]>) {
    await setContent(w, 900);
    if (dock) await win.evaluate(() => { (window as any).dkToggle(); });
    await win.waitForTimeout(700);
    const f = await headFit();
    fits.push(`${w}${dock ? '+dock' : ''}: ${f.sw}/${f.cw} h${f.h}${f.compact ? ' compact' : ''}`);
    ok(`head: one row, nothing pushed off the end at ${w}px${dock ? ' with the Assistant docked' : ''}`, f.sw <= f.cw && f.h < 70, fits.join(' · '));
    if (dock) await win.evaluate(() => { (window as any).dkToggle(); });
  }
  ok('head: beside the docked Assistant at 1180px the switcher folds to one button', / compact/.test(fits[2]) && !/ compact/.test(fits[0]), fits.join(' · '));
  await setContent(1440, 900);
  await win.waitForTimeout(700);

  // ── Desktop: today's grid, with the switcher in the header ──────────────
  const d0 = await grid(win);
  ok('layouts: the header carries a Desktop / Tablet / Phone switcher, on Desktop',
    (await win.evaluate(() => [...document.querySelectorAll('#ly-switch .ly-seg')].map((b) => b.getAttribute('aria-label')).join('|')))
      === 'Desktop layout|Tablet layout, derived|Phone layout, derived' && (await segPressed(win)) === 'desktop',
    await segPressed(win));
  ok('layouts: a wide pane draws the desktop grid', d0.size === 'desktop' && !/ly-grid/.test(d0.grid) && d0.cards.length === 7, JSON.stringify(d0));
  const deskCells = JSON.stringify(d0.cards.map((c) => [c.id, c.col, c.row]).sort());

  // ── Phone: derived ──────────────────────────────────────────────────────
  ok('layouts: switch to Phone', await click(win, '#ly-switch .ly-seg[data-size="phone"]'));
  await until(win, async () => (await grid(win)).size === 'phone');
  const p0 = await grid(win);
  ok('phone: a framed preview on the phone grid', p0.frame && /ly-grid--phone/.test(p0.grid) && (await segPressed(win)) === 'phone', JSON.stringify(p0));
  ok('phone: the state says Derived', (await text(win, '#ly-state')) === 'Derived');
  ok('phone: read top to bottom, left to right',
    JSON.stringify(p0.cards.map((c) => c.id)) === JSON.stringify([ID.total, ID.avg, ID.count, ID.max, ID.sales, ID.map, ID.notes]),
    JSON.stringify(p0.cards.map((c) => c.title)));
  ok('phone: the KPIs sit two-up', JSON.stringify(p0.cards.slice(0, 4).map((c) => [c.col, c.row]))
    === JSON.stringify([['1 / span 1', '1 / span 2'], ['2 / span 1', '1 / span 2'], ['1 / span 1', '3 / span 2'], ['2 / span 1', '3 / span 2']]),
    JSON.stringify(p0.cards.slice(0, 4)));
  ok('phone: each chart takes the full width at 6 rows',
    p0.cards.slice(4, 6).every((c) => c.col === '1 / span 2' && / span 6$/.test(c.row)), JSON.stringify(p0.cards.slice(4, 6)));
  ok('phone: the filter bar folds into "Filters (2)"',
    (await text(win, '#dash-control-bar .ly-fb-open')) === 'Filters (2)'
      && await win.evaluate(() => (document.getElementById('dash-fb-chips') as HTMLElement).getClientRects().length === 0),
    await text(win, '#dash-control-bar'));
  await shot('r6-layouts-phone-derived.png');

  ok('phone: "Filters (2)" opens the chips in a sheet', await click(win, '#dash-control-bar .ly-fb-open'));
  const sheet = await until(win, () => win.evaluate(() => {
    const box = document.querySelector('.ly-sheet');
    return !!box && box.querySelectorAll('.dash-fb-chip').length === 2 && box.getAttribute('role') === 'dialog';
  }), 5000);
  ok('phone: the sheet holds both controls, as a dialog', sheet, await text(win, '.ly-sheet'));
  await shot('r6-layouts-phone-filters.png');
  await win.keyboard.press('Escape');
  ok('phone: Escape closes the sheet and the chips go home',
    await until(win, () => win.evaluate(() => !document.querySelector('.ly-sheet')
      && document.getElementById('dash-fb-chips')?.parentElement?.id === 'dash-control-bar'), 5000));

  // ── Hide, reorder, height ───────────────────────────────────────────────
  ok('phone: hide Average with its eye', await win.evaluate((id: string) => {
    const b = document.querySelector('#dash-grid .dash-card[data-card-id="' + id + '"] .ly-hide-btn') as HTMLElement | null;
    if (!b || b.getAttribute('aria-label') !== 'Hide on phone') return false;
    b.click();
    return true;
  }, ID.avg));
  await until(win, async () => !(await grid(win)).cards.some((c) => c.id === ID.avg));
  const p1 = await grid(win);
  ok('phone: the hidden KPI is gone and the other three re-pair — a pair, then one across',
    JSON.stringify(p1.cards.slice(0, 3).map((c) => [c.id, c.col])) === JSON.stringify([[ID.total, '1 / span 1'], [ID.count, '2 / span 1'], [ID.max, '1 / span 2']]),
    JSON.stringify(p1.cards.slice(0, 3)));
  ok('phone: the tray offers it back', (await text(win, '#ly-tray .ly-tray-title')) === 'Hidden on phone'
    && (await text(win, '#ly-tray .ly-tray-count')) === '1' && (await text(win, '#ly-tray .ly-tray-name')) === 'Average', await text(win, '#ly-tray'));
  ok('phone: now Edited, with a dot on the Phone switch and Reset offered',
    (await text(win, '#ly-state')) === 'Edited'
      && await win.evaluate(() => !(document.querySelector('#ly-switch [data-size="phone"] .ly-seg-dot') as HTMLElement).hidden
        && !(document.getElementById('ly-reset') as HTMLElement).hidden));

  const scrollTo = (id: string, block: string): Promise<void> => win.evaluate((a: string[]) => {
    document.querySelector('#dash-grid .dash-card[data-card-id="' + a[0] + '"]')?.scrollIntoView({ block: a[1] as ScrollLogicalPosition });
  }, [id, block]);
  await scrollTo(ID.sales, 'start');
  await win.waitForTimeout(200);
  const mapHead = await box(win, '#dash-grid .dash-card[data-card-id="' + ID.map + '"] .dash-card-title');
  const salesCard = await box(win, '#dash-grid .dash-card[data-card-id="' + ID.sales + '"]');
  if (mapHead && salesCard) {
    await win.mouse.move(mapHead.x + 4, mapHead.y + mapHead.h / 2);
    await win.mouse.down();
    await win.mouse.move(salesCard.x + salesCard.w / 2, salesCard.y + 30, { steps: 10 });
    await win.mouse.up();
  }
  await until(win, async () => (await grid(win)).cards.findIndex((c) => c.id === ID.map) < (await grid(win)).cards.findIndex((c) => c.id === ID.sales));
  const p2 = await grid(win);
  ok('phone: dragging the map by its header onto the top of the other chart puts it first',
    p2.cards.findIndex((c) => c.id === ID.map) === p2.cards.findIndex((c) => c.id === ID.sales) - 1, JSON.stringify(p2.cards.map((c) => c.title)));

  const notes0 = p2.cards.find((c) => c.id === ID.notes)!;
  await scrollTo(ID.notes, 'center');
  await win.waitForTimeout(200);
  const edge = await box(win, '#dash-grid .dash-card[data-card-id="' + ID.notes + '"] .an-resize--s');
  const pitch: number = await win.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('dash-grid') as HTMLElement);
    return parseFloat(cs.getPropertyValue('--dash-row')) + parseFloat(cs.getPropertyValue('--dash-gap'));
  });
  if (edge) {
    await win.mouse.move(edge.x + edge.w / 2, edge.y + 2);
    await win.mouse.down();
    await win.mouse.move(edge.x + edge.w / 2, edge.y + 2 + pitch * 2, { steps: 8 });
    await win.mouse.up();
  }
  const spanOf = (row: string): number => Number((/span (\d+)/.exec(row) || [])[1] || 0);
  await until(win, async () => spanOf((await grid(win)).cards.find((c) => c.id === ID.notes)!.row) !== spanOf(notes0.row));
  const tallNotes = spanOf((await grid(win)).cards.find((c) => c.id === ID.notes)!.row);
  ok('phone: dragging the note\'s bottom edge down two rows makes it two rows taller', tallNotes === spanOf(notes0.row) + 2, tallNotes + ' vs ' + notes0.row);
  await shot('r6-layouts-phone-edited.png');

  ok('phone: Undo names the height change', /Change height \(phone\)/.test(await win.evaluate(() => (document.getElementById('dash-undo-btn') as HTMLElement).title)));
  await click(win, '#dash-undo-btn');
  ok('phone: Undo puts the height back', await until(win, async () => spanOf((await grid(win)).cards.find((c) => c.id === ID.notes)!.row) === spanOf(notes0.row), 5000));
  await click(win, '#dash-redo-btn');
  ok('phone: Redo makes it tall again', await until(win, async () => spanOf((await grid(win)).cards.find((c) => c.id === ID.notes)!.row) === tallNotes, 5000));

  // ── Desktop untouched ───────────────────────────────────────────────────
  ok('desktop: switch back', await click(win, '#ly-switch .ly-seg[data-size="desktop"]'));
  await until(win, async () => (await grid(win)).size === 'desktop');
  const d1 = await grid(win);
  ok('desktop: every card is in the cell it started in — the phone edits moved nothing here',
    JSON.stringify(d1.cards.map((c) => [c.id, c.col, c.row]).sort()) === deskCells && !d1.frame, JSON.stringify(d1));
  // Every phone edit autosaves on its own, so wait for the LAST one to land — the
  // first save (Average hidden) alone already satisfies "a phone layout exists".
  const phoneSaved = (r: any): boolean => {
    const items: any[] = (r.sheets[0].layouts && r.sheets[0].layouts.phone && r.sheets[0].layouts.phone.items) || [];
    const at = (id: string): number => items.findIndex((i) => i.id === id);
    return at(ID.map) >= 0 && at(ID.map) < at(ID.sales) && items[at(ID.avg)]?.hidden === true
      && items[at(ID.notes)]?.h === tallNotes && !r.sheets[0].layouts.tablet;
  };
  await until(win, async () => phoneSaved(await record()), 15_000);
  const onDisk = await record();
  ok('desktop: on disk the cards keep their desktop layouts', JSON.stringify(onDisk.sheets[0].cards.map((c: any) => c.layout)) === desktopLayouts);
  ok('desktop: …and the page carries the phone layout — map before sales, Average hidden, the note taller, no tablet',
    phoneSaved(onDisk), JSON.stringify(onDisk.sheets[0].layouts));

  // ── Published: all three layouts, switched by the page's CSS alone ──────
  const pub: any = await app.evaluate(async (electronModule, a: { pid: string; aid: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const nodeFs = req('fs');
    const nodePath = req('path');
    const { BrowserWindow, session, app: eapp } = electronModule as any;
    const html = await req('./src/publish/publish.js').dashboardPageHtml(a.pid, a.aid);
    const file = nodePath.join(eapp.getPath('userData'), 'r6-layouts-published.html');
    nodeFs.writeFileSync(file, html, 'utf8');
    const ses = session.fromPartition('r6-layouts-published');
    const requests: string[] = [];
    ses.webRequest.onBeforeRequest((d: any, cb: any) => { if (!d.url.startsWith('file:')) requests.push(d.url); cb({}); });
    const out: any = { requests, logs: [] as string[] };
    for (const width of [390, 800, 1300]) {
      const w = new BrowserWindow({ show: false, width, height: 900, useContentSize: true, webPreferences: { session: ses, contextIsolation: true } });
      w.webContents.on('console-message', (_ev: any, level: number, message: string) => { if (level >= 2) out.logs.push(message); });
      await w.loadFile(file);
      for (let i = 0; i < 100; i++) {
        if (await w.webContents.executeJavaScript('document.body.dataset.ready === "true"')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      out[width] = await w.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.pub-grid > .pub-card')].map((c) => {
          const cs = getComputedStyle(c);
          return { t: (c.querySelector('.pub-card-title, .pub-text-h') || {}).textContent || '', shown: cs.display !== 'none',
            col: cs.gridColumnStart + '/' + cs.gridColumnEnd, row: cs.gridRowStart + '/' + cs.gridRowEnd };
        });
        const open = document.querySelector('.pub-filters-open');
        return { inner: innerWidth, tracks: getComputedStyle(document.querySelector('.pub-grid')).gridTemplateColumns.split(' ').length, cards,
          filtersBtn: open && getComputedStyle(open).display !== 'none' ? open.textContent : '',
          bar: getComputedStyle(document.querySelector('.pub-filters')).display };
      })()`);
      w.destroy();
    }
    return out;
  }, { pid, aid });
  const pcard = (width: number, t: string): any => (pub[width].cards as any[]).find((c) => c.t === t) || {};
  const rowOf = (c: any): number => Number(String(c.row).split('/')[0]);
  ok('published: a phone-width window draws the phone layout — 2 tracks, Average hidden, the map above the sales chart',
    pub[390].tracks === 2 && pcard(390, 'Average').shown === false && pcard(390, 'Total').shown
      && rowOf(pcard(390, 'Revenue by state')) < rowOf(pcard(390, 'Sales by region')), JSON.stringify(pub[390]));
  ok('published: …KPIs two-up, and the filter bar folded into "Filters (2)"',
    pcard(390, 'Total').col === '1/span 1' && pcard(390, 'Count').col === '2/span 1' && rowOf(pcard(390, 'Total')) === rowOf(pcard(390, 'Count'))
      && pub[390].filtersBtn === 'Filters (2)' && pub[390].bar === 'none', JSON.stringify(pub[390]));
  ok('published: a tablet-width window draws the derived tablet layout — 8 tracks, KPIs four-up, the charts paired',
    pub[800].tracks === 8 && ['Total', 'Average', 'Count', 'Largest'].map((t) => pcard(800, t).col).join() === '1/span 2,3/span 2,5/span 2,7/span 2'
      && pcard(800, 'Sales by region').col === '1/span 4' && pcard(800, 'Revenue by state').col === '5/span 4', JSON.stringify(pub[800]));
  ok('published: a wide window draws the desktop grid, filter bar open',
    pub[1300].tracks === 12 && pcard(1300, 'Largest').col === '10/span 3' && pcard(1300, 'Revenue by state').col === '7/span 6'
      && pub[1300].filtersBtn === '' && pub[1300].bar !== 'none', JSON.stringify(pub[1300]));
  ok('published: offline and CSP-clean at every width', pub.requests.length === 0 && pub.logs.length === 0, JSON.stringify({ r: pub.requests, l: pub.logs }));

  // ── Tablet: still derived ───────────────────────────────────────────────
  ok('tablet: switch to Tablet', await click(win, '#ly-switch .ly-seg[data-size="tablet"]'));
  await until(win, async () => (await grid(win)).size === 'tablet');
  const t0 = await grid(win);
  ok('tablet: derived — KPIs four-up at 2 of 8 columns', /ly-grid--tablet/.test(t0.grid) && (await text(win, '#ly-state')) === 'Derived'
    && JSON.stringify(t0.cards.slice(0, 4).map((c) => c.col)) === JSON.stringify(['1 / span 2', '3 / span 2', '5 / span 2', '7 / span 2']), JSON.stringify(t0.cards));
  ok('tablet: the two half-width charts pair on one row',
    JSON.stringify(t0.cards.slice(4, 6).map((c) => [c.id, c.col])) === JSON.stringify([[ID.sales, '1 / span 4'], [ID.map, '5 / span 4']]), JSON.stringify(t0.cards.slice(4, 6)));
  await shot('r6-layouts-tablet.png');

  // ── Reset to derived ────────────────────────────────────────────────────
  await click(win, '#ly-switch .ly-seg[data-size="phone"]');
  await until(win, async () => (await grid(win)).size === 'phone');
  let confirmText = '';
  win.once('dialog', (d) => { confirmText = d.message(); void d.accept(); });
  ok('reset: Reset to derived sits in the note above the grid', await click(win, '#ly-reset'));
  await until(win, async () => (await text(win, '#ly-state')) === 'Derived');
  const p3 = await grid(win);
  ok('reset: the app asks first, naming the size', /Reset the phone layout of this page to derived\?/.test(confirmText), confirmText);
  ok('reset: the phone layout is derived again — Average back, reading order, tray gone',
    JSON.stringify(p3.cards.map((c) => c.id)) === JSON.stringify(p0.cards.map((c) => c.id))
      && await win.evaluate(() => (document.getElementById('ly-tray') as HTMLElement).hidden === true), JSON.stringify(p3.cards.map((c) => c.title)));
  ok('reset: …and the record no longer carries a phone layout', await until(win, async () => {
    const r = await record();
    return !r.sheets[0].layouts;
  }, 10_000));

  // ── The size follows the pane ───────────────────────────────────────────
  ok('pane: Desktop follows the pane again', await click(win, '#ly-switch .ly-seg[data-size="desktop"]'));
  await until(win, async () => (await grid(win)).size === 'desktop');
  await setContent(900, 900);
  ok('pane: a window narrowed below the tablet breakpoint picks tablet by itself, unframed',
    await until(win, async () => {
      const g = await grid(win);
      return g.size === 'tablet' && !g.frame && /ly-grid--tablet/.test(g.grid);
    }), JSON.stringify(await grid(win)));
  ok('pane: the switcher shows Tablet, and the note says why and offers the desktop layout',
    (await segPressed(win)) === 'tablet' && /Showing the tablet layout/.test(await text(win, '#ly-note .ly-note-text'))
      && /Edit desktop layout/.test(await text(win, '#ly-note .ly-note-acts')), await text(win, '#ly-note'));
  await win.evaluate(() => { (document.getElementById('dash-editor') as HTMLElement).scrollTop = 0; });
  await shot('r6-layouts-narrow-window.png');
  await setContent(1440, 900);
  ok('pane: widened again, it is back on desktop', await until(win, async () => (await grid(win)).size === 'desktop'));

  // A split pane counts too: the dataset on the left, the dashboard beside it.
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(800);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(600);
  await win.evaluate((d: string) => (window as any).openSavedDataset(d), fx.datasetId);
  await win.waitForTimeout(1200);
  await win.evaluate(() => (window as any).tabSplitCommand());
  const split = await until(win, () => win.evaluate(() => document.querySelector('.hub-body')?.classList.contains('tab-split') === true
    && !(document.getElementById('dash-editor') as HTMLElement).hidden), 15_000);
  ok('split: the dataset and the dashboard side by side', split);
  await win.evaluate(() => (window as any).tabSetRatio(0.4, true));
  ok('split: a dashboard pane 60% of the window shows tablet',
    await until(win, async () => (await grid(win)).size === 'tablet'), JSON.stringify(await grid(win)));
  await win.evaluate(() => (window as any).tabSetRatio(0.65, true));
  ok('split: narrowed to a third, it shows phone', await until(win, async () => (await grid(win)).size === 'phone'), JSON.stringify(await grid(win)));
  ok('split: …with "Filters (2)" in place of the chips',
    (await text(win, '#dash-control-bar .ly-fb-open')) === 'Filters (2)', await text(win, '#dash-control-bar'));
  await shot('r6-layouts-split-phone.png');

  ok('present: Present, from the head\'s More menu', await click(win, '#an-more-btn') && await win.evaluate(() => {
    const item = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Present') as HTMLElement | undefined;
    item?.click();
    return !!item;
  }));
  ok('present: a phone-width pane presents the tablet layout, never phone',
    await until(win, async () => (await grid(win)).size === 'tablet'
      && await win.evaluate(() => document.documentElement.classList.contains('dash-presenting'))), JSON.stringify(await grid(win)));
  await shot('r6-layouts-present-small.png');
  await win.keyboard.press('Escape');
  await until(win, () => win.evaluate(() => !document.documentElement.classList.contains('dash-presenting')), 5000);

  // ── Neutral ─────────────────────────────────────────────────────────────
  await win.evaluate(() => (window as any).tabSplitCommand()); // unsplit
  await until(win, () => win.evaluate(() => document.querySelector('.hub-body')?.classList.contains('tab-split') !== true), 5000);
  await setContent(size0[0] || 1440, size0[1] || 900);
  await win.waitForTimeout(400);
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(800);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(600);
  ok('layouts: back on the project, unsplit, the editor closed', await win.evaluate(() =>
    (document.getElementById('dash-editor') as HTMLElement).hidden === true && !document.querySelector('.hub-body')?.classList.contains('tab-split')));
  const errs = s.errors.slice(errors0);
  ok('layouts: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
