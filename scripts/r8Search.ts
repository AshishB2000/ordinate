// Round 8 smoke SECTION: search inside the data, driven through the REAL app.
// Not a standalone smoke — scripts/smoke-round8.ts calls searchSection(s, fx).
//
//   the save wrote a value index beside each Parquet → ⌘K "region3" shows a
//   Data group: value · Sales / region · its row count (main's figure, checked
//   against main) → "Open filtered" lands on the grid filtered to region =
//   region3, its total equal to that count, with a banner that clears →
//   "Profile the column" opens the profile on region → on a dashboard reading
//   Sales, the hit offers "Filter this dashboard" and applying it adds the
//   selection step; a hit in a dataset the dashboard does not read does not
//   offer it → → opens the actions as a list, ← / Escape step back → a column
//   marked personal is not searched under the default share policy, and is
//   under `include` → the top bar's search opens the same box.
// Leaves the project's Data list on screen, the palette closed, and deletes the
// dashboard it made; the catalog mark and the policy are restored.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `let`s, read by bare name inside evaluate — not on window.
declare let expTotal: number;
declare let expId: string;
declare let dsProfileCol: number;
declare let dashSel: any[];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

interface PaletteRow { group: string; title: string; meta: string; count: string; acts: string[] }

/** What ⌘K shows, row by row, with the group each row sits under. */
const paletteRows = (win: Win): Promise<PaletteRow[]> => win.evaluate(() => {
  const out: Array<{ group: string; title: string; meta: string; count: string; acts: string[] }> = [];
  let group = '';
  for (const el of Array.from(document.querySelectorAll('#cp-results > *'))) {
    if (el.classList.contains('cp-group')) { group = (el.textContent || '').trim(); continue; }
    if (!el.classList.contains('cp-row')) continue;
    out.push({
      group,
      title: (el.querySelector('.cp-row-title')?.textContent || '').trim(),
      meta: (el.querySelector('.cp-row-meta')?.textContent || '').trim(),
      count: (el.querySelector('.cp-row-count')?.textContent || '').trim(),
      acts: Array.from(el.querySelectorAll('.cp-row-act')).map((b) => b.getAttribute('aria-label') || ''),
    });
  }
  return out;
});

const dataRows = async (win: Win): Promise<PaletteRow[]> => (await paletteRows(win)).filter((r) => r.group.startsWith('Data'));

/** Open ⌘K on `term` and wait for its Data group. */
async function search(win: Win, term: string): Promise<PaletteRow[]> {
  await win.evaluate((t: string) => { (window as any).paletteClose(); (window as any).paletteOpen(t); }, term);
  await until(win, async () => (await dataRows(win)).length > 0, 10_000);
  return dataRows(win);
}

/** Press a row's action button (mousedown, as the palette listens for). */
const pressAction = (win: Win, title: string, label: string): Promise<boolean> => win.evaluate((a: { t: string; l: string }) => {
  const row = Array.from(document.querySelectorAll('#cp-results .cp-row'))
    .find((r) => (r.querySelector('.cp-row-title')?.textContent || '').trim() === a.t);
  const btn = row && Array.from(row.querySelectorAll('.cp-row-act')).find((b) => b.getAttribute('aria-label') === a.l);
  if (!btn) return false;
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
}, { t: title, l: label });

export async function searchSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, ...args: unknown[]): Promise<T> => app.evaluate(async (_e, a: { fn: string; args: unknown[] }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const mods: Record<string, any> = {
      count: { run: async (p: string, d: string, col: string, v: string) => {
        const ds = await req('./src/data/datasets.js').getDataset(p, d);
        const ci = ds.columns.findIndex((c: any) => c.name === col);
        return ds.rows.filter((r: any[]) => r[ci] === v).length;
      } },
      indexed: { run: async (p: string, d: string) => {
        const rec = req('./src/data/datasetRecord.js');
        const idx = await req('./src/engine/dataSearchResident.js').readIndex(rec.parquetPath(p, d));
        return !!idx;
      } },
      mark: { run: (p: string, d: string, col: string, level: string) => req('./src/app/catalog.js').setColumn(p, d, col, { sensitivity: level }) },
      policy: { run: (p: string, patch: unknown) => req('./src/app/privacyStore.js').setPolicy(p, patch) },
      getPolicy: { run: (p: string) => req('./src/app/privacyStore.js').getPolicy(p) },
      dropAnalysis: { run: (p: string, id: string) => req('./src/analysis/analysis.js').deleteAnalysis(p, id) },
    };
    return mods[a.fn].run(...a.args);
  }, { fn, args });

  await openProject(win, pid);

  // ── The index the save wrote ────────────────────────────────────────────
  ok('search: the save wrote a value index beside the Parquet',
    await until(win, () => main<boolean>('indexed', pid, fx.datasetId), 10_000));

  // ── ⌘K: the Data group ──────────────────────────────────────────────────
  const truth = await main<number>('count', pid, fx.datasetId, 'region', 'region3');
  const rows = await search(win, 'region3');
  const hit = rows.find((r) => r.title === 'region3');
  ok('search: ⌘K shows a Data group with the value', !!hit, JSON.stringify(await paletteRows(win)));
  ok('search: the row names dataset / column', !!hit && hit.meta === 'Sales / region', hit && hit.meta);
  ok('search: the row count is main\'s count of rows holding it',
    !!hit && hit.count === `${truth.toLocaleString()} rows`, `${hit && hit.count} vs ${truth}`);
  ok('search: off a dashboard, Open filtered and Profile are offered (no dashboard filter)',
    !!hit && hit.acts.join('|') === 'Open filtered to it|Profile the column', hit && hit.acts.join('|'));
  await shot('r8-search-palette.png');

  const ranked = await search(win, 'california');
  ok('search: another dataset\'s text column is searched too', ranked.some((r) => r.title === 'California' && r.meta === 'By state / state'),
    JSON.stringify(ranked));
  ok('search: a number column is never searched', !(await search(win, '-10')).some((r) => r.meta.endsWith('/ amount')));

  // ── Keyboard: → lists the actions, ← steps back ─────────────────────────
  await search(win, 'region3');
  await win.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#cp-results .cp-row'));
    const i = rows.findIndex((r) => (r.querySelector('.cp-row-title')?.textContent || '').trim() === 'region3');
    for (let k = 0; k < i; k++) document.getElementById('cp-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await win.evaluate(() => {
    // → acts only with the caret at the end — paletteOpen selects what it prefilled.
    const input = document.getElementById('cp-input') as HTMLInputElement;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  const listed = await paletteRows(win);
  ok('search: → lists the hit\'s actions under its value', listed.length === 2 && listed[0].group === 'region3'
    && listed[0].title === 'Open filtered to it', JSON.stringify(listed));
  await win.evaluate(() => {
    const input = document.getElementById('cp-input') as HTMLInputElement;
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
  ok('search: ← steps back to the results', await until(win, async () => (await dataRows(win)).length > 0, 5000));

  // ── Open filtered ───────────────────────────────────────────────────────
  ok('search: Open filtered to it', await pressAction(win, 'region3', 'Open filtered to it'));
  ok('search: the grid opens on Sales, filtered — its total IS the count',
    await until(win, () => win.evaluate((a: { id: string; n: number }) => expId === a.id && expTotal === a.n, { id: fx.datasetId, n: truth })),
    await win.evaluate(() => `${expId} ${expTotal}`));
  const banner = await win.evaluate(() => {
    const b = document.getElementById('dsr-banner');
    return b && !b.hidden ? (b.textContent || '').trim() : '';
  });
  ok('search: the banner says what the grid shows', banner.startsWith(`Showing ${truth.toLocaleString()} rows where region is region3`), banner);
  ok('search: the palette closed', await win.evaluate(() => !(window as any).paletteIsOpen()));
  await shot('r8-search-filtered.png');
  await win.evaluate(() => (document.querySelector('#dsr-banner .dq-banner-clear') as HTMLElement).click());
  ok('search: Clear restores every row and hides the banner',
    await until(win, () => win.evaluate((n: number) => expTotal === n && document.getElementById('dsr-banner')!.hidden === true, fx.rowCount)));

  // ── Profile ─────────────────────────────────────────────────────────────
  await search(win, 'region3');
  ok('search: Profile the column', await pressAction(win, 'region3', 'Profile the column'));
  ok('search: the profile opens on region', await until(win, () => win.evaluate(() =>
    dsProfileCol === 0 && !(document.getElementById('ds-profile') as HTMLElement).hidden)));

  // ── A dashboard: Filter is offered only where the dashboard reads the dataset ──
  const aid = await seedAnalysis(app, pid, { name: 'Search board', sheets: [{ name: 'Sheet 1', cards: [
    { type: 'visual', visualId: fx.visualId, layout: { x: 0, y: 0, w: 6, h: 6 } },
  ] }] });
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(800);
  ok('search: the dashboard opens', await openSeededAnalysis(win, 'Search board'));
  const onDash = (await search(win, 'region3')).find((r) => r.title === 'region3');
  ok('search: on a dashboard reading Sales, the hit offers Filter this dashboard',
    !!onDash && onDash.acts.includes('Filter this dashboard'), onDash && onDash.acts.join('|'));
  const offDash = (await search(win, 'california')).find((r) => r.title === 'California');
  ok('search: a hit in a dataset the dashboard does not read does not',
    !!offDash && !offDash.acts.includes('Filter this dashboard'), offDash && offDash.acts.join('|'));
  await search(win, 'region3');
  ok('search: Filter this dashboard', await pressAction(win, 'region3', 'Filter this dashboard'));
  ok('search: the dashboard carries region = region3 as a selection', await until(win, () => win.evaluate(() =>
    dashSel.some((st: any) => st.column === 'region' && st.op === '=' && st.value === 'region3'))));
  await shot('r8-search-dashboard.png');
  await win.evaluate(() => { dashSel = []; (window as any).renderDashSelStrip(); });
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(600);
  ok('search: the dashboard it made is deleted', await main<boolean>('dropAnalysis', pid, aid));

  // ── Sensitive columns ───────────────────────────────────────────────────
  const policy0 = await main<any>('getPolicy', pid);
  await main('mark', pid, fx.geoDatasetId, 'state', 'personal');
  await win.evaluate(() => { (window as any).paletteClose(); (window as any).paletteOpen('california'); });
  await win.waitForTimeout(1500);
  ok('search: a column marked personal is not searched under the default policy',
    !(await dataRows(win)).some((r) => r.title === 'California'), JSON.stringify(await paletteRows(win)));
  await main('policy', pid, { export: 'include' });
  ok('search: …and is, once the share policy includes it', (await search(win, 'california')).some((r) => r.title === 'California'));
  await main('policy', pid, policy0);
  await main('mark', pid, fx.geoDatasetId, 'state', 'none');

  // ── A newer query cancels an older one; the newest always answers ──────
  const pair = await win.evaluate(async (p: string) => {
    const a = (window as any).hubDataSearch.query(p, 'regi', '');
    const b = (window as any).hubDataSearch.query(p, 'region5', '');
    return Promise.all([a, b]);
  }, pid);
  ok('search: the newest query answers', pair[1].ok === true && pair[1].hits.some((h: any) => h.value === 'region5'), JSON.stringify(pair[1]));
  ok('search: the older one either finished or says it was cancelled', pair[0].ok === true || pair[0].cancelled === true);

  // ── The top bar's search is the same box ────────────────────────────────
  await win.evaluate(() => { (window as any).paletteClose(); });
  await win.evaluate(() => (document.getElementById('global-search') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  ok('search: the top bar opens the palette', await until(win, () => win.evaluate(() => (window as any).paletteIsOpen()), 3000));

  // ── Neutral ─────────────────────────────────────────────────────────────
  await win.evaluate(() => { (window as any).paletteClose(); (window as any).selectSection('datasets'); });
  await win.waitForTimeout(500);
  const errs = s.errors.slice(errors0);
  ok('search: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
