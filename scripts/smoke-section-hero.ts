// Visuals and Dashboards teach in ONE place: the empty state.
//
// Visuals used to carry a full-bleed gradient banner (`.ws-hero`) above the
// grid, shown only when the section ALREADY had saved visuals and hidden on the
// empty state — so the pitch "One chart, saved once, used everywhere" was
// addressed to the one person who had demonstrably stopped needing it, and it
// was the loudest surface in an otherwise white/grey/blue product. It is gone;
// the empty state, which already said the same thing with the same art and the
// same primary action, is now the only place that copy lives.
//
// This is a separate smoke file rather than assertions bolted onto
// smoke-app.ts because that file is at its allowlisted line count and cannot
// grow (.claude/rules/file-size.md).
//
// What it pins, and why each one is a real regression if it flips:
//   • populated Visuals AND populated Dashboards show no teach banner at all —
//     the rule the change exists to establish, asserted on both sections
//     because they shared the CSS and fixing one is exactly how they drift;
//   • it stays gone across a section switch and across a RELOAD, which is where
//     a re-introduced "first-run, until dismissed" banner would come back;
//   • the empty state still carries the teach, with the one sentence the banner
//     used to own — deleting the pitch is only honest if it survives somewhere;
//   • no `.ws-hero` rule is left in hub.css, so the styling half cannot rot back
//     in behind a deleted element.
//
//   npm run build:ts && node scripts/smoke-section-hero.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-hero-'));

/** Everything a "is there a teach banner over the content?" answer needs. */
function probe(): any {
  const panel = document.querySelector('.ws-panel:not([hidden])');
  // The VISIBLE empty state: a section can hold more than one (Dashboards also
  // carries the Reports tab's, hidden), and the first in document order is not
  // necessarily the one on screen.
  const empty = ([...document.querySelectorAll('.ws-panel:not([hidden]) .ws-empty')] as HTMLElement[])
    .find((e) => e.offsetParent !== null) || null;
  return {
    section: panel ? panel.getAttribute('data-section') : null,
    // The element itself, and the class, and any surviving id — a banner could
    // come back under any one of the three.
    heroEls: document.querySelectorAll('.ws-hero, #viz-hero, #viz-hero-new, #viz-hero-dismiss').length,
    // Cards/rows on screen, so "no banner" is asserted against a POPULATED page
    // and not accidentally against an empty one.
    cards: document.querySelectorAll('.ws-panel:not([hidden]) .viz-card, .ws-panel:not([hidden]) .an-card').length,
    emptyShown: !!empty && empty.offsetParent !== null,
    emptyText: empty ? (empty.textContent || '').replace(/\s+/g, ' ').trim() : '',
  };
}

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // The first paint is a SPLASH: a screenshot or DOM read taken there passes
  // every check while proving nothing.
  const killSplash = async () => {
    await win.evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    }).catch(() => {});
  };
  await win.waitForTimeout(6000);
  await killSplash();

  // The bundled sample seeds visuals and a dashboard into its own project; a
  // second, bare project gives us the empty state of both sections.
  const ids: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const visuals = req('./src/analysis/visuals.js');
    const list = await projects.listProjects();
    const full = list[0];
    const bare = await projects.createProject('Bare project');
    return { full: full.id, bare: bare.id, visuals: (await visuals.listVisuals(full.id)).length };
  });
  ok('the bundled sample seeded visuals to assert a POPULATED page against',
     ids.visuals > 0, JSON.stringify(ids));

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(4000);
  await killSplash();

  const go = async (projectId: string, section: string) => {
    await win.evaluate(async (a: any) => {
      await (window as any).adoptProject(a.p); // MUST await: the click repaints
      ([...document.querySelectorAll('.as-nav-item')]
        .find((b) => (b.textContent || '').trim() === a.s) as HTMLElement | undefined)?.click();
    }, { p: projectId, s: section });
    await win.waitForTimeout(1200);
    return win.evaluate(probe);
  };

  // ── Populated: no teach banner, in EITHER section ─────────────────────────
  const vizFull = await go(ids.full, 'Visuals');
  ok('populated Visuals renders its saved visuals with no teach banner above them',
     vizFull.cards > 0 && vizFull.heroEls === 0 && !vizFull.emptyShown, JSON.stringify(vizFull));

  const dashFull = await go(ids.full, 'Dashboards');
  ok('…and populated Dashboards, which shares the same CSS, has none either',
     dashFull.cards > 0 && dashFull.heroEls === 0 && !dashFull.emptyShown, JSON.stringify(dashFull));

  // ── It stays gone across a section switch ────────────────────────────────
  const backToViz = await go(ids.full, 'Visuals');
  ok('…and it does not reappear on switching back to Visuals',
     backToViz.cards > 0 && backToViz.heroEls === 0, JSON.stringify(backToViz));

  // ── …and across a reload, where a "first run" banner would return ────────
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(4000);
  await killSplash();
  const afterReload = await go(ids.full, 'Visuals');
  ok('…and it does not come back after a full reload',
     afterReload.cards > 0 && afterReload.heroEls === 0, JSON.stringify(afterReload));

  // ── Empty: the teach IS the content ──────────────────────────────────────
  const vizEmpty = await go(ids.bare, 'Visuals');
  ok('the Visuals empty state carries the teach, banner-free',
     vizEmpty.emptyShown && vizEmpty.heroEls === 0 && /No visuals yet/.test(vizEmpty.emptyText),
     JSON.stringify(vizEmpty).slice(0, 300));
  ok('…including the one line the deleted banner used to own',
     /Every number is computed by the app/.test(vizEmpty.emptyText),
     vizEmpty.emptyText.slice(0, 240));

  const dashEmpty = await go(ids.bare, 'Dashboards');
  ok('the Dashboards empty state does the same job the same way',
     dashEmpty.emptyShown && dashEmpty.heroEls === 0 && /No dashboards yet/.test(dashEmpty.emptyText),
     JSON.stringify(dashEmpty).slice(0, 300));

  // ── The stylesheet half ──────────────────────────────────────────────────
  // Deleting the markup while leaving `.ws-hero` styled is how it grows back.
  const css = fs.readFileSync(path.join(REPO, 'renderer', 'hub', 'hub.css'), 'utf8');
  ok('no .ws-hero rule survives in hub.css',
     !/\.ws-hero/.test(css), (css.match(/\.ws-hero[\w-]*/g) || []).join(' '));

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} section-hero smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All section-hero smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
