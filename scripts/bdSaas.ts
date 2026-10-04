// Build-depth smoke SECTION: SaaS sources and folder watch, driven through the
// REAL UI. Not a standalone smoke — scripts/smoke-build.ts calls
// saasSection(s, fx) on its one launch and fixture.
//
//   A local HTTP fixture server (in THIS process, on 127.0.0.1) plays GitHub
//   and Airtable; ORDINATE_SAAS_FIXTURE_BASE points the declared hosts at it —
//   the loopback-only override in src/connectors/saasHttp.ts. Nothing here
//   touches the network.
//
//   GitHub: Connect → GitHub form (a dummy token) → Test & Save → the tree
//   lists what the token can read → the issues columns carry their types → the
//   sample shows every row across two pages → Save as dataset → composer → Save
//   → on disk with number/date/text types and a table origin → the repository
//   gains issues → Refresh → a refresh job finishes in the Jobs popover and the
//   dataset has the new rows.
//
//   Folder watch: a CSV-folder connection with "Watch this folder" ticked →
//   import a file → drop a NEW csv in the folder → the dataset refreshes on its
//   own → change the file → the new row arrives → untick the rail's toggle →
//   the watcher is gone.

import { ok } from './selfcheck';
import { openProject } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const httpMod: typeof import('http') = require('http');

type Win = Smoke['win'];
type App = Smoke['app'];

const TOKEN = 'ghp_smoke_dummy_token_0000'; // a test value; the fixture server is the only thing that sees it

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(250);
  }
  return false;
}

const visible = (win: Win, id: string): Promise<boolean> =>
  win.evaluate((i: string) => { const el = document.getElementById(i); return !!el && !el.hidden && el.getClientRects().length > 0; }, id);

// ── The fixture server ───────────────────────────────────────────────────────

interface Seen { path: string; query: string; auth: string }

function issuesOf(total: number): unknown[] {
  // Newest-created first, as GitHub sorts with sort=created&direction=desc.
  return Array.from({ length: total }, (_, i) => {
    const n = total - i;
    return {
      id: 9_000_000_000 + n, number: n, title: `Issue ${n}`, state: n % 3 ? 'open' : 'closed', state_reason: null,
      user: { login: n % 2 ? 'mona' : 'hubot' }, labels: [{ name: 'bug' }], assignees: [], milestone: null,
      comments: n % 7, created_at: new Date(Date.UTC(2024, 0, 1) + n * 3_600_000).toISOString(),
      updated_at: new Date(Date.UTC(2024, 0, 2) + n * 3_600_000).toISOString(), closed_at: null,
      html_url: `https://github.com/octo/demo/issues/${n}`,
    };
  });
}

async function startFixtureServer(): Promise<{
  url: string; seen: Seen[]; setIssues: (n: number) => void; close: () => Promise<void>;
}> {
  let total = 150;
  const seen: Seen[] = [];
  const server = httpMod.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://fixture');
    seen.push({ path: u.pathname, query: u.search, auth: String(req.headers.authorization || '') });
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/repos/octo/demo/issues') {
      const per = Number(u.searchParams.get('per_page') || 30);
      const page = Number(u.searchParams.get('page') || 1);
      json(200, issuesOf(total).slice((page - 1) * per, page * per));
      return;
    }
    if (u.pathname === '/repos/octo/demo/pulls' || u.pathname === '/repos/octo/demo/commits') { json(200, []); return; }
    if (u.pathname === '/v0/appSmoke/Tasks') {
      // Five pages of 100 behind offset tokens.
      const page = Number((u.searchParams.get('offset') || 'o0').slice(1));
      const size = Number(u.searchParams.get('pageSize') || 100);
      const records = Array.from({ length: size }, (_, i) => ({
        id: `rec${page}x${i}`, createdTime: '2024-01-01T00:00:00.000Z', fields: { Name: `Task ${page * size + i}`, Zip: '94107', Hours: i },
      }));
      json(200, page < 4 ? { records, offset: `o${page + 1}` } : { records });
      return;
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    setIssues: (n) => { total = n; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections(); // the app's fetch keeps sockets alive
      server.close(() => resolve());
    }),
  };
}

// ── Main-process reads ───────────────────────────────────────────────────────

async function datasetNamed(app: App, projectId: string, name: string): Promise<any> {
  return app.evaluate(async (_e, a: { projectId: string; name: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const hit = (await datasets.listDatasets(a.projectId)).find((d: any) => d.name === a.name);
    if (!hit) return null;
    const meta = await datasets.getDatasetMeta(a.projectId, hit.id);
    return {
      id: hit.id,
      rowCount: hit.rowCount,
      lastRefreshedAt: (meta && meta.lastRefreshedAt) || '',
      origin: meta && meta.origin,
      types: Object.fromEntries(((meta && meta.columns) || []).map((c: any) => [c.name, c.type])),
    };
  }, { projectId, name });
}

/** Fill the open connector form and Test & Save; resolves when the workbench is up. */
async function addConnection(win: Win, connectorId: string, name: string, fields: Record<string, string | boolean>): Promise<boolean> {
  await win.evaluate((id: string) => { (window as any).openConnPanel(id); }, connectorId);
  if (!(await until(win, () => visible(win, 'conn-form'), 30_000))) return false;
  await win.evaluate((a: { name: string; fields: Record<string, string | boolean> }) => {
    (document.getElementById('conn-name') as HTMLInputElement).value = a.name;
    for (const [k, v] of Object.entries(a.fields)) {
      const el = document.getElementById('conn-f-' + k) as HTMLInputElement | null;
      if (!el) continue;
      if (typeof v === 'boolean') el.checked = v; else el.value = v;
    }
  }, { name, fields });
  await win.click('#conn-test-btn', { timeout: 8000 });
  return until(win, () => visible(win, 'conn-wb'), 60_000);
}

/** Click a tree table, then Save as dataset → composer → Save. */
async function importTable(win: Win, table: string, dsName: string, minRows: number): Promise<boolean> {
  await win.evaluate((t: string) => {
    (document.querySelector(`.cw-node[data-table="${CSS.escape(t)}"] .cw-row-table`) as HTMLElement | null)?.click();
  }, table);
  const shown = await until(win, () => win.evaluate((n: number) => document.querySelectorAll('#conn-wb-grid .ds-table tbody tr').length >= n, minRows));
  if (!shown) return false;
  await win.evaluate((n: string) => { (document.getElementById('conn-wb-ds-name') as HTMLInputElement).value = n; }, dsName);
  await win.click('#conn-wb-save-ds', { timeout: 8000 });
  if (!(await until(win, () => visible(win, 'ds-composer'), 60_000))) return false;
  await until(win, () => win.evaluate(() => document.querySelectorAll('#dc-grid tbody tr').length > 0), 30_000);
  await win.click('#dc-save', { timeout: 8000 });
  return true;
}

export async function saasSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const srv = await startFixtureServer();
  await app.evaluate((_e, url: string) => { process.env.ORDINATE_SAAS_FIXTURE_BASE = url; }, srv.url);
  const folder = path.join(s.userData, 'watched folder');
  // Artifacts for review (SMOKE_ARTIFACT_DIR). The pause lets a fade-in finish.
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(350);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  try {
    await openProject(win, fx.projectId);

    // ── GitHub, through the real form ────────────────────────────────────────
    await win.evaluate(() => { (window as any).openConnPanel('github'); });
    await until(win, () => visible(win, 'conn-form'), 30_000);
    const form = await win.evaluate(() => ({
      name: (document.getElementById('conn-chosen-name')?.textContent || '').trim(),
      blurb: (document.getElementById('conn-chosen-blurb')?.textContent || '').trim(),
      tokenIsPassword: (document.getElementById('conn-f-token') as HTMLInputElement | null)?.type === 'password',
      fields: [...document.querySelectorAll('#conn-fields [data-conn-key]')].map((e) => (e as HTMLElement).dataset.connKey).join(','),
    }));
    await shot('saas-github-form.png');
    ok('saas: the GitHub form opens from the catalog, naming its one host',
      form.name === 'GitHub' && /Connects only to api\.github\.com\./.test(form.blurb), JSON.stringify(form));
    ok('saas: …with a masked token field, the repository and a date range',
      form.tokenIsPassword && form.fields === 'token,repo,from,to', form.fields);

    const wb = await addConnection(win, 'github', 'Smoke GitHub', { token: TOKEN, repo: 'octo/demo' });
    ok('saas: Test & Save against the fixture server lands in the workbench', wb);
    await until(win, () => win.evaluate(() => document.querySelectorAll('#conn-wb-tree .cw-node').length >= 3), 30_000);
    const tables = await win.evaluate(() => [...document.querySelectorAll('#conn-wb-tree .cw-node')].map((n) => (n as HTMLElement).dataset.table).join(','));
    ok('saas: the tree lists the resources the token can read', tables === 'issues,pulls,commits', tables);

    await win.evaluate(() => { (document.querySelector('.cw-node[data-table="issues"] .cw-caret') as HTMLElement | null)?.click(); });
    await until(win, () => win.evaluate(() => document.querySelectorAll('.cw-node[data-table="issues"] .cw-row-col').length >= 5), 30_000);
    const cols = await win.evaluate(() => Object.fromEntries([...document.querySelectorAll('.cw-node[data-table="issues"] .cw-row-col')]
      .map((r) => [(r.querySelector('.cw-row-name')?.textContent || '').trim(), (r.querySelector('.cw-col-type')?.textContent || '').trim()])));
    ok('saas: expanding issues shows its columns with the API\'s types', cols.number === 'number' && cols.created_at === 'date' && cols.id === 'text', JSON.stringify(cols));

    await shot('saas-github-workbench.png');
    const imported = await importTable(win, 'issues', 'GitHub issues', 150);
    ok('saas: the issues sample shows all 150 rows (two pages) and saves through the composer', imported);
    await until(win, async () => !!(await datasetNamed(app, fx.projectId, 'GitHub issues')), 30_000);
    const ds = await datasetNamed(app, fx.projectId, 'GitHub issues');
    ok('saas: the dataset is on disk with every issue', !!ds && ds.rowCount === 150, JSON.stringify(ds && ds.rowCount));
    ok('saas: …typed by the API: number is a number, created_at a date, the 10-digit id text',
      !!ds && ds.types.number === 'number' && ds.types.created_at === 'date' && ds.types.id === 'text' && ds.types.comments === 'number',
      JSON.stringify(ds && ds.types));
    ok('saas: …with an ordinary connection origin on the issues table', !!ds && ds.origin && ds.origin.kind === 'connection' && ds.origin.table === 'issues',
      JSON.stringify(ds && ds.origin));
    const issueCalls = srv.seen.filter((x) => x.path === '/repos/octo/demo/issues');
    ok('saas: every request asked for a page size, and the token rode in the header only',
      issueCalls.length > 0 && issueCalls.every((x) => /per_page=\d+/.test(x.query) && x.auth === 'Bearer ' + TOKEN && !x.query.includes(TOKEN)),
      JSON.stringify(issueCalls.slice(0, 3)));

    // ── Refresh: the repository gained ten issues ────────────────────────────
    srv.setIssues(160);
    const refreshed = await win.evaluate(async (a: { pid: string; id: string }) => {
      const r = await (window as any).hub.refreshDataset(a.pid, a.id);
      return { ok: !!(r && r.ok), error: r && r.error };
    }, { pid: fx.projectId, id: ds ? ds.id : '' });
    ok('saas: Refresh re-runs the import', refreshed.ok, JSON.stringify(refreshed));
    const after = await datasetNamed(app, fx.projectId, 'GitHub issues');
    ok('saas: …and the dataset now has the new issues', !!after && after.rowCount === 160, JSON.stringify(after && after.rowCount));
    await win.click('#topbar-jobs', { timeout: 5000 }).catch(() => {});
    const inPopover = await until(win, () => win.evaluate(() => [...document.querySelectorAll('#jp-pop .jp-row--done .jp-name')]
      .some((n) => (n.textContent || '').includes('Refresh GitHub issues'))), 10_000);
    ok('saas: the refresh ran as a job the Jobs popover lists as done', inPopover);
    await win.keyboard.press('Escape');

    // ── Airtable pagination over real HTTP, straight through the dispatch ────
    const air = await app.evaluate(async () => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const run = req('./src/connectors/connectionRun.js');
      const r = await run.runConnection('airtable', { baseId: 'appSmoke', table: 'Tasks' }, { token: 'pat_smoke_dummy' }, { table: 'records' }, { rowLimit: 250 });
      return r.ok ? { ok: true, rows: r.result.rowCount, truncated: r.truncated, zip: r.result.columns.find((c: any) => c.name === 'Zip')?.type } : r;
    });
    const airCalls = srv.seen.filter((x) => x.path === '/v0/appSmoke/Tasks');
    ok('saas: Airtable follows offsets and stops at the row cap (3 of 5 pages)',
      air.ok && air.rows === 250 && air.truncated && airCalls.length === 3 && airCalls.every((x) => /pageSize=100/.test(x.query)),
      JSON.stringify({ air, calls: airCalls.length }));
    ok('saas: …a zip sent as a string stays text', air.ok && air.zip === 'text', JSON.stringify(air));

    // ── Folder watch ─────────────────────────────────────────────────────────
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'sales.csv'), 'region,revenue\nEast,10\nWest,20\nNorth,30\n');
    const fwb = await addConnection(win, 'csv-folder', 'Smoke watched folder', { path: folder, watch: true });
    ok('saas: a CSV folder connection saves with "Watch this folder" ticked', fwb);
    await until(win, () => win.evaluate(() => !!document.querySelector('.cw-node[data-table="sales"]')), 30_000);
    const connId = await app.evaluate(async (_e, pid: string) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const list = await req('./src/connectors/connections.js').listConnections(pid);
      const c = list.find((x: any) => x.name === 'Smoke watched folder');
      return c ? { id: c.id, watch: c.values.watch, watching: req('./src/connectors/folderWatch.js').isWatching(c.id) } : null;
    }, fx.projectId);
    ok('saas: the flag is stored and the folder is being watched', !!connId && connId.watch === true && connId.watching, JSON.stringify(connId));
    const watchedImport = await importTable(win, 'sales', 'Watched sales', 3);
    ok('saas: a file from the folder imports', watchedImport);
    await until(win, async () => !!(await datasetNamed(app, fx.projectId, 'Watched sales')), 30_000);
    const before = await datasetNamed(app, fx.projectId, 'Watched sales');
    ok('saas: …as a 3-row dataset', !!before && before.rowCount === 3, JSON.stringify(before));

    fs.writeFileSync(path.join(folder, 'returns.csv'), 'region,amount\nEast,1\n');
    const onNewFile = await until(win, async () => {
      const d = await datasetNamed(app, fx.projectId, 'Watched sales');
      return !!d && !!d.lastRefreshedAt && d.lastRefreshedAt !== (before && before.lastRefreshedAt);
    }, 30_000);
    ok('saas: dropping a NEW csv in the folder refreshes the dataset on its own', onNewFile);

    fs.appendFileSync(path.join(folder, 'sales.csv'), 'South,40\n');
    const grew = await until(win, async () => ((await datasetNamed(app, fx.projectId, 'Watched sales')) || {}).rowCount === 4, 30_000);
    ok('saas: changing the file brings its new row in', grew);
    // The second refresh writes its row before its job is marked done: wait for the job, as every check here waits.
    const doneWatchJobs = () => win.evaluate(async () => {
      const snap = await (window as any).hubPlatform.listJobs();
      return (snap.recent || []).filter((j: any) => j.kind === 'refresh' && j.label === 'Refresh Watched sales' && j.state === 'done').length;
    });
    await until(win, async () => (await doneWatchJobs()) >= 2, 30_000);
    const watchJob = await doneWatchJobs();
    ok('saas: each watched refresh ran as a refresh job', watchJob >= 2, watchJob);

    // ── The rail's toggle turns it off ───────────────────────────────────────
    await win.evaluate(() => { (window as any).selectSection('connect'); });
    await until(win, () => win.evaluate(() => !!document.querySelector('#conn-saved-list .conn-card')), 10_000);
    await win.evaluate((id: string) => {
      (document.querySelector(`#conn-saved-list .conn-card[data-conn-id="${id}"]`) as HTMLElement | null)?.click();
    }, connId ? connId.id : '');
    const toggleOn = await until(win, () => win.evaluate(() => (document.getElementById('conn-wb-watch') as HTMLInputElement | null)?.checked === true), 15_000);
    ok('saas: the workbench rail shows "Watch this folder" as a live, ticked toggle', toggleOn);
    await shot('saas-folder-watch-rail.png');
    await win.click('#conn-wb-watch', { timeout: 5000 }).catch(() => {});
    const stopped = await until(win, () => app.evaluate((_e, id: string) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return !req('./src/connectors/folderWatch.js').isWatching(id);
    }, connId ? connId.id : ''), 10_000);
    ok('saas: unticking it closes the watcher', stopped);

    ok('saas: no renderer console error in the whole section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
  } finally {
    await app.evaluate(() => { delete process.env.ORDINATE_SAAS_FIXTURE_BASE; });
    await srv.close();
    await win.evaluate(() => { (window as any).selectSection?.('home'); }).catch(() => {});
  }
}
