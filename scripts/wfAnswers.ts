// Workflow smoke, section 1 — the Assistant answers with charts.
//
// Home's ask bar → a stubbed model answering with an `answer` spec → the app
// builds the card: five bars whose values ARE the app's aggregate (the same
// `visual:data` figures, Object.is) and match the CSV summed independently
// here, a caption naming West as highest, the narration under it. Then "Add to
// dashboard" lands the chart on a NEW dashboard, and "Explain" on the sample
// dashboard's category chart opens the dock on that chart's facts.

import { ok } from './selfcheck';
import type { Smoke } from './smokeFixture';
import { queueReplies, stubState } from './wfStub';

// chartRender.ts's registry, read inside page.evaluate by its bare name.
declare const chartInstances: WeakMap<Element, any>;

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

/** Revenue by region, summed from the bundled CSV by this test — not by the app. */
function csvRevenueByRegion(): Map<string, number> {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv'), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ri = head.indexOf('region');
  const vi = head.indexOf('revenue');
  const out = new Map<string, number>();
  for (const l of lines.slice(1)) {
    const f = l.split(',');
    out.set(f[ri], (out.get(f[ri]) || 0) + Number(f[vi]));
  }
  return out;
}

export async function answersSection(s: Smoke, ids: { projectId: string; datasetId: string; dashboardId: string }): Promise<void> {
  const { win } = s;
  // The dock's default 340px is narrower than a 320px chart plus its card, so
  // the card narrows there (asserted below); widened, the chart is 320×180.
  await win.evaluate(async (id: string) => {
    const w = window as any;
    await w.adoptProject(id);
    w.selectSection('home');
    w.dkPersistWidth(400);
  }, ids.projectId);
  await win.waitForTimeout(800);

  // ── Ask from Home ──────────────────────────────────────────────────────────
  await queueReplies(s, [
    {
      text: 'Here is revenue by region.',
      action: {
        kind: 'answer', intent: 'revenue by region',
        spec: { dataset: 'Retail orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] },
      },
    },
    { text: 'West brings in the most revenue of the five regions, and Northeast the least.' },
  ]);
  await win.fill('#home-ask-input', 'revenue by region');
  await win.press('#home-ask-input', 'Enter');
  await win.waitForSelector('#dk-messages .ans-card .ans-chart canvas', { timeout: 30_000 });
  await win.waitForTimeout(1200);

  const got = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dk-messages .ans-card')];
    const card = cards[cards.length - 1] as HTMLElement;
    const area = card.querySelector('.ans-chart') as HTMLElement;
    // chartInstances is a top-level const in chartRender.js — reachable by name, not off window.
    const inst: any = chartInstances.get(area);
    const r = area.getBoundingClientRect();
    const row = card.closest('.xp-msg') as HTMLElement;
    return {
      title: (card.querySelector('.ans-title')?.textContent || '').trim(),
      labels: inst ? inst.data.labels.map(String) : [],
      values: inst ? inst.data.datasets[0].data : [],
      caption: (card.querySelector('.ans-caption')?.textContent || '').trim(),
      kpis: [...card.querySelectorAll('.ans-kpi')].map((k) => (k.textContent || '').trim()),
      actions: [...card.querySelectorAll('.ans-actions button')].map((b) => (b.textContent || '').trim()),
      chips: [...card.querySelectorAll('.ans-chip')].map((b) => (b.textContent || '').trim()),
      narration: (row.querySelector('.xp-bubble')?.textContent || '').trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      canvasH: Math.round((area.querySelector('canvas') as HTMLElement).getBoundingClientRect().height),
      chartBottom: Math.round(r.bottom),
      captionTop: Math.round((card.querySelector('.ans-caption') as HTMLElement).getBoundingClientRect().top),
    };
  });
  ok('answer: a card renders in the dock for a question asked on Home', got.title === 'Revenue by region', JSON.stringify(got.title));
  ok('answer: a five-bar chart', got.labels.length === 5 && got.values.length === 5, JSON.stringify(got.labels));
  ok('answer: the chart is 320×180', got.w === 320 && got.h === 180, `${got.w}×${got.h}`);
  ok('answer: …and the plot stays inside it (canvas no taller than its box)', got.canvasH > 0 && got.canvasH <= 180, String(got.canvasH));
  ok('answer: the caption sits below the chart, not under it', got.captionTop >= got.chartBottom, JSON.stringify(got));

  const app = await win.evaluate(async (a: { pid: string; did: string }) =>
    (window as any).hub.computeVisualData(a.pid, a.did, { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, []),
  { pid: ids.projectId, did: ids.datasetId });
  const appMap = new Map<string, number>(app.data.labels.map((l: unknown, i: number) => [String(l), app.data.series[0].values[i]]));
  ok('answer: every bar IS the app\'s aggregate (Object.is against visual:data)',
    got.labels.every((l: string, i: number) => Object.is(got.values[i], appMap.get(l))), JSON.stringify({ got: got.values, app: [...appMap] }));
  const csv = csvRevenueByRegion();
  ok('answer: …and matches the CSV summed independently by this test',
    got.labels.every((l: string, i: number) => Math.abs(got.values[i] - (csv.get(l) || NaN)) < 1e-6));
  const west = got.labels.indexOf('West');
  ok('answer: West is the tallest bar', west >= 0 && got.values[west] === Math.max(...got.values));
  ok('answer: the caption names West as highest', /^West leads/.test(got.caption), got.caption);
  ok('answer: headline figures, formatted by the app', got.kpis.length === 2 && /Total revenue/.test(got.kpis[0]) && /Highest · West/.test(got.kpis[1]),
    JSON.stringify(got.kpis));
  ok('answer: the four actions', got.actions.join('|') === 'Save as visual|Add to dashboard|Open in builder|Show table', got.actions.join('|'));
  ok('answer: follow-up chips generated from the spec', got.chips.includes('Split by category') && got.chips.includes('Show as table'),
    JSON.stringify(got.chips));
  ok('answer: the narration sits under the card', /West brings in the most revenue/.test(got.narration), got.narration);
  await win.screenshot({ path: path.join(s.shotDir, 'wf-1-answer.png') });

  // Show table toggles a real table of the same figures.
  const table = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dk-messages .ans-card')].pop() as HTMLElement;
    const b = [...card.querySelectorAll('.ans-actions button')].find((x) => x.textContent === 'Show table') as HTMLElement;
    b.click();
    return card.querySelectorAll('.ans-table tbody tr').length;
  });
  ok('answer: Show table lists the five rows', table === 5, String(table));

  // ── Add to dashboard → a NEW dashboard ─────────────────────────────────────
  const before = await win.evaluate(async (pid: string) => (await (window as any).hub.listAnalyses(pid)).length, ids.projectId);
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dk-messages .ans-card')].pop() as HTMLElement;
    ([...card.querySelectorAll('.ans-actions button')].find((x) => x.textContent === 'Add to dashboard') as HTMLElement).click();
  });
  await win.waitForTimeout(4000);
  const dash = await win.evaluate(async (pid: string) => {
    const list = await (window as any).hub.listAnalyses(pid);
    const cards = [...document.querySelectorAll('#dash-grid .dash-card')];
    return {
      count: list.length,
      names: list.map((a: any) => a.name),
      editorOpen: !!(document.getElementById('dash-editor') as HTMLElement | null)?.offsetParent,
      cards: cards.length,
      canvases: cards.filter((c) => c.querySelector('canvas')).length,
    };
  }, ids.projectId);
  ok('Add to dashboard: a new dashboard exists, named for the answer',
    dash.count === before + 1 && dash.names.includes('Revenue by region'), JSON.stringify(dash));
  ok('Add to dashboard: …and it opens with the chart on it', dash.editorOpen && dash.cards === 1 && dash.canvases === 1, JSON.stringify(dash));

  // ── Explain on the sample dashboard's category chart ───────────────────────
  await win.evaluate(async (id: string) => {
    const w = window as any;
    if (w.dashCurrent) await w.handleBackToList();
    w.selectSection('analyses');
    await w.openAnalysis(id);
  }, ids.dashboardId);
  await win.waitForTimeout(3000);
  await queueReplies(s, [{ text: 'Technology carries revenue by category; Office Supplies is a small share.' }]);
  const opened = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue by category') as HTMLElement | undefined;
    const btn = card?.querySelector('.dash-card-menu-btn') as HTMLElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  });
  await win.waitForTimeout(300);
  const clicked = await win.evaluate(() => {
    const item = [...document.querySelectorAll('.dash-card-menu .chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Explain') as HTMLElement | undefined;
    if (!item) return false;
    item.click();
    return true;
  });
  ok('Explain: the category chart\'s ⋯ menu offers Explain', opened && clicked);
  await win.waitForFunction(() => [...document.querySelectorAll('#dk-messages .ans-card .ans-title')]
    .some((t) => (t.textContent || '').trim() === 'Revenue by category'), undefined, { timeout: 30_000 });
  await win.waitForTimeout(1200);
  const ex = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dk-messages .ans-card')].pop() as HTMLElement;
    const row = card.closest('.xp-msg') as HTMLElement;
    const users = [...document.querySelectorAll('#dk-messages .xp-msg-user .xp-bubble')].map((b) => (b.textContent || '').trim());
    return {
      dockOpen: document.body.classList.contains('dk-open') || !!(document.getElementById('dk-panel') as HTMLElement | null)?.offsetParent,
      question: users[users.length - 1] || '',
      kpis: [...card.querySelectorAll('.ans-kpi')].map((k) => (k.textContent || '').trim()),
      caption: (card.querySelector('.ans-caption')?.textContent || '').trim(),
      canvas: !!card.querySelector('.ans-chart canvas'),
      narration: (row.querySelector('.xp-bubble')?.textContent || '').trim(),
      turns: document.querySelectorAll('#dk-messages .xp-msg').length,
    };
  });
  ok('Explain: the dock opens on a new conversation about that chart',
    ex.dockOpen && ex.question === 'Explain “Revenue by category”' && ex.turns === 2, JSON.stringify(ex));
  ok('Explain: …carrying the chart\'s facts — total, leader, caption, the chart itself',
    /Total revenue/.test(ex.kpis[0] || '') && /Highest · Technology/.test(ex.kpis[1] || '') && /^Technology leads/.test(ex.caption) && ex.canvas,
    JSON.stringify(ex));
  ok('Explain: …narrated from those facts', /Technology carries revenue/.test(ex.narration), ex.narration);
  const asked = (await stubState(s)).asked;
  ok('Explain: the model was handed the tile\'s facts (its aggregates and share)',
    /Answer: "Revenue by category"/.test(asked[asked.length - 1]) && /Technology is \d/.test(asked[asked.length - 1]));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-1-explain.png') });

  // Back to the default dock: the chart narrows to its card and keeps 180px.
  await win.evaluate(() => { (window as any).dkPersistWidth(340); });
  await win.waitForTimeout(600);
  const narrow = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dk-messages .ans-card')].pop() as HTMLElement;
    const r = (card.querySelector('.ans-chart') as HTMLElement).getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), inside: r.right <= c.right && r.left >= c.left };
  });
  ok('answer: in the default 340px dock the chart fits its card at 180px tall', narrow.h === 180 && narrow.w < 320 && narrow.inside,
    JSON.stringify(narrow));
  ok('answers: nothing reached the network', (await stubState(s)).net === 0);
}
