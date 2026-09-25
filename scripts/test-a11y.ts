// ACCESSIBILITY, enforced — the real app, on the sample project, with no
// dependency beyond the Playwright every smoke already drives.
//
// On every surface:
//   • no interactive element without a name (label, aria-label, or visible
//     text; a placeholder is NOT a name) — fail on any;
//   • Tab visits the surface's controls in DOM order — no positive tabindex,
//     no focus hijack, nothing tabbable that the DOM says comes later;
//   • every visible text node meets WCAG AA contrast against its computed
//     background (4.5:1, or 3:1 for large text), in the light and dark
//     themes and on the sample dashboard in every style preset.
// On every modal: focus lands inside, Tab and Shift+Tab never leave it, and
// Escape closes it and gives focus back to what opened it.
// And `?` lists every registered command.
//
// It is a SMOKE (it launches Electron), run by run-smokes.js. `npm test` globs
// scripts/test-*.js, so under `node --test` it steps aside.
//
//   npm run build && node scripts/test-a11y.js

import { ok, failureCount } from './selfcheck';
import { launchSmoke, finishSmoke, openProject, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

// Renderer globals the page functions below reach by name (script-level bindings).
declare let dashCurrent: any;
declare const DASH_STYLE_PRESETS: Record<string, any>;
declare function syncDashStyle(): void;
declare function renderDashGrid(): void;

// The in-page half: installed once per page load as window.__a11y.
const HELPERS = `(() => {
  // Rendered and reachable. Opacity does NOT count: a control faded to 0 until
  // its card is hovered is still tabbable, still announced, still needs a name.
  const vis = (el) => {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"], template')) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  // Seen: for contrast, text a reader cannot see yet is not judged.
  const seen = (el) => {
    for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 0.02) return false;
    return vis(el);
  };
  const text = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\\s+/g, ' ').trim();
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map((id) => text(document.getElementById(id))).join(' ').trim(); if (t) return t; }
    const al = (el.getAttribute('aria-label') || '').trim();
    if (al) return al;
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && text(l)) return text(l); }
    const wrap = el.closest('label');
    if (wrap && text(wrap)) return text(wrap);
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type)) return (el.value || '').trim();
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const t = text(el);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img && img.alt.trim()) return img.alt.trim();
    }
    return (el.getAttribute('title') || '').trim();
  };
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=option], [role=checkbox], [role=radio], [role=switch], [role=combobox], [contenteditable=true], [tabindex]:not([tabindex="-1"])';
  const where = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''));
    }
    return parts.join(' > ');
  };
  const scope = (sel) => (sel ? document.querySelector(sel) : document.body) || document.body;
  function unnamed(sel) {
    return [...scope(sel).querySelectorAll(INTERACTIVE)].filter(vis).filter((el) => !name(el)).map(where);
  }
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=true]';
  function tabbables(sel) {
    return [...scope(sel).querySelectorAll(FOCUSABLE)].filter(vis).filter((el) => el.tabIndex >= 0);
  }
  // WCAG 2.x relative luminance and contrast.
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  // The background a text node actually sits on: composite translucent layers
  // down to the first opaque one. An image or a canvas under it: unknown → skip.
  function backdrop(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const b = parse(s.backgroundColor);
      if (b && b[3] > 0) { layers.push(b); if (b[3] >= 0.999) break; }
      if (e.matches('.maplibregl-map, canvas')) return null;
    }
    let c = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) c = over(layers[i], c);
    return c;
  }
  function contrast(sel) {
    const out = [];
    const walker = document.createTreeWalker(scope(sel), NodeFilter.SHOW_TEXT);
    const judged = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || judged.has(el) || !n.textContent.trim()) continue;
      judged.add(el);
      if (!seen(el) || el.closest('svg, canvas, option, [disabled], .sr-only, .maplibregl-ctrl-attrib')) continue;
      // An unavailable control is exempt (WCAG 1.4.3): it is not information.
      if (el.closest('[aria-disabled="true"], button:disabled')) continue;
      const s = getComputedStyle(el);
      const fg = parse(s.color);
      const bg = backdrop(el);
      if (!fg || !bg) continue;
      let op = 1;
      for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const col = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const L1 = lum(col), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio + 0.005 < need) out.push(where(el) + ' "' + n.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(2) + ':1 < ' + need);
    }
    return out;
  }
  function topModal() {
    const open = [...document.querySelectorAll('[aria-modal="true"], .ws-modal-overlay')].filter(vis);
    const t = open[open.length - 1];
    return t ? (t.matches('.ws-modal-overlay') ? (t.querySelector('[role=dialog], .ws-modal') || t) : t) : null;
  }
  window.__a11y = { unnamed, tabbables, contrast, topModal, where, name };
})()`;

type Win = Awaited<ReturnType<typeof launchSmoke>>['win'];

async function install(win: Win): Promise<void> {
  await win.evaluate(HELPERS);
}

async function settle(win: Win, ms = 900): Promise<void> {
  await win.waitForTimeout(ms);
}

/** Tab through `scope` from its first control; the path must be the DOM order. */
async function focusOrder(win: Win, scope: string | null, max = 40): Promise<{ ok: boolean; detail: string }> {
  const n = await win.evaluate(({ scope }) => {
    const list = (window as any).__a11y.tabbables(scope);
    (window as any).__a11yList = list;
    if (list[0]) list[0].focus();
    return list.length;
  }, { scope });
  const steps = Math.min(n - 1, max);
  for (let i = 1; i <= steps; i++) {
    // An editor where Tab indents must offer the documented way out (Escape,
    // then Tab) — the walk takes it, and so proves it exists.
    if (await win.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.tabIndents === '1')) {
      await win.keyboard.press('Escape');
    }
    await win.keyboard.press('Tab');
    const r = await win.evaluate((i: number) => {
      const list = (window as any).__a11yList as HTMLElement[];
      const a = document.activeElement as HTMLElement;
      return a === list[i] ? '' : `step ${i}: expected ${(window as any).__a11y.where(list[i])}, got ${a ? (window as any).__a11y.where(a) : 'nothing'}`;
    }, i);
    if (r) return { ok: false, detail: r };
  }
  return { ok: true, detail: `${steps} steps` };
}

async function check(win: Win, label: string, scope: string | null, opts: { order?: boolean; contrast?: boolean } = {}): Promise<void> {
  await install(win);
  const unnamed: string[] = await win.evaluate((s) => (window as any).__a11y.unnamed(s), scope);
  ok(`${label}: every interactive element has a name`, unnamed.length === 0, unnamed.slice(0, 8).join('\n     '));
  if (opts.order !== false) {
    const r = await focusOrder(win, scope);
    ok(`${label}: Tab follows DOM order`, r.ok, r.detail);
  }
  if (opts.contrast !== false) {
    const bad: string[] = await win.evaluate((s) => (window as any).__a11y.contrast(s), scope);
    ok(`${label}: text meets WCAG AA contrast`, bad.length === 0, `${bad.length} failing\n     ` + bad.slice(0, 10).join('\n     '));
  }
}

/** Open a modal by `open`, then prove it traps focus and hands it back. */
async function modal(win: Win, label: string, openerSel: string, open?: () => Promise<void>): Promise<void> {
  await install(win);
  await win.evaluate((sel: string) => (document.querySelector(sel) as HTMLElement | null)?.focus(), openerSel);
  if (open) await open();
  else await win.evaluate((sel: string) => (document.querySelector(sel) as HTMLElement).click(), openerSel);
  await settle(win, 900);
  const inside = await win.evaluate(() => {
    const m = (window as any).__a11y.topModal();
    return { ok: !!m && m.contains(document.activeElement), dialog: m ? (m.getAttribute('aria-label') || m.className) : '(none)', active: (window as any).__a11y.where(document.activeElement || document.body) };
  });
  ok(`${label}: focus lands inside the dialog`, inside.ok, JSON.stringify(inside));
  // No dialog: stop here. Tabbing on would walk the page itself — into the top
  // bar's search, which opens the palette — and every later check would be
  // reading the wrong layer.
  if (inside.dialog === '(none)') return;
  let escaped = '';
  for (let i = 0; i < 24 && !escaped; i++) {
    await win.keyboard.press(i < 12 ? 'Tab' : 'Shift+Tab');
    escaped = await win.evaluate(() => {
      const m = (window as any).__a11y.topModal();
      return m && m.contains(document.activeElement) ? '' : (window as any).__a11y.where(document.activeElement || document.body);
    });
  }
  ok(`${label}: Tab and Shift+Tab never leave it`, !escaped, escaped);
  const unnamed: string[] = await win.evaluate(() => {
    const m = (window as any).__a11y.topModal();
    if (!m) return ['(no dialog)'];
    m.setAttribute('data-a11y-scope', '1');
    const r = (window as any).__a11y.unnamed('[data-a11y-scope]');
    m.removeAttribute('data-a11y-scope');
    return r;
  });
  ok(`${label}: every control in it has a name`, unnamed.length === 0, unnamed.join('\n     '));
  await win.evaluate(() => {
    const log: string[] = [];
    (window as any).__focusLog = log;
    const w = (window as any).__a11y.where;
    document.addEventListener('focusin', (e) => log.push('in ' + w(e.target)), true);
    document.addEventListener('focusout', (e) => log.push('out ' + w(e.target)), true);
  });
  await win.keyboard.press('Escape');
  await settle(win, 700);
  const back = await win.evaluate((sel: string) => {
    const m = (window as any).__a11y.topModal();
    const opener = document.querySelector(sel) as HTMLElement | null;
    return {
      closed: !m,
      focus: !!opener && (document.activeElement === opener || opener.contains(document.activeElement)),
      active: (window as any).__a11y.where(document.activeElement || document.body),
      opener: opener ? { shown: opener.getClientRects().length > 0, where: (window as any).__a11y.where(opener) } : null,
      log: (window as any).__focusLog || [],
    };
  }, openerSel);
  ok(`${label}: Escape closes it and gives focus back to its opener`, back.closed && back.focus, JSON.stringify(back));
}

async function theme(win: Win, t: 'light' | 'dark'): Promise<void> {
  await win.evaluate((tt: string) => (window as any).applyEffectiveTheme(tt), t);
  await settle(win, 500);
}

async function main(): Promise<void> {
  if (process.env.NODE_TEST_CONTEXT) {
    console.log('test-a11y launches the app; it runs under `npm run smoke`, not `npm test`.');
    process.exit(0);
  }
  const smoke = await launchSmoke('a11y');
  const { app, win, errors, shotDir } = smoke;
  // The sample project, plus a second dataset: a relationship needs two, and
  // the New relationship dialog honestly refuses to open with one.
  const pid = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const list = await req('./src/app/projects.js').listProjects();
    const id = (list.find((p: any) => p.name === 'My project') || list[0]).id;
    await req('./src/data/datasets.js').saveDataset(id, {
      name: 'Targets', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'target', type: 'number' }],
      rows: [['East', 1], ['West', 2]],
    });
    return id;
  });
  await openProject(win, pid);
  const go = async (section: string): Promise<void> => {
    await win.evaluate((s: string) => (window as any).selectSection(s), section);
    await settle(win, 1200);
  };
  const tab = async (id: string): Promise<void> => {
    await win.evaluate((i: string) => (document.getElementById(i) as HTMLElement).click(), id);
    await settle(win, 900);
  };

  for (const t of ['light', 'dark'] as const) {
    await theme(win, t);
    await go('home');
    await check(win, `Home (${t})`, '.hub-body', { order: t === 'light' });
    await go('datasets');
    // Every tab the strip has, whatever it has grown to: read from the DOM.
    const dataTabs: string[] = await win.evaluate(() =>
      [...document.querySelectorAll('#ds-tab-datasets ~ [role="tab"], #ds-tab-datasets')].map((t) => t.id));
    for (const id of dataTabs) {
      await tab(id);
      await check(win, `Data › ${id.replace('ds-tab-', '')} (${t})`, '.hub-body', { order: t === 'light' });
    }
    await go('visuals');
    await check(win, `Visuals (${t})`, '.hub-body', { order: t === 'light' });
    await go('analyses');
    await check(win, `Dashboards (${t})`, '.hub-body', { order: t === 'light' });
    await go('trash');
    await check(win, `Trash (${t})`, '.hub-body', { order: t === 'light' });
  }
  await theme(win, 'light');

  // The explorer, the builder, the dashboard editor.
  await go('datasets');
  await tab('ds-tab-datasets');
  const retail = await app.evaluate(async (_e, p: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const all = await req('./src/data/datasets.js').listDatasets(p);
    return all.find((d: any) => d.name === 'Retail orders').id;
  }, pid);
  await win.evaluate((id: string) => (window as any).openSavedDataset(id), retail);
  await settle(win, 2500);
  await check(win, 'Dataset explorer', '.hub-body');
  // Back to the list, as a user would: the explorer takes the whole Data panel.
  await win.evaluate(() => (document.getElementById('ds-explorer-close') as HTMLElement).click());
  await settle(win, 800);

  await go('visuals');
  await modal(win, 'New visual', '#viz-new-btn');
  await win.evaluate(() => (document.getElementById('viz-new-btn') as HTMLElement).click());
  await settle(win, 1000);
  await win.evaluate(() => {
    ([...document.querySelectorAll('.vn-row')].find((r) => /Retail orders/.test(r.textContent || '')) as HTMLElement).click();
    (document.querySelector('.js-vn-manual') as HTMLElement).click();
  });
  await settle(win, 3000);
  await check(win, 'Visual builder', '.hub-body');
  await win.screenshot({ path: path.join(shotDir, '5-a11y-builder.png') });

  await go('analyses');
  ok('the sample dashboard opens', await openSeededAnalysis(win, 'Retail overview'));
  await settle(win, 2500);
  const ready = await win.evaluate(() => document.getElementById('a11y-live')?.textContent || '');
  ok('the live region says when the dashboard\'s queries are done', /^Retail overview is ready — \d+ tiles\.$/.test(ready), ready);
  await check(win, 'Dashboard', '.hub-body');
  const chart = await win.evaluate(() => {
    const c = document.querySelector('#dash-grid .dash-card canvas[role="img"]') as HTMLCanvasElement | null;
    return c ? { label: c.getAttribute('aria-label') || '', tab: c.tabIndex } : null;
  });
  ok('charts are role=img with the app\'s caption as their description, and focusable',
    !!chart && chart.tab === 0 && /\w+.*\. .+/.test(chart.label), JSON.stringify(chart));
  // Keyboard mark navigation: → moves to a mark, and the live region says its value.
  const layoutOf = (): Promise<string> => win.evaluate(() => {
    const el = (document.querySelector('#dash-grid .dash-card canvas[role="img"]') as HTMLElement).closest('.dash-card') as HTMLElement;
    return JSON.stringify(dashCurrent.pages[0].cards.find((c: any) => c.id === el.dataset.cardId).layout);
  });
  const before = await layoutOf();
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card canvas[role="img"]') as HTMLElement).focus());
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight');
  await settle(win, 400);
  ok('stepping through a chart\'s marks never moves its tile', (await layoutOf()) === before);
  const said = await win.evaluate(() => document.getElementById('a11y-live')?.textContent || '');
  ok('→ on a focused chart walks its marks and announces the value', /: /.test(said), said);
  await win.screenshot({ path: path.join(shotDir, '5-a11y-chart-keyboard.png') });
  // "View as table" from the tile menu.
  const tableShown = await win.evaluate(async () => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')].find((c) => /Revenue by category/.test(c.textContent || '')) as HTMLElement;
    (card.querySelector('.dash-card-menu-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const item = [...document.querySelectorAll('.dash-card-menu [role="menuitem"]')].find((b) => b.textContent === 'View as table') as HTMLElement | undefined;
    const menuFocused = !!document.activeElement && (document.activeElement as HTMLElement).getAttribute('role') === 'menuitem';
    item?.click();
    await new Promise((r) => setTimeout(r, 300));
    const t = card.querySelector('table.a11y-table');
    return { menuFocused, rows: t ? t.querySelectorAll('tbody tr').length : 0, headers: t ? [...t.querySelectorAll('thead th')].map((h) => h.textContent) : [] };
  });
  ok('the tile menu is a menu with focus on its first item', tableShown.menuFocused);
  ok('"View as table" shows the tile\'s figures as a table', tableShown.rows === 3 && tableShown.headers.length === 2, JSON.stringify(tableShown));
  await win.screenshot({ path: path.join(shotDir, '5-a11y-table.png') });

  // Every dashboard style preset.
  for (const preset of ['auto', 'clean', 'executive', 'dense', 'dark']) {
    await win.evaluate((p: string) => {
      dashCurrent.style = { ...DASH_STYLE_PRESETS[p] };
      syncDashStyle();
      renderDashGrid();
    }, preset);
    await settle(win, 2000);
    await check(win, `Dashboard, style ${preset}`, '#dash-editor', { order: false });
  }

  // Modals. Leave the dashboard first, the way a user does: an open analysis is
  // a focus mode that keeps the rest of the app hidden behind it, so an opener
  // "visited" underneath it would be invisible and could never take focus back.
  await win.evaluate(() => (document.getElementById('dash-back-btn') as HTMLElement | null)?.click());
  await settle(win, 1200);
  await go('datasets');
  await tab('ds-tab-relationships');
  await modal(win, 'New relationship', '#rel-new');
  await tab('ds-tab-metrics');
  await modal(win, 'New metric', '#mp-new');
  await tab('ds-tab-datasets');
  await modal(win, 'Paste data', '#ds-paste-open');
  await go('analyses');
  await openSeededAnalysis(win, 'Retail overview');
  await settle(win, 2000);
  await modal(win, 'Text card prompt', '#dash-add-text');
  await modal(win, 'Command palette', 'body', async () => { await win.evaluate(() => (window as any).paletteOpen()); });
  await win.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await modal(win, 'Keyboard shortcuts', 'body', async () => { await win.keyboard.press('Shift+Slash'); });

  // `?` lists every command.
  await win.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await win.keyboard.press('Shift+Slash');
  await settle(win, 600);
  const sheet = await win.evaluate(() => {
    const all = (window as any).listCommands(false).map((c: any) => c.title);
    const rows = [...document.querySelectorAll('#cp-sheet .cp-sheet-name')].map((n) => n.textContent);
    return { open: !(document.getElementById('cp-sheet') as HTMLElement).hidden, all: all.length, rows: rows.length, missing: all.filter((t: string) => !rows.includes(t)) };
  });
  ok('? lists every registered command', sheet.open && sheet.rows === sheet.all && sheet.missing.length === 0, JSON.stringify(sheet));
  await win.keyboard.press('Escape');

  ok('no renderer console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await smoke.close();
  finishSmoke('a11y', failureCount());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
