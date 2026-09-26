// AUTHORING DEPTH, in the real app, on the bundled sample project.
//
//   1. Relationships — seed Targets(region, target); the dialog suggests
//      region → region at 100%; save; the builder on Retail orders adds
//      sum(target) from Targets beside sum(revenue) by region, and the drawn
//      numbers equal a JS join of the CSV and the seeded targets.
//   2. Actions — a navigate action on the category chart; clicking Technology
//      opens a second dashboard with the selection chip and a "From Retail
//      overview" Back; a tooltip draws another visual; a Navigation card links.
//   3. Cards — ⇧-click two KPIs into a Container, add Tabs, drag the container
//      (both KPIs move), switch tab, undo restores; a Markdown card renders
//      {{Revenue}} as 5.2M in bold.
//   4. Maps — 5,000 generated points cluster at low zoom and separate at high;
//      a click selects; an imported three-polygon boundary set draws a
//      choropleth on the offline basemap and is listed in the builder.
// (test-a11y.ts, beside it in run-smokes, holds every surface to the a11y bar.)
//
// Every expected figure is folded out of the committed CSV inside this file.
// Screenshots land in SMOKE_ARTIFACT_DIR (or the temp userData), one per
// feature, named for the PR.
//
//   npm run build && node scripts/smoke-authoring.js

import { ok, failureCount } from './selfcheck';
import { launchSmoke, finishSmoke, openProject, openSeededAnalysis, REPO } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

declare const chartInstances: { get(el: unknown): any };
declare const dashCurrent: any;
declare function getMapInContainer(el: HTMLElement): any;

const TARGETS: Record<string, number> = { Central: 900000, East: 1400000, Northeast: 400000, South: 750000, West: 1600000 };

function csvTruth(): { revenueByRegion: Map<string, number>; regions: string[] } {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const iRev = head.indexOf('revenue');
  const iRegion = head.indexOf('region');
  const revenueByRegion = new Map<string, number>();
  const regions: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (!revenueByRegion.has(c[iRegion])) regions.push(c[iRegion]);
    revenueByRegion.set(c[iRegion], (revenueByRegion.get(c[iRegion]) || 0) + Number(c[iRev]));
  }
  return { revenueByRegion, regions };
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/** Answer the OPEN prompt modal (smokeFixture.domDriver's rule: the visible overlay). */
async function fillPromptOpen(win: any, value: string): Promise<boolean> {
  return win.evaluate((v: string) => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0)
      .map((o) => o.querySelector('.ws-modal'))[0];
    if (!box) return false;
    const input = box.querySelector('.ws-modal-input') as HTMLInputElement | null;
    if (input) input.value = v;
    (box.querySelector('.ws-modal-actions .btn-primary') as HTMLElement).click();
    return true;
  }, value);
}

/** Sum of revenue over the CSV rows `keep` accepts. */
function csvSum(keep: (row: Record<string, string>) => boolean): number {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  let s = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const row: Record<string, string> = {};
    head.forEach((h, k) => { row[h] = c[k]; });
    if (keep(row)) s += Number(row.revenue);
  }
  return s;
}

async function main(): Promise<void> {
  const smoke = await launchSmoke('authoring');
  const { app, win, errors, shotDir } = smoke;
  const shot = async (name: string): Promise<void> => {
    await win.screenshot({ path: path.join(shotDir, name + '.png') });
  };

  // ── Fixture: the sample project, plus Targets ─────────────────────────────
  const seed = await app.evaluate(async (_e, targets: Record<string, number>) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const list = await projects.listProjects();
    const proj = list.find((p: any) => p.name === 'My project') || list[0];
    const all = await datasets.listDatasets(proj.id);
    const retail = all.find((d: any) => d.name === 'Retail orders');
    const t = await datasets.saveDataset(proj.id, {
      name: 'Targets', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'target', type: 'number' }],
      rows: Object.entries(targets),
    });
    return { projectId: proj.id, retailId: retail && retail.id, targetsId: t && t.id };
  }, TARGETS);
  ok('fixture: the sample project has Retail orders, and Targets is seeded', Boolean(seed.projectId && seed.retailId && seed.targetsId));
  await openProject(win, seed.projectId);

  // ── 1. Relationships ──────────────────────────────────────────────────────
  await win.evaluate(() => (window as any).selectSection('datasets'));
  await win.waitForTimeout(800);
  ok('Data has a Relationships tab', await win.evaluate(() => {
    const t = document.getElementById('ds-tab-relationships');
    if (!t) return false;
    t.click();
    return t.getAttribute('aria-selected') === 'true';
  }));
  await win.waitForTimeout(1200);
  const canvas = await win.evaluate(() => ({
    panel: !(document.getElementById('rel-wrap') as HTMLElement).hidden,
    nodes: [...document.querySelectorAll('#rel-canvas .rel-node')].map((n) => (n.querySelector('.rel-node-name') as HTMLElement).textContent),
    explain: (document.querySelector('.rel-explain') as HTMLElement)?.textContent || '',
    datasetsHidden: (document.getElementById('ds-saved') as HTMLElement).hidden,
  }));
  ok('…showing both datasets as cards on the canvas', canvas.panel && canvas.nodes.includes('Retail orders') && canvas.nodes.includes('Targets'), JSON.stringify(canvas));
  ok('…with the one line on how it differs from Combine datasets', /Combine datasets/.test(canvas.explain));
  ok('…and the Datasets panel stood down', canvas.datasetsHidden === true);

  await win.evaluate(() => (document.getElementById('rel-new') as HTMLElement).click());
  await win.waitForTimeout(600);
  await win.evaluate((ids: { retailId: string; targetsId: string }) => {
    const sels = [...document.querySelectorAll('.rel-modal select')] as HTMLSelectElement[];
    const [fromDs, , toDs] = sels;
    fromDs.value = ids.retailId;
    fromDs.dispatchEvent(new Event('change'));
    toDs.value = ids.targetsId;
    toDs.dispatchEvent(new Event('change'));
  }, { retailId: seed.retailId, targetsId: seed.targetsId });
  await win.waitForFunction(() => !!document.querySelector('.rel-sug-item[aria-checked="true"]'), undefined, { timeout: 15000 }).catch(() => {});
  const sug = await win.evaluate(() => {
    const on = document.querySelector('.rel-sug-item[aria-checked="true"]') as HTMLElement | null;
    return {
      pair: on?.querySelector('.rel-sug-pair')?.textContent || '',
      rate: on?.querySelector('.rel-sug-rate')?.textContent || '',
      first: document.querySelector('.rel-sug-item') === on,
      dialog: document.querySelector('.rel-modal')?.getAttribute('role'),
    };
  });
  ok('New relationship suggests region → region first, preselected', sug.first && sug.pair === 'region → region', JSON.stringify(sug));
  ok('…with a 100% match', sug.rate === '100% match', sug.rate);
  ok('…in a labelled dialog', sug.dialog === 'dialog');
  await shot('1-relationships-dialog');
  await win.evaluate(() => ([...document.querySelectorAll('.rel-modal .btn-primary')].pop() as HTMLElement).click());
  await win.waitForTimeout(2000);
  const saved = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/analysis/relationships.js').listRelationships(pid);
  }, seed.projectId);
  ok('saving writes one many-to-one relationship, verified over all 5,000 rows',
    saved.length === 1 && saved[0].cardinality === 'many_to_one' && saved[0].verified.matched === 5000 && saved[0].verified.unmatchedFrom === 0,
    JSON.stringify(saved));
  const drawn = await win.evaluate(() => ({
    edges: document.querySelectorAll('#rel-canvas .rel-edge').length,
    label: (document.querySelector('#rel-canvas .rel-edge-label') as HTMLElement)?.textContent || '',
    rows: document.querySelectorAll('#rel-list .rel-row').length,
  }));
  ok('…and the canvas draws its edge, labelled N:1 · 100%', drawn.edges === 1 && drawn.label === 'N:1 · 100%', JSON.stringify(drawn));
  ok('…and lists it', drawn.rows === 1);
  await shot('1-relationships');

  // The builder, on Retail orders: sum(revenue) and sum(target) by region.
  await win.evaluate(() => (window as any).selectSection('visuals'));
  await win.waitForTimeout(1000);
  await win.evaluate(() => (document.getElementById('viz-new-btn') as HTMLElement).click());
  await win.waitForTimeout(1000);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find((r) => /Retail orders/.test(r.textContent || '')) as HTMLElement;
    row.click();
    (document.querySelector('.js-vn-manual') as HTMLElement).click();
  });
  await win.waitForTimeout(2500);
  await win.evaluate((retailId: string) => {
    const sel = document.getElementById('viz-dataset-select') as HTMLSelectElement;
    if (sel.value !== retailId) {
      sel.value = retailId;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, seed.retailId);
  await win.waitForTimeout(2500);
  const pickers = await win.evaluate(() => {
    const cat = document.querySelector('#ws-visuals .js-enc-cat') as HTMLSelectElement;
    const col = document.querySelector('#ws-visuals .viz-value-col') as HTMLSelectElement;
    return {
      catGroups: [...cat.querySelectorAll('optgroup')].map((g) => g.label),
      measureGroups: [...col.querySelectorAll('optgroup')].map((g) => g.label),
    };
  });
  ok('the builder lists Targets columns, grouped under their dataset', pickers.catGroups.includes('From Targets') && pickers.measureGroups.includes('From Targets'), JSON.stringify(pickers));
  await win.evaluate((targetsId: string) => {
    const cat = document.querySelector('#ws-visuals .js-enc-cat') as HTMLSelectElement;
    cat.value = 'region';
    cat.dispatchEvent(new Event('change'));
    const first = document.querySelector('#ws-visuals .viz-value-col') as HTMLSelectElement;
    first.value = 'revenue';
    first.dispatchEvent(new Event('change'));
    (document.querySelector('#ws-visuals .js-enc-add-value') as HTMLElement).click();
    const cols = [...document.querySelectorAll('#ws-visuals .viz-value-col')] as HTMLSelectElement[];
    const second = cols[cols.length - 1];
    second.value = '@' + targetsId + '/target';
    second.dispatchEvent(new Event('change'));
  }, seed.targetsId);
  await win.waitForTimeout(3000);
  const chart = await win.evaluate(() => {
    const area = document.getElementById('viz-area');
    const c = area && chartInstances.get(area);
    if (!c) return null;
    return { labels: c.data.labels, series: c.data.datasets.map((d: any) => ({ label: d.label, data: d.data })) };
  });
  const truth = csvTruth();
  const want = truth.regions.map((r) => ({ region: r, revenue: truth.revenueByRegion.get(r) as number, target: TARGETS[r] }));
  const got = chart ? want.map((w) => {
    const i = chart.labels.indexOf(w.region);
    return { region: w.region, revenue: chart.series[0]?.data[i], target: chart.series[1]?.data[i] };
  }) : [];
  ok('the joined chart draws two series by region', !!chart && chart.series.length === 2 && chart.labels.length === truth.regions.length, JSON.stringify(chart));
  ok('…sum of revenue equals the CSV, region by region', got.length > 0 && got.every((g, i) => close(g.revenue, want[i].revenue)), JSON.stringify(got));
  ok('…and sum of target is each region\'s ONE target — the join never fans out', got.length > 0 && got.every((g, i) => g.target === want[i].target), JSON.stringify(got));
  ok('…labelled with where it came from', chart !== null && /Targets\.target/.test(chart.series[1]?.label || ''));
  await win.evaluate(() => {
    const chip = [...document.querySelectorAll('#ws-visuals button')].find((b) => (b.textContent || '').trim() === 'Clustered column') as HTMLElement | undefined;
    chip?.click();
  });
  await win.waitForTimeout(1200);
  await shot('1-relationships-builder');

  // ── 2. Actions and navigation ─────────────────────────────────────────────
  // A second dashboard to navigate to: one tile, revenue by region.
  const detail = await app.evaluate(async (_e, ids: { projectId: string; retailId: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    const { randomUUID } = req('crypto');
    const v = await visuals.saveVisual(ids.projectId, {
      datasetId: ids.retailId, name: 'Revenue by region', chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
    });
    const a = await analysis.saveAnalysis(ids.projectId, {
      name: 'Category detail',
      sheets: [{ id: randomUUID(), name: 'Detail', cards: [{ id: randomUUID(), type: 'visual', visualId: v.id, layout: { x: 0, y: 0, w: 12, h: 6 } }] }],
    });
    return { analysisId: a.id, visualId: v.id };
  }, { projectId: seed.projectId, retailId: seed.retailId });
  await win.evaluate(() => (window as any).selectSection('analyses'));
  await win.waitForTimeout(1200);
  ok('the sample dashboard opens', await openSeededAnalysis(win, 'Retail overview'));
  const catCard = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find((c) =>
      /Revenue by category/.test(c.querySelector('.dash-card-title')?.textContent || '')) as HTMLElement | undefined;
    if (!card) return '';
    (card.querySelector('.dash-card-head') as HTMLElement).click();
    return card.dataset.cardId || '';
  });
  await win.waitForTimeout(1500);
  ok('selecting the category chart opens its Properties', !!catCard && await win.evaluate(() => !(document.getElementById('an-pane-props') as HTMLElement).hidden));
  await win.evaluate(() => (document.getElementById('an-tab-interact') as HTMLElement).click());
  await win.waitForFunction(() => !!document.querySelector('#an-interact .ae-add'), undefined, { timeout: 10000 }).catch(() => {});
  await win.evaluate(() => (document.querySelector('#an-interact .ae-add') as HTMLElement).click());
  await win.waitForTimeout(800);
  const warned = await win.evaluate(() => (document.querySelector('#an-interact .ae-row .ae-warn') as HTMLElement)?.textContent || '');
  ok('a new navigate action says it needs a dashboard', /Choose a dashboard/.test(warned), warned);
  await win.evaluate((target: string) => {
    const sel = [...document.querySelectorAll('#an-interact .ae-row select')].find((s) =>
      [...(s as HTMLSelectElement).options].some((o) => o.value === target)) as HTMLSelectElement;
    sel.value = target;
    sel.dispatchEvent(new Event('change'));
  }, detail.analysisId);
  await win.waitForTimeout(1500);
  const stored = await win.evaluate((id: string) => {
    for (const p of dashCurrent.pages) for (const c of p.cards) if (c.id === id) return c.actions;
    return null;
  }, catCard);
  ok('…and once chosen, the action is on the card: click → navigate, carrying the clicked value',
    Array.isArray(stored) && stored[0].kind === 'navigate' && stored[0].trigger === 'click'
      && stored[0].carry === 'clicked_value' && stored[0].target.analysisId === detail.analysisId, JSON.stringify(stored));
  ok('…with no warning left', await win.evaluate(() => !document.querySelector('#an-interact .ae-warn')));
  await shot('2-actions-interactions');
  await win.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); (window as any).anSelectCard?.(null); });
  await win.waitForTimeout(2500);

  // Click the Technology bar, where Chart.js actually drew it.
  const bar = await win.evaluate((id: string) => {
    const card = document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"]`) as HTMLElement;
    const area = card.querySelector('.dash-viz-area') as HTMLElement;
    const chart = chartInstances.get(area);
    if (!chart) return null;
    const i = chart.data.labels.indexOf('Technology');
    const el = chart.getDatasetMeta(0).data[i];
    const r = (chart.canvas as HTMLCanvasElement).getBoundingClientRect();
    return i < 0 ? null : { x: r.left + el.x, y: r.top + (el.y + el.base) / 2 };
  }, catCard);
  ok('the category chart drew a Technology bar', bar !== null);
  if (bar) await win.mouse.click(bar.x, bar.y);
  await win.waitForTimeout(3500);
  const landed = await win.evaluate(() => ({
    name: document.getElementById('dash-name')?.textContent || '',
    chips: [...document.querySelectorAll('#dash-sel-strip .dash-sel-chip-txt')].map((c) => c.textContent),
    crumb: document.querySelector('#dash-sel-strip .dash-crumb-from')?.textContent || '',
    back: document.querySelector('#dash-sel-strip .dash-crumb-back')?.getAttribute('aria-label') || '',
  }));
  ok('clicking Technology opens Category detail', landed.name === 'Category detail', JSON.stringify(landed));
  ok('…with the selection chip category = Technology', landed.chips.includes('category = Technology'), JSON.stringify(landed.chips));
  ok('…and the breadcrumb "From Retail overview" with Back', landed.crumb === 'From Retail overview' && landed.back === 'Back to Retail overview');
  const techTotal = csvSum((c) => c.category === 'Technology');
  const drawnTotal = await win.evaluate(() => {
    const area = document.querySelector('#dash-grid .dash-viz-area') as HTMLElement;
    const chart = area && chartInstances.get(area);
    return chart ? chart.data.datasets[0].data.reduce((a: number, b: number) => a + (b || 0), 0) : null;
  });
  ok('…and its tile draws only Technology\'s revenue', drawnTotal !== null && close(drawnTotal, techTotal), `${drawnTotal} vs ${techTotal}`);
  await shot('2-actions-navigate');
  await win.evaluate(() => (document.querySelector('#dash-sel-strip .dash-crumb-back') as HTMLElement).click());
  await win.waitForTimeout(3000);
  ok('Back returns to Retail overview, with no selection carried back',
    await win.evaluate(() => document.getElementById('dash-name')?.textContent === 'Retail overview'
      && (document.getElementById('dash-sel-strip') as HTMLElement).hidden === true));

  // A tooltip that draws another visual, filtered to the hovered mark.
  await win.evaluate((ids: { card: string; visualId: string }) => {
    for (const p of dashCurrent.pages) for (const c of p.cards) {
      if (c.id === ids.card) c.actions = (c.actions || []).concat([{ kind: 'tooltip_visual', trigger: 'click', carry: 'clicked_value', tooltipVisualId: ids.visualId }]);
    }
    (window as any).markDashDirty('Add tooltip visual');
    (window as any).renderDashGrid();
  }, { card: catCard, visualId: detail.visualId });
  await win.waitForTimeout(2500);
  const bar2 = await win.evaluate((id: string) => {
    const area = document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"] .dash-viz-area`) as HTMLElement;
    const chart = chartInstances.get(area);
    const i = chart.data.labels.indexOf('Technology');
    const el = chart.getDatasetMeta(0).data[i];
    const r = (chart.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: r.left + el.x, y: r.top + (el.y + el.base) / 2 };
  }, catCard);
  await win.mouse.move(bar2.x - 3, bar2.y);
  await win.mouse.move(bar2.x, bar2.y);
  await win.waitForTimeout(2500);
  const tip = await win.evaluate(() => {
    const t = document.querySelector('.tv-tip') as HTMLElement | null;
    const c = t?.querySelector('canvas') as HTMLCanvasElement | null;
    return t ? { head: t.querySelector('.tv-tip-head')?.textContent, sub: t.querySelector('.tv-tip-sub')?.textContent,
      w: c?.getBoundingClientRect().width, h: c?.getBoundingClientRect().height, role: t.getAttribute('role') } : null;
  });
  ok('hovering Technology draws the tooltip visual for Technology in a 240×140 canvas',
    tip !== null && tip.head === 'Technology' && tip.sub === 'Revenue by region' && tip.w === 240 && tip.h === 140 && tip.role === 'tooltip', JSON.stringify(tip));
  await shot('2-actions-tooltip');
  await win.mouse.move(5, 5);
  await win.waitForTimeout(300);
  ok('…and it goes when the pointer leaves', await win.evaluate(() => !document.querySelector('.tv-tip')));

  // The Navigation card, from the editor's More menu: a button per dashboard.
  await win.evaluate(() => (document.getElementById('dash-add-more') as HTMLElement).click());
  await win.waitForTimeout(300);
  await win.evaluate(() => ([...document.querySelectorAll('.chart-menu-item')].find((b) => /Navigation/.test(b.textContent || '')) as HTMLElement).click());
  await win.waitForTimeout(2000);
  const navBtn = await win.evaluate(() => [...document.querySelectorAll('#dash-grid .nav-card button')].map((b) => b.textContent));
  ok('More → Navigation adds a row of buttons to the other dashboards', navBtn.includes('Category detail'), JSON.stringify(navBtn));
  await win.evaluate(() => ([...document.querySelectorAll('#dash-grid .nav-card button')].find((b) => b.textContent === 'Category detail') as HTMLElement).click());
  await win.waitForTimeout(3000);
  ok('…and a button opens its dashboard, with the way back', await win.evaluate(() =>
    document.getElementById('dash-name')?.textContent === 'Category detail'
      && document.querySelector('#dash-sel-strip .dash-crumb-from')?.textContent === 'From Retail overview'));
  await win.evaluate(() => (document.querySelector('#dash-sel-strip .dash-crumb-back') as HTMLElement).click());
  await win.waitForTimeout(3000);

  // ── 3. Cards and layout ───────────────────────────────────────────────────
  const kpiIds = await win.evaluate(() => {
    const byTitle = (t: string): HTMLElement | undefined => [...document.querySelectorAll('#dash-grid .dash-card')].find((c) =>
      (c.querySelector('.dash-card-title')?.textContent || '') === t) as HTMLElement | undefined;
    return [byTitle('Revenue')?.dataset.cardId || '', byTitle('Profit')?.dataset.cardId || ''];
  });
  ok('the sample dashboard has its Revenue and Profit KPIs', kpiIds.every(Boolean), JSON.stringify(kpiIds));
  await win.evaluate((id: string) => (document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"] .dash-card-head`) as HTMLElement).click(), kpiIds[0]);
  await win.waitForTimeout(500);
  await win.evaluate((id: string) => {
    const head = document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"] .dash-card-head`) as HTMLElement;
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  }, kpiIds[1]);
  await win.waitForTimeout(400);
  const bar3 = await win.evaluate(() => ({
    shown: !(document.getElementById('an-arrange') as HTMLElement)?.hidden,
    text: document.querySelector('#an-arrange .an-arrange-count')?.textContent || '',
    multi: document.querySelectorAll('#dash-grid .dash-card.is-multi').length,
  }));
  ok('⇧-click makes a two-card selection with the arrange bar', bar3.shown && bar3.multi === 2 && bar3.text === '2 cards selected', JSON.stringify(bar3));
  await win.evaluate(() => ([...document.querySelectorAll('#an-arrange button')].find((b) => b.textContent === 'Container') as HTMLElement).click());
  await win.waitForTimeout(1500);
  const grouped = await win.evaluate((ids: string[]) => {
    const cards = dashCurrent.pages[0].cards;
    const g = cards.find((c: any) => c.type === 'container');
    return {
      id: g && g.id,
      layout: g && g.layout,
      kids: cards.filter((c: any) => ids.includes(c.id)).map((c: any) => ({ parent: c.parentId, layout: c.layout })),
      inGroup: document.querySelectorAll('#dash-grid .dash-card.in-group').length,
    };
  }, kpiIds);
  ok('Group → Container wraps both KPIs', !!grouped.id && grouped.kids.every((k: any) => k.parent === grouped.id) && grouped.inGroup === 2, JSON.stringify(grouped));

  await win.evaluate(() => (document.getElementById('dash-add-more') as HTMLElement).click());
  await win.waitForTimeout(300);
  await win.evaluate(() => ([...document.querySelectorAll('.chart-menu-item')].find((b) => /Tabs/.test(b.textContent || '')) as HTMLElement).click());
  await win.waitForTimeout(1500);
  const tabsCard = await win.evaluate(() => {
    const card = dashCurrent.pages[0].cards.find((c: any) => c.type === 'tabs');
    const el = card && document.querySelector(`#dash-grid .dash-card[data-card-id="${card.id}"]`);
    return card ? { id: card.id, tabs: [...(el as HTMLElement).querySelectorAll('[role=tab]')].map((t) => ({ name: t.textContent, on: t.getAttribute('aria-selected') })) } : null;
  });
  ok('More → Tabs adds a tabs card with two tabs, the first showing', !!tabsCard && tabsCard.tabs.length === 2 && tabsCard.tabs[0].on === 'true', JSON.stringify(tabsCard));
  await shot('3-cards-container-tabs');

  // Drag the container by its head, three columns right.
  const before = grouped;
  const drag = await win.evaluate((id: string) => {
    const head = document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"] .dash-card-head`) as HTMLElement;
    const r = head.getBoundingClientRect();
    const grid = document.getElementById('dash-grid') as HTMLElement;
    return { x: r.left + 40, y: r.top + r.height / 2, col: grid.getBoundingClientRect().width / 12 };
  }, grouped.id);
  await win.mouse.move(drag.x, drag.y);
  await win.mouse.down();
  for (let i = 1; i <= 6; i++) await win.mouse.move(drag.x + (drag.col * 3 * i) / 6, drag.y + 2);
  await win.mouse.up();
  await win.waitForTimeout(1200);
  const after = await win.evaluate((ids: string[]) => {
    const cards = dashCurrent.pages[0].cards;
    const g = cards.find((c: any) => c.type === 'container');
    return { layout: g.layout, kids: cards.filter((c: any) => ids.includes(c.id)).map((c: any) => c.layout) };
  }, kpiIds);
  const dx = after.layout.x - before.layout.x;
  ok('dragging the container moves it', dx > 0, JSON.stringify({ before: before.layout, after: after.layout }));
  ok('…and both KPIs move with it, by the same amount',
    after.kids.every((k: any, i: number) => k.x - before.kids[i].layout.x === dx && k.y === before.kids[i].layout.y), JSON.stringify(after.kids));
  await win.evaluate((id: string) => ([...document.querySelectorAll(`#dash-grid .dash-card[data-card-id="${id}"] [role=tab]`)][1] as HTMLElement).click(), tabsCard ? tabsCard.id : '');
  await win.waitForTimeout(800);
  ok('switching tab shows the second tab', await win.evaluate((id: string) =>
    ([...document.querySelectorAll(`#dash-grid .dash-card[data-card-id="${id}"] [role=tab]`)][1] as HTMLElement).getAttribute('aria-selected') === 'true', tabsCard ? tabsCard.id : ''));
  await win.evaluate(() => (document.getElementById('dash-undo-btn') as HTMLElement).click());
  await win.waitForTimeout(1500);
  const undone = await win.evaluate((ids: string[]) => {
    const cards = dashCurrent.pages[0].cards;
    const g = cards.find((c: any) => c.type === 'container');
    return { layout: g.layout, kids: cards.filter((c: any) => ids.includes(c.id)).map((c: any) => c.layout) };
  }, kpiIds);
  ok('undo puts the container AND its KPIs back where they were',
    JSON.stringify(undone.layout) === JSON.stringify(before.layout)
      && undone.kids.every((k: any, i: number) => JSON.stringify(k) === JSON.stringify(before.kids[i].layout)), JSON.stringify(undone));

  // A Markdown text card whose {{Revenue}} resolves to the metric, in bold.
  await win.evaluate(() => (document.getElementById('dash-add-text') as HTMLElement).click());
  await win.waitForTimeout(500);
  await fillPromptOpen(win, 'Headline');
  await win.waitForTimeout(400);
  await fillPromptOpen(win, 'Revenue this period: **{{Revenue}}**');
  await win.waitForTimeout(2500);
  const mdCard = await win.evaluate(() => {
    const strong = [...document.querySelectorAll('#dash-grid .md-card strong')].find((s) => s.querySelector('.md-token'));
    return strong ? { bold: strong.textContent, token: strong.querySelector('.md-token')?.className } : null;
  });
  ok('a Markdown text card renders {{Revenue}} as 5.2M, in bold', !!mdCard && /5\.2M/.test(mdCard.bold || '') && /is-resolved/.test(mdCard.token || ''), JSON.stringify(mdCard));
  await win.evaluate(() => [...document.querySelectorAll('#dash-grid .md-card strong')].pop()?.closest('.dash-card')?.scrollIntoView({ block: 'center' }));
  await win.waitForTimeout(400);
  await shot('3-cards-markdown');

  // ── 4. Maps that carry more ───────────────────────────────────────────────
  const maps = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    const boundaries = req('./src/app/projectBoundaries.js');
    const { randomUUID } = req('crypto');
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const rows: any[][] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push(['site' + i, Math.round((30 + rnd() * 15) * 1e4) / 1e4, Math.round((-120 + rnd() * 45) * 1e4) / 1e4, Math.round(rnd() * 500), i % 3 ? 'retail' : 'depot']);
    }
    const sites = await datasets.saveDataset(pid, {
      name: 'Sites', sourceKind: 'csv', rows,
      columns: [{ name: 'site', type: 'text' }, { name: 'Latitude', type: 'number' }, { name: 'Longitude', type: 'number' }, { name: 'sales', type: 'number' }, { name: 'kind', type: 'text' }],
    });
    const sq = (x: number, y: number): number[][][] => [[[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8], [x, y]]];
    const b = await boundaries.importBoundaryText(pid, 'Zones', JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { zone: 'North' }, geometry: { type: 'Polygon', coordinates: sq(-110, 42) } },
      { type: 'Feature', properties: { zone: 'South' }, geometry: { type: 'Polygon', coordinates: sq(-110, 30) } },
      { type: 'Feature', properties: { zone: 'East' }, geometry: { type: 'Polygon', coordinates: sq(-95, 36) } },
    ] }));
    const zones = await datasets.saveDataset(pid, {
      name: 'Zones', sourceKind: 'csv',
      columns: [{ name: 'zone', type: 'text' }, { name: 'value', type: 'number' }],
      rows: [['North', 10], ['South', 20], ['East', 30]],
    });
    const pv = await visuals.saveVisual(pid, {
      datasetId: sites.id, name: 'Sites', chartType: 'map_bubble',
      encoding: { category: 'site', values: [{ column: 'sales', aggregation: 'none' }], geo: { level: 'point', color: 'kind' } },
    });
    const cv = await visuals.saveVisual(pid, {
      datasetId: zones.id, name: 'Value by zone', chartType: 'map_choropleth',
      encoding: { category: 'zone', values: [{ column: 'value', aggregation: 'sum' }], geo: { level: 'custom', boundaryId: b.id, property: 'zone', basemap: 'none' } },
    });
    const a = await analysis.saveAnalysis(pid, { name: 'Maps', sheets: [{ id: randomUUID(), name: 'Maps', cards: [
      { id: randomUUID(), type: 'visual', visualId: pv.id, layout: { x: 0, y: 0, w: 7, h: 8 } },
      { id: randomUUID(), type: 'visual', visualId: cv.id, layout: { x: 7, y: 0, w: 5, h: 8 } },
    ] }] });
    return { boundaryId: b.id, featureCount: b.featureCount, pointVisual: pv.id, zoneVisual: cv.id, analysisId: a.id, firstPoint: [rows[0][2], rows[0][1]] };
  }, seed.projectId);
  ok('fixture: three boundary polygons import and validate', maps.featureCount === 3, JSON.stringify(maps));
  await win.evaluate(() => (document.querySelector('.dash-editor-head #dash-back-btn') as HTMLElement)?.click());
  await win.waitForTimeout(1500);
  ok('the maps dashboard opens', await openSeededAnalysis(win, 'Maps'));
  await win.waitForFunction(() => document.querySelectorAll('#dash-grid .cv-map-wrap').length === 2
    && !!document.querySelector('#dash-grid .cv-map-wrap[data-clusters]') && !!document.querySelector('#dash-grid .cv-map-wrap[data-matched]'),
    undefined, { timeout: 30000 }).catch(() => {});
  await win.waitForTimeout(1500);
  const low = await win.evaluate(() => {
    const w = document.querySelector('#dash-grid .cv-map-wrap[data-clusters]') as HTMLElement | null;
    return w ? { clusters: Number(w.dataset.clusters), points: Number(w.dataset.points), markers: w.querySelectorAll('.cv-map-cluster').length,
      label: (w.querySelector('.cv-map-cluster') as HTMLElement | null)?.getAttribute('aria-label') || '' } : null;
  });
  ok('5,000 generated points render as clusters at low zoom, counts in the markers',
    !!low && low.clusters > 0 && low.markers === low.clusters && /points — zoom in/.test(low.label), JSON.stringify(low));
  await shot('4-maps');
  const hi = await win.evaluate(async () => {
    const w = document.querySelector('#dash-grid .cv-map-wrap[data-clusters]') as HTMLElement;
    const area = w.closest('.dash-viz-area') as HTMLElement;
    const map = getMapInContainer(area);
    map.jumpTo({ center: [-100, 38], zoom: 18 });
    await new Promise((r) => setTimeout(r, 1200));
    return { clusters: Number(w.dataset.clusters), points: Number(w.dataset.points) };
  });
  ok('…and as single points at high zoom', hi.clusters === 0 && hi.points === 5000, JSON.stringify(hi));
  // Click one point: its site joins the selection layer.
  const target = await win.evaluate(async (at: number[]) => {
    const w = document.querySelector('#dash-grid .cv-map-wrap[data-clusters]') as HTMLElement;
    const area = w.closest('.dash-viz-area') as HTMLElement;
    const map = getMapInContainer(area);
    map.jumpTo({ center: at, zoom: 14 });
    await new Promise((r) => setTimeout(r, 1500));
    const f = map.queryRenderedFeatures(undefined, { layers: ['cv-points-circles'] })[0];
    if (!f) return null;
    const p = map.project(f.geometry.coordinates);
    const r = map.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y, name: f.properties.__name };
  }, maps.firstPoint);
  if (target) await win.mouse.click(target.x, target.y);
  await win.waitForTimeout(1500);
  const selChip = await win.evaluate(() => [...document.querySelectorAll('#dash-sel-strip .dash-sel-chip-txt')].map((c) => c.textContent));
  ok('clicking a point selects it — a chip in the selection layer', !!target && selChip.includes(`site = ${target.name}`), JSON.stringify({ target, selChip }));
  const zone = await win.evaluate(() => {
    const w = document.querySelector('#dash-grid .cv-map-wrap[data-matched]') as HTMLElement | null;
    return w ? { matched: w.dataset.matched, basemap: w.dataset.basemap, legend: !!w.querySelector('.cv-map-legend') } : null;
  });
  ok('the imported three-polygon boundary set renders a choropleth, all three regions matched', !!zone && zone.matched === '3' && zone.legend, JSON.stringify(zone));
  ok('…on the offline basemap it asked for', !!zone && zone.basemap === 'none');
  await win.evaluate(() => (document.querySelector('#dash-sel-strip .dash-sel-clear, #dash-sel-strip .dash-filter-chip-x') as HTMLElement)?.click());
  await win.waitForTimeout(1500);
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find((c) => /Value by zone/.test(c.querySelector('.dash-card-title')?.textContent || '')) as HTMLElement;
    (card.querySelector('.dash-card-head') as HTMLElement).click();
  });
  await win.waitForFunction(() => {
    const s = document.querySelector('#an-wells .js-enc-geo') as HTMLSelectElement | null;
    return !!s && s.value.startsWith('custom:');
  }, undefined, { timeout: 10000 }).catch(() => {});
  const listed = await win.evaluate((id: string) => {
    const s = document.querySelector('#an-wells .js-enc-geo') as HTMLSelectElement | null;
    return s ? { value: s.value, has: [...s.options].some((o) => o.value === 'custom:' + id && /Zones/.test(o.textContent || '')), point: [...s.options].some((o) => o.value === 'point') } : null;
  }, maps.boundaryId);
  ok('the builder lists the imported boundaries beside the bundled geographies, selected', !!listed && listed.has && listed.value === 'custom:' + maps.boundaryId && listed.point, JSON.stringify(listed));

  ok('no renderer console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await smoke.close();
  finishSmoke('authoring', failureCount());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
