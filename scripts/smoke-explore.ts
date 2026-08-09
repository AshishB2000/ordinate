// End-to-end smoke test of EXPLORE — launches the REAL app.
//
// Explore is a new section reachable two ways (the sidebar nav item and a band
// on Home), so the thing worth proving is the routing and the chrome, not the
// model: that both doors land on the same section, that the stage renders, and
// that the composer is inert until a model is connected. A smoke run has no
// model configured, which is exactly the state most users first meet.
//
// It is a SEPARATE script rather than more lines in smoke-app.ts, for the same
// reason smoke-composer.ts is: smoke-app.ts is 3,544 lines and allowlisted in
// scripts/test-file-size.ts, whose rule is that an oversized file is split
// before more is added to it. Growing it to add coverage is precisely what that
// check exists to refuse.
//
//   npm run smoke   (runs this after smoke-composer.js)

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-explore-'));

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

/** Which section the shell currently shows. */
function sectionOf(win: any): Promise<string | null> {
  return win.evaluate(() => document.querySelector('.hub-body')?.getAttribute('data-section') ?? null);
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

  // The first paint is a SPLASH that covers the whole window. Every geometry and
  // visibility check below would pass against it while proving nothing — this
  // caught a false pass in smoke-app.ts once already. Wait for it to finish, then
  // remove it defensively (same belt-and-braces as smoke-app.ts), and only then
  // wait for the shell itself.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win
    .evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    })
    .catch(() => {});
  await win.waitForSelector('.as-nav-item[data-section="explore"]', { timeout: 60_000 });

  // ── The nav entry ──────────────────────────────────────────────────────────
  ok('Explore is in the sidebar nav',
    (await win.locator('.as-nav-item[data-section="explore"]').count()) === 1);

  ok('…above Home, because asking is the fastest route to an answer',
    await win.evaluate(() => {
      const items = [...document.querySelectorAll('.as-nav .as-nav-item')];
      return items.findIndex((n: any) => n.dataset.section === 'explore') <
             items.findIndex((n: any) => n.dataset.section === 'home');
    }));

  await win.click('.as-nav-item[data-section="explore"]', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelector('.hub-body')?.getAttribute('data-section') === 'explore',
    { timeout: 8000 },
  );
  ok('the nav item opens the Explore section', (await sectionOf(win)) === 'explore');
  ok('…and marks itself active',
    (await win.locator('.as-nav-item.active[data-section="explore"]').count()) === 1);

  // ── The surface actually rendered ──────────────────────────────────────────
  ok('the panel is visible, not merely present',
    await win.evaluate(() => {
      const p = document.getElementById('ws-explore');
      return Boolean(p && !(p as HTMLElement).hidden && p.getClientRects().length > 0);
    }));

  ok('the stage is full-bleed, not a narrow card in whitespace',
    await win.evaluate(() => {
      const stage = document.querySelector('.xp-stage');
      const panel = document.getElementById('ws-explore');
      if (!stage || !panel) return false;
      // Within 1px of the panel's own width — the stage carries the background
      // edge to edge; only the composer inside it is width-capped.
      return Math.abs(stage.getBoundingClientRect().width - panel.getBoundingClientRect().width) <= 1;
    }));

  ok('the composer is capped, and narrower than the stage it sits on',
    await win.evaluate(() => {
      const composer = document.querySelector('.xp-composer');
      const stage = document.querySelector('.xp-stage');
      if (!composer || !stage) return false;
      const cw = composer.getBoundingClientRect().width;
      return cw > 0 && cw <= 721 && cw < stage.getBoundingClientRect().width;
    }));

  ok('the greeting is on screen', await win.locator('#xp-greet').isVisible());

  // ── Inert until a model is connected (no model in a smoke run) ─────────────
  ok('the composer is disabled with no model configured',
    await win.evaluate(() => {
      const input = document.getElementById('xp-input') as HTMLTextAreaElement | null;
      const send = document.getElementById('xp-send') as HTMLButtonElement | null;
      return Boolean(input && input.disabled && send && send.disabled);
    }));

  ok('…and says so in the placeholder rather than throwing a dialog',
    await win.evaluate(() => {
      const input = document.getElementById('xp-input') as HTMLTextAreaElement | null;
      return Boolean(input && /model/i.test(input.placeholder));
    }));

  // ── The Home band is the second door ───────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForFunction(
    () => document.querySelector('.hub-body')?.getAttribute('data-section') === 'home',
    { timeout: 8000 },
  );
  ok('the Explore band is on Home', await win.locator('#home-xp-band').isVisible());

  await win.click('#home-xp-band', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelector('.hub-body')?.getAttribute('data-section') === 'explore',
    { timeout: 8000 },
  );
  ok('the Home band opens the same section', (await sectionOf(win)) === 'explore');

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failures) {
      console.error(`${failures} Explore smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All Explore smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
