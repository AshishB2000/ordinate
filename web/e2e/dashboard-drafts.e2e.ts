// What a project VIEWER sees while an editor drafts and publishes (docs/superpowers/specs/2026-10-29-dashboard-drafts-
// publish-design.md), on the real server with Postgres (header sign-in from a trusted 127.0.0.1 peer, its own scratch
// database). The admin makes a project with a dataset and a dashboard over RPC and shares it with one viewer and one
// editor. Then, in the browser, switching who is signed in:
//
//   the viewer   cannot open the draft, by either address
//   the editor   publishes it from the editing screen (Publish → the dialog)
//   the viewer   reads it, read-only: no Edit, no Preview strip even with ?draft=1
//   the editor   adds a card → Edits not live, "Not live yet: 1 card added since you published on …"
//   the viewer   still reads the published version, without that card
//   the editor   Publish changes
//   the viewer   reads the new version, with the card
//   the editor   adds another card, then Discard edits → Published, the card gone
//   the viewer   never saw it
//
// Screens of the viewer's published dashboard, both themes: web/e2e/__screens__/drafts-viewer-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'admin@acme.test';
const VIEWER = 'vera@acme.test';
const EDITOR = 'eddie@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('dashboard drafts e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_drafts_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, settled, screens, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** Adds a text card from the editor's add row, and waits for it on the sheet. */
  async function addText(page: Page, heading: string): Promise<void> {
    await page.getByRole('group', { name: 'Add to the sheet' }).getByRole('button', { name: 'Text' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add text' });
    await dlg.getByLabel('Heading (optional)').fill(heading);
    await dlg.getByLabel('Text (optional)').fill('Written in the draft.');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await page.getByRole('group', { name: `${heading} card` }).waitFor();
  }

  e2e('drafts: a viewer sees the last published version until the next Publish, and never a draft', async ({ page, server }) => {
    // Any GET hands the context its CSRF cookie (T6.2); a non-GET repeats it in X-CSRF-Token, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${r.status()} ${await r.text()}`);
      return r.json();
    };

    // ── The admin builds the project and shares it ────────────────────────
    const pid: string = (await rpc(ADMIN, 'projects:create', { name: 'Pipeline' })).id;
    const saved = await rpc(ADMIN, 'dataset:composeSave', {
      projectId: pid,
      name: 'Deals',
      base: { inline: { name: 'Deals', columns: [{ name: 'stage', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['Lead', 120], ['Won', 80], ['Lead', 30]] } },
      joins: [],
      steps: [],
      sourceKind: 'paste',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const did: string = saved.dataset.id;
    const dash = await rpc(ADMIN, 'analysis:create', {
      projectId: pid,
      name: 'Pipeline health',
      sheets: [
        {
          id: crypto.randomUUID(),
          name: 'Summary',
          cards: [{ id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: did, column: 'amount', aggregation: 'sum', label: 'Open pipeline' } }],
        },
      ],
    });
    const aid: string = dash.id;
    assert.match(aid, /^[0-9a-f-]{36}$/, JSON.stringify(dash));
    await rpc(VIEWER, 'projects:list'); // a first header-mode request provisions the account (an org viewer)
    await rpc(EDITOR, 'projects:list');
    const targets = (await rpc(ADMIN, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
    const userId = (email: string) => targets.users.find((u) => u.email === email)?.id;
    await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: userId(VIEWER) }, role: 'viewer' });
    await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: userId(EDITOR) }, role: 'editor' });

    const editor = `/analyses/${pid}/${aid}`;
    const view = `/dashboards/${pid}/${aid}`;
    const as = async (who: string, path: string) => {
      await page.setExtraHTTPHeaders({ 'x-forwarded-email': who });
      await page.goto(path);
    };
    const head = page.locator('[data-print-root] header').first();
    const figure = () => page.getByRole('group', { name: 'Open pipeline card' }).getByText('230').waitFor(); // 120 + 80 + 30, by the server
    /** The viewer's published dashboard, read-only, and which of the draft's cards it shows. */
    const viewerReads = async (shows: string[], hides: string[]) => {
      await as(VIEWER, view);
      await page.getByRole('heading', { level: 1, name: 'Pipeline health' }).waitFor();
      await figure();
      for (const name of shows) await page.getByRole('group', { name: `${name} card` }).waitFor();
      for (const name of hides) assert.equal(await page.getByRole('group', { name: `${name} card` }).count(), 0, `the viewer does not see “${name}”`);
      assert.equal(await page.getByRole('link', { name: 'Edit', exact: true }).count(), 0, 'a viewer has no Edit');
      assert.equal(await page.getByText(/edits that aren’t live/).count(), 0, 'a viewer is not told about drafts');
    };

    // ── A draft: the viewer cannot open it, by either address ─────────────
    for (const path of [view, editor]) {
      await as(VIEWER, path);
      await settled(page);
      await page.getByRole('heading', { name: 'That dashboard could not be loaded' }).waitFor();
      assert.equal(await page.getByText('Pipeline health').count(), 0, `${path}: not even its name`);
    }

    // ── The editor publishes it ───────────────────────────────────────────
    await as(EDITOR, editor);
    await figure();
    await head.getByText('Draft', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish “Pipeline health”?' });
    await dialog.getByText('Everyone in Pipeline can see it').waitFor();
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
    await head.getByText('Published', { exact: true }).waitFor();

    // ── The viewer reads it ───────────────────────────────────────────────
    await viewerReads([], ['Next steps']);
    await page.getByText(/Published [A-Z][a-z]+ \d+/).waitFor();
    await screens(page, 'drafts-viewer-published');
    await as(VIEWER, `${view}?draft=1`);
    await figure();
    assert.equal(await page.getByRole('region', { name: 'Preview' }).count(), 0, 'a viewer asking for the draft gets the published version');
    await as(VIEWER, editor);
    await figure();
    await page.getByText('View only', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Publish/ }).count(), 0, 'nothing to publish');

    // ── The editor edits: not live ────────────────────────────────────────
    await as(EDITOR, editor);
    await figure();
    await addText(page, 'Next steps');
    await head.getByText('Edits not live', { exact: true }).waitFor();
    await page.getByText(/^Not live yet: 1 card added since you published on .+\.$/).waitFor();
    await viewerReads([], ['Next steps']);

    // ── Publish changes: the viewer sees the new version ──────────────────
    await as(EDITOR, editor);
    await page.getByRole('group', { name: 'Next steps card' }).waitFor();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await page.getByRole('dialog', { name: 'Publish “Pipeline health”?' }).getByRole('button', { name: 'Publish changes' }).click();
    await head.getByText('Published', { exact: true }).waitFor();
    assert.equal(await page.getByText(/^Not live yet/).count(), 0, 'nothing waits to go live');
    await viewerReads(['Next steps'], []);

    // ── Discard edits: a card the viewer never sees ───────────────────────
    await as(EDITOR, editor);
    await page.getByRole('group', { name: 'Next steps card' }).waitFor();
    await addText(page, 'Scratch');
    await head.getByText('Edits not live', { exact: true }).waitFor();
    await viewerReads(['Next steps'], ['Scratch']);
    await as(EDITOR, editor);
    await page.getByRole('group', { name: 'Scratch card' }).waitFor();
    await page.getByRole('button', { name: 'Discard edits' }).click();
    await page.getByRole('dialog', { name: 'Discard your edits?' }).getByRole('button', { name: 'Discard edits' }).click();
    await head.getByText('Published', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'Next steps card' }).waitFor();
    assert.equal(await page.getByRole('group', { name: 'Scratch card' }).count(), 0, 'the draft is the published version again');
    await viewerReads(['Next steps'], ['Scratch']);
  });
}
