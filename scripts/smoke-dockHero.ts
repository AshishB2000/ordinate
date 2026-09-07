// End-to-end smoke test of the DOCK'S EMPTY STATE and of the leaked-action-line
// fix — launches the REAL app.
//
// TWO THINGS, both of which pass every unit test while being broken on screen:
//
//  1. THE STAGE AND THE CHIPS. The stage — the dotted lattice and accent washes
//     on .dk-messages — is pure CSS, and its dark rule restates the whole
//     `background` shorthand, which implicitly resets background-size: lose the
//     restated 22px and the lattice silently becomes one element-sized gradient
//     with no dots and no error. Both themes are read back here for that reason.
//     The chips are painted by dkPaintHero, called from dkRenderContext in
//     ANOTHER file, using prompt strings from haSuggestPrompts in a THIRD, each
//     hop a bare global resolved at call time — so a rename anywhere along the
//     chain breaks them silently. Plus the visibility rule (chips while empty,
//     gone once a turn exists), driven by a MutationObserver rather than a call.
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

  // ── 1. THE STAGE is painted, in both themes ─────────────────────────────
  // The dotted lattice and the accent washes are the design (40bff73^'s
  // .xp-stage, retuned for the panel). They are also the thing a stylesheet edit
  // silently loses: the dark rule restates the whole `background` shorthand,
  // which implicitly resets background-size to `auto` — drop the restated
  // `background-size` and the 22px lattice becomes ONE element-sized gradient,
  // i.e. no dots, with no error anywhere. So both themes are read back.
  ok('#dk-hero is gone — the stage is CSS on the body, not a card in the markup',
    (await win.locator('#dk-hero').count()) === 0);

  const stageIn = async (theme: string): Promise<any> => {
    await win.evaluate((t: string) => { document.documentElement.dataset.theme = t; }, theme);
    await win.waitForTimeout(400);
    return win.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('dk-messages')!);
      return { image: cs.backgroundImage, size: cs.backgroundSize, repeat: cs.backgroundRepeat };
    });
  };
  for (const theme of ['light', 'dark']) {
    const bg = await stageIn(theme);
    ok(`the ${theme} stage paints the accent washes`,
      (bg.image.match(/radial-gradient/g) || []).length >= 3, bg.image.slice(0, 120));
    ok(`…and the 22px dot lattice under them`,
      /\b22px 22px\b/.test(bg.size) && /repeat/.test(bg.repeat),
      JSON.stringify({ size: bg.size, repeat: bg.repeat }));
  }
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await win.waitForTimeout(400);

  // ── The starter chips are the only thing an empty conversation shows ─────
  // Async: haSuggestPrompts → listDatasets.
  await win.waitForFunction(
    () => !(document.getElementById('dk-suggests') as HTMLElement).hidden, { timeout: 15_000 },
  ).catch(() => {});
  const chips: string[] = await win.evaluate(() =>
    [...document.querySelectorAll('#dk-suggests .dk-suggest')].map((c) => (c.textContent || '').trim()));
  ok('an empty conversation shows 2–3 starter chips built from the project’s real data',
    chips.length >= 2 && chips.length <= 3, JSON.stringify(chips));
  ok('…naming the dataset that is actually there, not a placeholder',
    chips.some((c) => c.indexOf(seeded.datasetName) >= 0), JSON.stringify(chips));
  // Pinned just above the composer, not floating mid-panel.
  const strip = await win.evaluate(() => {
    const s = document.getElementById('dk-suggests')!.getBoundingClientRect();
    const c = document.querySelector('.dk-composer')!.getBoundingClientRect();
    const m = document.getElementById('dk-messages')!.getBoundingClientRect();
    return { gap: Math.round(c.top - s.bottom), belowBody: Math.round(s.top - m.bottom) };
  });
  ok('…sitting directly above the composer, outside the scrolling stage',
    strip.gap >= 0 && strip.gap < 24 && strip.belowBody >= 0, JSON.stringify(strip));
  // A chip FILLS the composer. It must never auto-send — a suggestion is a draft.
  await win.click('#dk-suggests .dk-suggest', { timeout: 8000 });
  ok('clicking a chip fills the composer and sends nothing',
    (await win.inputValue('#dk-input')) === chips[0]
      && (await win.locator('#dk-messages .xp-msg').count()) === 0,
    await win.inputValue('#dk-input'));
  // A smoke run has no model, so the composer is disabled — clear it by
  // property, not by Playwright's fill (which refuses a disabled control).
  await win.evaluate(() => { (document.getElementById('dk-input') as HTMLTextAreaElement).value = ''; });

  // ── The chips follow the CONTEXT ────────────────────────────────────────
  // The user path: the Data section, then the dataset. openSavedDataset sets
  // expId/expName but does NOT switch section, and dkContextRef only claims a
  // dataset context while the Data section is the one on screen.
  await win.evaluate(() => (window as any).selectSection('datasets'));
  await win.waitForTimeout(600);
  await win.evaluate((id: string) => (window as any).openSavedDataset(id), seeded.datasetId);
  await win.waitForTimeout(1500);
  await win.evaluate(() => { (window as any).dkSetOpen(true); (window as any).dkSync(); });
  await win.waitForFunction(
    (name: string) => [...document.querySelectorAll('#dk-suggests .dk-suggest')]
      .some((c) => (c.textContent || '').indexOf(name) >= 0),
    seeded.datasetName, { timeout: 15_000 },
  ).catch(() => {});
  const scoped = await win.evaluate(() => ({
    chips: [...document.querySelectorAll('#dk-suggests .dk-suggest')].map((c) => (c.textContent || '').trim()),
    header: (document.getElementById('dk-context')!.textContent || '').trim(),
    ref: (window as any).dkContextRef(),
  }));
  ok('with a dataset open the chips lead with it, like the header does',
    scoped.chips.length > 0 && scoped.chips[0].indexOf(seeded.datasetName) >= 0, JSON.stringify(scoped));

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
  // The strip is hidden by a MutationObserver, whose callback runs at the end of
  // the microtask checkpoint — before the next paint, so there is no flash, but
  // after the evaluate above returns. Read it in its own round-trip.
  const chipsHidden = await win.evaluate(() => (document.getElementById('dk-suggests') as HTMLElement).hidden);
  ok('an action-only answer renders the app-written line, and NO "{" anywhere',
    painted.bubbles.join(' ').indexOf('{') < 0 && painted.bubbles.some((b: string) => b === empty),
    JSON.stringify(painted.bubbles));
  ok('…and the starter chips disappear once there is a turn (the observer fired)',
    chipsHidden === true, String(chipsHidden));
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

  // A new conversation brings them back — the empty state is a STATE, not a
  // first-run screen. The stage never went anywhere; only the chips toggle.
  await win.evaluate(() => (window as any).dkNew());
  await win.waitForSelector('#dk-suggests:not([hidden])', { timeout: 8000 });
  ok('"New conversation" restores the starter chips', await win.locator('#dk-suggests').isVisible());

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
