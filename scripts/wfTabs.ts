// Tabs and windows, end to end — ONE section of the assembled workflow smoke.
//
// Exported, not run: the runner launches the app on a fresh userData, where
// main has seeded the SAMPLE project on first launch ("My project": dataset
// "Retail orders", dashboard "Retail overview", visual "Revenue by month"…),
// and calls tabsSection(s). The sample must be the project Home adopts at
// launch (the newest), because the reload step asserts the LAUNCH restore.
//
// What it drives, in order, all through the real renderer:
//   three records opened from their lists → three tabs · ⌘⇧] / ⌘⇧[ cycle ·
//   × closes one → two · reload → the same two, the same one active and on
//   screen · ⌘\ → dashboard and dataset side by side with a divider · ⌘\ →
//   one pane again · the tab menu's "Open in new window" → a second window on
//   the dashboard, with its own strip · closing it leaves the first intact ·
//   no renderer console error in either window.
//
// The pure bookkeeping (where a tab lands, what focus falls to, restore with
// deleted records) is scripts/test-tabModel.ts; this is only what paints.

import type { Smoke } from './smokeFixture';

const path: typeof import('path') = require('path');
import { reloadSmoke } from './smokeFixture';
import { ok } from './selfcheck';

type Win = Smoke['win'];

// Renderer lexical globals: a top-level let/const in a classic script is not a
// window property, but a bare name inside win.evaluate reaches it.
declare const currentSection: string;
declare const currentProjectId: string | null;
declare const tabState: {
  tabs: { kind: string; id: string; name: string }[];
  active: string | null;
  split: { left: string; right: string; ratio: number } | null;
};

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

interface StripView { keys: string[]; names: string[]; active: string | null; shown: boolean; height: number }

function readStrip(win: Win): Promise<StripView> {
  return win.evaluate(() => {
    const el = document.getElementById('tab-strip');
    const items = Array.from(document.querySelectorAll('#tab-strip .tab-item')) as HTMLElement[];
    const on = items.find((i) => i.classList.contains('is-active'));
    return {
      keys: items.map((i) => i.dataset.key || ''),
      names: items.map((i) => (i.querySelector('.tab-name')?.textContent || '').trim()),
      active: on ? on.dataset.key || null : null,
      shown: !!el && !el.hidden,
      height: el ? Math.round(el.getBoundingClientRect().height) : 0,
    };
  });
}

/** Wait for a page condition; false on timeout rather than a throw, so the check reports. */
// ponytail: `any` — Playwright's PageFunction<Arg> cannot take a generic Arg
// (it unboxes it); each call site's predicate is concretely typed.
async function until(win: Win, fn: (a: any) => boolean, arg: unknown, ms = 15_000): Promise<boolean> {
  try {
    await win.waitForFunction(fn, arg, { timeout: ms, polling: 150 });
    return true;
  } catch (_) {
    return false;
  }
}

/** Is a panel / page element actually laid out (not hidden, with a width)? */
function shownWidth(win: Win, id: string): Promise<number> {
  return win.evaluate((i: string) => {
    const el = document.getElementById(i);
    if (!el || el.closest('[hidden]')) return 0;
    return Math.round(el.getBoundingClientRect().width);
  }, id);
}

export async function tabsSection(s: Smoke): Promise<void> {
  const { app, win } = s;
  const errorsBefore = s.errors.length;
  const errors2: string[] = [];

  // ── The sample's records, by name, straight from main ──────────────────────
  const ids: { pid: string; ds: string; viz: string; dash: string } = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    const list = await projects.listProjects();
    const p = list.find((x: any) => x.name === 'My project') || list[0];
    if (!p) return { pid: '', ds: '', viz: '', dash: '' };
    const d = (await datasets.listDatasets(p.id)).find((x: any) => x.name === 'Retail orders');
    const v = (await visuals.listVisuals(p.id)).find((x: any) => x.name === 'Revenue by month');
    const a = (await analysis.listAnalyses(p.id)).find((x: any) => x.name === 'Retail overview');
    return { pid: p.id, ds: d ? d.id : '', viz: v ? v.id : '', dash: a ? a.id : '' };
  });
  ok('tabs: the sample project and its three records are there',
    !!(ids.pid && ids.ds && ids.viz && ids.dash), JSON.stringify(ids));
  const K = { ds: 'dataset:' + ids.ds, viz: 'visual:' + ids.viz, dash: 'analysis:' + ids.dash };

  // A clean slate: whatever an earlier section left open is closed, and the
  // sample project is the one in hand.
  await win.evaluate(async (pid: string) => {
    const w = window as any;
    await w.cmdGoto('home');
    if (currentProjectId !== pid) await w.openWorkspace(pid);
    for (const t of tabState.tabs.slice()) await w.tabCloseKey(w.tabKey(t.kind, t.id));
    w.selectSection('home');
  }, ids.pid);
  await win.waitForTimeout(800);
  const empty = await readStrip(win);
  ok('tabs: with nothing open there is no strip, and it takes no height',
    !empty.shown && empty.height === 0 && empty.keys.length === 0, JSON.stringify(empty));

  // ── Three records, opened from their lists the way a user does ────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  ok('tabs: the dataset row is on the Data list', await until(win, (id: string) =>
    !!document.querySelector(`#ds-saved-list [data-rec-id="${id}"] .ds-saved-open`), ids.ds));
  await win.evaluate((id: string) => {
    (document.querySelector(`#ds-saved-list [data-rec-id="${id}"] .ds-saved-open`) as HTMLElement | null)?.click();
  }, ids.ds);
  ok('tabs: opening a dataset gives it a tab, lit', await until(win, (k: string) =>
    tabState.active === k && !!document.querySelector(`#tab-strip .tab-item.is-active[data-key="${k}"]`), K.ds));

  await win.evaluate(() => { (window as any).selectSection('visuals'); });
  ok('tabs: the visual card is in the gallery', await until(win, (id: string) =>
    !!document.querySelector(`#viz-grid [data-rec-id="${id}"] .viz-card-body`), ids.viz));
  const back = await readStrip(win);
  ok('tabs: going back to a list keeps the tab but lights none', back.keys.length === 1 && back.active === null,
    JSON.stringify(back));
  await win.evaluate((id: string) => {
    (document.querySelector(`#viz-grid [data-rec-id="${id}"] .viz-card-body`) as HTMLElement | null)?.click();
  }, ids.viz);
  ok('tabs: opening a visual adds a second tab', await until(win, (k: string) => tabState.active === k, K.viz));

  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  ok('tabs: the dashboard card is on the Dashboards list', await until(win, (id: string) =>
    !!document.querySelector(`#an-list [data-rec-id="${id}"] .an-card-body`), ids.dash));
  await win.evaluate((id: string) => {
    (document.querySelector(`#an-list [data-rec-id="${id}"] .an-card-body`) as HTMLElement | null)?.click();
  }, ids.dash);
  ok('tabs: opening the dashboard adds a third', await until(win, (k: string) => tabState.active === k, K.dash));
  await win.waitForTimeout(600);
  let st = await readStrip(win);
  ok('tabs: three tabs, in open order, the dashboard active',
    st.keys.join() === [K.ds, K.viz, K.dash].join() && st.active === K.dash, JSON.stringify(st));
  ok('tabs: each tab carries its record\'s name',
    st.names.join('|') === 'Retail orders|Revenue by month|Retail overview', st.names.join('|'));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-5-tabs.png') });
  ok('tabs: the strip sits between the top bar and the content', await win.evaluate(() => {
    const bar = document.querySelector('.hub-topbar')!.getBoundingClientRect();
    const strip = document.getElementById('tab-strip')!.getBoundingClientRect();
    const body = document.querySelector('.hub-body')!.getBoundingClientRect();
    return Math.round(strip.top) === Math.round(bar.bottom) && Math.round(body.top) >= Math.round(strip.bottom)
      && strip.height >= 30;
  }));

  // ── ⌘⇧] / ⌘⇧[ ──────────────────────────────────────────────────────────────
  await win.keyboard.press(MOD + '+Shift+BracketRight');
  ok('tabs: ⌘⇧] wraps from the last tab to the first — the dataset, on screen',
    await until(win, (k: string) => tabState.active === k && currentSection === 'datasets'
      && !document.getElementById('ds-explorer')!.hidden, K.ds));
  ok('tabs: …and leaving the dashboard left focus mode (the sidebar is back)',
    await until(win, () => !document.body.classList.contains('an-focus'), null));
  await win.keyboard.press(MOD + '+Shift+BracketLeft');
  ok('tabs: ⌘⇧[ wraps back to the dashboard, open in its editor',
    await until(win, (k: string) => tabState.active === k && currentSection === 'analyses'
      && !document.getElementById('dash-editor')!.hidden, K.dash));

  // ── × closes one ────────────────────────────────────────────────────────────
  await win.evaluate((k: string) => {
    (document.querySelector(`#tab-strip .tab-item[data-key="${k}"] .tab-close`) as HTMLElement | null)?.click();
  }, K.viz);
  ok('tabs: × on an inactive tab closes it — two left, the active one untouched',
    await until(win, (a: string[]) => tabState.tabs.length === 2 && tabState.active === a[1]
      && !tabState.tabs.some((t) => t.kind + ':' + t.id === a[0]), [K.viz, K.dash]));

  // ── Reload: the set and the active tab come back ────────────────────────────
  await reloadSmoke(s);
  ok('tabs: after a reload the same two tabs restore, the dashboard active and on screen',
    await until(win, (k: string) => tabState.active === k && !!document.querySelector('#tab-strip .tab-item.is-active')
      && !document.getElementById('dash-editor')!.hidden, K.dash, 20_000));
  st = await readStrip(win);
  ok('tabs: …in the same order', st.keys.join() === [K.ds, K.dash].join(), JSON.stringify(st));

  // ── ⌘\ split, ⌘\ unsplit ────────────────────────────────────────────────────
  await win.keyboard.press(MOD + '+Backslash');
  ok('tabs: ⌘\\ splits the dashboard and the dataset side by side', await until(win, () =>
    !!tabState.split && document.querySelector('.hub-body')!.classList.contains('tab-split')
    && !document.getElementById('ds-explorer')!.hidden && !document.getElementById('dash-editor')!.hidden, null));
  await win.waitForTimeout(500);
  const wA = await shownWidth(win, 'ws-analyses');
  const wD = await shownWidth(win, 'ws-datasets');
  const wDiv = await shownWidth(win, 'tab-divider');
  ok('tabs: both panes are laid out with real width, a divider between them',
    wA > 150 && wD > 150 && wDiv > 0, JSON.stringify({ wA, wD, wDiv }));
  ok('tabs: the dashboard is on the left, the dataset on the right, with focus', await win.evaluate((k: string[]) => {
    const a = document.getElementById('ws-analyses')!.getBoundingClientRect();
    const d = document.getElementById('ws-datasets')!.getBoundingClientRect();
    return a.right <= d.left + 1 && tabState.split!.left === k[0] && tabState.split!.right === k[1]
      && tabState.active === k[1] && currentSection === 'datasets';
  }, [K.dash, K.ds]));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-5-split.png') });
  // The divider is keyboard-operable: → widens the left pane by 5%.
  await win.focus('#tab-divider');
  await win.keyboard.press('ArrowRight');
  ok('tabs: the divider moves from the keyboard', await until(win, () =>
    !!tabState.split && Math.abs(tabState.split.ratio - 0.55) < 0.001, null));
  // A click in the other pane moves focus there WITHOUT tearing the split down.
  await win.evaluate(() => {
    const t = document.querySelector('#ws-analyses .dash-editor-head, #ws-analyses') as HTMLElement;
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
  });
  ok('tabs: pointing at the other pane focuses it and the split survives', await until(win, (k: string) =>
    !!tabState.split && tabState.active === k && currentSection === 'analyses'
    && !document.getElementById('ds-explorer')!.hidden, K.dash));

  await win.keyboard.press(MOD + '+Backslash');
  ok('tabs: ⌘\\ again unsplits to the focused pane alone', await until(win, () =>
    !tabState.split && !document.querySelector('.hub-body')!.classList.contains('tab-split')
    && document.getElementById('tab-divider')!.hidden && document.getElementById('ws-datasets')!.hidden
    && !document.getElementById('ws-analyses')!.hidden, null));
  ok('tabs: …and both tabs are still there', (await readStrip(win)).keys.length === 2);

  // ── Open in new window ──────────────────────────────────────────────────────
  await win.click(`#tab-strip .tab-item[data-key="${K.dash}"]`, { button: 'right' });
  const menuRow = await until(win, () => Array.from(document.querySelectorAll('.tab-menu button'))
    .some((b) => (b.textContent || '').includes('Open in new window')), null, 5000);
  ok('tabs: a tab\'s menu offers "Open in new window"', menuRow);
  const popup = app.waitForEvent('window', { timeout: 30_000 }).catch(() => null);
  await win.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.tab-menu button'))
      .find((x) => (x.textContent || '').includes('Open in new window')) as HTMLElement | undefined;
    b?.click();
  });
  const win2 = await popup;
  ok('tabs: a second window opens', !!win2);
  if (win2) {
    win2.on('pageerror', (e) => errors2.push('pageerror: ' + e.message));
    win2.on('console', (m) => { if (m.type() === 'error') errors2.push('console: ' + m.text()); });
    await win2.waitForLoadState('domcontentloaded');
    ok('tabs: …making two BrowserWindows', app.windows().length === 2, String(app.windows().length));
    ok('tabs: the new window boots straight into the dashboard, in its own strip', await until(win2, (k: string) =>
      tabState.tabs.length === 1 && tabState.active === k && !document.getElementById('dash-editor')!.hidden
      && (document.querySelector('#tab-strip .tab-item.is-active .tab-name')?.textContent || '').includes('Retail overview'),
    K.dash, 30_000));
    ok('tabs: …with the Assistant available there too', await win2.evaluate(() =>
      !(document.getElementById('side-ai-btn') as HTMLButtonElement).disabled));
    await win2.screenshot({ path: path.join(s.shotDir, 'wf-5-window.png') });
    ok('tabs: the tab MOVED — the first window no longer has it', await until(win, (k: string) =>
      tabState.tabs.length === 1 && !tabState.tabs.some((t) => t.kind + ':' + t.id === k), K.dash));

    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('secondary=1'));
      if (w) w.close();
    });
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      await win.waitForTimeout(250);
      closed = app.windows().length === 1;
    }
    ok('tabs: closing the second window leaves exactly the first', closed, String(app.windows().length));
    ok('tabs: …which still works', await win.evaluate(() => {
      (window as any).selectSection('datasets');
      return currentSection === 'datasets' && !document.getElementById('ws-datasets')!.hidden;
    }));
  }

  const mine = s.errors.slice(errorsBefore).concat(errors2);
  ok('tabs: no renderer console errors in either window', mine.length === 0, mine.join('\n'));

  // Leave the next section a clean window: no tabs, on Home.
  await win.evaluate(async () => {
    const w = window as any;
    for (const t of tabState.tabs.slice()) await w.tabCloseKey(w.tabKey(t.kind, t.id));
    await w.cmdGoto('home');
  });
}
