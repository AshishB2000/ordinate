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

  // ── The model chip mirrors execution state, and is the way to fix it ───────
  ok('the model chip says a model is needed, with none connected',
    /connect a model/i.test((await win.locator('#xp-model-chip').textContent()) || ''),
    (await win.locator('#xp-model-chip').textContent()) || '');

  ok('…and stays clickable, because it is how you connect one',
    await win.evaluate(() => !(document.getElementById('xp-model-chip') as HTMLButtonElement).disabled));

  await win.click('#xp-model-chip', { timeout: 8000 });
  await win.waitForTimeout(400);
  ok('clicking it opens the EXISTING exec-mode menu, not a second picker',
    await win.evaluate(() => {
      const m = document.getElementById('exec-menu');
      return Boolean(m && !(m as HTMLElement).hidden);
    }));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(250);

  // ── Scope: seed a project + dataset, then drive the dataset chip ───────────
  // The chooser is the app's shared dashChooseModal, so this also proves Explore
  // did not grow a bespoke modal.
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/projects.js');
    const datasets = req('./src/datasets.js');
    const copilot = req('./src/copilot.js');
    await projects.init();
    const proj = await projects.createProject('Explore smoke');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Revenue by month',
      sourceKind: 'csv',
      columns: [{ name: 'month', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['Jan', '10'], ['Feb', '20'], ['Mar', '30']],
    });
    // Seed a finished exchange so the transcript can be asserted WITHOUT a
    // model: the renderer path (renderCopilotTurns → provenance chips) is what
    // is under test here, and it reads from disk either way.
    await copilot.appendTurn(proj.id, { role: 'user', text: 'What is the trend in amount?' });
    await copilot.appendTurn(proj.id, {
      role: 'assistant',
      text: 'Amount rises across the three months.',
      provenance: { kind: 'dataset', name: 'Revenue by month', columns: ['month', 'amount'], note: 'stats app-computed' },
    });
    return { projectId: proj.id, datasetId: ds && ds.id };
  });

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1200);
  await win.evaluate(() => { (window as any).selectSection('explore'); });
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-messages .xp-msg').length >= 2,
    { timeout: 10_000 },
  );

  ok('a project with history opens straight into the transcript',
    await win.evaluate(() => {
      const p = document.getElementById('ws-explore');
      return Boolean(p && p.classList.contains('xp-asked'));
    }));
  ok('…rendering both turns into Explore’s own container',
    (await win.locator('#xp-messages .xp-msg').count()) === 2,
    `${await win.locator('#xp-messages .xp-msg').count()} bubbles`);
  ok('…with the provenance chips that say where the figures came from',
    (await win.locator('#xp-messages .xp-provenance .xp-prov-chip').count()) > 0);
  ok('…including the app-computed note, so the model is never credited with the math',
    /app-computed/i.test((await win.locator('#xp-messages .xp-provenance').first().textContent()) || ''));
  ok('the greeting is collapsed once there is a conversation',
    await win.evaluate(() => {
      const g = document.getElementById('xp-greet');
      return Boolean(g && g.getBoundingClientRect().height < 2);
    }));

  // The context chip defaults to whole-project scope and says so.
  ok('the context chip defaults to whole-project scope, and says so',
    /whole project/i.test((await win.locator('#xp-context-chip').textContent()) || ''),
    (await win.locator('#xp-context-chip').textContent()) || '');

  await win.click('#xp-context-chip', { timeout: 8000 });
  await win.waitForSelector('#xp-picker:not([hidden])', { timeout: 8000 });
  ok('it opens the picker, not a modal chooser',
    (await win.locator('.ws-modal-overlay:not([id])').count()) === 0);
  ok('…with "Whole project" pinned at the top as the always-available clear',
    /whole project/i.test((await win.locator('#xp-picker-rows .gs-hit').first().textContent()) || ''),
    (await win.locator('#xp-picker-rows .gs-hit').first().textContent()) || '');
  // An empty query shows the recent handful, not nothing — the seeded dataset is
  // in the recent list, so there is at least one row under the pinned clear.
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-picker-rows .gs-hit').length > 1,
    { timeout: 8000 },
  );
  ok('…and the recent handful under it, so an empty query is not an empty list',
    (await win.locator('#xp-picker-rows .gs-hit').count()) > 1,
    `${await win.locator('#xp-picker-rows .gs-hit').count()} rows`);

  // Search-as-you-type, over the SAME search:query channel the sidebar box uses.
  await win.fill('#xp-picker-q', 'Revenue');
  await win.waitForFunction(
    () => [...document.querySelectorAll('#xp-picker-rows .gs-hit')]
      .some((n) => /Revenue by month/.test(n.textContent || '')),
    { timeout: 8000 },
  );
  await win.locator('#xp-picker-rows .gs-hit')
    .filter({ hasText: 'Revenue by month' }).first()
    .dispatchEvent('mousedown');
  // state:'hidden' — the default is 'visible', which would wait forever for a
  // [hidden] element to become visible.
  await win.waitForSelector('#xp-picker', { state: 'hidden', timeout: 8000 });
  ok('picking a dataset relabels the chip with its name',
    /Revenue by month/.test((await win.locator('#xp-context-chip').textContent()) || ''),
    (await win.locator('#xp-context-chip').textContent()) || '');
  ok('…with the kind glyph the sidebar’s search results already use',
    (await win.locator('#xp-context-chip .gs-glyph').textContent()) === '▦',
    (await win.locator('#xp-context-chip .gs-glyph').textContent()) || '');
  ok('…and a full-sentence tooltip saying what is in scope',
    /^Every question is answered about the dataset .+click to point Explore at something else\.$/
      .test((await win.locator('#xp-context-chip').getAttribute('title')) || ''),
    (await win.locator('#xp-context-chip').getAttribute('title')) || '');

  // ── Anything, not just a dataset ───────────────────────────────────────────
  // The point of the phase: a dashboard is not a dataset, and xpContextRef has to
  // hand copilot:ask that kind — the channel has always taken { kind, id }.
  await app.evaluate(async (_electronModule, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const dashboards = req('./src/dashboards.js');
    await dashboards.saveDashboard(pid, { name: 'Quarter review' });
  }, seeded.projectId);

  await win.click('#xp-context-chip', { timeout: 8000 });
  await win.waitForSelector('#xp-picker:not([hidden])', { timeout: 8000 });
  await win.fill('#xp-picker-q', 'Quarter');
  await win.waitForFunction(
    () => [...document.querySelectorAll('#xp-picker-rows .gs-hit')]
      .some((n) => /Quarter review/.test(n.textContent || '')),
    { timeout: 8000 },
  );
  await win.locator('#xp-picker-rows .gs-hit')
    .filter({ hasText: 'Quarter review' }).first()
    .dispatchEvent('mousedown');
  // state:'hidden' — the default is 'visible', which would wait forever for a
  // [hidden] element to become visible.
  await win.waitForSelector('#xp-picker', { state: 'hidden', timeout: 8000 });
  ok('Explore can be pointed at a dashboard, and the chip names it',
    /Quarter review/.test((await win.locator('#xp-context-chip').textContent()) || ''),
    (await win.locator('#xp-context-chip').textContent()) || '');
  ok('…and the ref handed to copilot:ask carries that kind, not "dataset"',
    await win.evaluate(() => {
      const ref = (window as any).xpContextRef();
      return ref.kind === 'dashboard' && Boolean(ref.id) && ref.label === 'dashboard · Quarter review';
    }));

  // Back to whole project via the pinned clear — the chip must be resettable.
  await win.click('#xp-context-chip', { timeout: 8000 });
  await win.waitForSelector('#xp-picker:not([hidden])', { timeout: 8000 });
  await win.locator('#xp-picker-rows .gs-hit').first().dispatchEvent('mousedown');
  // state:'hidden' — the default is 'visible', which would wait forever for a
  // [hidden] element to become visible.
  await win.waitForSelector('#xp-picker', { state: 'hidden', timeout: 8000 });
  ok('the pinned "Whole project" row clears the scope again',
    await win.evaluate(() => {
      const ref = (window as any).xpContextRef();
      return ref.kind === '' && ref.id === '' && ref.label === 'whole project';
    }));

  // Put a dataset back in scope — the chart assertions below need one.
  await win.click('#xp-context-chip', { timeout: 8000 });
  await win.waitForSelector('#xp-picker:not([hidden])', { timeout: 8000 });
  await win.fill('#xp-picker-q', 'Revenue');
  await win.waitForFunction(
    () => [...document.querySelectorAll('#xp-picker-rows .gs-hit')]
      .some((n) => /Revenue by month/.test(n.textContent || '')),
    { timeout: 8000 },
  );
  await win.locator('#xp-picker-rows .gs-hit')
    .filter({ hasText: 'Revenue by month' }).first()
    .dispatchEvent('mousedown');
  // state:'hidden' — the default is 'visible', which would wait forever for a
  // [hidden] element to become visible.
  await win.waitForSelector('#xp-picker', { state: 'hidden', timeout: 8000 });

  // ── The chart path (exploreChart.ts) ──────────────────────────────────────
  // A full run needs a model, which a smoke run has none of. What IS assertable
  // — and what actually breaks silently — is that the script loaded at all, and
  // that its documented contract holds: every failure is silent, so an answer
  // never gets an error card bolted under it for an extra nobody asked for.
  ok('the chart script loaded (a missing <script src> fails silently otherwise)',
    await win.evaluate(() => typeof (window as any).xpMaybeRenderChart === 'function'));

  // A dataset IS in scope by now (the chip test above picked one), so this runs
  // the real path as far as it can go: visual:suggest answers notReady with no
  // model connected. That is the branch a first-run user hits every time.
  const beforeCharts = await win.locator('#xp-messages .xp-chart').count();
  const threw = await win.evaluate(async () => {
    try {
      await (window as any).xpMaybeRenderChart('what is the trend?');
      return false;
    } catch (_) {
      return true;
    }
  });
  ok('…and a notReady suggestion is silent, not an error', !threw);
  ok('…painting nothing under the answer',
    (await win.locator('#xp-messages .xp-chart').count()) === beforeCharts);

  // ── Conversations ─────────────────────────────────────────────────────────
  ok('the strip becomes Conversations once the project has one',
    /conversations/i.test((await win.locator('#xp-jump-h').textContent()) || ''),
    (await win.locator('#xp-jump-h').textContent()) || '');
  ok('…listing it, titled from the first question asked',
    /What is the trend in amount\?/.test((await win.locator('#xp-jump-rows').textContent()) || ''),
    (await win.locator('#xp-jump-rows').textContent()) || '');
  ok('…and offering a way to start a fresh one', await win.locator('#xp-new-thread').isVisible());

  await win.click('#xp-new-thread', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-messages .xp-msg').length === 0,
    { timeout: 8000 },
  );
  ok('starting a new conversation clears the transcript', true);
  ok('…and returns the stage to its blank slate',
    await win.evaluate(() => {
      const p = document.getElementById('ws-explore');
      return Boolean(p && !p.classList.contains('xp-asked'));
    }));
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-jump-rows .xp-jump-row').length >= 2,
    { timeout: 8000 },
  );
  ok('…leaving the previous conversation listed, not replaced',
    (await win.locator('#xp-jump-rows .xp-jump-row').count()) >= 2,
    `${await win.locator('#xp-jump-rows .xp-jump-row').count()} rows`);

  // Resume the older conversation — its turns come back.
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#xp-jump-rows .xp-jump-row')] as HTMLElement[];
    const older = rows.find((r) => /What is the trend in amount\?/.test(r.textContent || ''));
    if (older) older.click();
  });
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-messages .xp-msg').length === 2,
    { timeout: 8000 },
  );
  ok('clicking a past conversation resumes it with its turns intact',
    (await win.locator('#xp-messages .xp-msg').count()) === 2);


  // ── A pre-threads copilot.json still loads (schemaVersion 1 → 2) ──────────
  // The migration is unit-tested in scripts/test-copilot-threads.ts; what only a
  // real run can prove is that a file written by the SHIPPED previous version is
  // still readable through the IPC the renderer actually calls.
  const legacy: any = await app.evaluate(async (electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const nodeFs = req('fs');
    const nodePath = req('path');
    const projects = req('./src/projects.js');
    const copilot = req('./src/copilot.js');
    const proj = await projects.createProject('Legacy chat');
    // Exactly the v1 shape: { projectId, turns, schemaVersion: 1 }.
    const file = nodePath.join(
      electronModule.app.getPath('userData'), 'projects', proj.id, 'copilot.json',
    );
    nodeFs.writeFileSync(file, JSON.stringify({
      projectId: proj.id,
      schemaVersion: 1,
      turns: [
        { id: 'a', role: 'user', text: 'Legacy question', createdAt: new Date().toISOString() },
        { id: 'b', role: 'assistant', text: 'Legacy answer', createdAt: new Date().toISOString() },
      ],
    }, null, 2), 'utf8');
    const threads = await copilot.listThreads(proj.id);
    const turns = await copilot.loadHistory(proj.id);
    return { projectId: proj.id, threadCount: threads.length, title: threads[0] && threads[0].title, turns: turns.map((t: any) => t.text) };
  });
  ok('a pre-threads copilot.json migrates to exactly one conversation',
    legacy.threadCount === 1, `${legacy.threadCount} threads`);
  ok('…titled from its first user turn', legacy.title === 'Legacy question', String(legacy.title));
  ok('…with its history intact and in order',
    legacy.turns.length === 2 && legacy.turns[0] === 'Legacy question' && legacy.turns[1] === 'Legacy answer',
    legacy.turns.join(' | '));

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), legacy.projectId);
  await win.waitForTimeout(1000);
  await win.evaluate(() => { (window as any).selectSection('explore'); });
  await win.waitForFunction(
    () => document.querySelectorAll('#xp-messages .xp-msg').length === 2,
    { timeout: 10_000 },
  );
  ok('…and the migrated conversation renders in Explore', true);

  // ── The old Copilot panel is gone, not merely unwired ─────────────────────
  ok('the ws-ai panel no longer exists in the document',
    (await win.locator('#ws-ai').count()) === 0);
  ok('…and none of its ids are left behind',
    await win.evaluate(() =>
      ['ai-messages', 'ai-input', 'ai-send', 'ai-toggle', 'ai-clear', 'ai-empty', 'ai-context', 'ai-hint']
        .every((id) => document.getElementById(id) === null)));

  // The AI tool button is the third door into the one chat surface.
  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(300);
  await win.click('#side-ai-btn', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelector('.hub-body')?.getAttribute('data-section') === 'explore',
    { timeout: 8000 },
  );
  ok('the sidebar AI button opens Explore, not a retired section',
    (await sectionOf(win)) === 'explore');

  // The hard OFF switch came across with the feature. It was the panel's only
  // control; losing it would have stranded anyone who had AI switched off.
  ok('the AI on/off switch survived the panel it used to live on',
    await win.locator('#xp-ai-toggle').isVisible());
  ok('…reading On by default', /AI: On/.test((await win.locator('#xp-ai-toggle').textContent()) || ''));

  await win.click('#xp-ai-toggle', { timeout: 8000 });
  await win.waitForFunction(
    () => /AI: Off/.test(document.getElementById('xp-ai-toggle')?.textContent || ''),
    { timeout: 8000 },
  );
  ok('turning AI off is reflected in the switch', true);

  await win.click('#xp-ai-toggle', { timeout: 8000 });
  await win.waitForFunction(
    () => /AI: On/.test(document.getElementById('xp-ai-toggle')?.textContent || ''),
    { timeout: 8000 },
  );
  ok('…and it can be turned back on — the route back still exists', true);

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
