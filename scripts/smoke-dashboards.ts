// Smoke test for the Visuals and Dashboards pages — the four defects a walk
// through the real app turned up, each of which is invisible to a DOM check and
// only exists once the page is laid out:
//
//   1. Three of the four Assistant doors were not gated on a model being
//      configured. They looked live and answered a click with an alert.
//   2. A dashboard card's chart was sized against the VIEWPORT, not the card,
//      so every visual card was a scrollbar over a chart cropped to its top
//      third. `hidden`-vs-`display` was last sweep's version of this: a rule
//      written for one surface, inherited by another where it is wrong.
//   3. Visual cards were headed "Visual" — the card TYPE, which the reader can
//      already see — instead of the visual's name.
//   4. The Dashboards header had no subtitle and a unit-less count chip, while
//      Data and Visuals both have one of each.
//
// A smoke run never has a model configured, which is what makes (1) testable
// here at all.

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-dash-'));

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // A project with datasets and no visuals (for the empty states), and one with
  // both plus a dashboard. The bare one is created FIRST so the other stays the
  // most recently updated, which is the one the hub adopts on boot.
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    await projects.init();
    const bare = await projects.createProject('Empty gallery');
    await datasets.saveDataset(bare.id, { name: 'Signups', sourceKind: 'csv',
      columns: [{ name: 'city', type: 'text' }, { name: 'n', type: 'number' }],
      rows: [['Austin', 12], ['Denver', 7]] });

    const proj = await projects.createProject('Sales review');
    const regions = ['North', 'South', 'East', 'West', 'Central'];
    const rows: any[][] = [];
    // `units` and `order_date` exist for the STARTER assertions below: two
    // numeric columns and a date are what make a "KPIs + chart" layout more than
    // one KPI and one chart. The visuals below still encode region/amount, so
    // the older assertions are unaffected.
    for (let i = 0; i < 300; i++) {
      rows.push([regions[i % 5], (i % 97) - 10, (i % 40) + 3,
        new Date(2024, i % 12, 1 + (i % 27)).toISOString().slice(0, 10)]);
    }
    const ds = await datasets.saveDataset(proj.id, { name: 'Sales', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' },
        { name: 'units', type: 'number' }, { name: 'order_date', type: 'date' }], rows });
    const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
    const v1 = await visuals.saveVisual(proj.id, { name: 'Revenue by region', datasetId: ds.id, chartType: 'bar', encoding: enc, filters: [] });
    const v2 = await visuals.saveVisual(proj.id, { name: 'Revenue trend', datasetId: ds.id, chartType: 'line', encoding: enc, filters: [] });
    // The bundled sample ("Retail overview" in "My project") is seeded at boot,
    // so the list assertions below get a REAL dashboard with real charts and no
    // setup of their own.
    const sample = (await projects.listProjects()).find((p: any) => /My project/.test(p.name));
    const an = await analysis.saveAnalysis(proj.id, { name: 'Quarterly review', sheets: [{
      name: 'Overview',
      cards: [
        { type: 'visual', visualId: v1.id, layout: { x: 0, y: 0, w: 6, h: 4 } },
        { type: 'visual', visualId: v2.id, layout: { x: 6, y: 0, w: 6, h: 4 } },
      ],
    }] });
    // A second, EMPTY dashboard: the starter buttons only show on an empty page.
    const blank = await analysis.saveAnalysis(proj.id, { name: 'Starter target', sheets: [{ name: 'Overview', cards: [] }] });
    return { projectId: proj.id, bareProjectId: bare.id, analysisId: an.id, blankId: blank.id,
      datasetId: ds.id, sampleProjectId: sample ? sample.id : '' };
  });
  ok('seeded a bare project and one with visuals + a dashboard',
    Boolean(seeded.projectId && seeded.bareProjectId && seeded.analysisId));

  await win.waitForTimeout(3000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  // ── 1. Every Assistant door is gated, not just the one that had a gate ────
  // No model is configured here, so all four must be disabled and say why.
  // Asserted as a SET: the defect was three surfaces each deciding for
  // themselves, so naming them one at a time is how it came back.
  await win.evaluate(async (id: string) => {
    await (window as any).adoptProject(id);
    (window as any).selectSection('analyses');
  }, seeded.bareProjectId);
  await win.waitForTimeout(900);
  const doors = await win.evaluate(() =>
    ['viz-empty-ai', 'viz-suggest-btn', 'an-draft-btn', 'an-empty-draft'].map((id) => {
      const b = document.getElementById(id) as HTMLButtonElement | null;
      return { id, present: !!b, disabled: !!b && b.disabled, titled: !!b && /Settings → Execution/.test(b.title) };
    }));
  ok('with no model, every Assistant door is disabled', doors.every((d) => d.present && d.disabled),
    JSON.stringify(doors));
  ok('…and each says why on hover, in the one shared sentence',
    doors.every((d) => d.titled), JSON.stringify(doors.filter((d) => !d.titled)));
  const dashHint = await win.evaluate(() => {
    const h = document.getElementById('an-empty-hint');
    return { present: !!h, shown: !!h && !h.hidden, text: (h?.textContent || '').trim() };
  });
  ok('…and the Dashboards empty state explains it in line, as Visuals does',
    dashHint.shown && dashHint.text === 'Connect a model in Settings → Execution to use the Assistant.',
    JSON.stringify(dashHint));

  // ── 4. The Dashboards header matches its sibling sections ────────────────
  await win.evaluate(async (id: string) => {
    await (window as any).adoptProject(id);
    (window as any).selectSection('analyses');
  }, seeded.projectId);
  await win.waitForTimeout(1200);
  const head = await win.evaluate(() => ({
    count: (document.getElementById('an-count') || {} as any).textContent,
    countHidden: (document.getElementById('an-count') as HTMLElement | null)?.hidden,
    sub: (document.querySelector('#ws-analyses .viz-sub') as HTMLElement | null)?.textContent?.trim() || null,
    subVisible: !!(document.querySelector('#ws-analyses .viz-sub') as HTMLElement | null)?.offsetParent,
  }));
  // Two now: the seed adds an empty one for the starter assertions below, which
  // means this also exercises the PLURAL the singular form used to hide.
  ok('the Dashboards count names what it counts, like the Visuals one',
    head.count === '2 dashboards' && head.countHidden === false, JSON.stringify(head));
  ok('…and the page has a subtitle, like Data and Visuals',
    !!head.sub && head.subVisible, JSON.stringify(head));

  // ── 4b. The list is a CARD GRID with live previews, not a text table ─────
  // A dashboard is the one record in the app that is mostly pictures, and its
  // list was the plainest surface in the product. Asserted by geometry and by
  // drawn content: a collapsed card and an empty card both pass every
  // structural check that "the element exists" can make.
  await win.waitForFunction(
    () => document.querySelectorAll('#an-list .an-card').length === 2, { timeout: 20_000 },
  ).catch(() => {});
  const drew = await win.waitForFunction(
    () => document.querySelectorAll('#an-list .viz-card-tile--thumb canvas').length >= 2,
    { timeout: 25_000 },
  ).then(() => true).catch(() => false);
  const grid = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#an-list .an-card')] as HTMLElement[];
    const byName = (re: RegExp) => cards.find((c) => re.test(c.textContent || ''));
    const area = (c?: HTMLElement) => {
      const r = c?.getBoundingClientRect();
      return r ? Math.round(r.width) * Math.round(r.height) : 0;
    };
    const full = byName(/Quarterly review/);
    const blank = byName(/Starter target/);
    return {
      cards: cards.length,
      boxes: cards.map((c) => area(c)),
      laidOut: cards.length > 0 && cards.every((c) => area(c) > 20_000),
      tiles: full ? full.querySelectorAll('.an-card-prev .viz-card-tile').length : 0,
      canvases: full ? full.querySelectorAll('canvas').length : 0,
      menus: cards.filter((c) => c.querySelector('.an-row-menu')).length,
      meta: (full?.querySelector('.viz-card-meta')?.textContent || '').trim(),
      blankBars: !!blank?.querySelector('.an-card-bars .ws-hero-bar'),
      blankCanvas: !!blank?.querySelector('canvas'),
    };
  });
  ok('the list renders one card per dashboard', grid.cards === 2, JSON.stringify(grid.boxes));
  ok('…each laid out, not collapsed to nothing', grid.laidOut, JSON.stringify(grid.boxes));
  ok('…the two-visual sheet previews both of them as live charts',
    drew && grid.tiles === 2 && grid.canvases === 2,
    `tiles=${grid.tiles} canvases=${grid.canvases}`);
  ok('…a sheet with no visual cards keeps the bar glyph instead',
    grid.blankBars && !grid.blankCanvas, JSON.stringify(grid));
  ok('…the card still names the sheet count and when it changed',
    /^1 sheet · /.test(grid.meta), grid.meta);
  ok('…and every card keeps its ⋯ menu', grid.menus === 2, String(grid.menus));

  // ── 4c. The bundled sample, and no leaked charts across repaints ─────────
  // "Retail overview" is seeded into "My project" on a fresh user-data-dir, so
  // this is a real dashboard with real charts. Its first sheet leads with a line
  // and a column chart; the map comes third and is never thumbnailed.
  if (seeded.sampleProjectId) {
    await win.evaluate(async (id: string) => {
      await (window as any).adoptProject(id);
      (window as any).selectSection('analyses');
    }, seeded.sampleProjectId);
    const sampleDrew = await win.waitForFunction(
      () => {
        const c = [...document.querySelectorAll('#an-list .an-card')]
          .find((x) => /Retail overview/.test(x.textContent || ''));
        return !!c && c.querySelectorAll('canvas').length >= 1;
      }, { timeout: 30_000 },
    ).then(() => true).catch(() => false);
    ok('the bundled sample\'s "Retail overview" card draws a real chart', sampleDrew);

    // Three round-trips through the section. Each re-entry repaints the grid,
    // and vizThumbsReset() must destroy the previous paint's charts first — a
    // Chart that outlives its discarded canvas keeps its RAF and resize hooks.
    // Chart.js's own registry proves nothing leaked; vizThumbs' registry proves
    // the tracking set was emptied rather than merely forgotten.
    const before = await win.evaluate(() => ({
      thumbs: (window as any).vizThumbLiveCount(),
      charts: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    }));
    for (let i = 0; i < 3; i += 1) {
      await win.evaluate(() => { (window as any).selectSection('datasets'); });
      await win.waitForTimeout(400);
      await win.evaluate(() => { (window as any).selectSection('analyses'); });
      await win.waitForFunction(
        () => document.querySelectorAll('#an-list .viz-card-tile--thumb canvas').length >= 1,
        { timeout: 25_000 },
      ).catch(() => {});
    }
    const after = await win.evaluate(() => ({
      thumbs: (window as any).vizThumbLiveCount(),
      charts: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    }));
    ok('three section round-trips leak no thumbnail charts',
      after.thumbs <= before.thumbs && after.charts <= before.charts,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    const emptied = await win.evaluate(() => {
      (window as any).vizThumbsReset();
      return (window as any).vizThumbLiveCount();
    });
    ok('…and a repaint empties the registry outright', emptied === 0, String(emptied));
  }

  await win.evaluate(async (id: string) => { await (window as any).adoptProject(id); },
    seeded.projectId);
  await win.waitForTimeout(600);

  // ── 2 + 3. The dashboard editor's cards ──────────────────────────────────
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.analysisId);
  await win.waitForTimeout(2500);
  const cards = await win.evaluate(() => [...document.querySelectorAll('.dash-card')].map((c) => {
    const body = c.querySelector('.dash-card-body') as HTMLElement | null;
    const title = c.querySelector('.dash-card-title') as HTMLElement | null;
    return {
      title: (title?.textContent || '').trim(),
      clientH: body?.clientHeight ?? 0,
      scrollH: body?.scrollHeight ?? 0,
      hasCanvas: !!c.querySelector('canvas'),
    };
  }));
  ok('the editor rendered both visual cards with a chart in each',
    cards.length === 2 && cards.every((c) => c.hasCanvas), JSON.stringify(cards.map((c) => c.title)));
  // The measurement IS the assertion: a chart sized against the viewport
  // overflowed a 189px card body by 300px, and every DOM check passed while it
  // did. Allow a pixel of rounding, nothing more.
  ok('…each chart FITS its card rather than scrolling inside it',
    cards.every((c) => c.clientH > 0 && c.scrollH <= c.clientH + 1),
    JSON.stringify(cards.map((c) => `${c.scrollH}/${c.clientH}`)));
  ok('…and each card is named after its visual, not after the card type',
    cards.some((c) => /Revenue by region/.test(c.title)) && cards.some((c) => /Revenue trend/.test(c.title))
      && !cards.some((c) => /^Visual/.test(c.title)),
    JSON.stringify(cards.map((c) => c.title)));

  // ── 5. A starter layout builds REAL tiles ────────────────────────────────
  // "KPIs + chart" used to insert one text card reading "Add metric cards here"
  // and then ask which SAVED VISUAL went in the slot — so on a project with no
  // visuals it produced that one card and nothing else. Asserted by KIND and by
  // DRAWN CONTENT, not by count: four empty boxes would satisfy a count.
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.blankId);
  await win.waitForTimeout(2000);
  await win.evaluate(() => {
    const b = document.getElementById('dash-starter-kpis') as HTMLElement | null;
    if (b) b.click();
  });
  await win.waitForTimeout(6000);
  const built = await win.evaluate(() => [...document.querySelectorAll('#dash-grid .dash-card')].map((c) => ({
    kind: (c.className.match(/dash-card--(\w+)/) || [])[1],
    title: ((c.querySelector('.dash-card-title') || {}) as any).textContent || '',
    metric: ((c.querySelector('.dash-metric-value') || {}) as any).textContent || '',
    canvas: !!c.querySelector('canvas'),
    x: getComputedStyle(c as HTMLElement).gridColumnStart,
  })));
  ok('a starter layout builds at least three tiles', built.length >= 3, JSON.stringify(built));
  ok('…a KPI row of metric tiles, each showing a computed figure',
    built.filter((b) => b.kind === 'metric').length >= 2
      && built.filter((b) => b.kind === 'metric').every((b) => /\d/.test(b.metric)),
    JSON.stringify(built.filter((b) => b.kind === 'metric').map((b) => b.metric)));
  ok('…and chart tiles that actually drew, not empty placeholders',
    built.filter((b) => b.kind === 'visual').length >= 1
      && built.filter((b) => b.kind === 'visual').every((b) => b.canvas),
    JSON.stringify(built.filter((b) => b.kind === 'visual').map((b) => b.title)));
  ok('…no "add a card here" placeholder text tile survives',
    !built.some((b) => b.kind === 'text'), JSON.stringify(built.map((b) => b.kind)));
  // The KPI strip shares one row: two tiles starting in different columns is
  // what proves dashFindSlot ran instead of the old x:0 stack.
  ok('…and the KPI tiles share a row rather than stacking in column 0',
    new Set(built.filter((b) => b.kind === 'metric').map((b) => b.x)).size >= 2,
    JSON.stringify(built.filter((b) => b.kind === 'metric').map((b) => b.x)));

  // ── 6. A tile's controls are not on top of its plot ──────────────────────
  // .cv-graph-controls is absolutely positioned at the chart's top-right, which
  // is where Chart.js draws its top-right data labels — it sat on the last bar's
  // own number. Geometry, because "the element exists" was always true.
  const overlap = await win.evaluate(() => {
    const cluster = document.querySelector('#dash-grid .cv-graph-controls') as HTMLElement | null;
    const canvas = document.querySelector('#dash-grid canvas') as HTMLElement | null;
    if (!cluster || !canvas) return { found: false, area: -1, inSlot: false };
    const a = cluster.getBoundingClientRect();
    const b = canvas.getBoundingClientRect();
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return { found: true, area: Math.round(w * h), inSlot: !!cluster.closest('.cv-controls-slot') };
  });
  ok('a tile still has its chart controls', overlap.found && overlap.inSlot, JSON.stringify(overlap));
  ok('…and they do not intersect the canvas at all', overlap.area === 0, `${overlap.area}px2 of overlap`);

  // ── 7. The resize handles can be seen ────────────────────────────────────
  // They always worked; they drew nothing, so the affordance only appeared once
  // the pointer was already on a 7px strip. Read AFTER the fade, or the computed
  // value is still the transition's start.
  const handle = await win.evaluate(() => {
    const card = document.querySelector('#dash-grid .dash-card') as HTMLElement | null;
    if (!card) return { rest: '-1', shown: '-1' };
    const e = card.querySelector('.an-resize--e') as HTMLElement | null;
    if (!e) return { rest: '-1', shown: '-1' };
    const rest = getComputedStyle(e).opacity;
    card.classList.add('is-selected');
    return new Promise<{ rest: string; shown: string }>((res) => {
      setTimeout(() => res({ rest, shown: getComputedStyle(e).opacity }), 400);
    });
  });
  ok('a resize handle is invisible at rest', handle.rest === '0', JSON.stringify(handle));
  ok('…and visible once the card is engaged', Number(handle.shown) > 0.2, JSON.stringify(handle));

  // ── 8. Present mode fills the window ─────────────────────────────────────
  // The old rule hid `.sidebar`, which is not the rail — so both rails and the
  // page tabs stayed up through a presentation, and the fixed row pitch left a
  // band of empty background below the last row.
  const present = await win.evaluate(async () => {
    (window as any).enterDashPresent();
    await new Promise((r) => setTimeout(r, 2500));
    const vis = (q: string) => { const el = document.querySelector(q) as HTMLElement | null; return !!(el && el.offsetParent); };
    const ed = document.getElementById('dash-editor') as HTMLElement;
    const grid = document.getElementById('dash-grid') as HTMLElement;
    const pad = parseFloat(getComputedStyle(ed).paddingBottom) || 0;
    const contentBottom = ed.getBoundingClientRect().top + ed.clientHeight - pad;
    return {
      rail: vis('.app-sidebar') || vis('.an-rail'),
      tabs: vis('.dash-pages'),
      head: vis('.dash-editor-head'),
      controls: vis('#dash-grid .cv-graph-controls'),
      band: Math.round(contentBottom - grid.getBoundingClientRect().bottom),
      scrolls: ed.scrollHeight > ed.clientHeight + 1,
    };
  });
  ok('present mode hides the rail', !present.rail, JSON.stringify(present));
  ok('…and the page tabs and the editor head', !present.tabs && !present.head, JSON.stringify(present));
  ok('…and the per-tile chart controls', !present.controls, JSON.stringify(present));
  ok('…and the tiles fill the window, leaving no band below the last row',
    present.band <= 4 && present.band >= -1 && !present.scrolls, JSON.stringify(present));

  const exited = await win.evaluate(async () => {
    (window as any).exitDashPresent();
    await new Promise((r) => setTimeout(r, 1500));
    const grid = document.getElementById('dash-grid') as HTMLElement;
    return {
      rail: !!(document.querySelector('.an-rail') as HTMLElement | null)?.offsetParent,
      row: getComputedStyle(grid).getPropertyValue('--dash-row').trim(),
    };
  });
  ok('leaving present mode puts the chrome and the row pitch back',
    exited.rail && exited.row === '48px', JSON.stringify(exited));

  ok('no renderer console errors on either page', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' dashboards smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll dashboards smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
