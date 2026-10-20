// E2E: Explore (docs/explore/00-design.md) against the real server and the
// bundled sample (Retail orders).
//
//   editor   pick the sample dataset: the suggested questions, their thumbnails
//            drawn from ONE visual:dataBatch; take a suggestion; change the group-by
//            in its well; the table's figures equal the server's own reply to
//            the same request; a reload of the URL draws the same answer; Save
//            as visual → it is in Visuals
//   viewer   (with Postgres: header sign-in, a project viewer) the same
//            question by link — answered, shareable (Copy link), and offered
//            neither Save as visual nor Open in the builder
//   phone    375×812, touch: the rail is gone, Fields opens the bottom sheet,
//            a tap there changes the question
//   no data  an empty project: what Explore does and, for an editor, the
//            import and connect doors (with Postgres, a viewer's sentence)
//
// Without DATABASE_URL the editor is the dev sign-in (everyone admin) and the
// viewer test prints one skip line, as the other viewer specs do. Every page:
// no console error or CSP violation, ≤ 25 RPCs per load. Screens in both
// themes: explore-empty, explore-question, explore-viewer, explore-phone,
// explore-phone-fields, explore-nodata (-viewer).

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import type { Page, Response } from 'playwright';
import { csrfToken, configureServer, e2e, screens, SCREENS, settled, type Session } from './fixtures.ts';
import { decodeQuestion, encodeQuestion, type Question } from '../src/features/explore/spec.ts';

const ADMIN = 'admin@acme.test';
const VIEWER = 'vera@acme.test';
const EDITOR = 'eddie@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (adminUrl) {
  const dbName = `ordinate_e2e_explore_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
}

async function post(s: Session, channel: string, payload?: unknown, as?: string): Promise<any> { // any: each channel's own reply
  const csrf = await csrfToken(s);
  const r = await s.page.request.post(`${s.server.base}/api/rpc/${channel}`, {
    headers: { 'x-csrf-token': csrf, ...(as ? { 'x-forwarded-email': as } : {}) },
    data: { args: payload === undefined ? [] : [payload] },
  });
  assert.equal(r.status(), 200, `${channel}: ${r.status()} ${await r.text()}`);
  return r.json();
}

/**
 * The project and dataset Explore is walked on, and who walks it. With Postgres the admin seeds the
 * sample (`sample:seed`) and shares it with a viewer and an editor; without, it is the harness's
 * seeded sample and the dev sign-in.
 */
let ready: Promise<{ pid: string; did: string }> | undefined;
function project(s: Session): Promise<{ pid: string; did: string }> {
  ready ??= (async () => {
    let pid = s.server.sample.projectId;
    if (adminUrl) {
      const sample = await post(s, 'sample:seed');
      assert.equal(sample.ok, true, JSON.stringify(sample));
      pid = sample.projectId;
      await post(s, 'projects:list', undefined, VIEWER); // a first header-mode request provisions the account
      await post(s, 'projects:list', undefined, EDITOR);
      const targets = (await post(s, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
      const id = (email: string) => targets.users.find((u) => u.email === email)?.id;
      await post(s, 'project:share', { projectId: pid, member: { userId: id(VIEWER) }, role: 'viewer' });
      await post(s, 'project:share', { projectId: pid, member: { userId: id(EDITOR) }, role: 'editor' });
    }
    const list = (await post(s, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
    const did = list.find((d) => d.name === 'Retail orders')?.id;
    assert.ok(did, `no Retail orders in ${JSON.stringify(list.map((d) => d.name))}`);
    return { pid, did };
  })();
  return ready;
}

/** Signs `who` in (header mode), and draws every chart's final frame: a screenshot never catches a bar mid-grow. */
const signIn = async (page: Page, who: string) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (adminUrl) await page.setExtraHTTPHeaders({ 'x-forwarded-email': who });
};

/** A desktop screenshot tall enough for the answer AND its table (the shell scrolls inside, so a full page is the window). */
async function tallScreens(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1500 });
  await screens(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
}

const reply = (page: Page, channel: string) =>
  page.waitForResponse((r: Response) => decodeURIComponent(new URL(r.url()).pathname) === `/api/rpc/${channel}` && r.request().method() === 'POST');

/** Waits until at least `count` canvases under `sel` hold ink (Chart.js has drawn into them). */
async function inked(page: Page, sel: string, count = 1): Promise<void> {
  await page.waitForFunction(
    ([q, n]) =>
      [...document.querySelectorAll<HTMLCanvasElement>(q)].filter((c) => {
        if (!c.width || !c.height) return false;
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let k = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i]) k++;
        return k > 200;
      }).length >= n,
    [sel, count] as const,
  );
}

/** The answer's table as the page shows it: one [label, …cells] per row. */
const tableRows = (page: Page) =>
  page.getByRole('table', { name: /, as a table$/ }).locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent?.trim() ?? '')));

/** Both themes WITHOUT a reload: an open sheet would not survive `screens`. */
async function shots(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search ? '?…' : ''}`);
}

const REGION: Question = { chartType: 'column', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, filters: [] };

e2e('explore: an editor takes a suggestion, regroups it, checks it against the server, reloads it and saves it', async (s) => {
  const { page } = s;
  const { pid, did } = await project(s);
  await signIn(page, EDITOR);

  // ── Pick the sample dataset; its suggestions, their thumbnails from ONE batch ──
  const batches: { datasetId: string; items: unknown[] }[] = [];
  page.on('request', (r) => {
    if (decodeURIComponent(new URL(r.url()).pathname) !== '/api/rpc/visual:dataBatch') return;
    const body = JSON.parse(r.postData() ?? '{}') as { args: [{ items: { datasetId: string }[] }] };
    batches.push({ datasetId: body.args[0].items[0]?.datasetId ?? '', items: body.args[0].items });
  });
  await page.goto(`/explore?project=${pid}`);
  await settled(page);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Explore');
  await page.getByRole('combobox', { name: 'Dataset' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await page.waitForURL((u) => u.searchParams.get('dataset') === did);
  const cards = page.getByRole('list', { name: 'Suggested questions' }).getByRole('button');
  await page.getByRole('button', { name: /^Total revenue by region/ }).waitFor();
  assert.equal(await cards.count(), 6);
  await inked(page, '[data-suggestion] canvas', 6);
  const mine = batches.filter((b) => b.datasetId === did);
  assert.equal(mine.length, 1, `one visual:dataBatch for the dataset's thumbnails, not ${mine.length}`);
  assert.equal(mine[0]!.items.length, 6, 'it carries every thumbnail');
  assert.equal(await page.getByRole('textbox', { name: 'Ask in your own words' }).count(), 0, 'no AI model: no ask box');
  await screens(page, 'explore-empty');
  await inked(page, '[data-suggestion] canvas', 6);

  // ── Take a suggestion: it becomes the question in the URL ──────────────
  await page.getByRole('button', { name: /^Total revenue by region/ }).click();
  await page.waitForURL(/[?&]q=/);
  assert.deepEqual(decodeQuestion(new URL(page.url()).searchParams.get('q')), REGION);
  await page.getByRole('heading', { level: 2, name: 'Total revenue by region' }).waitFor();
  await inked(page, '[data-chart-type="column"] canvas');

  // ── Change the group-by in its well ────────────────────────────────────
  await page.getByRole('button', { name: 'Group by: region' }).click();
  await page.getByRole('dialog', { name: 'Group by' }).getByRole('button', { name: 'category', exact: true }).click();
  await page.getByRole('heading', { level: 2, name: 'Total revenue by category' }).waitFor();
  await page.waitForFunction(() => document.querySelector('table[aria-label$=", as a table"] tbody th')?.textContent !== 'East');
  const q = decodeQuestion(new URL(page.url()).searchParams.get('q'));
  assert.equal(q?.encoding.category, 'category');

  // ── The figures shown ARE the server's: its reply to the same request ──
  const server = await post(s, 'visual:data', { projectId: pid, datasetId: did, encoding: q!.encoding, filters: q!.filters });
  assert.equal(server.ok, true, JSON.stringify(server).slice(0, 300));
  const shown = await tableRows(page);
  const labels: string[] = server.data.labels.map(String);
  const values: number[] = server.data.series[0].values;
  assert.deepEqual(shown.map((r) => r[0]), labels, 'the rows are the server’s labels, in its order');
  shown.forEach((r, i) => {
    const cell = Number((r[1] ?? '').replace(/,/g, ''));
    assert.ok(Math.abs(cell - values[i]!) <= 0.005, `${labels[i]}: the table shows ${r[1]}, the server says ${values[i]}`);
  });

  // ── A reload of the URL draws the same answer ──────────────────────────
  const before = shown;
  await page.reload();
  await settled(page);
  await page.getByRole('heading', { level: 2, name: 'Total revenue by category' }).waitFor();
  await page.getByRole('table', { name: /, as a table$/ }).waitFor();
  assert.deepEqual(await tableRows(page), before, 'the same question, the same figures');
  await inked(page, '[data-chart-type] canvas');
  await tallScreens(page, 'explore-question');
  await inked(page, '[data-chart-type] canvas');

  // ── Save as visual: it is in Visuals ───────────────────────────────────
  await page.getByRole('button', { name: 'Save as visual' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as a visual' });
  assert.equal(await dialog.getByLabel('Name').inputValue(), 'Total revenue by category');
  const saved = reply(page, 'visual:save');
  await dialog.getByRole('button', { name: 'Save' }).click();
  assert.equal((await saved).status(), 200);
  await page.getByText('Saved “Total revenue by category” to Visuals.').waitFor();
  await page.goto(`/visuals?project=${pid}`);
  await settled(page);
  await page.getByRole('button', { name: /^Total revenue by category/ }).waitFor();
  report(s);
});

if (adminUrl) {
  e2e('explore: a viewer asks and shares by link, and is offered nothing that writes', async (s) => {
    const { page } = s;
    const { pid, did } = await project(s);
    await signIn(page, VIEWER);
    const link = `/explore?project=${pid}&dataset=${did}&q=${encodeQuestion(REGION)}`;
    const roles = reply(page, 'projects:roles');
    await page.goto(link);
    await settled(page);
    await page.getByRole('heading', { level: 2, name: 'Total revenue by region' }).waitFor();
    await page.getByRole('table', { name: /, as a table$/ }).waitFor();
    await inked(page, '[data-chart-type="column"] canvas');
    await page.getByRole('button', { name: 'Copy link' }).waitFor();
    assert.equal((await roles).status(), 200); // the roles are in: what is absent now is absent for the viewer
    await settled(page);
    assert.equal(await page.getByRole('button', { name: 'Save as visual' }).count(), 0, 'a viewer is not offered Save as visual');
    assert.equal(await page.getByRole('button', { name: 'Open in the builder' }).count(), 0, 'nor the builder');
    // …and still explores: a field click asks a new question.
    await page.getByRole('complementary', { name: 'Fields' }).getByRole('button', { name: 'profit', exact: true }).click();
    await page.getByRole('heading', { level: 2, name: 'Total revenue and total profit by region' }).waitFor();
    await page.getByRole('radio', { name: /^Clustered column$/, checked: true }).waitFor(); // a second measure: the chart that suits two
    await tallScreens(page, 'explore-viewer');
    report(s);
  });
} else {
  void test('explore: the viewer', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
}

e2e(
  'explore: on a phone the fields are a bottom sheet and the answer is full width',
  async (s) => {
    const { page } = s;
    const { pid, did } = await project(s);
    await signIn(page, adminUrl ? VIEWER : EDITOR);
    await page.goto(`/explore?project=${pid}&dataset=${did}&q=${encodeQuestion(REGION)}`);
    await settled(page);
    await page.getByRole('heading', { level: 2, name: 'Total revenue by region' }).waitFor();
    await inked(page, '[data-chart-type="column"] canvas');
    assert.equal(await page.getByRole('complementary', { name: 'Fields' }).isVisible(), false, 'no rail on a phone');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 375, `no sideways scroll on the page (${width}px)`);
    await screens(page, 'explore-phone');
    await inked(page, '[data-chart-type="column"] canvas');

    await page.getByRole('button', { name: 'Fields', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Fields' });
    await sheet.getByRole('button', { name: 'customer_segment', exact: true }).waitFor();
    await shots(page, 'explore-phone-fields');
    await sheet.getByRole('button', { name: 'customer_segment', exact: true }).click();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('heading', { level: 2, name: 'Total revenue by customer_segment' }).waitFor();
    report(s);
  },
  { device: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
);

e2e('explore: a project with no data shows what Explore does, and its doors to an editor', async (s) => {
  const { page } = s;
  await project(s); // the shared sample first, so this empty project is never the one the others walk
  await signIn(page, adminUrl ? ADMIN : EDITOR);
  const made = (await post(s, 'projects:create', { name: 'Nothing yet' })) as { id: string };
  await page.goto(`/explore?project=${made.id}`);
  await settled(page);
  await page.getByRole('heading', { level: 2, name: 'No data to explore yet' }).waitFor();
  await page.getByRole('link', { name: 'Import data' }).waitFor();
  await page.getByRole('link', { name: 'Connect a database' }).waitFor();
  await screens(page, 'explore-nodata');
  if (adminUrl) {
    // …and a viewer of it reads who can bring data in, with no door.
    const targets = (await post(s, 'project:shareTargets', { projectId: made.id })) as { users: { id: string; email: string }[] };
    await post(s, 'project:share', { projectId: made.id, member: { userId: targets.users.find((u) => u.email === VIEWER)?.id }, role: 'viewer' });
    await signIn(page, VIEWER);
    await page.goto(`/explore?project=${made.id}`);
    await settled(page);
    await page.getByText('An editor of this project can bring in data. You have view-only access.').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Import data' }).count(), 0);
    await screens(page, 'explore-nodata-viewer');
  }
  report(s);
});
