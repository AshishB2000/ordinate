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
    for (let i = 0; i < 300; i++) rows.push([regions[i % 5], (i % 97) - 10]);
    const ds = await datasets.saveDataset(proj.id, { name: 'Sales', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows });
    const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
    const v1 = await visuals.saveVisual(proj.id, { name: 'Revenue by region', datasetId: ds.id, chartType: 'bar', encoding: enc, filters: [] });
    const v2 = await visuals.saveVisual(proj.id, { name: 'Revenue trend', datasetId: ds.id, chartType: 'line', encoding: enc, filters: [] });
    const an = await analysis.saveAnalysis(proj.id, { name: 'Quarterly review', sheets: [{
      name: 'Overview',
      cards: [
        { type: 'visual', visualId: v1.id, layout: { x: 0, y: 0, w: 6, h: 4 } },
        { type: 'visual', visualId: v2.id, layout: { x: 6, y: 0, w: 6, h: 4 } },
      ],
    }] });
    return { projectId: proj.id, bareProjectId: bare.id, analysisId: an.id };
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
  ok('the Dashboards count names what it counts, like the Visuals one',
    head.count === '1 dashboard' && head.countHidden === false, JSON.stringify(head));
  ok('…and the page has a subtitle, like Data and Visuals',
    !!head.sub && head.subVisible, JSON.stringify(head));

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
