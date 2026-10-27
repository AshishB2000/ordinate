// E2E (T2.12): the Assistant dock against the real server and a STUB model
// provider on loopback (./dockStub.ts: an Anthropic Messages API look-alike in
// this process — no real network call is made).
//
// Without DATABASE_URL: the dock opens from the top bar onto its designed
// not-set-up state — "AI isn't set up", and for this admin the operator line
// (no database, so no key can be stored) instead of a key field. Screens in
// both themes.
//
// With DATABASE_URL (its own scratch database, header sign-in as the org
// admin, a master key): AI is set up the way Admin → AI does it (ai:connect,
// ai:setModels — the tab's own walk is admin.e2e.ts), then the dock's model
// picker offers both models and saves the pick, "Powered by" names it, the
// stub is asked with it, and the answer STREAMS into the pending bubble token
// by token over this tab's event stream; then a plan whose import step is fed
// by an upload (T0.4 — the server has no file picker) runs to the
// app-computed KPI; a follow-up whose reply is a REFINE changes the answer on
// screen, its card showing the filter it kept beside the one it added; and a
// reply that proposes a dashboard ASKS FIRST — the
// brief (shape and look), then the model's own questions, once — drafts it from
// the answers, shows the review, and creates it on the click, in the look that
// was picked. Zero console errors throughout; screens in both themes.
//
// The context follows the screen (both modes): beside a saved visual the
// header names that visual from the page's own `visual:get` and a question
// carries `{ kind: 'visual', id }` (the half CI runs: it has no database);
// there too, with no model, an Explain card is saved as a visual (the button,
// then the link to the visual's own page, at the dock's 340px) and an answer
// with no rows offers the stored values its filter may have meant ("Did you
// mean"), one of which runs as the app's own chart;
// beside the open dashboard a question carries `{ kind: 'analysis', id }`, and
// the facts the model is sent are that dashboard's, its KPI the app's own sum.

import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';
import type { Page } from 'playwright';
// The provider stub and what it was asked; the four it reassigns or appends to are read live.
import { ANSWER, ASK_CHART, ASK_MISS, ASK_REFINE, ON_SCREEN, ON_SCREEN_ANSWER, askedModels, draftAsk, draftCalls, lastAsk, stubUrl } from './dockStub.ts';

const ADMIN = 'boss@acme.test';

async function openDock(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the Assistant' }).waitFor();
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  const { e2e, screens, settled, SCREENS } = await import('./fixtures.ts');
  e2e('dock: opens from the top bar onto the not-set-up state (no database → no key field)', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await openDock(page);
    const setup = page.getByTestId('dock-setup');
    await setup.getByText(/AI isn’t set up for your organization yet/).waitFor();
    await setup.getByText(/no database, so it cannot store API keys/).waitFor();
    assert.equal(await page.getByLabel('API key').count(), 0, 'no key field in the dock, ever');
    assert.equal(await setup.getByRole('link', { name: /Set up AI/ }).count(), 0, 'no Set up button where nothing can be set up');
    assert.equal(await page.getByRole('textbox', { name: 'Ask the Assistant' }).isDisabled(), true);
    await screens(page, 'dock-setup');
    // The left edge is a handle the pointer can find: it runs the panel's height
    // (it was 0 x 0 once), drags the panel wider, and a double-click restores the default.
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    const edge = await dock.getByRole('separator', { name: 'Resize the Assistant panel' }).boundingBox();
    const start = await dock.boundingBox();
    assert.ok(edge && start && edge.height === start.height, `the resize handle spans the panel (${JSON.stringify(edge)})`);
    const y = edge.y + edge.height / 2;
    await page.mouse.move(edge.x, y);
    await page.mouse.down();
    await page.mouse.move(edge.x - 60, y, { steps: 4 });
    await page.mouse.up();
    assert.equal(Math.round((await dock.boundingBox())?.width ?? 0), Math.round(start.width) + 60, 'dragging the edge left widens the panel by the drag');
    await page.mouse.dblclick(edge.x - 60, y);
    assert.equal(Math.round((await dock.boundingBox())?.width ?? 0), 340, 'a double-click restores the default width');
    // Escape closes it and hands focus back to the toggle.
    await page.keyboard.press('Escape');
    await page.getByRole('complementary', { name: 'Assistant' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dock-toggle');
  });

  // The context follows the screen (dockRoute.ts). No model is needed to see what a question WOULD be about.
  e2e('dock: beside a saved visual the header names it; a new draft is the whole project', async ({ page, server, rpc }) => {
    const pid = server.sample.projectId;
    await page.goto('/');
    await settled(page);
    await openDock(page); // remembered: the dock is open on every load from here
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const listed = await page.request.post(`${server.base}/api/rpc/visual:list`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId: pid }] } });
    // By name, never by position: the sample's first visual is a map, and a map fetches OpenStreetMap tiles (maps.e2e.ts answers them locally).
    const visual = ((await listed.json()) as { id: string; name: string }[]).find((v) => v.name === 'Revenue by category');
    assert.ok(visual, 'the sample project has the visual "Revenue by category"');
    let gets = 0;
    page.on('request', (r) => {
      if (decodeURIComponent(new URL(r.url()).pathname) === '/api/rpc/visual:get') gets += 1;
    });
    // This server has no model (no database to keep a key in). `ai:status` is answered as ready at the browser's edge,
    // so the composer sends and the REQUEST can be read: what a question here is about. The server's reply stays its own.
    const ready = JSON.stringify({ ready: true, models: [{ provider: 'anthropic', model: 'stub', label: 'Stub', isDefault: true }], mine: { provider: 'anthropic', model: 'stub' }, copilotEnabled: true, keyStore: null });
    await page.route('**/api/rpc/ai%3Astatus', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: ready }));
    await page.goto(`/visuals/${pid}/${visual.id}`);
    await page.waitForFunction(() => document.querySelector('[data-chart-type] canvas')); // the builder has drawn it
    const chip = page.getByTestId('dock-context');
    await page.waitForFunction((name) => document.querySelector('[data-testid="dock-context"]')?.textContent === name, visual.name);
    assert.equal(await chip.getAttribute('title'), `Answers are based on visual · ${visual.name}`);
    // The name is the page's own read of the visual: the dock, open from the first paint, asked for nothing.
    assert.equal(gets, 1, `visual:get was asked ${gets} times`);
    console.log(`rpc  ${String(rpc.loads.at(-1)?.rpcs).padStart(2)}  a saved visual, the dock open`);
    // Its own starter questions, by name; the screenshots show them under the header.
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    await dock.getByRole('button', { name: `What does ${visual.name} show?` }).waitFor();
    await screens(page, 'dock-on-visual');
    const box = page.getByRole('textbox', { name: 'Ask the Assistant' });
    const sent = page.waitForRequest((r) => decodeURIComponent(new URL(r.url()).pathname) === '/api/rpc/copilot:ask');
    await box.fill('What stands out?');
    await box.press('Enter');
    const about = ((await sent).postDataJSON() as { args: [{ projectId: string; context: unknown }] }).args[0];
    assert.deepEqual([about.projectId, about.context], [pid, { kind: 'visual', id: visual.id }], 'a question beside a saved visual is about that visual');
    await page.unroute('**/api/rpc/ai%3Astatus');
    // Negative control: a new visual is nothing saved yet — the whole project, and still this one.
    await page.goto(`/visuals/${pid}/new`);
    await page.getByRole('textbox', { name: 'Ask the Assistant' }).waitFor();
    await page.getByRole('radiogroup').first().waitFor(); // the builder is up, on a draft
    assert.equal(await chip.textContent(), 'whole project');
  });

  // An answer is kept, and an empty one is not a dead end — with no model: "Explain" draws the card from the app's facts.
  e2e('dock: an Explain card is saved as a visual; an answer with no rows offers the values the data holds', async ({ page, server }) => {
    const pid = server.sample.projectId;
    await page.goto(`/visuals/${pid}`);
    await settled(page);
    await page.getByRole('button', { name: 'More actions for Revenue by category' }).click();
    await page.getByRole('menuitem', { name: 'Explain' }).click();
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    const card = dock.getByTestId('answer-card').last();
    await card.locator('canvas').waitFor();
    assert.equal(Math.round((await dock.boundingBox())?.width ?? 0), 340, 'the dock at its default width');
    /** The card in both themes, switched in place: a saved card is this panel's state, which a reload would drop. */
    const shots = async (name: string) => {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await page.waitForTimeout(300); // the colour transition
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
      }
    };
    const save = card.getByRole('button', { name: 'Save as visual' });
    await save.waitFor(); // this member may edit (dev sign-in is an admin)
    await shots('dock-save-visual');
    const sent = page.waitForRequest((r) => decodeURIComponent(new URL(r.url()).pathname) === '/api/rpc/answer:saveVisual');
    await save.click();
    assert.deepEqual(
      Object.keys(((await sent).postDataJSON() as { args: [Record<string, unknown>] }).args[0]),
      ['projectId', 'spec', 'threadId', 'turnId'],
      'the browser sends the spec and which turn it is — nothing else',
    );
    const open = card.getByRole('link', { name: 'Open in Visuals' });
    await open.waitFor();
    const href = (await open.getAttribute('href')) ?? '';
    assert.match(href, new RegExp(`^/visuals/${pid}/[0-9a-f-]{36}$`));
    await shots('dock-saved-visual');
    // A reload forgets the page, not the save: the turn records the visual, so the card links to it again.
    await page.reload();
    await settled(page);
    const again = dock.getByTestId('answer-card').last().getByRole('link', { name: 'Open in Visuals' });
    await again.waitFor();
    assert.equal(await again.getAttribute('href'), href, 'after a reload the card links to the same visual');

    // A visual of the project now, made by the server from the card: its title, its type, its encoding.
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (channel: string, input: unknown) =>
      (await (await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [input] } })).json()) as Record<string, unknown>;
    const kept = (await call('visual:get', { projectId: pid, id: href.split('/').pop() })) as { name: string; chartType: string; datasetId: string; encoding: { category: string } };
    assert.deepEqual([kept.name, kept.chartType, kept.encoding.category], ['Revenue by category', 'column', 'category']);
    await open.click();
    await page.waitForURL(`**${href}`);
    await page.waitForFunction(() => document.querySelector('[data-chart-type] canvas')); // its own page draws it

    // A tile whose filter names a value no row holds ("New"), explained: no chart, the server's sentence, and
    // the stored values it may have meant. A click runs one — the app's chart, no model.
    const explained = await call('answer:explain', {
      projectId: pid,
      tile: { datasetId: kept.datasetId, encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] }, filters: [{ type: 'filter', column: 'state', op: '=', value: 'New' }], chartType: 'column', name: 'Revenue in New' },
    });
    assert.equal(explained.ok, true, JSON.stringify(explained));
    await page.goto(`/visuals/${pid}`);
    await settled(page);
    const empty = dock.getByTestId('answer-no-match');
    await empty.getByText('No rows match state = "New".', { exact: true }).waitFor();
    const meant = empty.getByRole('group', { name: 'Did you mean' }).getByRole('button');
    assert.deepEqual((await meant.allTextContents()).sort(), ['New Jersey', 'New York'], 'the stored values "New" begins');
    await screens(page, 'dock-did-you-mean');
    await empty.getByRole('button', { name: 'New York' }).click();
    const ran = dock.getByTestId('answer-card').last();
    await ran.getByText('state = New York', { exact: true }).waitFor();
    await ran.locator('canvas').waitFor();
  });
} else {
  const dbName = `ordinate_e2e_dock_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, screens, settled, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      // The stub provider is on loopback, which the SSRF guard refuses unless allowlisted (T6.1).
      SSRF_ALLOW: '127.0.0.1/32',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('dock: pick a model, stream an answer into the dock, run a plan fed by an upload', async ({ page, server }) => {
    // Records live in Postgres here: make the project over RPC.
    // Any GET hands the context its CSRF cookie (T6.2); the POST repeats it, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const made = await page.request.post(`${server.base}/api/rpc/projects:create`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ name: 'Ledger' }] } });
    assert.equal(made.status(), 200);

    // ── Set up, as Admin → AI does: connect the stub, enable two models ──────
    const rpc = async (channel: string, input: unknown) => {
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [input] } });
      return (await r.json()) as { ok: boolean };
    };
    assert.equal((await rpc('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    const models = [
      { provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' },
      { provider: 'anthropic', model: 'claude-haiku-stub', label: 'Claude Haiku Stub' },
    ];
    assert.equal((await rpc('ai:setModels', { models, defaultIndex: 0 })).ok, true);

    // ── The picker: both models, the default marked; the pick is saved ──────
    await page.goto('/');
    await settled(page);
    await openDock(page);
    const box = page.getByRole('textbox', { name: 'Ask the Assistant' });
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
    assert.equal(await page.getByLabel('API key').count(), 0, 'no key field in the dock, ever');
    await page.getByText('Powered by Claude Sonnet Stub').waitFor();
    await page.getByRole('combobox', { name: 'Model' }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Claude Sonnet Stub · Default', 'Claude Haiku Stub']);
    await page.getByRole('option', { name: 'Claude Haiku Stub' }).click();
    await page.getByText('Powered by Claude Haiku Stub').waitFor();
    await screens(page, 'dock-picker');

    // ── Ask: the answer streams in, then is the stored turn ──────────────────
    await page.reload();
    await settled(page);
    await box.waitFor();
    await box.fill('What is in this project?');
    await box.press('Enter');
    const partial = await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dock-pending"]');
      return el && el.className.includes('streaming') ? el.textContent : null;
    });
    const seen = String(await partial.jsonValue());
    assert.ok(seen.length > 0 && seen.length < ANSWER.join('').length, `a PARTIAL answer was on screen while streaming (${JSON.stringify(seen)})`);
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    await dock.getByText(ANSWER.join(''), { exact: true }).waitFor();
    assert.equal(askedModels.at(-1), 'claude-haiku-stub', 'the question went to the member\'s pick, which survived the reload');
    await dock.getByText(/stats app-computed$/).first().waitFor();
    await page.getByRole('button', { name: /Scanned the project/ }).waitFor(); // the app's work, collapsed above the answer
    // The reply proposed bringing data in: the three ways in, as links into this project.
    const ways = page.getByTestId('dock-get-data');
    assert.deepEqual(await ways.getByRole('link').allTextContents(), ['Import a file', 'Paste data', 'Connect a source']);
    assert.match((await ways.getByRole('link', { name: 'Import a file' }).getAttribute('href')) ?? '', /^\/data\/import\?project=[0-9a-f-]{36}$/);
    // Like a plan card, the buttons are not persisted: switch the theme in place, then let screens() reload.
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(300); // the colour transition, or the shot catches the buttons mid-fade
      await page.screenshot({ path: path.join(SCREENS, `dock-get-data-${theme}.png`), fullPage: true });
    }
    await screens(page, 'dock-answer');

    // ── A plan: its import step reads an upload ─────────────────────────────
    await box.fill('Make a plan for my sales file');
    await box.press('Enter');
    const card = page.getByTestId('plan-card');
    await card.getByText('Plan — 2 steps').waitFor();
    await card.getByRole('button', { name: 'Run all' }).click();
    await card.getByText('Choose the file for step 1.').waitFor();
    await page.setInputFiles('input[aria-label="File to import"]', {
      name: 'sales.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('region,revenue\nWest,1200\nEast,800\nNorth,500\n'),
    });
    await card.getByRole('link', { name: 'Sales' }).waitFor();
    // The KPI is the app's: sum of revenue = 2,500, formatted by the server.
    await card.getByText('Total revenue', { exact: true }).first().waitFor();
    const kpi = (await card.getByText('Total revenue', { exact: true }).first().locator('xpath=..').textContent()) ?? '';
    assert.match(kpi, /^Total revenue2[,.]?500$|^Total revenue2\.5K$/, `the KPI chip carries the app's sum (${kpi})`);
    await card.getByRole('button', { name: 'Undo run' }).waitFor();
    // A plan card is never persisted (a reload drops it, as on the desktop), so
    // these two screens switch the theme in place instead of reloading.
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENS, `dock-plan-${theme}.png`), fullPage: true });
    }

    // ── @ points the Assistant at one thing ─────────────────────────────────
    // Typed where a word starts it opens the picker and is not kept; the chip
    // names the pick, and the answer's provenance is THAT dataset — the
    // reference reached the server, which built its facts from it.
    await box.pressSequentially('Tell me about @');
    const picker = page.getByRole('dialog', { name: 'Point the Assistant at' });
    await picker.getByRole('textbox', { name: 'Search the project' }).fill('sal');
    await picker.getByRole('button', { name: 'Sales' }).waitFor();
    await page.keyboard.press('Enter');
    await picker.waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('dock-context').textContent(), 'Sales');
    assert.equal(await box.inputValue(), 'Tell me about ', 'the @ opened the picker and was not typed');
    // Focus comes back to the composer (a tick after the picker goes), not to the @ button.
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ask the Assistant');
    // The pin is this panel's own state (a reload returns to the screen's context), so no reload here either.
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.screenshot({ path: path.join(SCREENS, `dock-context-${theme}.png`), fullPage: true });
    }
    await box.pressSequentially('it');
    await box.press('Enter');
    await dock.getByText(/^dataset: Sales · /).waitFor();

    // ── A follow-up refines the answer on screen ────────────────────────────
    // The first answer leaves one region out. The follow-up's reply is a REFINE
    // that carries only the new filter: the model was told what the chart is, by
    // name, and the app merged the change — so the second card shows BOTH filters.
    await page.reload();
    await settled(page);
    await box.fill(ASK_CHART);
    await box.press('Enter');
    const answersShown = dock.getByTestId('answer-card');
    await answersShown.first().getByText('region != North', { exact: true }).waitFor();
    assert.doesNotMatch(lastAsk, /PREVIOUS ANSWER/, 'the first question of the chart is told of no previous answer');
    await box.fill(ASK_REFINE);
    await box.press('Enter');
    const refined = answersShown.nth(1);
    await refined.getByText('revenue > 900', { exact: true }).waitFor();
    assert.equal(await refined.getByText('region != North', { exact: true }).count(), 1, 'the carried filter is still on the refined card');
    assert.equal(await answersShown.first().getByText('revenue > 900', { exact: true }).count(), 0, 'the first card is the first answer, untouched');
    // The app told the model what the chart was — names only — and the figure is the app's: only West is above 900.
    assert.match(lastAsk, /PREVIOUS ANSWER[^]*dataset \\"Sales\\"; category \\"region\\"; measures sum\(revenue\); filters: \\"region\\" != \\"North\\"; chart column\./);
    assert.doesNotMatch(lastAsk.slice(lastAsk.indexOf('PREVIOUS ANSWER')), /1[,.]?200|800/, 'no figure of the card is in the block');
    await refined.getByText('Highest · West', { exact: true }).waitFor();
    await refined.locator('canvas').waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await refined.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300); // the colour transition
      await page.screenshot({ path: path.join(SCREENS, `dock-follow-up-${theme}.png`), fullPage: true });
    }

    // ── A name corrected once holds ─────────────────────────────────────────
    // The model writes "net revenue"; the data calls it revenue. The refused reply offers it, the answer
    // that option runs offers to remember the name, and the same question then charts outright.
    const cardsBefore = await answersShown.count();
    await box.fill(ASK_MISS);
    await box.press('Enter');
    const meant = dock.getByRole('group', { name: 'Did you mean, instead of net revenue' });
    await meant.getByRole('button', { name: 'revenue', exact: true }).click();
    const corrected = answersShown.nth(cardsBefore);
    const remember = corrected.getByRole('button', { name: 'Remember “net revenue” as revenue' });
    await remember.waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await corrected.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300); // the colour transition
      await page.screenshot({ path: path.join(SCREENS, `dock-remember-${theme}.png`), fullPage: true });
    }
    await remember.click();
    await corrected.getByText('“net revenue” now means revenue in this project.', { exact: true }).waitFor();
    await box.fill(ASK_MISS);
    await box.press('Enter');
    await answersShown.nth(cardsBefore + 1).locator('canvas').waitFor();
    assert.equal(await dock.getByRole('group', { name: /^Did you mean/ }).count(), 1, 'asked again, the same words chart outright — no second "Did you mean"');

    // ── Rename and delete a conversation ────────────────────────────────────
    // ⋯ renames the one on screen; the header then shows the STORED name, which a
    // reload proves. History's row deletes it after asking, and its turns go with it.
    await page.reload();
    await settled(page);
    await dock.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Rename conversation' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename conversation' });
    assert.equal(await rename.getByRole('textbox', { name: 'Name' }).inputValue(), 'What is in this project?', 'the dialog opens on the name its first question gave it');
    await rename.getByRole('textbox', { name: 'Name' }).fill('Ledger review');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await dock.getByRole('button', { name: 'Conversations — Ledger review' }).waitFor();
    await page.reload();
    await settled(page);
    await dock.getByRole('button', { name: 'Conversations — Ledger review' }).waitFor();
    await dock.getByText(ANSWER.join(''), { exact: true }).first().waitFor(); // the stub gave the same answer twice

    await dock.getByRole('button', { name: 'Conversation history' }).click();
    const history = page.getByRole('dialog', { name: 'Conversation history' });
    await history.getByTestId('history-row').first().hover(); // the row's actions show under the pointer
    await history.getByRole('button', { name: 'Delete Ledger review' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this conversation?' });
    await confirm.getByText(/“Ledger review” and everything in it will be removed/).waitFor();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await dock.getByRole('button', { name: 'Conversations — New conversation' }).waitFor();
    assert.equal(await dock.getByText(ANSWER.join(''), { exact: true }).count(), 0, 'the deleted conversation\'s turns are gone from the dock');

    // ── A dashboard: it asks first, drafts from the answers, is reviewed, and is created on the click ──
    await page.reload();
    await settled(page);
    await box.fill('Build a regional dashboard');
    await box.press('Enter');
    /** The dialog on screen, in both themes (it is this panel's state: a reload would drop it). */
    const shots = async (name: string) => {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
      }
    };

    // The brief — shape and look — is there at once: no model has been asked to draft.
    const brief = page.getByRole('dialog', { name: 'Draft a dashboard' });
    const shapes = brief.getByRole('radiogroup', { name: 'Shape' });
    await shapes.waitFor();
    assert.equal(draftCalls.length, 0, 'the brief asks no model');
    assert.deepEqual(await shapes.getByRole('radio').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)), ['auto', 'scorecard', 'review', 'visual', 'table']);
    assert.equal(await shapes.getByRole('radio', { name: /^Assistant picks/ }).isChecked(), true, 'the Assistant picks the shape unless the person does');
    assert.equal(await brief.getByRole('radio', { name: /^Workspace default/ }).isChecked(), true, 'the workspace default is the default look');
    // A real radio group: one arrow key moves the pick to the next shape.
    await shapes.getByRole('radio', { name: /^Assistant picks/ }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await shapes.getByRole('radio', { name: /^Scorecard/ }).isChecked(), true, 'the arrow keys move within the group');
    await brief.getByRole('radio', { name: /^Dark/ }).check();
    await shots('dock-draft-brief');
    await brief.getByRole('button', { name: 'Draft dashboard' }).click();

    // The model's own questions: answer one, leave one.
    const ask = page.getByRole('dialog', { name: 'A few questions first' });
    const measure = ask.getByRole('radiogroup', { name: 'Which measure matters most?' });
    await measure.waitFor();
    assert.equal(await ask.getByRole('radio').count(), 5, 'two questions, with two and three options');
    assert.equal(await ask.getByRole('button', { name: 'Continue' }).isDisabled(), true, 'nothing is answered for the user');
    await ask.getByRole('button', { name: 'Skip — just build it' }).waitFor();
    await measure.getByRole('radio', { name: 'Revenue' }).check();
    await shots('dock-draft-questions');
    await ask.getByRole('button', { name: 'Continue' }).click();

    const review = page.getByRole('dialog', { name: 'Assistant draft — review before creating' });
    await review.getByText('Revenue by region', { exact: true }).waitFor();
    await review.locator('canvas').first().waitFor(); // the app drew it, from its own figures
    assert.deepEqual(draftCalls.map((c) => c.asking), [true, false], 'it asked once: the call that carried the answers could not ask again');
    assert.match(draftAsk, /revenue by region/, 'the draft was asked for what the reply proposed');
    assert.match(draftAsk, /The user chose this dashboard shape\. .*SCORECARD/, 'the shape picked in the brief is in the facts, as the app\'s sentence');
    assert.match(draftAsk, /Which measure matters most\? → Revenue/, 'the answer is in the facts');
    assert.doesNotMatch(draftAsk, /How should the regions be compared/, 'a question left unanswered is not sent');
    assert.doesNotMatch(draftCalls.map((c) => c.facts).join('\n'), /dark/i, 'the look never goes to the model');
    await shots('dock-draft');
    await review.getByRole('button', { name: 'Create dashboard' }).click();
    await page.waitForURL(/\/analyses\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    await page.getByText('Revenue by region', { exact: true }).first().waitFor(); // the dashboard it built, open
    // …in the look the brief picked, which went to the build and nowhere else.
    const [, projectId, id] = /\/analyses\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(page.url()) ?? [];
    const opened = await page.request.post(`${server.base}/api/rpc/analysis:open`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId, id }] } });
    assert.equal(((await opened.json()) as { analysis?: { style?: { theme?: string } } }).analysis?.style?.theme, 'dark', 'the dashboard is saved in the look that was picked');

    // ── The context follows the screen: beside the open dashboard, a question is about IT ──
    // The header names it (the page's own analysis:open), the ask carries its kind and id, and
    // the facts the model is sent are that dashboard's — its KPI the app's own sum.
    const chip = page.getByTestId('dock-context');
    assert.equal(await chip.textContent(), 'Regional revenue');
    assert.equal(await chip.getAttribute('title'), 'Answers are based on analysis · Regional revenue');
    const sent = page.waitForRequest((r) => decodeURIComponent(new URL(r.url()).pathname) === '/api/rpc/copilot:ask');
    await box.fill(ON_SCREEN);
    await box.press('Enter');
    const about = ((await sent).postDataJSON() as { args: [{ projectId: string; context: unknown }] }).args[0];
    assert.deepEqual([about.projectId, about.context], [projectId, { kind: 'analysis', id }], 'the ask is about the dashboard on screen');
    await dock.getByText(ON_SCREEN_ANSWER.join(''), { exact: true }).waitFor();
    await dock.getByText(/^analysis: Regional revenue · /).waitFor();
    assert.match(lastAsk, /Dashboard: \\"Regional revenue\\"/, 'the model was sent this dashboard\'s facts');
    assert.match(lastAsk, /Total revenue: 2,?500\b/, 'with its KPI: the app\'s sum of revenue');
    await shots('dock-on-analysis');

    // ── The wizard's Assistant step shows the same brief, so the flow does not ask for it again ──
    await page.goto(`/analyses?project=${projectId}`);
    await settled(page);
    await page.getByRole('button', { name: 'Create dashboard' }).click();
    const wiz = page.getByRole('dialog', { name: 'Create dashboard' });
    await wiz.getByRole('button', { name: 'Next' }).click(); // the project's one dataset is already chosen
    await wiz.getByRole('radio', { name: /Let the Assistant design it/ }).click();
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz.getByRole('textbox', { name: 'Describe the dashboard' }).fill('Revenue by region');
    await wiz.getByRole('radio', { name: /^Table/ }).check();
    assert.equal(await wiz.getByRole('radio', { name: /^Workspace default/ }).isChecked(), true);
    await shots('analyses-wizard-brief');
    const before = draftCalls.length;
    await wiz.getByRole('button', { name: 'Draft with the Assistant' }).click();
    // Straight to the model's questions — and "Skip" drafts with none of them answered.
    await page.getByRole('dialog', { name: 'A few questions first' }).getByRole('button', { name: 'Skip — just build it' }).click();
    await review.getByText('Revenue by region', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Draft a dashboard' }).count(), 0, 'the brief was the wizard\'s: the flow showed none of its own');
    assert.deepEqual(draftCalls.slice(before).map((c) => c.asking), [true, false], 'asked once here too');
    assert.match(draftAsk, /The user chose this dashboard shape\. .*TABLE/, 'the wizard\'s shape is in the facts');
    assert.doesNotMatch(draftAsk, /USER ANSWERS/, 'Skip sends no answers');
    await review.getByRole('button', { name: 'Discard' }).click();
    await review.waitFor({ state: 'detached' });
  });
}
