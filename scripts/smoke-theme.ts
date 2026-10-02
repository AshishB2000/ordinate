// DARK MODE, through the real Appearance control, in the real app.
//
// The app chrome went dark and every dashboard stayed a white sheet inside it,
// because a dashboard carries its own style preset and the default — 'clean' —
// pins the LIGHT tokens on the sheet container. That is a real feature for a
// dashboard someone deliberately pinned; it was catastrophic as a default. The
// tile text is the tell: it is inherited from outside the sheet, so a dark app
// drew near-white text on the forced-white card.
//
// Everything here goes through the ACTUAL control (#settings-gear → the
// Appearance segment), never `document.documentElement.dataset.theme = …`, so
// the whole path is under test: the click, config.themePreference, main's
// resolve, applyEffectiveTheme, the themechange event, and every redraw.
//
// Computed values, not class names. `.dash-theme--auto` being present proves
// nothing about what colour anything painted.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-theme-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** Rough relative luminance of `rgb(r, g, b)` or `#rrggbb`, 0 (black) to 1. */
function lum(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec((color || '').trim());
  const rgb = hex
    ? [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
    : (/(\d+)\D+(\d+)\D+(\d+)/.exec(color || '') || []).slice(1).map(Number);
  if (rgb.length !== 3 || rgb.some((n) => !Number.isFinite(n))) return 1;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await win.waitForTimeout(5000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  /** Click a real Appearance option in the gear menu, then close the menu. */
  const setAppearance = async (pref: 'light' | 'dark'): Promise<boolean> => {
    await win.evaluate(() => {
      const g = document.getElementById('settings-gear') as HTMLElement | null;
      if (g) g.click();
    });
    await win.waitForTimeout(600);
    const hit = await win.evaluate((p: string) => {
      const opt = [...document.querySelectorAll('.menu-seg-opt[data-theme], .stp-seg-opt[data-theme]')]
        .find((e) => (e as HTMLElement).dataset.theme === p && (e as HTMLElement).offsetParent) as HTMLElement | undefined;
      if (!opt) return false;
      opt.click();
      return true;
    }, pref);
    await win.waitForTimeout(1200);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    return hit;
  };

  const ids = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const analysis = req('./src/analysis/analysis.js');
    for (const p of await projects.listProjects()) {
      const l = await analysis.listAnalyses(p.id);
      if (l.length) return { pid: p.id, aid: l[0].id };
    }
    return null;
  });
  ok('the sample dashboard is there to theme', Boolean(ids && ids.pid), JSON.stringify(ids));
  if (!ids) { await closeApp(app); return; }

  /** Everything a theme can change, measured rather than assumed. */
  const measure = (): Promise<any> => win.evaluate(() => {
    const ed = document.getElementById('dash-editor') as HTMLElement;
    const card = document.querySelector('#dash-grid .dash-card') as HTMLElement | null;
    const cs = (e: Element | null) => (e ? getComputedStyle(e) : null);
    // EVERY axis, not scales.x. Only the VALUE axis is given a gridline colour
    // (chartScales.ts); the category axis sets `grid: { display: false }` and no
    // colour, and Chart.js then merges its own rgba(0,0,0,0.1) default in — so
    // reading scales.x reports that default forever and can never go dark.
    let grid = '';
    let axis = '';
    try {
      const cv = document.querySelector('#dash-grid canvas') as HTMLCanvasElement | null;
      const chart = cv && (window as any).Chart && (window as any).Chart.getChart(cv);
      const scales = (chart && chart.options && chart.options.scales) || {};
      const all = Object.keys(scales).map((k) => ({
        k, c: scales[k] && scales[k].grid && scales[k].grid.color,
      })).filter((e) => typeof e.c === 'string' && e.c);
      const token = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
      const hit = all.find((e) => e.c === token) || all[0];
      if (hit) { grid = hit.c; axis = hit.k; }
      axis += ' (of ' + all.map((e) => e.k).join('/') + ')';
    } catch (_) { grid = 'unreadable'; }
    return {
      root: document.documentElement.dataset.theme,
      themeClass: (ed.className.match(/dash-theme--(\w+)/) || [])[1] || '',
      sheetBg: cs(ed)!.getPropertyValue('--bg').trim(),
      cardBg: card ? cs(card)!.backgroundColor : '',
      cardText: card ? cs(card)!.color : '',
      rootBorder: getComputedStyle(document.documentElement).getPropertyValue('--border').trim(),
      gridColor: grid,
      gridAxis: axis,
    };
  });

  // ── Dark, through the real control ───────────────────────────────────────
  ok('the Appearance control offers Dark', await setAppearance('dark'));
  await win.evaluate(async (i: any) => {
    await (window as any).adoptProject(i.pid);
    (window as any).selectSection('analyses');
    await (window as any).openAnalysis(i.aid);
  }, ids);
  await win.waitForTimeout(5000);

  const dark = await measure();
  ok('the app is in dark mode', dark.root === 'dark', JSON.stringify(dark));
  ok('an untouched dashboard follows it rather than pinning a look',
    dark.themeClass === 'auto', dark.themeClass);
  ok('…so the SHEET is dark', lum(dark.sheetBg) < 0.3, dark.sheetBg);
  ok('…and so is a TILE', lum(dark.cardBg) < 0.35, dark.cardBg);
  // The original symptom: light text inherited from outside a forced-white card.
  ok('…with its text legible against it',
    lum(dark.cardText) - lum(dark.cardBg) > 0.4, `${dark.cardText} on ${dark.cardBg}`);
  // Chart.js reads its colours once, at construction. Without a redraw the chart
  // keeps the palette it was built with, whatever the sheet does around it.
  ok('…and a chart has been REDRAWN with the dark gridline token',
    dark.gridColor === dark.rootBorder,
    `${dark.gridAxis}.grid.color=${dark.gridColor} vs --border=${dark.rootBorder}`);
  await win.screenshot({ path: path.join(shotDir, 'theme-dark-dashboard.png') });

  // ── Back to light, live ──────────────────────────────────────────────────
  ok('the Appearance control offers Light', await setAppearance('light'));
  await win.waitForTimeout(3000);
  const light = await measure();
  ok('switching back repaints the sheet light', lum(light.sheetBg) > 0.8, light.sheetBg);
  ok('…and redraws the chart with the light gridline token',
    light.gridColor === light.rootBorder,
    `${light.gridAxis}.grid.color=${light.gridColor} vs --border=${light.rootBorder}`);

  // ── An explicit preset still overrides, inside a light app ───────────────
  // 'auto' must not have cost the feature: a dashboard pinned Dark stays dark
  // however the app is set, which is what presenting needs.
  await win.evaluate(() => (window as any).applyDashStylePreset('dark'));
  await win.waitForTimeout(3000);
  const pinnedDark = await measure();
  ok('a dashboard pinned Dark stays dark in a LIGHT app',
    pinnedDark.root === 'light' && pinnedDark.themeClass === 'dark' && lum(pinnedDark.cardBg) < 0.35,
    JSON.stringify(pinnedDark));
  await win.screenshot({ path: path.join(shotDir, 'theme-pinned-dark-in-light-app.png') });

  await win.evaluate(() => (window as any).applyDashStylePreset('clean'));
  await win.waitForTimeout(3000);
  const pinnedLight = await measure();
  ok('…and one pinned Light stays light', lum(pinnedLight.cardBg) > 0.8, pinnedLight.cardBg);
  // The migration must not undo a real choice: 'clean' picked here carries the
  // flag, so it survives the next read rather than reverting to auto.
  const stored = await app.evaluate(async (_a: any, i: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const rec = await analysis.getAnalysis(i.pid, i.aid);
    return rec.style;
  }, ids);
  ok('…and that choice is recorded as chosen, so it survives the clean migration',
    stored && stored.theme === 'clean' && stored.chosen === true, JSON.stringify(stored));

  await win.evaluate(() => (window as any).applyDashStylePreset('auto'));
  await win.waitForTimeout(2500);
  ok('the Appearance control offers Dark again', await setAppearance('dark'));
  await win.waitForTimeout(3000);
  const backToAuto = await measure();
  ok('setting it back to Auto makes it follow the app again',
    lum(backToAuto.cardBg) < 0.35, JSON.stringify(backToAuto));

  ok('no renderer console errors across every theme switch', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  await closeApp(app);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' theme smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll theme smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
