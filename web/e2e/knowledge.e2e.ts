// E2E: knowledge documents (docs/knowledge-docs/00-design.md), the whole path, on the real server with Postgres, header
// sign-in and the STUB model provider on loopback (./agentsStub.ts: no real network call is made).
//
//   - Assistant → Agents & setup: the Documents section is an empty state that points short rules to Instructions.
//   - The admin types a document, uploads a small .docx and a small PDF (each read in a worker thread, the text shown
//     back exactly), and is refused a scanned PDF with its own sentence.
//   - In "Try a question" they ask about refunds: the stub provider's prompt carries the matching passage, and "How
//     this was answered" lists the document by title.
//   - They delete the document: it leaves the list, and the same answer then names "a removed document".
//
// Screens: web/e2e/__screens__/knowledge-{empty,list,view,refused,answered}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import pg from 'pg';
import { asks, stubUrl } from './agentsStub.ts';

const ADMIN = 'boss@acme.test';
const dbUrl = process.env.DATABASE_URL;
const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../../scripts/fixtures/knowledge/${name}`, import.meta.url)));

if (!dbUrl) {
  void test('knowledge e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_knowledge_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, screensInPlace, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      SSRF_ALLOW: '127.0.0.1/32', // the stub provider is on loopback
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('knowledge: type, upload (docx, pdf), refuse a scan, ask and see the document under "How this was answered", delete it', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': ADMIN, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    const pid: string = (await rpc('projects:create', { name: 'Policies' })).id;
    assert.equal((await rpc('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc('ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);

    // ── Empty ──────────────────────────────────────────────────────────────
    await page.goto(`/assistant/setup/${pid}`);
    const docs = page.getByRole('region', { name: 'Documents' });
    await docs.getByText('No documents yet').waitFor();
    assert.match((await docs.textContent()) ?? '', /Short rules, one line each, belong in Instructions\./);
    await docs.getByRole('button', { name: 'Instructions' }).click(); // a link to the Instructions section above
    await settled(page);
    await docs.scrollIntoViewIfNeeded();
    await screensInPlace(page, 'knowledge-empty');

    // ── Type one ───────────────────────────────────────────────────────────
    await docs.getByRole('button', { name: 'Add document' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('textbox', { name: 'Title' }).fill('Revenue policy');
    await dlg.getByRole('textbox', { name: /^Text/ }).fill('# Revenue\n\n## Refunds\n\nA refund reduces revenue in the month it is paid out, never the month of the order.');
    await dlg.getByRole('button', { name: 'Add document' }).click();
    await dlg.waitFor({ state: 'detached' });
    await docs.getByRole('button', { name: 'Edit Revenue policy' }).waitFor();

    // ── Upload a .docx and a PDF; the text is shown back exactly ──────────
    const z = new JSZip();
    z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Fiscal year</w:t></w:r></w:p><w:p><w:r><w:t>The fiscal year starts on 1 February.</w:t></w:r></w:p></w:body></w:document>');
    const picker = docs.getByLabel('Document file');
    await picker.setInputFiles({ name: 'Fiscal calendar.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await z.generateAsync({ type: 'nodebuffer' }) });
    await docs.getByRole('button', { name: 'Edit Fiscal calendar' }).waitFor();
    await docs.getByRole('button', { name: 'Edit Fiscal calendar' }).click();
    const word = await page.getByRole('dialog').getByRole('textbox', { name: /^Text/ }).inputValue();
    assert.equal(word, '# Fiscal year\n\nThe fiscal year starts on 1 February.');
    await screensInPlace(page, 'knowledge-view');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await picker.setInputFiles({ name: 'hello.pdf', mimeType: 'application/pdf', buffer: fixture('hello.pdf') });
    await docs.getByRole('button', { name: 'Edit hello' }).waitFor();
    await docs.getByRole('button', { name: 'Edit hello' }).click();
    assert.equal(await page.getByRole('dialog').getByRole('textbox', { name: /^Text/ }).inputValue(), 'Refunds are deducted from net revenue.\nThe fiscal year starts on 1 February.');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await docs.getByTestId('document-row').count(), 3);
    await settled(page);
    await screensInPlace(page, 'knowledge-list');

    // ── A scan is refused with its own sentence (a fresh page load: the RPC budget counts per load) ──
    await page.reload();
    await docs.getByTestId('document-row').nth(2).waitFor();
    await picker.setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: fixture('scan.pdf') });
    const refused = docs.getByRole('alert');
    await refused.waitFor();
    assert.match((await refused.textContent()) ?? '', /scan\.pdf was not added\. No text could be read from this file\. A scanned PDF holds pictures, not text\./);
    assert.equal(await docs.getByTestId('document-row').count(), 3);
    await docs.scrollIntoViewIfNeeded();
    await screensInPlace(page, 'knowledge-refused');
    await refused.getByRole('button', { name: 'Dismiss' }).click();

    // ── Ask in the test chat; the document is listed under "How this was answered" ──
    const ask = page.getByRole('textbox', { name: 'Question to try' });
    await ask.fill('How do we count refunds?');
    await ask.press('Enter');
    const how = page.getByTestId('how-documents');
    await how.waitFor();
    assert.match((await how.textContent()) ?? '', /It read 1 document\.Revenue policy/);
    const sent = asks.at(-1)!;
    assert.ok(sent.asked.includes('[Revenue policy › Revenue › Refunds] A refund reduces revenue in the month it is paid out'), 'the matching passage reached the prompt');
    assert.ok(!sent.asked.includes('Fiscal year') || sent.asked.includes('From the project'), 'passages sit under their own header');
    await settled(page);
    await how.scrollIntoViewIfNeeded();
    await screensInPlace(page, 'knowledge-answered');

    // ── Delete it ──────────────────────────────────────────────────────────
    await docs.getByRole('button', { name: 'Remove Revenue policy' }).click();
    const confirm = page.getByRole('dialog');
    assert.match((await confirm.textContent()) ?? '', /the original file is not kept/);
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await docs.getByRole('button', { name: 'Edit Revenue policy' }).waitFor({ state: 'detached' });
    await docs.getByTestId('document-row').nth(1).waitFor();
    assert.equal(await docs.getByTestId('document-row').count(), 2);
    await page.reload();
    assert.match((await page.getByTestId('how-documents').textContent()) ?? '', /It read 1 document\.a removed document/);
  });
}
