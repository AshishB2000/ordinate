// Smoke SECTION: the prepare power steps, driven through the real Prepare panel
// on the bundled sample ("My project" / "Retail orders").
//
// Not a smoke file of its own: `prepareSection(s, ids)` runs against an app
// someone else launched, on a FRESH userData. It creates one small second
// dataset through the app's own IPC ("Region managers", with one region missing
// and one repeated) and a relationship to it in the data model, then, through
// the Add-step menu and each step's own form:
//
//   · opens a Parse dates editor and reads its failure preview (then cancels),
//   · adds a Split column step (order_date on "-", into three columns),
//   · adds a Look up step — the keys prefilled from the relationship — and reads
//     its matched-rate preview before saving,
//   · adds a Replace values step (customer_segment, exact),
//
// and checks the step list's before → after row counts, the warning, the
// resulting columns and cells. Every expected figure is computed HERE from
// assets/samples/retail-orders.csv with this file's own arithmetic, never read
// back from the app. The section restores the sample's pipeline and removes
// what it created, so later sections see the sample as it was.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];

const HELPER = 'Region managers';
const MANAGERS: Array<[string, string]> = [['East', 'Avery'], ['West', 'Blake'], ['Central', 'Casey'], ['South', 'Drew'], ['East', 'Emery']];

interface Expected {
  n: number;
  matched: number;
  ratePct: number;
  consumer: number;
  firstDates: string[];
  yearIsNumber: boolean;
}

/** Everything the section asserts, from the committed CSV (no quoted fields — asserted). */
function expectedFromCsv(): Expected {
  const text = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  const at = (name: string): number => head.indexOf(name);
  const keys = new Set(MANAGERS.map((m) => m[0]));
  const matched = rows.filter((r) => keys.has(r[at('region')])).length;
  const dates: string[] = [];
  for (const r of rows) {
    const d = r[at('order_date')];
    if (!dates.includes(d)) dates.push(d);
    if (dates.length === 5) break;
  }
  return {
    n: rows.length,
    matched,
    ratePct: Math.round((matched / rows.length) * 1000) / 10,
    consumer: rows.filter((r) => r[at('customer_segment')] === 'Consumer').length,
    firstDates: dates,
    // A strict number: no leading zero — so the year part types as a number, month/day as text.
    yearIsNumber: rows.every((r) => /^[1-9][0-9]*$/.test(r[at('order_date')].split('-')[0])),
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Data → the dataset → its Prepare tab, the way the dock's Apply does it. */
async function openPrepare(win: Win, datasetId: string): Promise<boolean> {
  await win.evaluate(async (id: string) => {
    const w = window as any;
    w.selectSection('datasets');
    await w.openSavedDataset(id);
    w.dxSelectTab('ds-tab-prepare', true);
  }, datasetId);
  await win.waitForTimeout(1500);
  return win.evaluate(() => (document.getElementById('ds-prepare-panel') as HTMLElement).hidden === false);
}

/** "+ Add step" → the menu item → the step's form is open. */
async function addStep(win: Win, label: string): Promise<boolean> {
  return win.evaluate(async (l: string) => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (document.getElementById('ds-step-add') as HTMLElement).click();
    await pause(300);
    const item = [...document.querySelectorAll('.chart-menu-item')]
      .find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
    if (!item) return false;
    item.click();
    await pause(400);
    const ed = document.getElementById('ds-step-editor') as HTMLElement;
    return !ed.hidden && (ed.querySelector('.ds-step-editor-title')?.textContent || '').includes(l);
  }, label);
}

/** Set the control of the form field whose label starts with `label`, as a user would. */
async function setField(win: Win, label: string, value: string): Promise<boolean> {
  return win.evaluate((a: { label: string; value: string }) => {
    const field = [...document.querySelectorAll('#ds-step-editor .ds-step-field')].find((f) =>
      (f.querySelector('.ds-step-field-label')?.textContent || '').startsWith(a.label));
    const ctl = field && (field.querySelector('select, input') as HTMLInputElement | HTMLSelectElement | null);
    if (!ctl) return false;
    ctl.value = a.value;
    if (ctl.value !== a.value) return false;
    ctl.dispatchEvent(new Event('input', { bubbles: true }));
    ctl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { label, value });
}

async function fieldValue(win: Win, label: string): Promise<string> {
  return win.evaluate((l: string) => {
    const field = [...document.querySelectorAll('#ds-step-editor .ds-step-field')].find((f) =>
      (f.querySelector('.ds-step-field-label')?.textContent || '').startsWith(l));
    const ctl = field && (field.querySelector('select, input') as HTMLInputElement | null);
    return ctl ? ctl.value : '';
  }, label);
}

/** The editor's preview lines (counted in main). Waits for them to appear. */
async function previewLines(win: Win): Promise<string[]> {
  await win.waitForFunction(() => {
    const p = document.querySelector('#ds-step-editor .pp-preview') as HTMLElement | null;
    return !!p && !p.hidden && p.children.length > 0;
  }, undefined, { timeout: 15_000 }).catch(() => {});
  return win.evaluate(() => [...document.querySelectorAll('#ds-step-editor .pp-preview > div')].map((d) => d.textContent || ''));
}

async function clickEditor(win: Win, text: string): Promise<boolean> {
  const hit = await win.evaluate((t: string) => {
    const b = [...document.querySelectorAll('#ds-step-editor .ds-step-editor-actions button')]
      .find((x) => (x.textContent || '').trim() === t) as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }, text);
  await win.waitForTimeout(2500);
  return hit;
}

/** The pipeline list as the user sees it: each step's summary and its row-count chip. */
async function stepList(win: Win): Promise<Array<{ summary: string; count: string }>> {
  return win.evaluate(() => [...document.querySelectorAll('#ds-steps-list .ds-step')].map((r) => ({
    // The summary's own text; the count is a child line under it.
    summary: r.querySelector('.ds-step-summary')?.firstChild?.textContent || '',
    count: r.querySelector('.ds-step-count')?.textContent || '',
  })));
}

export async function prepareSection(s: Smoke, ids: { projectId: string; datasetId: string; dashboardId: string }): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const csv = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  ok('prepare: the sample CSV has no quoted fields, so a comma split is exact', !csv.includes('"'));
  const x = expectedFromCsv();
  const { projectId: pid, datasetId: did } = ids;

  // The sample's pipeline as it was, to restore at the end.
  const before = await win.evaluate(async (a: { pid: string; did: string }) => {
    const ds = await (window as any).hub.getDataset(a.pid, a.did);
    return { steps: ds.steps || [], columns: ds.columns.map((c: any) => c.name) };
  }, { pid, did });

  // A second dataset and a relationship to it, through the app's own IPC.
  const setup = await win.evaluate(async (a: { pid: string; did: string; name: string; rows: string[][] }) => {
    const w = window as any;
    const saved = await w.hub.saveDataset({
      projectId: a.pid, name: a.name, sourceKind: 'paste',
      columns: [{ name: 'region', type: 'text' }, { name: 'manager', type: 'text' }], rows: a.rows,
    });
    if (!saved || !saved.id) return { helperId: '', relId: '' };
    const rel = await w.hubAuthoring.saveRelationship(a.pid, {
      from: { datasetId: a.did, column: 'region' }, to: { datasetId: saved.id, column: 'region' },
      cardinality: 'many_to_one', verified: { matched: 0, unmatchedFrom: 0 },
    });
    const relId = (rel && rel.relationship && rel.relationship.id) || (rel && rel.id) || '';
    return { helperId: String(saved.id), relId: String(relId) };
  }, { pid, did, name: HELPER, rows: MANAGERS.map((m) => [m[0], m[1]]) });
  ok('prepare: a second dataset and a relationship to it were created', !!setup.helperId && !!setup.relId, JSON.stringify(setup));

  try {
    ok('prepare: the Prepare tab opens on the sample', await openPrepare(win, did));

    // ── Parse dates: the failure preview, over the step's real input ─────────
    ok('prepare/parse: the Parse dates form opens', await addStep(win, 'Parse dates'));
    ok('prepare/parse: column and a format that does not fit', await setField(win, 'Column', 'order_date') &&
      await setField(win, 'Format', 'DD/MM/YYYY'));
    // The column change previews first (under the default format); wait for the
    // preview of the format just chosen rather than read whichever landed.
    await win.waitForFunction(() => /^0 of /.test(document.querySelector('#ds-step-editor .pp-preview > div')?.textContent || ''),
      undefined, { timeout: 15_000 }).catch(() => {});
    const parse = await previewLines(win);
    ok('prepare/parse: every value fails, counted by the app',
      parse[0] === `0 of ${fmt(x.n)} values parsed · ${fmt(x.n)} failed`, JSON.stringify(parse));
    ok('prepare/parse: the first distinct failures are listed, in stored order',
      parse[1] === 'Did not parse: ' + x.firstDates.map((d) => `"${d}"`).join(', '), JSON.stringify(parse));
    ok('prepare/parse: Cancel adds nothing', await clickEditor(win, 'Cancel') && (await stepList(win)).length === before.steps.length);

    // ── Split column ────────────────────────────────────────────────────────
    ok('prepare/split: the Split column form opens', await addStep(win, 'Split column'));
    ok('prepare/split: order_date on "-" into 3 columns', await setField(win, 'Column', 'order_date') &&
      await setField(win, 'Split by', 'delimiter') && await setField(win, 'Delimiter', '-') &&
      await setField(win, 'Into', 'columns') && await setField(win, 'How many columns', '3'));
    ok('prepare/split: saved', await clickEditor(win, 'Save step'));

    // ── Lookup: keys from the relationship, the matched rate before saving ───
    ok('prepare/lookup: the Look up form opens', await addStep(win, 'Look up from another dataset'));
    const picked = await win.evaluate(async (name: string) => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        const sel = document.querySelector('#ds-step-editor .pp-dataset') as HTMLSelectElement | null;
        const opt = sel && [...sel.options].find((o) => o.textContent === name);
        if (sel && opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        await pause(250);
      }
      return false;
    }, HELPER);
    ok('prepare/lookup: the other dataset is offered and picked', picked);
    const rate = await previewLines(win);
    const note = await win.evaluate(() =>
      [...document.querySelectorAll('#ds-step-editor .ds-step-hint')].map((h) => h.textContent || '').join(' | '));
    ok('prepare/lookup: the keys were prefilled from the relationship',
      await fieldValue(win, 'Key in this dataset') === 'region' && await fieldValue(win, 'Matching key') === 'region' &&
      note.includes('Keys taken from the relationship'), note);
    ok('prepare/lookup: the matched rate is the one the CSV implies',
      rate[0] === `${fmt(x.matched)} of ${fmt(x.n)} rows matched · ${x.ratePct}%`, JSON.stringify(rate));
    ok('prepare/lookup: the repeated key is called out', /1 key value\(s\) repeat/.test(rate.join(' ')), JSON.stringify(rate));
    ok('prepare/lookup: saved', await clickEditor(win, 'Save step'));

    // ── Replace values ──────────────────────────────────────────────────────
    ok('prepare/replace: the Replace values form opens', await addStep(win, 'Replace values'));
    const ruled = await win.evaluate(() => {
      const from = document.querySelector('#ds-step-editor .pp-pair .pp-from') as HTMLInputElement | null;
      const to = document.querySelector('#ds-step-editor .pp-pair .pp-to') as HTMLInputElement | null;
      if (!from || !to) return false;
      from.value = 'Consumer';
      to.value = 'Retail consumer';
      return true;
    });
    ok('prepare/replace: customer_segment, exact, Consumer → Retail consumer',
      ruled && await setField(win, 'Column', 'customer_segment') && await setField(win, 'Match', 'exact'));
    ok('prepare/replace: saved', await clickEditor(win, 'Save step'));

    // ── The step list, the warning, the result ──────────────────────────────
    await win.waitForTimeout(1000);
    const list = await stepList(win);
    const mine = list.slice(before.steps.length);
    ok('prepare: the three steps are in the list, in order', mine.length === 3 &&
      /^Split order_date on "-" into 3 columns$/.test(mine[0].summary) &&
      mine[1].summary.startsWith('Look up manager by region = region') && mine[1].summary.includes(HELPER) &&
      mine[2].summary === 'Replace in customer_segment (exact): 1 rule', JSON.stringify(list));
    ok('prepare: every step shows its rows before → after',
      list.length > 0 && list.every((r) => r.count === `${fmt(x.n)} → ${fmt(x.n)} rows`), JSON.stringify(list));
    const warnings = await win.evaluate(() =>
      [...document.querySelectorAll('#ds-prepare-warnings .ds-warning')].map((w) => w.textContent || ''));
    ok('prepare: the lookup\'s repeated key is a pipeline warning', warnings.includes(
      'Lookup: 1 key value(s) repeat in "region" of the other dataset; the first match in stored order was used'), JSON.stringify(warnings));

    const result = await win.evaluate(async (a: { pid: string; did: string }) => {
      const ds = await (window as any).hub.getDataset(a.pid, a.did);
      const at = (n: string): number => ds.columns.findIndex((c: any) => c.name === n);
      const seg = at('customer_segment');
      const east = ds.rows.find((r: any[]) => r[at('region')] === 'East');
      const ne = ds.rows.find((r: any[]) => r[at('region')] === 'Northeast');
      return {
        columns: ds.columns.map((c: any) => c.name + ':' + c.type),
        retail: ds.rows.filter((r: any[]) => r[seg] === 'Retail consumer').length,
        consumer: ds.rows.filter((r: any[]) => r[seg] === 'Consumer').length,
        eastManager: east ? east[at('manager')] : undefined,
        northeastManager: ne ? ne[at('manager')] : undefined,
        rowCount: ds.rowCount,
      };
    }, { pid, did });
    ok('prepare/split: order_date became three typed parts, in place',
      !result.columns.some((c: string) => c.startsWith('order_date:')) &&
      result.columns.includes(`order_date_1:${x.yearIsNumber ? 'number' : 'text'}`) &&
      result.columns.includes('order_date_2:text') && result.columns.includes('order_date_3:text'), JSON.stringify(result.columns));
    ok('prepare/lookup: the first East row found its FIRST manager, Northeast found none',
      result.eastManager === 'Avery' && result.northeastManager === null, JSON.stringify(result));
    ok('prepare/replace: every Consumer became Retail consumer', result.retail === x.consumer && result.consumer === 0,
      JSON.stringify({ retail: result.retail, expected: x.consumer }));
    ok('prepare: no row was lost or added', result.rowCount === x.n);
    await win.screenshot({ path: path.join(s.shotDir, 'pw-prepare-steps.png') });
  } finally {
    // Leave the sample exactly as it was for whatever runs next.
    const restored = await win.evaluate(async (a: { pid: string; did: string; steps: any[]; helperId: string; relId: string }) => {
      const w = window as any;
      const res = await w.hub.setDatasetSteps(a.pid, a.did, a.steps);
      if (a.relId) await w.hubAuthoring.deleteRelationship(a.pid, a.relId);
      if (a.helperId) await w.hub.deleteDataset(a.pid, a.helperId);
      w.applyStepResult(res);
      return res && res.dataset ? res.dataset.columns.map((c: any) => c.name) : [];
    }, { pid, did, steps: before.steps, helperId: setup.helperId, relId: setup.relId });
    ok('prepare: the sample\'s pipeline is restored', JSON.stringify(restored) === JSON.stringify(before.columns), JSON.stringify(restored));
  }

  const errors = s.errors.slice(errorsBefore);
  ok('prepare: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
}
