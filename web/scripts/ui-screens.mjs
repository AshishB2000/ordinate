// The UI kit's review screenshots AND its CSP check, in one pass:
//
//   npm run build:ts && node web/scripts/ui-screens.mjs
//
// 1. Builds the app in the `gallery` mode (a production build — minified, the
//    CSP <meta> injected — that keeps the dev-only /dev/ui route) into a temp dir.
// 2. Serves it through the SERVER's own static handler (src/server/static.ts),
//    so the page runs exactly as `npm run server` would deliver it.
// 3. Drives Chromium over /dev/ui in light and dark: screenshots into
//    web/e2e/__screens__/, then opens every overlay for real (menu, context
//    menu, select, combobox, popover, tooltip, dialog, drawer, toast, splitter
//    drag) while recording console errors and `securitypolicyviolation` events.
// 4. A negative control injects a <style> element and a style="" attribute
//    and REQUIRES both to be reported — proof the detector is live.
// Exit 1 on any console error, page error or CSP violation.
//
// ponytail: a script, not a Playwright test; T0.8 builds the real e2e harness
// (fixtures, CI) and this folds into it.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.join(WEB, '..');
const SCREENS = path.join(WEB, 'e2e', '__screens__');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require('playwright');
const { fastify } = require('fastify');
const { registerStatic } = require(path.join(REPO, 'src', 'server', 'static.js'));

const out = mkdtempSync(path.join(os.tmpdir(), 'ordinate-gallery-'));
await build({ root: WEB, mode: 'gallery', logLevel: 'warn', build: { outDir: out, emptyOutDir: true } });

const app = fastify({ logger: false });
registerStatic(app, out);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

mkdirSync(SCREENS, { recursive: true });
// CHROMIUM_PATH: drive an already-installed Chromium when Playwright's own
// build is not downloaded (no surprise installs from a review script).
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];

async function open(theme, query) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  await ctx.addInitScript((t) => {
    localStorage.setItem('ordinate.theme', t);
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} blocked=${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`),
    );
  }, theme);
  const page = await ctx.newPage();
  const tag = `[${theme} ${query || '(plain)'}]`;
  page.on('console', (m) => m.type() === 'error' && problems.push(`${tag} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${tag} page error: ${e.message}`));
  await page.goto(`${base}/dev/ui${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-gallery-ready]');
  await page.waitForTimeout(400); // entrance animations are ≤ 220 ms
  return { page, ctx, tag };
}

async function cspOf({ page, tag }) {
  for (const v of await page.evaluate(() => window.__csp)) problems.push(`${tag} CSP: ${v}`);
}

async function screens(theme) {
  // Everything at once: the non-modal overlays forced open, a viewport as tall as the page.
  const all = await open(theme, '?open=1');
  const h = await all.page.evaluate(() => document.querySelector('main').scrollHeight + 40);
  await all.page.setViewportSize({ width: 1440, height: h });
  await all.page.waitForTimeout(300);
  await all.page.screenshot({ path: path.join(SCREENS, `ui-${theme}.png`) });
  // --sections: one image per gallery section too, for a closer look.
  if (process.argv.includes('--sections')) {
    const sections = all.page.locator('main section');
    for (let i = 0; i < (await sections.count()); i++) {
      await all.page.screenshot({
        path: path.join(SCREENS, `ui-${theme}-${String(i + 1).padStart(2, '0')}.png`),
        clip: await sections.nth(i).boundingBox(),
      });
    }
  }
  await cspOf(all);
  await all.ctx.close();
  for (const which of ['dialog', 'drawer']) {
    const s = await open(theme, `?open=${which}`);
    await s.page.screenshot({ path: path.join(SCREENS, `ui-${theme}-${which}.png`) });
    await cspOf(s);
    await s.ctx.close();
  }
  // The long select opened for real at the bottom edge of the window: it must
  // flip above its trigger, cap its height and scroll inside (customDropdown).
  const s = await open(theme, '');
  const model = s.page.getByRole('combobox', { name: 'Model' });
  await model.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await model.click();
  await s.page.getByRole('listbox').waitFor();
  await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: path.join(SCREENS, `ui-${theme}-select.png`) });
  await cspOf(s);
  await s.ctx.close();
}

async function interact(theme) {
  const s = await open(theme, '');
  const { page } = s;
  // Escape, then require the layer to be GONE (not just closed) before the next.
  const esc = async (role = 'menu') => {
    await page.keyboard.press('Escape');
    await page.getByRole(role).first().waitFor({ state: 'detached', timeout: 3000 });
  };
  await page.getByRole('button', { name: 'Card actions', exact: true }).click();
  await page.getByRole('menu').waitFor();
  await esc();
  await page.getByText('Sales by region').click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  await esc();
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Dataset' }).fill('sql');
  await page.getByRole('listbox').waitFor();
  await esc('listbox');
  await page.locator('[aria-haspopup="dialog"]', { hasText: 'Rename' }).click();
  await page.getByRole('dialog', { name: 'Rename' }).waitFor();
  await esc('dialog');
  await page.getByRole('button', { name: 'Refresh', exact: true }).hover();
  await page.getByRole('tooltip').waitFor();
  await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Tab');
  await esc('dialog');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await page.getByRole('dialog', { name: 'Version history' }).waitFor();
  await esc('dialog');
  await page.getByRole('button', { name: 'Error + action', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Profile', exact: true }).click();
  const handle = page.getByRole('separator', { name: 'Resize the history panel' });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 1, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await cspOf(s);

  // Negative control: what the CSP must refuse IS refused and IS seen.
  const before = await page.evaluate(() => window.__csp.length);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = 'body { outline: 1px solid red }';
    document.head.append(st);
    const d = document.createElement('div');
    d.innerHTML = '<span style="color: red">x</span>';
    document.body.append(d);
  });
  await page.waitForTimeout(200);
  const seen = (await page.evaluate(() => window.__csp.length)) - before;
  // Chromium also logs each refusal as a console error: drop those two.
  for (let i = 0; i < 2; i++) {
    const at = problems.findLastIndex((p) => p.includes('console:') && p.includes('Content Security Policy'));
    if (at >= 0) problems.splice(at, 1);
  }
  if (seen < 2) problems.push(`${s.tag} negative control: expected 2 CSP reports, saw ${seen}`);
  console.log(`${s.tag} negative control: ${seen} CSP reports for an injected <style> + style="" (expected 2)`);
  await s.ctx.close();
}

try {
  for (const theme of ['light', 'dark']) {
    await screens(theme);
    await interact(theme);
  }
} finally {
  await browser.close();
  await app.close();
  rmSync(out, { recursive: true, force: true });
}

console.log(`screens: ${SCREENS}/ui-{light,dark}{,-dialog,-drawer,-select}.png`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('no console errors, no page errors, no CSP violations');
