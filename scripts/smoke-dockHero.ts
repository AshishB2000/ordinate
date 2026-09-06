// End-to-end smoke test of the DOCK'S EMPTY STATE and of the leaked-action-line
// fix — launches the REAL app.
//
// TWO THINGS, both of which pass every unit test while being broken on screen:
//
//  1. THE EMPTY STATE (dockHero.ts). The greeting, the sub line and the starter
//     chips are painted by dkPaintHero, which is called from dkRenderContext in
//     ANOTHER file, using prompt strings from haSuggestPrompts in a THIRD. Every
//     one of those hops is a bare global resolved at call time, so a rename
//     anywhere along the chain breaks the hero silently — no build error, no
//     lint error, no unit-test failure, just a blank panel. This file is that
//     coverage, plus the visibility rule (hero while empty, gone once a turn
//     exists) which is driven by a MutationObserver rather than a call.
//
//  2. THE LEAKED ACTION LINE. `{"kind":"none","intent":""}` rendered as the
//     answer to "hi". test-cliEnvelope.ts and test-suggestedAction.ts pin the
//     two layers that caused it, but neither one renders anything — and the bug
//     report is about a character on screen. A smoke run has no model
//     configured, so the assertion here is made where the renderer actually
//     paints: xpRenderTurns() is handed the shapes main can produce and the DOM
//     is read back. A brace in a bubble fails this.
//
// Separate file, not more lines in smoke-dock.ts: that file is at the 800-line
// cap (.claude/rules/file-size.md) and the ratchet only tightens.
//
//   npm run smoke   (or: node scripts/smoke-dockHero.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dockhero-'));

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

  // The first paint is a splash; a screenshot there passes every DOM check while
  // proving nothing (see CLAUDE.md), so wait it out before asserting anything.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  // ── Seed a project with a dataset, so the chips have a real name to use ──
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    await projects.init();
    const proj = await projects.createProject('Hero smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Adidas US Sales',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['North', 10], ['South', 20]],
    });
    return { projectId: proj.id, datasetId: ds.id, datasetName: ds.name };
  });
  ok('seeded a project and a named dataset', Boolean(seeded.projectId && seeded.datasetId));

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);
  await win.evaluate(() => { (window as any).dkSetOpen(true); (window as any).dkSync(); });
  await win.waitForSelector('#dk-panel', { state: 'visible', timeout: 8000 });

  // ── 1. The empty state is actually on screen ────────────────────────────
  await win.waitForSelector('#dk-hero:not([hidden])', { timeout: 8000 });
  const hero = await win.evaluate(() => {
    const h = document.getElementById('dk-hero')!;
    const mark = h.querySelector('.dk-hero-mark') as HTMLImageElement | null;
    return {
      visible: !h.hidden && h.getBoundingClientRect().height > 0,
      mark: Boolean(mark && mark.getBoundingClientRect().width > 0),
      greet: (document.getElementById('dk-hero-greet')!.textContent || '').trim(),
      sub: (document.getElementById('dk-hero-sub')!.textContent || '').trim(),
    };
  });
  ok('the dock opens onto the hero, not a blank rectangle', hero.visible && hero.mark, JSON.stringify(hero));
  ok('…with a greeting', hero.greet.length > 0, hero.greet);
  ok('…and exactly one sub line under it', hero.sub.length > 0 && hero.sub.indexOf('\n') < 0, hero.sub);

  // Chips are an async round-trip through haSuggestPrompts → listDatasets.
  await win.waitForFunction(
    () => !(document.getElementById('dk-suggests') as HTMLElement).hidden, { timeout: 15_000 },
  ).catch(() => {});
  const chips: string[] = await win.evaluate(() =>
    [...document.querySelectorAll('#dk-suggests .dk-suggest')].map((c) => (c.textContent || '').trim()));
  ok('…and 2–3 starter chips built from the project’s real data',
    chips.length >= 2 && chips.length <= 3, JSON.stringify(chips));
  ok('…naming the dataset that is actually there, not a placeholder',
    chips.some((c) => c.indexOf(seeded.datasetName) >= 0), JSON.stringify(chips));
  // A chip FILLS the composer. It must never auto-send — a suggestion is a draft.
  await win.click('#dk-suggests .dk-suggest', { timeout: 8000 });
  ok('clicking a chip fills the composer and sends nothing',
    (await win.inputValue('#dk-input')) === chips[0]
      && (await win.locator('#dk-messages .xp-msg').count()) === 0,
    await win.inputValue('#dk-input'));
  // A smoke run has no model, so the composer is disabled — clear it by
  // property, not by Playwright's fill (which refuses a disabled control).
  await win.evaluate(() => { (document.getElementById('dk-input') as HTMLTextAreaElement).value = ''; });

  // ── The greeting follows the CONTEXT ────────────────────────────────────
  // Open the dataset: the header says "Based on dataset · Adidas US Sales" and
  // the hero must say the same thing in its own voice, not stay generic.
  // The user path: the Data section, then the dataset. openSavedDataset sets
  // expId/expName but does NOT switch section, and dkContextRef only claims a
  // dataset context while the Data section is the one on screen.
  await win.evaluate(() => (window as any).selectSection('datasets'));
  await win.waitForTimeout(600);
  await win.evaluate((id: string) => (window as any).openSavedDataset(id), seeded.datasetId);
  await win.waitForTimeout(1500);
  await win.evaluate(() => { (window as any).dkSetOpen(true); (window as any).dkSync(); });
  await win.waitForFunction(
    (name: string) => (document.getElementById('dk-hero-greet')!.textContent || '').indexOf(name) >= 0,
    seeded.datasetName, { timeout: 15_000 },
  ).catch(() => {});
  const scoped = await win.evaluate(() => ({
    greet: (document.getElementById('dk-hero-greet')!.textContent || '').trim(),
    header: (document.getElementById('dk-context')!.textContent || '').trim(),
    section: (document.querySelector('.hub-body') as HTMLElement).dataset.section,
    ref: (window as any).dkContextRef(),
  }));
  ok('with a dataset open the greeting names it ("Ask about <dataset>")',
    scoped.greet === 'Ask about ' + seeded.datasetName, JSON.stringify(scoped));

  // ── 2. An action-only reply never shows a brace ─────────────────────────
  // No model is configured in a smoke run, so drive the renderer with the exact
  // turn shapes main can hand it. EMPTY_ANSWER is what splitAction substitutes
  // when stripping leaves nothing; the raw JSON is what the bug rendered.
  const empty: string = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/ai/suggestedAction.js').EMPTY_ANSWER;
  });
  ok('main exports an app-written line for an answer that was all wiring', Boolean(empty), empty);

  const painted = await win.evaluate((text: string) => {
    (window as any).xpRenderTurns([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text, provenance: { kind: 'project', name: 'Hero smoke', note: 'stats app-computed' } },
    ], 'dk-messages');
    const bubbles = [...document.querySelectorAll('#dk-messages .xp-bubble')]
      .map((b) => b.textContent || '');
    const prov = [...document.querySelectorAll('#dk-messages .xp-provenance')]
      .map((p) => p.textContent || '');
    return { bubbles, prov, provNodes: prov.length };
  }, empty);
  // The hero is hidden by a MutationObserver, whose callback runs at the end of
  // the microtask checkpoint — before the next paint, so there is no flash, but
  // after the evaluate above returns. Read it in its own round-trip.
  const heroHidden = await win.evaluate(() => (document.getElementById('dk-hero') as HTMLElement).hidden);
  ok('an action-only answer renders the app-written line, and NO "{" anywhere',
    painted.bubbles.join(' ').indexOf('{') < 0 && painted.bubbles.some((b: string) => b === empty),
    JSON.stringify(painted.bubbles));
  ok('…the hero gets out of the way once there is a turn (the observer fired)',
    heroHidden === true, String(heroHidden));
  ok('…and provenance is ONE muted line, not a row of pills',
    painted.provNodes === 1 && painted.prov[0].indexOf(' · ') > 0
      && (await win.locator('#dk-messages .xp-prov-chip').count()) === 0,
    JSON.stringify(painted.prov));

  // The user's turn keeps its accent bubble; the answer is plain text on the
  // panel. Both halves are asserted, because "make it plain" applied to the
  // wrong side would leave the transcript unreadable and still pass a one-sided
  // check.
  const sides = await win.evaluate(() => {
    const get = (sel: string) => {
      const b = document.querySelector(sel) as HTMLElement;
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const pr = (b.parentElement as HTMLElement).parentElement as HTMLElement;
      return { bg: cs.backgroundColor, right: Math.round(pr.getBoundingClientRect().right - r.right) };
    };
    return { user: get('.xp-msg-user .xp-bubble'), asst: get('.xp-msg-assistant .xp-bubble') };
  });
  const clear = (c: string) => c === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(c);
  ok('the user’s turn keeps a filled bubble, right-aligned',
    !clear(sides.user.bg) && sides.user.right < 20, JSON.stringify(sides));
  ok('…and the answer is plain text on the panel surface, not a second bubble',
    clear(sides.asst.bg), JSON.stringify(sides.asst));

  // A new conversation brings the hero back — the empty state is a STATE, not a
  // first-run screen.
  await win.evaluate(() => (window as any).dkNew());
  await win.waitForSelector('#dk-hero:not([hidden])', { timeout: 8000 });
  ok('"New conversation" restores the empty state', await win.locator('#dk-hero').isVisible());

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} dock-hero smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All dock-hero smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
