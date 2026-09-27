// Build-depth smoke SECTION: workspace themes, driven through the REAL UI.
// Not a standalone smoke — scripts/smoke-build.ts calls themeSection(s, fx) on
// its one launch and fixture.
//
//   Settings → Appearance → Themes lists the built-ins read-only → Duplicate
//   Light → Edit → change the surface, the accent and one ramp colour to a
//   washed-out yellow, and see that swatch's contrast warning (and not the
//   others') → Save → make it the workspace default → open a seeded dashboard,
//   pick the theme in its Style panel and Apply → the sheet's computed
//   --surface / --chart-1 / --chart-2 ARE the theme's → delete the theme → the
//   sheet falls back to its preset and the default is cleared. The app is left
//   with no user theme and no workspace default, so later sections see the
//   look they would have without this one.

import { ok } from './selfcheck';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

const path: typeof import('path') = require('path');

// Classic-script `function`s are on window; top-level `let`s are not, so they
// are read by bare name inside evaluate.
declare const showSettingsPanel: (cat?: string) => Promise<void>;
declare const hideSettingsPanel: () => void;
declare const selectSection: (s: string) => void;
declare const closeDashboardEditor: () => void;
declare const dashCurrentStyle: () => any;
declare const dashThemeExport: (style: any) => any;
declare const wsThemes: { defaultId: string; themes: any[] };

type Win = Smoke['win'];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

/** Set a native input the way a user does: value, then the event its listener hears. */
const setInput = (win: Win, sel: string, value: string, type = 'input'): Promise<boolean> =>
  win.evaluate(([q, v, t]: string[]) => {
    const el = document.querySelector(q) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event(t, { bubbles: true }));
    return true;
  }, [sel, value, type]);

const cssVar = (win: Win, sel: string, name: string): Promise<string> =>
  win.evaluate(([q, n]: string[]) => {
    const el = document.querySelector(q);
    return el ? getComputedStyle(el).getPropertyValue(n).trim() : '';
  }, [sel, name]);

export async function themeSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errorsBefore = s.errors.length;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  await openProject(win, fx.projectId);
  await seedAnalysis(app, fx.projectId, { name: 'Theme board', sheets: [{ name: 'Sheet 1', cards: [
    { type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation: 'sum', label: 'Amount' }, layout: { x: 0, y: 0, w: 4, h: 2 } },
    { type: 'visual', visualId: fx.visualId, layout: { x: 4, y: 0, w: 8, h: 4 } },
  ] }] });

  // ── Settings → Appearance → Themes ─────────────────────────────────────────
  await win.evaluate(() => { void showSettingsPanel('appearance'); });
  ok('theme: Settings → Appearance shows a Themes section', await until(win, () =>
    win.evaluate(() => !!document.querySelector('#stp-themes .te-row') && (document.getElementById('stp-themes') as HTMLElement).getClientRects().length > 0)));
  const builtins = await win.evaluate(() => [...document.querySelectorAll('#te-builtin-list .te-row')].map((r) => ({
    key: (r as HTMLElement).dataset.key,
    badge: r.querySelector('.te-badge')?.textContent || '',
    buttons: [...r.querySelectorAll('.te-row-actions button')].map((b) => (b.textContent || '').trim()),
  })));
  ok('theme: the built-ins are listed — Auto, Light, Executive, Dark, Dense',
    builtins.map((b) => b.key).join() === 'auto,clean,executive,dark,dense', JSON.stringify(builtins));
  ok('theme: …each read-only: a Read-only badge and Duplicate as its only action',
    builtins.every((b) => b.badge === 'Read-only' && b.buttons.join() === 'Duplicate'), JSON.stringify(builtins));
  const before = await win.evaluate(() => wsThemes.themes.length);
  if (before === 0) {
    ok('theme: no user themes yet shows the designed empty state',
      await win.evaluate(() => (document.querySelector('#te-user-list .te-empty-t')?.textContent || '') === 'No themes of your own yet'));
  }
  await win.evaluate(() => { document.getElementById('stp-themes')!.scrollIntoView({ block: 'start' }); });
  await shot('theme-list.png');

  // ── Duplicate Light → Edit ────────────────────────────────────────────────
  ok('theme: Duplicate on Light is clickable', await click(win, '#te-builtin-list .te-row[data-key="clean"] .te-duplicate'));
  const copied = await until(win, () => win.evaluate((n: number) => wsThemes.themes.length === n + 1 &&
    [...document.querySelectorAll('#te-user-list .te-row-name')].some((x) => (x.textContent || '').startsWith('Copy of Light')), before));
  ok('theme: the copy appears under Your themes', copied);
  const id: string = await win.evaluate(() => wsThemes.themes[wsThemes.themes.length - 1].id);
  const lightSurface: string = await win.evaluate(() => wsThemes.themes[wsThemes.themes.length - 1].tokens['--surface']);
  ok('theme: the copy carries Light\'s own surface, read off hub.css', lightSurface === '#ffffff', lightSurface);

  ok('theme: Edit opens the editor', await click(win, `#te-user-list .te-row[data-key="${id}"] .te-edit`) &&
    await until(win, () => win.evaluate(() => !(document.getElementById('te-editor-view') as HTMLElement).hidden && !!document.getElementById('te-preview-sheet'))));
  const warnedTokens = (): Promise<string[]> => win.evaluate(() =>
    [...document.querySelectorAll('#te-editor-view .te-color.has-warn')].map((w) => (w as HTMLElement).dataset.token || '').sort());
  // Light's own ramp is not all above 3:1 on white (series 3, #14b8a6, is
  // ~2.5:1), so the copy may open with warnings; what is asserted is the CHANGE.
  const warnedBefore = await warnedTokens();
  ok('theme: an untouched copy does not warn on series 1 or 2', !warnedBefore.includes('--chart-1') && !warnedBefore.includes('--chart-2'),
    warnedBefore.join());

  const SURFACE = '#fbfaf7';
  const ACCENT = '#7c3aed';
  const WEAK = '#fef08a'; // pale yellow: ~1.2:1 on a near-white surface
  await setInput(win, '#te-c-surface', SURFACE);
  await setInput(win, '#te-c-accent', ACCENT);
  await setInput(win, '#te-c-chart-2', WEAK);
  await setInput(win, '#te-name', 'Smoke theme');
  const weak = await win.evaluate(() => {
    const w = document.querySelector('#te-editor-view .te-color[data-token="--chart-2"]') as HTMLElement;
    const note = w.querySelector('.te-warn') as HTMLElement;
    return { on: w.classList.contains('has-warn'), shown: note.hidden !== true && note.getClientRects().length > 0, text: note.textContent || '' };
  });
  ok('theme: the washed-out ramp colour shows a contrast warning beside its swatch',
    weak.on && weak.shown && /\d(\.\d)?:1 on the surface — needs 3:1/.test(weak.text), JSON.stringify(weak));
  const warnedAfter = await warnedTokens();
  ok('theme: …and it is the only new one (series 1 and the accent still read)',
    JSON.stringify(warnedAfter) === JSON.stringify(warnedBefore.concat('--chart-2').sort()), warnedBefore.join() + ' → ' + warnedAfter.join());
  ok('theme: the summary says it can still be saved', /can still save/.test(await win.evaluate(() =>
    (document.getElementById('te-warn-summary') as HTMLElement).hidden ? '' : document.getElementById('te-warn-summary')!.textContent || '')));
  ok('theme: the preview repaints live under the edited surface and ramp',
    (await cssVar(win, '#te-preview-sheet', '--surface')) === SURFACE && (await cssVar(win, '#te-preview-sheet', '--chart-2')) === WEAK);
  ok('theme: editing the accent re-derives its family', (await cssVar(win, '#te-preview-sheet', '--chart-accent')) === ACCENT);
  await shot('theme-editor.png');
  await win.evaluate(() => { document.querySelector('.te-color[data-token="--chart-2"]')!.scrollIntoView({ block: 'center' }); });
  await shot('theme-editor-ramp.png');

  ok('theme: Save is clickable', await click(win, '#te-editor-view .te-save'));
  ok('theme: saving returns to the list, renamed', await until(win, () => win.evaluate((tid: string) =>
    (document.getElementById('te-editor-view') as HTMLElement).hidden === true &&
    (document.querySelector(`#te-user-list .te-row[data-key="${tid}"] .te-row-name`)?.textContent || '').startsWith('Smoke theme'), id)));
  const stored = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/themeStore.js').listThemes();
  });
  const rec = stored.themes.find((t: any) => t.id === id);
  ok('theme: main stored the edited tokens, warning and all',
    !!rec && rec.tokens['--surface'] === SURFACE && rec.tokens['--accent'] === ACCENT && rec.tokens['--chart-2'] === WEAK, JSON.stringify(rec && rec.tokens));
  ok('theme: the row summarises the warnings', /\d+ contrast warnings?/.test(await win.evaluate((tid: string) =>
    document.querySelector(`#te-user-list .te-row[data-key="${tid}"] .te-row-note`)?.textContent || '', id)));

  // ── The workspace default ─────────────────────────────────────────────────
  await setInput(win, '#te-default', id, 'change');
  ok('theme: it can be made the workspace default', await until(win, () => win.evaluate((tid: string) => wsThemes.defaultId === tid, id)));
  ok('theme: …and the list badges it', await until(win, () => win.evaluate((tid: string) =>
    (document.querySelector(`#te-user-list .te-row[data-key="${tid}"] .te-badge`)?.textContent || '') === 'Workspace default', id)));
  await win.evaluate(() => { document.getElementById('stp-themes')!.scrollIntoView({ block: 'start' }); });
  await shot('theme-list-saved.png');
  await win.evaluate(() => { hideSettingsPanel(); });

  // ── Apply it to a dashboard through the Style panel ───────────────────────
  await win.evaluate(() => { selectSection('analyses'); });
  await win.waitForTimeout(1200);
  ok('theme: the seeded dashboard opened', await openSeededAnalysis(win, 'Theme board'));
  ok('theme: a dashboard with no theme of its own wears the workspace default',
    (await cssVar(win, '#dash-editor', '--surface')) === SURFACE);
  // The workbench's ⋯ menu → Style…, the way a user reaches it.
  ok('theme: the ⋯ menu opens', await click(win, '#an-more-btn'));
  ok('theme: Style… opens the Style panel', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Style…') as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return true;
  }) && await until(win, () => win.evaluate(() => !!document.getElementById('dash-style-theme'))));
  const offered = await win.evaluate((tid: string) =>
    [...(document.getElementById('dash-style-theme') as HTMLSelectElement).options].some((o) => o.value === tid), id);
  ok('theme: the Style panel offers the theme', offered);
  await setInput(win, '#dash-style-theme', id, 'change');
  await shot('theme-style-panel.png');
  ok('theme: Apply is clickable', await click(win, '.dash-style-modal .btn-primary'));
  await win.waitForTimeout(600);
  const sheet = {
    surface: await cssVar(win, '#dash-editor', '--surface'),
    c1: await cssVar(win, '#dash-editor', '--chart-1'),
    c2: await cssVar(win, '#dash-editor', '--chart-2'),
    themed: await win.evaluate(() => document.getElementById('dash-editor')!.classList.contains('dash-themed')),
  };
  ok('theme: the sheet\'s computed --surface, --chart-1 and --chart-2 are the theme\'s',
    sheet.themed && sheet.surface === SURFACE && sheet.c1 === rec.tokens['--chart-1'] && sheet.c2 === WEAK, JSON.stringify(sheet));
  ok('theme: an export of it carries the theme', await win.evaluate(() => {
    const t = dashThemeExport(dashCurrentStyle());
    return !!t && t.tokens['--chart-2'] === '#fef08a';
  }));
  const persisted = await until(win, () => app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const list = await req('./src/analysis/analysis.js').listAnalyses(arg.pid);
    const a = list.find((x: any) => x.name === 'Theme board');
    const full = a ? await req('./src/analysis/analysis.js').getAnalysis(arg.pid, a.id) : null;
    return !!full && full.style.themeId === arg.id;
  }, { pid: fx.projectId, id }), 5000);
  ok('theme: the dashboard\'s style saved the theme id', persisted);
  await shot('theme-dashboard.png');

  // ── Delete it: the sheet falls back ───────────────────────────────────────
  await win.evaluate(() => { void showSettingsPanel('appearance'); });
  await until(win, () => win.evaluate(() => !!document.querySelector('#te-user-list .te-delete')));
  ok('theme: Delete asks first', await click(win, `#te-user-list .te-row[data-key="${id}"] .te-delete`) &&
    await until(win, () => win.evaluate(() => !!document.querySelector('#te-user-list .te-row--confirm .te-confirm-delete'))));
  ok('theme: confirming deletes it', await click(win, '#te-user-list .te-row--confirm .te-confirm-delete') &&
    await until(win, () => win.evaluate((tid: string) => !wsThemes.themes.some((t) => t.id === tid), id)));
  ok('theme: deleting the default cleared the default', await win.evaluate(() => wsThemes.defaultId === ''));
  await win.evaluate(() => { hideSettingsPanel(); });
  await win.waitForTimeout(400);
  const after = {
    surface: await cssVar(win, '#dash-editor', '--surface'),
    c2: await cssVar(win, '#dash-editor', '--chart-2'),
    themed: await win.evaluate(() => document.getElementById('dash-editor')!.classList.contains('dash-themed')),
  };
  ok('theme: the dashboard falls back to its own style (no theme tokens left on the sheet)',
    !after.themed && after.surface !== SURFACE && after.c2 !== WEAK && after.surface !== '', JSON.stringify(after));

  // Leave a neutral screen.
  await win.evaluate(() => { closeDashboardEditor(); selectSection('home'); });
  await win.waitForTimeout(300);
  const newErrors = s.errors.slice(errorsBefore);
  ok('theme: no renderer console error in the whole section', newErrors.length === 0, newErrors.join('\n'));
}
