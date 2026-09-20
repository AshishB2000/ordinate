// The TEMPLATE GALLERY, driven end to end in the real app.
//
// New dashboard → the gallery → Sales overview → Map columns → Create, on the
// BUNDLED SAMPLE (Retail orders), which is the one dataset every first run has
// and the one this feature's mapping was designed against. No project is seeded
// here: a fresh userData seeds the sample itself, and using it means the
// assertions below are about the data a real first user sees.
//
// WHY THIS CANNOT BE A UNIT TEST. scripts/test-templates.ts already proves the
// catalogue, the mapping and the plans against literals. What it cannot prove is
// that the card's thumbnail actually rasterised through Chart.js, that the
// mapping step's selects carry the preselections, that the KPI strip got real
// figures back over IPC, and that the built dashboard renders four KPIs, four
// charts and a two-chip filter bar without a single console error — which is
// also what catches a CSP violation.
//
//   npm run build && node scripts/smoke-templates.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, openProject, domDriver } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('templates');
  const { app, win, errors, shotDir } = smoke;

  // The sample project is seeded on first launch by main itself; give it room
  // to finish before asking for its id.
  await win.waitForTimeout(2500);
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const list = await projects.listProjects();
    const only = list[0];
    if (!only) return null;
    const sets = await datasets.listDatasets(only.id);
    return { projectId: only.id, datasets: sets.map((d: any) => ({ id: d.id, name: d.name })) };
  });
  ok('the bundled sample is on disk to build a template from',
     !!seeded && seeded.datasets.some((d: any) => d.name === 'Retail orders'),
     JSON.stringify(seeded && seeded.datasets));
  if (!seeded) { await smoke.close(); process.exit(1); }

  await openProject(win, seeded.projectId);
  const dialogs: string[] = [];
  win.on('dialog', (d) => { dialogs.push(d.type() + ': ' + d.message()); d.accept().catch(() => {}); });
  const { clickExact, clickId } = domDriver(win);

  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(900);

  // ── Step 1 → step 2 ───────────────────────────────────────────────────────
  ok('Create dashboard opens the wizard', await clickId('an-new-btn'));
  await win.waitForTimeout(700);
  const step1 = await win.evaluate(() => ({
    open: !!document.querySelector('.an-wiz'),
    // ONE dataset in the sample project, so the wizard preselects it and step 1
    // is a confirmation rather than a decision.
    selected: [...document.querySelectorAll('.an-wiz-row.is-selected .an-wiz-dsname')]
      .map((n) => (n.textContent || '').trim()),
  }));
  ok('…on the sample project it opens with Retail orders already chosen',
     step1.open && JSON.stringify(step1.selected) === JSON.stringify(['Retail orders']),
     JSON.stringify(step1));

  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  // The gallery is one IPC call (template:list) plus six Chart.js thumbnails.
  await win.waitForTimeout(1800);

  // ── Step 2: the gallery ───────────────────────────────────────────────────
  const gallery = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('.an-wiz-tpl')] as HTMLButtonElement[];
    const byName = (n: string) =>
      cards.find((c) => ((c.querySelector('.an-wiz-tpl-t') || {}) as any).textContent === n);
    const sales = byName('Sales overview');
    const finance = byName('Finance P&L');
    const imgs = [...document.querySelectorAll('.an-wiz-tpl-img')] as HTMLImageElement[];
    return {
      count: cards.length,
      names: cards.map((c) => ((c.querySelector('.an-wiz-tpl-t') || {}) as any).textContent || ''),
      // Every card must be PAINTED, not just present.
      painted: cards.every((c) => c.getBoundingClientRect().height > 100),
      // Real rasterised charts, not hand-drawn SVG: a data URL with pixels in it.
      thumbs: imgs.length,
      thumbsReal: imgs.filter((i) => /^data:image\/png/.test(i.src) && i.src.length > 2000).length,
      thumbSize: imgs[0] ? Math.round(imgs[0].getBoundingClientRect().width) : 0,
      salesNeeds: ((sales?.querySelector('.an-wiz-tpl-needs') || {}) as any).textContent || '',
      salesBlocked: !!sales?.disabled,
      financeBlocked: !!finance?.disabled,
      financeReason: ((finance?.querySelector('.an-wiz-tpl-needs') || {}) as any).textContent || '',
      financeDimmed: !!finance && finance.classList.contains('is-blocked'),
      // The Layouts row is untouched — four cards, the Assistant among them.
      layouts: [...document.querySelectorAll('.an-wiz-start-t')].map((t) => (t.textContent || '').trim()),
      groups: [...document.querySelectorAll('.an-wiz-grouph > span:first-child')]
        .map((g) => (g.textContent || '').trim()),
    };
  });
  ok('the gallery shows the six subject templates',
     gallery.count === 6 &&
     ['Sales overview', 'Finance P&L', 'Marketing funnel', 'Operations', 'Customer', 'Inventory']
       .every((n) => gallery.names.includes(n)),
     JSON.stringify(gallery.names));
  ok('…each card painted, under a Templates and a Layouts heading',
     gallery.painted && JSON.stringify(gallery.groups) === JSON.stringify(['Templates', 'Layouts']),
     JSON.stringify(gallery.groups));
  ok('…with a REAL rendered thumbnail on every one, not an icon',
     gallery.thumbs === 6 && gallery.thumbsReal === 6 && gallery.thumbSize > 100,
     `${gallery.thumbsReal}/${gallery.thumbs} real, ${gallery.thumbSize}px wide`);
  ok('…Sales says what it needs and can be picked',
     /^Needs: date, revenue, category$/.test(gallery.salesNeeds) && !gallery.salesBlocked,
     `"${gallery.salesNeeds}" blocked=${gallery.salesBlocked}`);
  // THE DIMMED CASE. The sample has no cost column, so Finance cannot be built
  // from it — and the card says exactly that instead of offering a broken one.
  ok('…and Finance is dimmed, disabled, and says why',
     gallery.financeBlocked && gallery.financeDimmed && /^Needs a cost column$/.test(gallery.financeReason),
     `"${gallery.financeReason}" blocked=${gallery.financeBlocked}`);
  ok('…the three layouts and the Assistant are unchanged beside them',
     JSON.stringify(gallery.layouts) ===
       // No longer '✨ Let the Assistant design it' — the sparkle is an icon
       // now, so the card's TEXT is just the title.
       JSON.stringify(['Blank sheet', 'KPIs + chart', 'Two-up', 'Let the Assistant design it']),
     JSON.stringify(gallery.layouts));

  const galleryShot = path.join(shotDir, 'templates-gallery.png');
  await win.screenshot({ path: galleryShot });
  ok('gallery screenshot captured',
     fs.existsSync(galleryShot) && fs.statSync(galleryShot).size > 5000,
     `${Math.round(fs.statSync(galleryShot).size / 1024)} KB -> ${galleryShot}`);

  // A dimmed card is not a click that does nothing — it is a click that cannot
  // happen. Clicking it must leave the wizard exactly where it was.
  const financeClick = await win.evaluate(() => {
    const finance = [...document.querySelectorAll('.an-wiz-tpl')]
      .find((c) => ((c.querySelector('.an-wiz-tpl-t') || {}) as any).textContent === 'Finance P&L') as HTMLButtonElement;
    finance.click();
    return {
      selected: document.querySelectorAll('.an-wiz-tpl.is-selected').length,
      label: ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0]?.textContent || '').trim(),
    };
  });
  ok('clicking the dimmed Finance card selects nothing and changes nothing',
     financeClick.selected === 0 && financeClick.label === 'Create dashboard',
     JSON.stringify(financeClick));

  // ── Picking Sales reveals the mapping step ────────────────────────────────
  await win.evaluate(() => {
    const sales = [...document.querySelectorAll('.an-wiz-tpl')]
      .find((c) => ((c.querySelector('.an-wiz-tpl-t') || {}) as any).textContent === 'Sales overview') as HTMLElement;
    sales.click();
  });
  await win.waitForTimeout(400);
  const picked = await win.evaluate(() => ({
    selected: [...document.querySelectorAll('.an-wiz-tpl.is-selected .an-wiz-tpl-t')]
      .map((t) => (t.textContent || '').trim()),
    label: ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0]?.textContent || '').trim(),
    // Step 3 stops being the AI step and becomes the mapping one.
    step3: ((document.querySelectorAll('.an-wiz-step')[2]?.querySelector('.an-wiz-step-label')) as any)?.textContent || '',
    step3Live: !document.querySelectorAll('.an-wiz-step')[2].classList.contains('is-skipped'),
  }));
  ok('picking Sales turns step 3 into "Map columns" and the button back to Next',
     JSON.stringify(picked.selected) === JSON.stringify(['Sales overview']) &&
     picked.label === 'Next' && picked.step3 === 'Map columns' && picked.step3Live,
     JSON.stringify(picked));

  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  // template:plan + analysis:previewPlan + four dashboard:metric calls, over a
  // 5,000-row resident dataset.
  await win.waitForTimeout(3500);

  // ── Step 3: Map columns ───────────────────────────────────────────────────
  const mapStep = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.an-tpl-row')];
    return {
      rows: rows.length,
      picks: rows.map((r) => [
        ((r.querySelector('.an-tpl-role') || {}) as any).childNodes[0]?.textContent?.trim() || '',
        (r.querySelector('.an-tpl-select') as HTMLSelectElement).value,
      ]),
      glyphs: rows.map((r) => ((r.querySelector('.an-tpl-glyph') || {}) as any).textContent || ''),
      dots: rows.map((r) => (r.querySelector('.an-tpl-dot') as HTMLElement).className.replace('an-tpl-dot is-', '')),
      // Optional roles offer a Skip; required ones do not.
      skippable: rows.map((r) =>
        [...(r.querySelector('.an-tpl-select') as HTMLSelectElement).options].some((o) => o.textContent === 'Skip')),
      summary: ((document.querySelector('.an-tpl-summary') || {}) as any).textContent || '',
      kpis: [...document.querySelectorAll('.an-tpl-kpi')].map((k) => ({
        label: ((k.querySelector('.an-tpl-kpi-l') || {}) as any).textContent || '',
        value: ((k.querySelector('.an-tpl-kpi-v') || {}) as any).textContent || '',
      })),
      aiHidden: !!(document.querySelector('.an-wiz-ai') as HTMLElement).hidden,
    };
  });
  // THE FIVE PRESELECTIONS. `region` → `state`, not `region`, is the whole point
  // of resolving the values rather than the name.
  ok('the mapping step preselects every role from the data',
     JSON.stringify(mapStep.picks) === JSON.stringify([
       ['Date', 'order_date'],
       ['Revenue', 'revenue'],
       ['Quantity', 'units'],
       ['Category', 'category'],
       ['Region', 'state'],
       ['Customer', 'customer_segment'],
     ]),
     JSON.stringify(mapStep.picks));
  ok('…with the dataset’s own type glyph beside each one',
     JSON.stringify(mapStep.glyphs) === JSON.stringify(['date', 'number', 'number', 'text', 'text', 'text']),
     JSON.stringify(mapStep.glyphs));
  ok('…a confidence dot per row, high where the mapper was certain',
     mapStep.dots.length === 6 && mapStep.dots.filter((d) => d === 'high').length >= 4,
     JSON.stringify(mapStep.dots));
  ok('…Skip offered on the optional roles only',
     JSON.stringify(mapStep.skippable) === JSON.stringify([false, false, true, false, true, true]),
     JSON.stringify(mapStep.skippable));
  ok('…a live line saying what will be built',
     /^6 of 6 mapped · \d+ tiles will be built/.test(mapStep.summary), `"${mapStep.summary}"`);
  ok('…and the AI card stands down on this route', mapStep.aiHidden);
  // REAL FIGURES, from dashboard:metric — the channel the built tile calls.
  ok('the KPI preview shows the four tiles that will be built',
     mapStep.kpis.length === 4 &&
     JSON.stringify(mapStep.kpis.map((k) => k.label))
       === JSON.stringify(['Revenue', 'Orders', 'Avg order value', 'Quantity']),
     JSON.stringify(mapStep.kpis));
  ok('…with app-computed numbers in them, not placeholders',
     mapStep.kpis.every((k) => k.value !== '—' && k.value !== '…' && /\d/.test(k.value)),
     JSON.stringify(mapStep.kpis.map((k) => k.value)));

  const mapShot = path.join(shotDir, 'templates-mapping.png');
  await win.screenshot({ path: mapShot });
  ok('mapping-step screenshot captured',
     fs.existsSync(mapShot) && fs.statSync(mapShot).size > 5000,
     `${Math.round(fs.statSync(mapShot).size / 1024)} KB -> ${mapShot}`);

  // Changing a select re-plans: Skip the optional Customer role and the bar
  // chart it feeds stops being built.
  const afterSkip = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.an-tpl-row')];
    const sel = rows[5].querySelector('.an-tpl-select') as HTMLSelectElement;
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  await win.waitForTimeout(3000);
  const skipped = await win.evaluate(() =>
    ((document.querySelector('.an-tpl-summary') || {}) as any).textContent || '');
  ok('skipping an optional role re-plans and says what it costs',
     afterSkip && /^5 of 6 mapped/.test(skipped) && /1 skipped/.test(skipped), `"${skipped}"`);

  // Put it back — the run below asserts the full Sales dashboard.
  await win.evaluate(() => {
    const sel = [...document.querySelectorAll('.an-tpl-row')][5].querySelector('.an-tpl-select') as HTMLSelectElement;
    sel.value = 'customer_segment';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.waitForTimeout(3000);

  // ── Create ────────────────────────────────────────────────────────────────
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(6000);

  const built = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dash-grid .dash-card')];
    return {
      wizardClosed: !document.querySelector('.an-wiz'),
      editorOpen: !!document.querySelector('#dash-grid'),
      name: ((document.getElementById('dash-name') || {}) as any).textContent || '',
      metrics: cards.filter((c) => c.classList.contains('dash-card--metric')).length,
      visuals: cards.filter((c) => c.classList.contains('dash-card--visual')).length,
      // A control is a chip in the filter bar, never a grid cell.
      controlsInGrid: cards.filter((c) => c.classList.contains('dash-card--control')).length,
      chips: [...document.querySelectorAll('.dash-fb-chip-label')].map((l) => (l.textContent || '').trim()),
      titles: cards.map((c) => ((c.querySelector('.dash-card-title') || {}) as any).textContent || '').filter(Boolean),
      // Every KPI shows a figure the app computed, not an em dash.
      metricValues: [...document.querySelectorAll('.dash-card--metric .dash-metric-value, .dash-card--metric .dash-card-body')]
        .map((v) => (v.textContent || '').trim()).filter(Boolean),
      canvases: document.querySelectorAll('#dash-grid canvas').length,
      maps: document.querySelectorAll('#dash-grid .maplibregl-map, #dash-grid .cv-chart-fallback').length,
    };
  });
  ok('Create closes the wizard and opens the built dashboard',
     built.wizardClosed && built.editorOpen && /Retail orders dashboard/.test(built.name),
     JSON.stringify({ name: built.name, closed: built.wizardClosed }));
  ok('…with the four KPI tiles', built.metrics === 4, String(built.metrics));
  ok('…the four charts', built.visuals === 4, `${built.visuals}: ${built.titles.join(' | ')}`);
  ok('…drawn, not empty frames', built.canvases + built.maps >= 4,
     `${built.canvases} canvas + ${built.maps} map`);
  ok('…and a filter bar of two chips, not two tiles',
     built.controlsInGrid === 0 && built.chips.length === 2,
     JSON.stringify({ chips: built.chips, inGrid: built.controlsInGrid }));

  const dashShot = path.join(shotDir, 'templates-dashboard.png');
  await win.screenshot({ path: dashShot });
  ok('built-dashboard screenshot captured',
     fs.existsSync(dashShot) && fs.statSync(dashShot).size > 5000,
     `${Math.round(fs.statSync(dashShot).size / 1024)} KB -> ${dashShot}`);

  // ── The RECORD, on disk ───────────────────────────────────────────────────
  // The screen can be right while the record is wrong. This reads what was
  // actually written, through the same module main serves it from.
  const record: any = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const datasets = req('./src/data/datasets.js');
    const list = await analysis.listAnalyses(pid);
    const made = list.find((a: any) => /Retail orders dashboard/.test(a.name));
    if (!made) return { found: false, names: list.map((a: any) => a.name) };
    const full = await analysis.getAnalysis(pid, made.id);
    const cards = (full.sheets && full.sheets[0] && full.sheets[0].cards) || [];
    const vids = cards.filter((c: any) => c.type === 'visual').map((c: any) => c.visualId);
    const vs: any[] = [];
    for (const id of vids) vs.push(await visuals.getVisual(pid, id));
    const sets = await datasets.listDatasets(pid);
    const ds = sets.find((d: any) => d.name === 'Retail orders');
    const meta = await datasets.getDatasetMeta(pid, ds.id);
    return {
      found: true,
      types: cards.map((c: any) => c.type),
      metrics: cards.filter((c: any) => c.type === 'metric')
        .map((c: any) => c.metric.aggregation + ':' + c.metric.column),
      controls: cards.filter((c: any) => c.type === 'control')
        .map((c: any) => c.control.kind + ':' + c.control.column),
      charts: vs.map((v: any) => v && v.chartType),
      geo: vs.map((v: any) => v && v.encoding && v.encoding.geo && v.encoding.geo.level).filter(Boolean),
      // The month bucket is an ORDINARY calculated-field step on the dataset,
      // removable in Prepare like a hand-written one.
      steps: (meta.steps || []).map((s: any) => s.type + ':' + (s.name || '')),
      columns: meta.columns.map((c: any) => c.name),
    };
  }, seeded.projectId);
  ok('the record on disk holds four metric cards, four visual cards and two controls',
     record.found &&
     record.types.filter((t: string) => t === 'metric').length === 4 &&
     record.types.filter((t: string) => t === 'visual').length === 4 &&
     record.types.filter((t: string) => t === 'control').length === 2,
     JSON.stringify(record.types));
  ok('…the KPIs name the mapped columns and the app’s own aggregations',
     JSON.stringify(record.metrics) ===
       JSON.stringify(['sum:revenue', 'count:order_date', 'avg:revenue', 'sum:units']),
     JSON.stringify(record.metrics));
  ok('…the charts are the line, column, bar and choropleth the card promised',
     JSON.stringify(record.charts) === JSON.stringify(['line', 'column', 'bar', 'map_choropleth']) &&
     JSON.stringify(record.geo) === JSON.stringify(['us_state']),
     JSON.stringify({ charts: record.charts, geo: record.geo }));
  ok('…the controls filter the date and the region column',
     JSON.stringify(record.controls) === JSON.stringify(['date_range:order_date', 'dropdown:state']),
     JSON.stringify(record.controls));
  ok('…and the month bucket landed as an ordinary Prepare step',
     record.steps.some((s: string) => /^calculated_field:Month/.test(s)) &&
     record.columns.includes('Month'),
     JSON.stringify(record.steps));

  // ── The LAUNCHPAD door: a dataset page opens the gallery directly ─────────
  // Step 1 is already answered from there — the dataset is the one on screen —
  // so the wizard must land ON the gallery rather than asking again.
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1500);
  await win.evaluate((id: string) => { (window as any).openSavedDataset(id); },
    seeded.datasets.find((d: any) => d.name === 'Retail orders').id);
  await win.waitForTimeout(2500);
  ok('the dataset page offers "New dashboard"', await clickId('ds-act-dashboard'));
  await win.waitForTimeout(2500);
  const launchpad = await win.evaluate(() => ({
    open: !!document.querySelector('.an-wiz'),
    onStep2: !(document.querySelectorAll('.an-wiz-pane')[1] as HTMLElement).hidden,
    activeStep: ((document.querySelector('.an-wiz-step.is-active .an-wiz-step-label') || {}) as any).textContent || '',
    chosen: [...document.querySelectorAll('.an-wiz-row.is-selected .an-wiz-dsname')]
      .map((n) => (n.textContent || '').trim()),
    cards: document.querySelectorAll('.an-wiz-tpl').length,
  }));
  ok('…and it opens the wizard ON the gallery, with that dataset already chosen',
     launchpad.open && launchpad.onStep2 && launchpad.activeStep === 'Start from' &&
     JSON.stringify(launchpad.chosen) === JSON.stringify(['Retail orders']) && launchpad.cards === 6,
     JSON.stringify(launchpad));
  await win.evaluate(() => {
    const x = document.querySelector('.an-wiz-x') as HTMLElement | null;
    x?.click();
  });
  await win.waitForTimeout(500);

  // ── Zero renderer errors, the whole way through ───────────────────────────
  ok('no renderer console errors or page errors in the whole run',
     errors.length === 0, errors.slice(0, 5).join(' | '));
  ok('no unexpected dialogs', dialogs.length === 0, dialogs.join(' | '));

  await smoke.close();
  process.exit(failureCount() > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL smoke-templates threw:', err && err.stack ? err.stack : err);
  process.exit(1);
});
