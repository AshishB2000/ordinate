// Build-depth smoke SECTION: the Assistant's plan mode, driven through the REAL
// UI. Not a standalone smoke — scripts/smoke-build.ts calls planSection(s, fx)
// on its own launch and fixture.
//
// No model runs in CI, so the model's REPLY is played instead: the exact line a
// model would write goes through main's own splitAction/validateAction, and
// the resulting action is handed to the dock the way dkSend hands it over.
// Everything after that is the shipped path:
//
//   1. the card: 8 numbered steps, each with an icon, a line and "Pending";
//      steps over the not-yet-imported file say they are checked when they run
//   2. Edit → change the alert's number → Done editing → re-checked in main
//   3. Run all → the file picker (stubbed in main: a native dialog cannot be
//      driven) → every step Done, with rows before/after, a KPI value and links
//   4. the records exist in main, the dashboard carries the style, and the run
//      is logged as a turn in the dock's conversation
//   5. Undo run → every created record is gone (to the Trash)
//   6. a plan with a broken step: flagged before it runs, stops the run with
//      the app's error, Fix without a model says so, Skip carries on

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

declare const dkSetOpen: (open: boolean) => void;
declare const dkSync: () => void;
declare const dkOfferPlanProposal: (action: unknown, threadId: string, containerId?: string) => Promise<void>;
declare const selectSection: (s: string) => void;
declare const dashCurrent: { id: string; name: string } | null;

type Win = Smoke['win'];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(250);
  }
  return false;
}

/** The newest plan card's state, read off the DOM. */
function cardState(win: Win): Promise<{ n: number; status: string[]; lines: string[]; notes: string[]; results: string[]; buttons: string[]; kpis: string[]; links: string[] } | null> {
  return win.evaluate(() => {
    const cards = document.querySelectorAll('#dk-messages .pl-card');
    const card = cards[cards.length - 1];
    if (!card) return null;
    const all = (sel: string) => [...card.querySelectorAll(sel)].map((e) => (e.textContent || '').trim());
    return {
      n: card.querySelectorAll('.pl-step').length,
      status: all('.pl-status'),
      lines: all('.pl-line'),
      notes: [...card.querySelectorAll('.pl-step')].map((li) => [...li.querySelectorAll('.pl-note')].map((e) => e.textContent).join(' ')),
      results: [...card.querySelectorAll('.pl-step')].map((li) => (li.querySelector('.pl-result')?.textContent || '').trim()),
      buttons: [...card.querySelectorAll('.pl-actions button')].map((b) => (b.textContent || '').trim()),
      kpis: all('.pl-kpi'),
      links: all('.pl-link'),
    };
  });
}

/** Click a button in the newest plan card by its exact label. */
function clickCard(win: Win, label: string): Promise<boolean> {
  return win.evaluate((l: string) => {
    const cards = document.querySelectorAll('#dk-messages .pl-card');
    const card = cards[cards.length - 1];
    const b = card && [...card.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === l) as HTMLButtonElement | undefined;
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }, label);
}

/** The model's reply, through main's own contract parser. */
async function actionFrom(s: Smoke, reply: string): Promise<any> {
  return s.app.evaluate((_e, r: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/ai/suggestedAction.js').splitAction(r).action;
  }, reply);
}

async function projectRecords(s: Smoke, pid: string): Promise<{ datasets: any[]; visuals: any[]; metrics: any[]; analyses: any[]; alerts: any[]; turns: any[] }> {
  return s.app.evaluate(async (_e, id: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const alerts = await req('./src/analysis/alertStore.js').load(id);
    return {
      datasets: await req('./src/data/datasets.js').listDatasets(id),
      visuals: await req('./src/analysis/visuals.js').listVisuals(id),
      metrics: await req('./src/analysis/metrics.js').listMetrics(id),
      analyses: await Promise.all((await req('./src/analysis/analysis.js').listAnalyses(id))
        .map((a: any) => req('./src/analysis/analysis.js').getAnalysis(id, a.id))),
      alerts: alerts.rules || [],
      turns: await req('./src/ai/copilot.js').loadHistory(id),
    };
  }, pid);
}

export async function planSection(s: Smoke, fx: Fixture): Promise<void> {
  const { win, app } = s;
  await openProject(win, fx.projectId);

  // The file the plan imports, and the picker answered with it.
  const dir = path.join(s.userData, '..', path.basename(s.userData) + '-plan');
  fs.mkdirSync(dir, { recursive: true });
  const csv = path.join(dir, 'orders.csv');
  fs.writeFileSync(csv, [
    'Region,Product,Revenue,Cost',
    'West,Chairs,120,70', 'West,Desks,300,180', 'East,Chairs,90,60',
    'East,Lamps,45,20', 'North,Desks,410,300', ',Lamps,15,5',
  ].join('\n'));
  await app.evaluate((electron, f: string) => {
    // ponytail: test stub over Electron's own dialog, restored at the end of the section.
    (globalThis as any).__plOpen = electron.dialog.showOpenDialog;
    (electron.dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, csv);

  await win.evaluate(() => { dkSetOpen(true); dkSync(); });
  await win.waitForSelector('#dk-panel', { state: 'visible', timeout: 8000 });

  // ── 1. The card ───────────────────────────────────────────────────────────
  const plan = {
    kind: 'plan',
    intent: 'Import orders.csv, clean it, and build me a regional dashboard',
    steps: [
      { kind: 'import', file: 'orders.csv', name: 'Orders' },
      { kind: 'step', dataset: 'Orders', step: { type: 'filter', column: 'Region', op: 'not_empty' } },
      { kind: 'calc', dataset: 'Orders', name: 'Margin', expression: '[Revenue] - [Cost]' },
      { kind: 'metric', dataset: 'Orders', name: 'Total revenue', column: 'Revenue', aggregation: 'sum' },
      { kind: 'chart', dataset: 'Orders', name: 'Revenue by region', chartType: 'column', encoding: { category: 'Region', values: [{ column: 'Revenue', aggregation: 'sum' }] } },
      { kind: 'dashboard', name: 'Regional sales', visuals: ['Revenue by region'], metrics: ['Total revenue'] },
      { kind: 'style', preset: 'executive' },
      { kind: 'alert', metric: 'Total revenue', op: '<', value: 100, name: 'Revenue low' },
    ],
  };
  const action = await actionFrom(s, 'I will import the file, clean it and build the dashboard.\n@@ACTION ' + JSON.stringify(plan));
  ok('plan: the model\'s line becomes a validated plan action', action && action.kind === 'plan' && action.steps.length === 8, JSON.stringify(action));
  await win.evaluate((a: unknown) => dkOfferPlanProposal(a, ''), action);
  const shown = await until(win, async () => ((await cardState(win))?.n || 0) === 8, 10_000);
  const c1 = await cardState(win);
  ok('plan: the card lists 8 numbered steps, every one Pending', shown && !!c1 && c1.status.every((x) => x === 'Pending'), JSON.stringify(c1));
  ok('plan: each step has an icon and a line', await win.evaluate(() =>
    [...document.querySelectorAll('#dk-messages .pl-card:last-of-type .pl-step')].every((li) => !!li.querySelector('.pl-ic svg') && !!(li.querySelector('.pl-line')?.textContent || '').trim())));
  ok('plan: steps over the file not imported yet say they are checked when they run',
    !!c1 && /imported by step 1/.test(c1.notes[1]) && /imported by step 1/.test(c1.notes[4]), JSON.stringify(c1 && c1.notes));
  ok('plan: Run all, Step through, Edit, Cancel', !!c1 && ['Run all', 'Step through', 'Edit', 'Cancel'].every((b) => c1.buttons.includes(b)), JSON.stringify(c1 && c1.buttons));
  await win.screenshot({ path: path.join(s.shotDir, 'build-plan-1-card.png') });

  // ── 2. Edit ───────────────────────────────────────────────────────────────
  await clickCard(win, 'Edit');
  const edited = await win.evaluate(() => {
    const inp = document.querySelector('#dk-messages .pl-card:last-of-type input[aria-label="Step 8 Value"]') as HTMLInputElement | null;
    if (!inp) return false;
    inp.value = '250';
    inp.dispatchEvent(new Event('change'));
    return true;
  });
  ok('plan: Edit shows a step\'s parameters inline', edited);
  await clickCard(win, 'Done editing');
  await until(win, async () => ((await cardState(win))?.lines[7] || '').includes('250'), 10_000);
  const c2 = await cardState(win);
  ok('plan: the edit is re-checked in main and shown', !!c2 && /< 250/.test(c2.lines[7]) && c2.buttons.includes('Run all'), JSON.stringify(c2 && c2.lines));

  // ── 3. Run all ────────────────────────────────────────────────────────────
  await clickCard(win, 'Run all');
  const finished = await until(win, async () => {
    const st = await cardState(win);
    return !!st && (st.status.every((x) => x === 'Done') || st.status.includes('Failed'));
  }, 90_000);
  const c3 = await cardState(win);
  ok('plan: Run all runs every step to Done', finished && !!c3 && c3.status.every((x) => x === 'Done'), JSON.stringify(c3));
  ok('plan: the import says what it read', !!c3 && /6 rows × 4 columns from orders\.csv/.test(c3.results[0]), c3 && c3.results[0]);
  ok('plan: the prepare step shows rows before and after', !!c3 && /6 → 5 rows/.test(c3.results[1]), c3 && c3.results[1]);
  ok('plan: the metric step shows the app\'s KPI value', !!c3 && c3.kpis.some((k) => /Total revenue/.test(k) && /\d/.test(k)), JSON.stringify(c3 && c3.kpis));
  ok('plan: created records are links', !!c3 && ['Orders', 'Total revenue', 'Revenue by region', 'Regional sales', 'Revenue low'].every((n) => c3.links.includes(n)), JSON.stringify(c3 && c3.links));
  ok('plan: a finished run offers Undo run', !!c3 && c3.buttons.includes('Undo run'));
  await win.screenshot({ path: path.join(s.shotDir, 'build-plan-2-finished.png') });

  const rec = await projectRecords(s, fx.projectId);
  const orders = rec.datasets.find((d) => d.name === 'Orders');
  const dash = rec.analyses.find((a) => a && a.name === 'Regional sales');
  ok('plan: the dataset exists with its two prepare steps landed', !!orders && orders.rowCount === 5);
  ok('plan: the dashboard exists, with the visual and the KPI tied to its metric, styled executive',
    !!dash && dash.style && dash.style.theme === 'executive'
    && dash.sheets[0].cards.some((c: any) => c.type === 'metric' && c.metric && c.metric.metricId)
    && dash.sheets[0].cards.some((c: any) => c.type === 'visual'), JSON.stringify(dash && dash.style));
  ok('plan: the alert rule exists at the user\'s number', rec.alerts.some((r: any) => r.name === 'Revenue low' && r.threshold && r.threshold.value === 250));
  const last = rec.turns[rec.turns.length - 1];
  ok('plan: the run is logged as a turn in the dock conversation',
    !!last && last.role === 'assistant' && /^Plan run finished — 8 of 8 steps done\./.test(last.text), last && last.text);
  ok('plan: …and shown in the dock', await win.evaluate(() =>
    [...document.querySelectorAll('#dk-messages .xp-msg')].some((m) => (m.textContent || '').includes('Plan run finished'))));

  // A link opens the record.
  await win.evaluate(() => {
    const cards = document.querySelectorAll('#dk-messages .pl-card');
    const a = [...cards[cards.length - 1].querySelectorAll('.pl-link')].find((x) => (x.textContent || '').includes('Regional sales')) as HTMLElement | undefined;
    a?.click();
  });
  ok('plan: the dashboard link opens it', await until(win, () => win.evaluate(() => !!dashCurrent && dashCurrent.name === 'Regional sales'), 10_000));

  // ── 5. Undo ───────────────────────────────────────────────────────────────
  await win.evaluate(() => selectSection('home'));
  await clickCard(win, 'Undo run');
  await until(win, async () => ((await cardState(win))?.buttons || []).some((b) => /^Undone/.test(b)) || await win.evaluate(() =>
    [...document.querySelectorAll('#dk-messages .pl-card .ai-interp-hint')].some((e) => /^Undone/.test(e.textContent || ''))), 30_000);
  const after = await projectRecords(s, fx.projectId);
  ok('plan: Undo run removes every record the run created',
    !after.datasets.some((d) => d.name === 'Orders') && !after.visuals.some((v) => v.name === 'Revenue by region')
    && !after.metrics.some((m) => m.name === 'Total revenue') && !after.analyses.some((a) => a && a.name === 'Regional sales')
    && !after.alerts.some((r: any) => r.name === 'Revenue low'), JSON.stringify({ d: after.datasets.map((d) => d.name) }));
  ok('plan: …and the seeded data is untouched', after.datasets.some((d) => d.id === fx.datasetId));
  ok('plan: the undo is logged too', /^Plan run undone — 5 records put back\./.test(String(after.turns[after.turns.length - 1]?.text)),
    String(after.turns[after.turns.length - 1]?.text));
  await clickCard(win, 'Done');

  // ── 6. A broken step ──────────────────────────────────────────────────────
  const broken = await actionFrom(s, 'Here is the plan.\n@@ACTION ' + JSON.stringify({
    kind: 'plan', intent: 'Add a ratio and a total',
    steps: [
      { kind: 'calc', dataset: 'Sales', name: 'Ratio', expression: '[Nope] / [amount]' },
      { kind: 'metric', dataset: 'Sales', name: 'Amount total (plan)', column: 'amount', aggregation: 'sum' },
    ],
  }));
  await win.evaluate((a: unknown) => dkOfferPlanProposal(a, ''), broken);
  await until(win, async () => ((await cardState(win))?.n || 0) === 2, 10_000);
  const b1 = await cardState(win);
  ok('plan: a broken step is flagged BEFORE anything runs, in the app\'s words',
    !!b1 && /unknown column/.test(b1.notes[0]), JSON.stringify(b1 && b1.notes));
  await clickCard(win, 'Run all');
  await until(win, async () => ((await cardState(win))?.status || []).includes('Failed'), 30_000);
  const b2 = await cardState(win);
  ok('plan: the run stops on it; the next step does not run', !!b2 && b2.status[0] === 'Failed' && b2.status[1] === 'Pending', JSON.stringify(b2 && b2.status));
  ok('plan: a failure offers Fix, Skip and Stop', !!b2 && ['Fix', 'Skip', 'Stop'].every((x) => b2.buttons.includes(x)), JSON.stringify(b2 && b2.buttons));
  await clickCard(win, 'Fix');
  ok('plan: Fix without a model says so, and changes nothing', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#dk-messages .pl-card .pl-flash')].some((e) => /needs an AI model/.test(e.textContent || ''))), 15_000));
  await clickCard(win, 'Skip');
  await until(win, async () => ((await cardState(win))?.status || [])[1] === 'Done', 30_000);
  const b3 = await cardState(win);
  ok('plan: Skip carries on with the next step', !!b3 && b3.status[0] === 'Skipped' && b3.status[1] === 'Done', JSON.stringify(b3 && b3.status));
  await clickCard(win, 'Undo run');
  await until(win, async () => !(await projectRecords(s, fx.projectId)).metrics.some((m) => m.name === 'Amount total (plan)'), 15_000);
  await clickCard(win, 'Done');

  // Leave the app as it was found.
  await app.evaluate((electron) => {
    const orig = (globalThis as any).__plOpen;
    if (orig) (electron.dialog as any).showOpenDialog = orig;
  });
  await win.evaluate(() => { dkSetOpen(false); dkSync(); selectSection('home'); });
}
