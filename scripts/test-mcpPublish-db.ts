// MCP publish_dashboard / unpublish_dashboard (the drafts design, docs/superpowers/specs/2026-10-29-dashboard-drafts-
// publish-design.md) against a real Postgres, over real HTTP, with personal API tokens — the door an agent uses.
//
//   1. An editor's token builds a draft (create_dashboard); a viewer's token does not list it.
//   2. NEGATIVE CONTROL: the viewer's token calling publish_dashboard / unpublish_dashboard is refused with the
//      catalog's sentence (the same one for a dashboard that does not exist: no draft-name oracle), audited as
//      denied, and the stored record and its history do not move.
//   3. The editor's token publishes: status + publishedAt; the viewer's list_dashboards now shows it, published.
//      Publishing again, in sync, is fine.
//   4. Unpublish: the viewer's list loses it; the draft stays for the editor.
//   5. DIFFERENTIAL: the same draft published by `analysis:publish` (the editor's RPC) and by publish_dashboard
//      leaves the same stored record, leaf by leaf with Object.is, minus the copy's publishedAt and versionKey; each
//      wrote one `published` version whose key the copy keeps.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-mcpPublish-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mcp-publish-db-'));
const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
const REFUSED = EN['draftMessages.only_the_project_s_editors_and'];

/** Every leaf path where `a` and `b` differ by Object.is (a key on one side only counts), `skip` left out. */
function leafDiffs(a: unknown, b: unknown, skip: ReadonlySet<string>, at = '', out: string[] = []): string[] {
  if (skip.has(at)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const p = at ? `${at}.${k}` : k;
      if (k in ao !== k in bo) out.push(p);
      else leafDiffs(ao[k], bo[k], skip, p, out);
    }
    return out;
  }
  if (!Object.is(a, b)) out.push(at);
  return out;
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip MCP publish DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  ok('the refusal sentence is in the catalog', typeof REFUSED === 'string' && REFUSED.length > 0);
  const dbName = `ordinate_mcppub_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  let app: FastifyInstance | null = null;
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();
    app = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
    const versions: typeof import('../src/app/versions') = require('../src/app/versions');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

    const call = async (email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base}/api/rpc/${channel}`, {
        method: 'POST',
        headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    let rpcId = 0;
    /** One tools/call: the reply's text, its parsed JSON when it ran, and whether it is an error. */
    const tool = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json() as any; // any: a JSON-RPC reply
      const text = String(body.result?.content?.[0]?.text ?? JSON.stringify(body));
      const isError = body.result?.isError !== false;
      return { isError, text, json: isError ? null : JSON.parse(text) as any }; // any: the tool's JSON
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    const asBoss = <T>(fn: () => Promise<T>) => context.runInContext(BOSS, 'read', fn);

    // ── Members, the project, a dataset, a token each ─────────────────────
    for (const p of ['boss', 'vic', 'eve']) await call(`${p}@acme.test`, 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'eve@acme.test'`);
    const P = (await call('boss@acme.test', 'projects:create', { name: 'Board room' })).body.id as string;
    const uid = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0].id;
    await call('boss@acme.test', 'project:share', { projectId: P, member: { userId: await uid('vic@acme.test') }, role: 'viewer' });
    await call('boss@acme.test', 'project:share', { projectId: P, member: { userId: await uid('eve@acme.test') }, role: 'editor' });
    await asBoss(() => datasets.saveDataset(P, {
      name: 'Sales', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['north', 3], ['south', 4]],
    }));
    const tokenOf = async (email: string) => (await call(email, 'tokens:create', { name: 'agent', expiresInDays: 30 })).body.token as string;
    const vic = await tokenOf('vic@acme.test');
    const eve = await tokenOf('eve@acme.test');
    const stored = () => asBoss(() => analysis.getStoredAnalysis(P, D));
    const history = () => asBoss(() => versions.list(P, 'dashboard', D));
    /** The dashboard's status in the viewer's list_dashboards: null when it is not listed. */
    const viewerSees = async (): Promise<string | null> => {
      const r = await tool(vic, 'list_dashboards', { project: P });
      return r.isError ? `error: ${r.text}` : (r.json as Array<{ id: string; status: string }>).find((d) => d.id === D)?.status ?? null;
    };

    // ── 1. A draft, built over MCP; the viewer does not list it ───────────
    const built = await tool(eve, 'create_dashboard', { project: P, plan: { name: 'Regional sales', sheets: [{
      name: 'Overview',
      metrics: [{ dataset: 'Sales', column: 'amount', aggregation: 'sum', label: 'Revenue' }],
      visuals: [{ dataset: 'Sales', name: 'Revenue by region', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } }],
      texts: [{ heading: 'About', text: 'Sales by region.' }],
    }] } });
    const D = built.json?.id as string;
    ok('create_dashboard (editor token): a draft', !built.isError && built.json.status === 'draft' && built.json.dropped.length === 0, built.text);
    ok('list_dashboards (viewer token): the draft is not there', (await viewerSees()) === null);

    // ── 2. NEGATIVE CONTROL: the viewer may not publish or unpublish ──────
    const before = JSON.stringify(await stored());
    const versionsBefore = (await history()).length;
    const vPub = await tool(vic, 'publish_dashboard', { project: P, dashboard: D });
    ok('publish_dashboard (viewer token): refused with the catalog\'s sentence', vPub.isError && vPub.text === REFUSED, vPub.text);
    const vName = await tool(vic, 'publish_dashboard', { project: P, dashboard: 'Regional sales' });
    const vNone = await tool(vic, 'publish_dashboard', { project: P, dashboard: 'No such board' });
    ok('…by name, or naming a dashboard that does not exist: the same sentence (a viewer learns no draft\'s name)', vName.text === REFUSED && vNone.text === REFUSED, [vName.text, vNone.text]);
    const vUnpub = await tool(vic, 'unpublish_dashboard', { project: P, dashboard: D });
    ok('unpublish_dashboard (viewer token): refused with the catalog\'s sentence', vUnpub.isError && vUnpub.text === REFUSED, vUnpub.text);
    ok('…and nothing moved: the stored record and its history are as they were',
      JSON.stringify(await stored()) === before && (await history()).length === versionsBefore);
    ok('…and the viewer still does not list it', (await viewerSees()) === null);

    // ── 3. The editor publishes; the viewer now sees it ───────────────────
    const pub = await tool(eve, 'publish_dashboard', { project: P, dashboard: D });
    const afterPub = await stored();
    ok('publish_dashboard (editor token): published, with the copy\'s publishedAt',
      !pub.isError && pub.json.id === D && pub.json.name === 'Regional sales' && pub.json.status === 'published'
        && typeof pub.json.publishedAt === 'string' && pub.json.publishedAt === afterPub?.published?.publishedAt, pub.text);
    ok('…the copy freezes the chart and names its publisher',
      afterPub?.published?.publishedBy === 'eve@acme.test' && afterPub.published.sheets[0]!.cards.some((c) => c.type === 'visual' && c.visual !== undefined));
    ok('list_dashboards (viewer token): now listed, published', (await viewerSees()) === 'published');
    const again = await tool(eve, 'publish_dashboard', { project: P, dashboard: 'Regional sales' });
    ok('publishing again, in sync and by name, is fine', !again.isError && again.json.status === 'published' && again.json.publishedAt >= pub.json.publishedAt, again.text);

    // ── 4. Unpublish: gone for the viewer, the draft stays ────────────────
    const unpub = await tool(eve, 'unpublish_dashboard', { project: P, dashboard: D });
    ok('unpublish_dashboard (editor token): a draft again', !unpub.isError && unpub.json.status === 'draft' && !('publishedAt' in unpub.json), unpub.text);
    ok('list_dashboards (viewer token): gone', (await viewerSees()) === null);
    const editorList = await tool(eve, 'list_dashboards', { project: P });
    ok('list_dashboards (editor token): still there, a draft', editorList.json?.some((d: { id: string; status: string }) => d.id === D && d.status === 'draft'), editorList.text);

    const audits = await q<{ channel: string; actor: string; outcome: string }>(
      `SELECT channel, actor, outcome FROM audit_log WHERE channel IN ('mcp:publish_dashboard', 'mcp:unpublish_dashboard') ORDER BY id`);
    ok('audit: the viewer\'s calls are denied rows, the editor\'s ok rows', JSON.stringify(audits) === JSON.stringify([
      ...['publish', 'publish', 'publish', 'unpublish'].map((v) => ({ channel: `mcp:${v}_dashboard`, actor: 'vic@acme.test', outcome: 'denied' })),
      ...['publish', 'publish', 'unpublish'].map((v) => ({ channel: `mcp:${v}_dashboard`, actor: 'eve@acme.test', outcome: 'ok' })),
    ]), JSON.stringify(audits));

    // ── 5. DIFFERENTIAL: analysis:publish vs publish_dashboard ────────────
    const viaRpc = await call('eve@acme.test', 'analysis:publish', { projectId: P, id: D });
    const A = await stored();
    const vUnpubLive = await tool(vic, 'unpublish_dashboard', { project: P, dashboard: D });
    ok('NEGATIVE CONTROL: a viewer\'s unpublish of a live dashboard is refused, and it stays live',
      vUnpubLive.text === REFUSED && JSON.stringify(await stored()) === JSON.stringify(A) && (await viewerSees()) === 'published');
    await call('eve@acme.test', 'analysis:unpublish', { projectId: P, id: D });
    const viaMcp = await tool(eve, 'publish_dashboard', { project: P, dashboard: D });
    const B = await stored();
    ok('the two replies agree on status, each with its own copy\'s publishedAt',
      viaRpc.body?.ok === true && Object.is(viaRpc.body.status, viaMcp.json?.status)
        && viaRpc.body.published?.publishedAt === A?.published?.publishedAt && viaMcp.json.publishedAt === B?.published?.publishedAt, [viaRpc.body, viaMcp.text]);
    const skip = new Set(['published.publishedAt', 'published.versionKey']);
    const diffs = leafDiffs(A, B, skip);
    ok('the stored records are the same, leaf by leaf with Object.is (minus publishedAt, versionKey)', A !== null && B !== null && diffs.length === 0, diffs);
    ok('NEGATIVE CONTROL: the walk sees into the copy (unskipped, the version keys differ)', leafDiffs(A, B, new Set()).includes('published.versionKey'));
    const hist = await history();
    ok('each publish wrote a `published` version, and the copy keeps its key',
      [A, B].every((r) => hist.find((v) => v.key === r?.published?.versionKey)?.event === 'published') && A?.published?.versionKey !== B?.published?.versionKey);
  } finally {
    await app?.close().catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
