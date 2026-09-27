// Smoke section: Settings → Automation and the loopback MCP server, in the
// REAL app. Called by the platform smoke with its launched app and fixture —
// no launch of its own.
//
//   1. Settings → Automation opens from its nav button, OFF, saying so, with
//      the CLI line still shown (the CLI is not behind the switch).
//   2. Enable → the stdio setup line; HTTP on → a free port applied through
//      the pane → "Listening", and the token shown ONCE.
//   3. Leave the pane and come back → only the mask.
//   4. From Node: tools/list and a read-only tool with the token; 401 without
//      it; create_visual → the visual exists on disk.
//   5. `--cli datasets import` in a second, headless process beside the app.
//   6. The Jobs popover (#topbar-jobs) lists both jobs — this process's and
//      the headless one's, which arrives through automation-log.jsonl.
//   7. Off again → the server stops listening.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Fixture, Smoke } from './smokeFixture';

const http: typeof import('http') = require('http');
const path: typeof import('path') = require('path');
const { execFile }: typeof import('child_process') = require('child_process');

function post(port: number, token: string | null, msg: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(msg);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(text); } catch (_) { body = text; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

export async function automationSection(s: Smoke, fx: Fixture): Promise<void> {
  const { win } = s;
  const wait = (ms: number) => win.waitForTimeout(ms);
  const errorsBefore = s.errors.length;
  const text = (sel: string) => win.evaluate((q: string) => (document.querySelector(q) as HTMLElement | null)?.textContent || '', sel);

  // 1. Open it the way a user does: Settings, then the Automation category.
  await win.evaluate(() => (window as any).showSettingsPanel('general'));
  await wait(500);
  await win.click('.settings-cat[data-cat="automation"]');
  await win.waitForSelector('#am-enabled', { timeout: 10_000 });
  const off = await win.evaluate(() => ({
    title: document.getElementById('stp-title')?.textContent || '',
    switchOn: document.getElementById('am-enabled')?.getAttribute('aria-checked'),
    offCard: !!document.getElementById('am-off'),
    cli: document.getElementById('am-cli-cmd')?.textContent || '',
  }));
  ok('automation: the pane opens OFF, says nothing can connect, and still shows the CLI',
    off.title === 'Automation' && off.switchOn === 'false' && off.offCard && off.cli.includes('--cli projects list --json'), JSON.stringify(off));

  // 2. Enable, then the HTTP transport on a free port.
  await win.click('#am-enabled');
  await win.waitForSelector('#am-stdio-cmd', { timeout: 10_000 });
  ok('automation: enabled → the Claude Code stdio line', (await text('#am-stdio-cmd')).includes('claude mcp add ordinate --') && (await text('#am-stdio-cmd')).includes('--mcp'));
  await win.click('#am-http');
  await win.waitForSelector('#am-port', { timeout: 10_000 });
  const port = 41000 + Math.floor(Math.random() * 2000);
  await win.fill('#am-port', String(port));
  await win.click('#am-port-apply');
  await win.waitForFunction(() => document.getElementById('am-http-state')?.classList.contains('is-on'), undefined, { timeout: 10_000 });
  const token = (await text('#am-token-value')).trim();
  ok('automation: HTTP on → Listening, and the token shown once in full', /^ord_[A-Za-z0-9_-]{20,}$/.test(token), token);

  // 3. Leave the pane and come back: the mask only.
  await win.click('.settings-cat[data-cat="general"]');
  await wait(300);
  await win.click('.settings-cat[data-cat="automation"]');
  await win.waitForSelector('#am-token-regen', { timeout: 10_000 });
  const masked = await text('#am-token-value');
  ok('automation: after leaving the pane the token is masked, never shown again', !masked.includes(token.slice(4, 12)) && masked.endsWith(token.slice(-4)), masked);

  // 4. The server, from outside the app.
  const list = await post(port, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = list.status === 200 ? list.body.result.tools.map((t: any) => t.name) : [];
  ok('automation: tools/list with the token', names.includes('create_visual') && names.includes('query_sql'), JSON.stringify(list.body).slice(0, 200));
  ok('automation: no token → 401', (await post(port, null, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status === 401);
  const ds = await post(port, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_datasets', arguments: { project: fx.projectId } } });
  const dsList = ds.status === 200 && !ds.body.result.isError ? JSON.parse(ds.body.result.content[0].text) : [];
  ok('automation: a read-only tool answers from the real project', dsList.some((d: any) => d.id === fx.datasetId), JSON.stringify(ds.body).slice(0, 300));
  const cv = await post(port, token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'create_visual', arguments: {
      project: fx.projectId, dataset: fx.datasetId, name: 'Smoke automation visual', chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    } },
  });
  const created = cv.status === 200 && cv.body.result && !cv.body.result.isError ? cv.body.result.structuredContent : null;
  const onDisk = created && await s.app.evaluate(async (_e, a: { pid: string; id: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const v = await req('./src/analysis/visuals.js').getVisual(a.pid, a.id);
    return v ? v.name : null;
  }, { pid: fx.projectId, id: created.id });
  ok('automation: create_visual saves a visual record', onDisk === 'Smoke automation visual', JSON.stringify(cv.body).slice(0, 300));

  // 5. A HEADLESS run of the same binary while the GUI is open: it must not be
  //    turned away by the single-instance lock, and its job must reach this
  //    window's Jobs popover through automation-log.jsonl.
  const electronBin = require('electron') as unknown as string; // from Node, the package is the binary's path
  const headless = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(electronBin, ['.', '--user-data-dir=' + s.userData, '--cli', 'datasets', 'import', fx.csvPath, '--project', fx.projectId, '--json'],
      { cwd: REPO, timeout: 60_000 }, (err, stdout) => resolve({ code: err ? Number((err as { code?: unknown }).code) || 1 : 0, out: String(stdout) }));
  });
  let imported: any = null;
  try { imported = JSON.parse(headless.out).result; } catch (_) { /* reported below */ }
  ok('automation: `--cli datasets import` runs beside the open app, exit 0', headless.code === 0 && imported && imported.rows > 0, headless.out.slice(0, 300));
  await wait(2500); // the GUI polls the log once a second

  // 6. The Jobs popover shows what automation did — in this process and the other.
  await win.evaluate(() => (window as any).hideSettingsPanel());
  await wait(300);
  await win.click('#topbar-jobs');
  await win.waitForSelector('.jp-pop', { timeout: 10_000 });
  const jobNames = await win.evaluate(() => Array.from(document.querySelectorAll('.jp-pop .jp-name')).map((n) => n.textContent || ''));
  ok('automation: the Jobs popover lists the MCP-created visual', jobNames.some((n) => n.includes('Smoke automation visual')), JSON.stringify(jobNames));
  ok('automation: …and the headless import', jobNames.some((n) => n.includes('Import ' + path.basename(fx.csvPath))), JSON.stringify(jobNames));
  await win.keyboard.press('Escape');

  // 7. Off again: nothing listens.
  await win.evaluate(() => (window as any).showSettingsPanel('automation'));
  await win.waitForSelector('#am-enabled', { timeout: 10_000 });
  await win.click('#am-enabled');
  await win.waitForSelector('#am-off', { timeout: 10_000 });
  const after = await post(port, token, { jsonrpc: '2.0', id: 5, method: 'ping' }).then((r) => String(r.status), (e) => e.code);
  ok('automation: switched off → the server is gone', after === 'ECONNREFUSED', after);
  await win.evaluate(() => (window as any).hideSettingsPanel());

  ok('automation: no renderer console errors in this section', s.errors.length === errorsBefore, s.errors.slice(errorsBefore).join(' | '));
}
