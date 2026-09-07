// Smoke test for dashboard STYLES — the four presets, in the real app.
//
// Everything here is invisible to a DOM check, because a style is not markup:
// it is what the browser RESOLVES after the cascade runs. The failures this
// guards against all look like working code and render wrong pixels:
//
//   1. A preset whose class lands but whose tokens do not (a block that omits a
//      token inherits the light value — the dark-sheet-with-white-boxes bug).
//   2. Charts that keep the OUTGOING palette, because Chart.js reads its colours
//      once at construction and getCSSVar used to resolve them against <html>
//      rather than the chart's own element. That is also what makes four
//      differently-styled previews possible at all, so it is asserted directly.
//   3. Density that changes the painted grid but not the drag/resize maths,
//      which were duplicated as frozen constants in TypeScript.
//   4. A style that applies but never persists — the user restyles, reopens,
//      and finds Clean again.
//
// It also writes one screenshot per preset (SHOTS below), which is the artifact
// the PR shows: four pictures of the same dashboard.

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-style-'));
const SHOTS = process.env.ORDINATE_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-style-shots-'));

// The picker's four. `dense` is still a preset the Assistant can name, but it
// is a density rather than a look, so it is not a tile.
const PRESETS = ['auto', 'clean', 'executive', 'dark'];

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

  // One dashboard with all three card kinds, so each preset is exercised on a
  // chart, a KPI and a block of text rather than on one card type.
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    await projects.init();
    const proj = await projects.createProject('Style review');
    const regions = ['North', 'South', 'East', 'West', 'Central'];
    const rows: any[][] = [];
    for (let i = 0; i < 300; i++) rows.push([regions[i % 5], (i % 97) + 12]);
    const ds = await datasets.saveDataset(proj.id, { name: 'Sales', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows });
    const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
    const v1 = await visuals.saveVisual(proj.id, { name: 'Revenue by region', datasetId: ds.id, chartType: 'bar', encoding: enc, filters: [] });
    const v2 = await visuals.saveVisual(proj.id, { name: 'Revenue trend', datasetId: ds.id, chartType: 'line', encoding: enc, filters: [] });
    const an = await analysis.saveAnalysis(proj.id, { name: 'Quarterly review', sheets: [{
      name: 'Overview',
      cards: [
        { type: 'metric', layout: { x: 0, y: 0, w: 4, h: 2 },
          metric: { datasetId: ds.id, column: 'amount', aggregation: 'sum', label: 'Total revenue', format: 'auto' } },
        { type: 'metric', layout: { x: 4, y: 0, w: 4, h: 2 },
          metric: { datasetId: ds.id, column: 'amount', aggregation: 'avg', label: 'Average order', format: 'auto' } },
        { type: 'text', layout: { x: 8, y: 0, w: 4, h: 2 }, heading: 'Note', text: 'Five regions, 300 orders.' },
        { type: 'visual', visualId: v1.id, layout: { x: 0, y: 2, w: 6, h: 5 } },
        { type: 'visual', visualId: v2.id, layout: { x: 6, y: 2, w: 6, h: 5 } },
      ],
    }] });
    return { projectId: proj.id, analysisId: an.id };
  });
  ok('seeded a dashboard with a chart, two KPIs and a text tile',
    Boolean(seeded.projectId && seeded.analysisId));

  await win.waitForTimeout(3000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  // selectSection FIRST: the editor is one re-parented element, and opening a
  // dashboard while another section is showing leaves it in a display:none
  // subtree — where every rect is 0x0 and getComputedStyle hands back the
  // UNRESOLVED `repeat(12, 1fr)` instead of twelve tracks. Every geometry
  // assertion below would then be measuring nothing at all.
  await win.evaluate(async (id: string) => {
    await (window as any).adoptProject(id);
    (window as any).selectSection('analyses');
  }, seeded.projectId);
  await win.waitForTimeout(1200);
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.analysisId);
  await win.waitForTimeout(3000);

  // ── A record written before styles existed opens as Clean ────────────────
  // saveAnalysis defaulted it, and the editor must paint that default rather
  // than leaving the element with no axis class at all (which renders the
  // theme.css values and only LOOKS right until a preset is applied and cleared).
  const initial = await measure(win);
  ok('a dashboard opens carrying all three axis classes',
    initial.classes.theme === 'auto' && initial.classes.density === 'comfortable'
      && initial.classes.accent === 'blue', JSON.stringify(initial.classes));

  // ── The Style button is reachable, and not gated on edit rights ──────────
  // Authoring an analysis re-homes .dash-toolbar into a collapsed side pane, so
  // the toolbar button exists but is unreachable — which is why Present, Export
  // and Share are mirrored into the ⋯ overflow. Style has to be there too, and
  // the overflow is what this asserts: the button alone proves nothing.
  const btn = await win.evaluate(() => {
    const b = document.getElementById('dash-style-btn') as HTMLButtonElement | null;
    const more = document.getElementById('an-more-btn') as HTMLElement | null;
    if (more) more.click();
    const rows = [...document.querySelectorAll('.chart-menu-item')].map((r) => (r.textContent || '').trim());
    return { present: !!b, editOnly: !!b && b.classList.contains('dash-edit-only'),
      moreVisible: !!more && !!more.offsetParent, rows };
  });
  ok('the dashboard offers a Style control', btn.present, JSON.stringify(btn));
  ok('…reachable from the ⋯ overflow, where Present and Share already are',
    btn.moreVisible && btn.rows.indexOf('Style…') >= 0, JSON.stringify(btn.rows));
  ok('…and usable by a reader of a published dashboard, not edit-only', !btn.editOnly, JSON.stringify(btn));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // ── The chooser previews four DIFFERENT worlds ───────────────────────────
  await win.evaluate(() => (document.getElementById('dash-style-btn') as HTMLElement).click());
  await win.waitForTimeout(600);
  const strip = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('.dash-style-modal .dash-style-tile')];
    return tiles.map((t) => {
      const p = t.querySelector('.dash-style-preview') as HTMLElement;
      const card = t.querySelector('.dash-mini-card') as HTMLElement | null;
      const bar = t.querySelector('.dash-mini-bar') as HTMLElement | null;
      return {
        name: (t.querySelector('.dash-style-tile-name') || {} as any).textContent,
        bg: getComputedStyle(p).backgroundColor,
        cardBg: card ? getComputedStyle(card).backgroundColor : '',
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
        w: p.getBoundingClientRect().width, h: p.getBoundingClientRect().height,
      };
    });
  });
  ok('the chooser offers exactly the four presets', strip.length === 4,
    JSON.stringify(strip.map((s) => s.name)));
  ok('…each preview is actually laid out, not a zero-height box',
    strip.every((s) => s.w > 40 && s.h > 30), JSON.stringify(strip.map((s) => `${s.w}x${s.h}`)));
  // The point of the strip. If the token classes did not scope per element,
  // every tile would resolve the SAME background and this is the assertion that
  // catches it — the four-thumbnail case is why getCSSVar takes an element.
  ok('…and the four previews resolve DIFFERENT surfaces, not one inherited sheet',
    new Set(strip.map((s) => s.cardBg)).size >= 2, JSON.stringify(strip.map((s) => s.cardBg)));
  // BY NAME. This read strip[1] until the picker gained Auto and reordered, at
  // which point it compared two tiles that are blue by design and failed for a
  // reason that had nothing to do with the accent.
  const execBar = (strip.find((s: any) => /executive/i.test(String(s.name))) || {}).barBg || '';
  const blueBar = (strip.find((s: any) => /auto|light|clean/i.test(String(s.name))) || {}).barBg || '';
  ok('…with the Executive tile drawing its bars in the muted accent, not blue',
    Boolean(execBar) && Boolean(blueBar) && execBar !== blueBar, `${blueBar} vs ${execBar}`);
  await win.screenshot({ path: path.join(SHOTS, 'style-chooser.png') });
  await win.evaluate(() => {
    const c = [...document.querySelectorAll('.dash-style-modal .btn')].find((b) => b.textContent === 'Cancel');
    (c as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  const afterCancel = await measure(win);
  ok('cancelling the chooser leaves the dashboard exactly as it was',
    afterCancel.classes.theme === 'auto' && afterCancel.editorBg === initial.editorBg,
    JSON.stringify(afterCancel.classes));

  // ── Each preset, applied for real ────────────────────────────────────────
  const seen: Record<string, any> = {};
  // The picker's four PLUS dense: it is no longer a tile (a density is not a
  // look) but it is still a preset the Assistant can name, and the geometry
  // assertions below are the only coverage its compact grid has.
  for (const preset of PRESETS.concat(['dense'])) {
    await win.evaluate((p: string) => (window as any).applyDashStylePreset(p), preset);
    await win.waitForTimeout(1400);
    const m = await measure(win);
    seen[preset] = m;
    ok(`"${preset}" applies its three axis classes`,
      m.classes.theme && m.classes.density && m.classes.accent, JSON.stringify(m.classes));
    ok(`…and "${preset}" paints every card, with no zero-size tile`,
      m.cards.length === 5 && m.cards.every((c: any) => c.w > 10 && c.h > 10),
      JSON.stringify(m.cards.map((c: any) => `${c.w}x${c.h}`)));
    await win.screenshot({ path: path.join(SHOTS, `dashboard-${preset}.png`) });
  }

  // Dark is the token-coverage guard: a theme block that forgets a token leaves
  // the LIGHT value behind, and the card surface is where that shows first.
  ok('Dark actually darkens the sheet, not just the frame',
    luminance(seen.dark.editorBg) < luminance(seen.clean.editorBg) - 0.25,
    `${seen.dark.editorBg} vs ${seen.clean.editorBg}`);
  ok('…and its CARDS go dark too (a light card here is a missing token)',
    luminance(seen.dark.cards[0].bg) < 0.35, seen.dark.cards[0].bg);
  ok('…and its card TEXT inverts with them, so the KPI stays readable',
    luminance(seen.dark.metricColor) > 0.6, seen.dark.metricColor);

  // Charts read their colours once, at construction. If setDashStyle did not
  // re-render, or if getCSSVar still resolved against <html>, the bars would
  // keep the palette of whichever style was applied first.
  ok('the chart repaints in the new palette rather than keeping the old one',
    seen.dark.chartPixel !== seen.clean.chartPixel && seen.executive.chartPixel !== seen.clean.chartPixel,
    `clean=${seen.clean.chartPixel} exec=${seen.executive.chartPixel} dark=${seen.dark.chartPixel}`);

  // Executive is the only preset defined by TYPE rather than colour.
  ok('Executive enlarges the KPI figure and sets it in a serif',
    seen.executive.metricSize > seen.clean.metricSize && /serif/i.test(seen.executive.metricFont),
    `${seen.clean.metricSize}px → ${seen.executive.metricSize}px, ${seen.executive.metricFont}`);

  // Density: the painted grid AND the maths that hit-tests it.
  ok('Dense tightens the painted grid',
    seen.dense.gap < seen.auto.gap && seen.dense.row < seen.auto.row,
    `gap ${seen.auto.gap}→${seen.dense.gap}, row ${seen.auto.row}→${seen.dense.row}`);
  ok('…and the drag/resize maths follow it, instead of measuring a grid that is gone',
    seen.dense.jsRow === seen.dense.row + seen.dense.gap && seen.auto.jsRow === seen.auto.row + seen.auto.gap,
    `dense js=${seen.dense.jsRow} css=${seen.dense.row}+${seen.dense.gap}`);
  ok('…while every preset keeps 12 columns, so no card ever moves',
    PRESETS.concat(['dense']).every((p) => seen[p].cols === 12 && seen[p].cards[0].col === seen.auto.cards[0].col),
    JSON.stringify(PRESETS.concat(['dense']).map((p) => seen[p].cols)));

  // ── It survives a reopen ─────────────────────────────────────────────────
  await win.evaluate((p: string) => (window as any).applyDashStylePreset(p), 'dark');
  await win.waitForTimeout(1200);
  await win.evaluate(() => (window as any).handleSaveDashboard());
  await win.waitForTimeout(900);
  const stored = await app.evaluate(async (_app: any, id: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const all = await analysis.listAnalyses(id);
    const rec = await analysis.getAnalysis(id, all[0].id);
    return rec.style;
  }, seeded.projectId);
  ok('the style is saved WITH the record, not kept as a view preference',
    stored && stored.theme === 'dark' && stored.density === 'comfortable' && stored.accent === 'blue',
    JSON.stringify(stored));

  await win.evaluate(() => (window as any).closeDashboardEditor());
  await win.waitForTimeout(500);
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.analysisId);
  await win.waitForTimeout(2000);
  const reopened = await measure(win);
  ok('…and reopening the dashboard brings the style back',
    reopened.classes.theme === 'dark' && luminance(reopened.cards[0].bg) < 0.35,
    JSON.stringify(reopened.classes) + ' ' + reopened.cards[0].bg);

  ok('no renderer console errors across every preset', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\nscreenshots: ' + SHOTS);

  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

/** Everything about the painted dashboard that a style can change. */
async function measure(win: any): Promise<any> {
  return win.evaluate(() => {
    const ed = document.getElementById('dash-editor') as HTMLElement;
    const grid = document.getElementById('dash-grid') as HTMLElement;
    const gs = getComputedStyle(grid);
    const axis = (p: string) => (ed.className.match(new RegExp('dash-' + p + '--(\\w+)')) || [])[1] || '';
    const metric = document.querySelector('.dash-metric-value') as HTMLElement | null;
    const canvas = document.querySelector('.dash-card canvas') as HTMLCanvasElement | null;
    // The most common OPAQUE colour anywhere on the chart — that is the bar
    // fill, and it is the only way to prove the bars themselves changed rather
    // than just the box around them. Sampled over the whole canvas on purpose:
    // a single scanline at 85% height lands in the axis-label band, where every
    // pixel is transparent, so the read came back empty for every preset and
    // the comparison silently could not fail.
    let chartPixel = '';
    if (canvas) {
      try {
        const ctx = canvas.getContext('2d');
        const d = ctx!.getImageData(0, 0, canvas.width, canvas.height).data;
        const counts: Record<string, number> = {};
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 200) continue;
          const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
          counts[k] = (counts[k] || 0) + 1;
        }
        chartPixel = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
      } catch (_) { chartPixel = 'unreadable'; }
    }
    return {
      classes: { theme: axis('theme'), density: axis('density'), accent: axis('accent') },
      // The editor paints no background of its own — the token it remaps is
      // the honest measure of "did the sheet change".
      editorBg: getComputedStyle(ed).getPropertyValue('--bg').trim(),
      gap: parseFloat(gs.gap) || parseFloat(gs.columnGap) || 0,
      row: parseFloat(gs.gridAutoRows) || 0,
      cols: gs.gridTemplateColumns.split(' ').length,
      // What the TypeScript believes, not what the CSS says — the two used to
      // be independent copies of the same number.
      jsRow: (window as any).dashRowPx() + (window as any).dashGapPx(),
      metricSize: metric ? parseFloat(getComputedStyle(metric).fontSize) : 0,
      metricFont: metric ? getComputedStyle(metric).fontFamily : '',
      metricColor: metric ? getComputedStyle(metric).color : '',
      chartPixel,
      cards: [...document.querySelectorAll('.dash-card')].map((c) => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height),
          bg: getComputedStyle(c as HTMLElement).backgroundColor,
          col: getComputedStyle(c as HTMLElement).gridColumnStart };
      }),
    };
  });
}

/** Rough relative luminance of an `rgb(r, g, b)` string, 0 (black) to 1 (white). */
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec((color || '').trim());
  const rgb = hex
    ? [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
    : (/(\d+)\D+(\d+)\D+(\d+)/.exec(color || '') || []).slice(1).map(Number);
  if (rgb.length !== 3 || rgb.some((n) => !Number.isFinite(n))) return 1;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' dashboard style smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll dashboard style smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
