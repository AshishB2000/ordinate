// A what-if KPI on a dashboard, moved by a slider — against the real server on
// the sample project's "Retail orders":
//
//   card      a KPI on a saved metric with a scenario shows the figure UNDER
//             the scenario, its change on the baseline and the scenario's name
//             (NEGATIVE CONTROL: the same metric's plain KPI beside it does not)
//   slider    the scenario's driver follows the sheet's `price` parameter: its
//             control is a slider, and moving it moves the what-if figure while
//             the plain KPI stays where it was
//   setting   the card's properties offer the project's scenarios; "None" puts
//             the baseline back
//
// Fails on any console error or CSP violation and stays inside the RPC budget.
// Screens in both themes go to web/e2e/__screens__/what-if-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, settled } from './fixtures.ts';

/** One screenshot per theme WITHOUT a reload (the slider stays where it was put). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

/** One RPC from the page, as the web client sends it (session cookie + CSRF header). */
async function call(page: Page, channel: string, payload: unknown): Promise<any> { // any: each channel's own reply
  return page.evaluate(
    async ([ch, body]) => {
      const m = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie);
      const res = await fetch(`/api/rpc/${ch}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(m ? { 'X-CSRF-Token': m[1] } : {}) }, body: JSON.stringify({ args: [body] }) });
      return res.json();
    },
    [channel, payload] as const,
  );
}

e2e('what-if: a KPI under a scenario, moved by the sheet’s slider; the card’s setting', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const saved = await call(page, 'metric:save', { projectId: pid, input: { name: 'What-if revenue', datasetId: ds, definition: { column: 'revenue', aggregation: 'sum' }, format: { kind: 'number', decimals: 0, compact: false } } });
  const metricId = (saved.metric?.id ?? saved.id) as string;
  assert.match(metricId, /^[0-9a-f-]{36}$/, JSON.stringify(saved));
  const sc = await call(page, 'scenario:create', {
    projectId: pid,
    input: { name: 'Price change', baseMetricIds: [metricId], drivers: [{ name: 'Price', kind: 'pct', value: 10, target: { column: 'revenue' }, param: 'price' }] },
  });
  const scenarioId = (sc.scenario?.id ?? sc.id) as string;
  assert.match(scenarioId, /^[0-9a-f-]{36}$/, JSON.stringify(sc));
  const paramId = crypto.randomUUID();
  const metric = { datasetId: ds, column: 'revenue', aggregation: 'sum', metricId };
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'What-if',
    parameters: [{ id: paramId, name: 'price', kind: 'number', value: 10, min: -50, max: 50, step: 5 }],
    sheets: [{
      id: crypto.randomUUID(),
      name: 'Sheet 1',
      cards: [
        { id: crypto.randomUUID(), type: 'control', layout: { x: 0, y: 0, w: 4, h: 2 }, control: { kind: 'parameter', label: 'Price change %', datasetId: '', column: '', paramId } },
        { id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 2, w: 4, h: 3 }, metric: { ...metric, label: 'Revenue today' } },
        { id: crypto.randomUUID(), type: 'metric', layout: { x: 4, y: 2, w: 4, h: 3 }, metric: { ...metric, label: 'Revenue what-if', scenarioId } },
      ],
    }],
  });
  assert.ok(made.id, JSON.stringify(made));
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);

  // ── The card ────────────────────────────────────────────────────────────
  const today = page.getByRole('group', { name: 'Revenue today card' });
  const whatIf = page.getByRole('group', { name: 'Revenue what-if card' });
  await whatIf.getByText(/^What-if: Price change · baseline /).waitFor();
  assert.equal(await today.getByText(/^What-if:/).count(), 0, 'NEGATIVE CONTROL: the plain KPI is not a what-if');
  const figure = async (card: typeof whatIf): Promise<string> => ((await card.locator('[class*="value"]').first().textContent()) ?? '').trim();
  const base = await figure(today);
  const at10 = await figure(whatIf);
  assert.notEqual(at10, base, `under +10% the what-if figure differs from today's (${base})`);
  assert.match((await whatIf.textContent()) ?? '', /\(\+10%\)/, 'the change on the baseline is the driver’s 10%');
  assert.ok(((await whatIf.textContent()) ?? '').includes(`baseline ${base}`), 'the baseline it names is the plain KPI’s figure');
  await screensInPlace(page, 'what-if-card');

  // ── The slider ──────────────────────────────────────────────────────────
  const slider = page.getByRole('slider', { name: 'Price change %' });
  await slider.fill('-20');
  await whatIf.getByText(/\(−20%\)/).waitFor();
  const atMinus20 = await figure(whatIf);
  assert.notEqual(atMinus20, at10, 'moving the slider moved the what-if figure');
  assert.equal(await figure(today), base, 'and left today’s figure where it was');
  await slider.fill('0');
  await whatIf.getByText('No change').waitFor();
  assert.equal(await figure(whatIf), base, 'at 0% the what-if IS the baseline');
  await slider.fill('25');
  await whatIf.getByText(/\(\+25%\)/).waitFor();
  await screensInPlace(page, 'what-if-slider');

  // ── The setting ─────────────────────────────────────────────────────────
  await whatIf.click();
  await page.getByRole('combobox', { name: 'What-if scenario' }).click();
  await page.getByRole('option', { name: 'None' }).click();
  await whatIf.getByText(/^What-if:/).waitFor({ state: 'detached' });
  assert.equal(await figure(whatIf), base, 'with no scenario the card shows the metric as it is');
  await page.getByRole('combobox', { name: 'What-if scenario' }).click();
  await page.getByRole('option', { name: 'Price change' }).click();
  await whatIf.getByText(/^What-if: Price change · baseline /).waitFor();
});
