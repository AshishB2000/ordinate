// Signed embedding end to end on Postgres (docs/embed/00-design.md) — header
// sign-in on a scratch database, the real secrets store, real HTTP.
//
//   roles       the org's settings and secret are an org admin's; a preview
//               is a project writer's; a denied call never reaches its handler
//   secret      shown once (embed:rotate), sealed in `secrets`, never in
//               another reply; enabling needs a secret and a site
//   route       off → refused, not framable; on → the page, its pinned CSP +
//               frame-ancestors <the org's sites>, no X-Frame-Options;
//               expired / too long / unknown claim / widened lock / alg none /
//               bad signature / wrong org / unpublished / not in the link —
//               each refused, framable only once the MAC held; rotation kills
//               every old token; the Referer check; preview tokens only in a
//               same-origin iframe
//   CSP         every other route keeps frame-ancestors 'none' and XFO DENY
//   limits      per token and per org → 429
//   audit       one `embed_view` row per view whose MAC held, ids only
//   canary      the secret in no log line, no other reply, no page, no row but
//               its ciphertext; the token in no log line
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-embed-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { createHmac, randomBytes } from 'crypto';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const api: typeof import('../src/api/index') = require('../src/api/index');
const { pageCsp } = require('../src/server/published') as typeof import('../src/server/published');
const secretsMod: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-embed-db-'));
const PORTAL = 'https://portal.acme.test';
const show = (v: unknown): string => JSON.stringify(v).slice(0, 300);
const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = (): number => Math.floor(Date.now() / 1000);
/** The host backend's signer — the Admin snippet's, not the server's signToken. */
function hostSign(secret: string, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT', kid: 'acme' }): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

async function suite(adminUrl: string): Promise<void> {
  const dbName = `ordinate_embed_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown

  const logLines: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, done) { logLines.push(String(chunk)); done(); } });
  const masterKey = randomBytes(32).toString('base64');
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'info', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: masterKey,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    RATE_LIMIT_EMBED_PER_MINUTE: '6', RATE_LIMIT_EMBED_ORG_PER_MINUTE: '80',
  });
  const app = appMod.buildApp(cfg, logStream);
  try {
    const base = await B.listen(app);
    const replies: string[] = [];
    const as = (who: string) => B.client(base, { 'x-forwarded-email': `${who}@acme.test` }, replies);
    for (const p of ['boss', 'alice', 'bob', 'carol']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    const boss = as('boss');
    const bob = as('bob');
    const alice = as('alice');
    const pid: string = (await boss.call('projects:create', { name: 'Customer portal' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    const BOSS: B.Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const s = await B.seed(BOSS, pid);
    const run = await boss.call('publish:run', { projectId: pid, dashboardIds: [s.aid] });
    ok('setup: the dashboard is published', run.body.ok === true, show(run.body));
    const site = run.body.site;
    const view = (token: string, headers: Record<string, string> = {}) => fetch(`${base}/embed/${token}`, { headers: { accept: 'text/html', ...headers }, redirect: 'manual' });
    const pages: string[] = [];
    const get = async (token: string, headers: Record<string, string> = {}) => {
      const r = await view(token, headers);
      const text = await r.text();
      pages.push(text);
      return { status: r.status, text, csp: r.headers.get('content-security-policy') ?? '', xfo: r.headers.get('x-frame-options'), r };
    };

    // ── Roles ───────────────────────────────────────────────────────────
    const calls = new Map<string, number>();
    for (const ch of Object.keys(api.contracts).filter((c) => c.startsWith('embed:'))) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => { calls.set(ch, (calls.get(ch) ?? 0) + 1); return real(e, ...args); });
    }
    const cells: Array<[string, unknown, string[]]> = [
      ['embed:settings', undefined, ['boss']],
      ['embed:save', { enabled: false, origins: [] }, ['boss']],
      ['embed:status', undefined, ['boss', 'alice', 'bob', 'carol']],
      ['embed:columns', { projectId: pid, siteId: site.id, dashboardId: s.aid }, ['boss', 'alice', 'bob']],
      ['embed:preview', { projectId: pid, siteId: site.id, dashboardId: s.aid }, ['boss', 'bob']],
    ];
    for (const [ch, input, allowed] of cells) {
      for (const who of ['boss', 'alice', 'bob', 'carol']) {
        const before = calls.get(ch) ?? 0;
        const r = await as(who).call(ch, input);
        const want = allowed.includes(who);
        ok(`roles: ${ch} as ${who} → ${want ? 'allowed' : '403, handler never ran'}`, want ? r.status === 200 : r.status === 403 && (calls.get(ch) ?? 0) === before, `${r.status}`);
      }
    }
    ok('roles: rotating the secret is an org admin\'s', (await bob.call('embed:rotate')).status === 403 && (await alice.call('embed:rotate')).status === 403);

    // ── The secret ──────────────────────────────────────────────────────
    const noSecret = await boss.call('embed:save', { enabled: true, origins: [PORTAL] });
    ok('secret: embedding cannot be turned on before a secret exists', noSecret.body.ok === false && /secret/i.test(noSecret.body.error), show(noSecret.body));
    const pv0 = await bob.call('embed:preview', { projectId: pid, siteId: site.id, dashboardId: s.aid });
    ok('secret: no preview before a secret exists', pv0.body.ok === false);
    const rot = await boss.call('embed:rotate');
    const SECRET: string = rot.body.secret;
    ok('secret: generated, shown once, ord_embed_ + 43 characters', rot.body.ok && /^ord_embed_[A-Za-z0-9_-]{43}$/.test(SECRET), show(rot.body));
    const rotIndex = replies.length - 1;
    const st = await boss.call('embed:settings');
    ok('secret: the settings say Stored, carry the org id, and not the secret', st.body.secretSet === true && st.body.org === 'acme' && st.body.enabled === false && !st.text.includes(SECRET));
    const sealed = await pool.query<{ kind: string; ref: string; ciphertext: Buffer }>(`SELECT kind, ref, ciphertext FROM secrets WHERE org_id = 'acme' AND kind = 'embed.signing'`);
    ok('secret: one `embed.signing` row of ciphertext', sealed.rows.length === 1 && sealed.rows[0].ref === 'org' && !sealed.rows[0].ciphertext.toString('latin1').includes(SECRET.slice(10)));
    const real = secretsMod.createSecretStore(pool, cfg.masterKey!);
    ok('secret: bound to its org (NEGATIVE CONTROL: its own org reads it)', (await real.get('globex', 'embed.signing', 'org')) === null && (await real.get('acme', 'embed.signing', 'org')) === SECRET);

    // ── Origins ─────────────────────────────────────────────────────────
    for (const bad of ['http://portal.acme.test', 'https://portal.acme.test/app', 'https://*.acme.test', 'portal.acme.test']) {
      const r = await boss.call('embed:save', { enabled: false, origins: [bad] });
      ok(`origins: ${bad} refused with a sentence`, r.body.ok === false && typeof r.body.error === 'string' && r.body.error.length > 10, show(r.body));
    }
    ok('origins: enabling with no site refused', (await boss.call('embed:save', { enabled: true, origins: [] })).body.ok === false);

    // ── Preview, before embedding is on ─────────────────────────────────
    const pv = await bob.call('embed:preview', { projectId: pid, siteId: site.id, dashboardId: s.aid, theme: 'dark' });
    ok('preview: an editor gets a 10-minute link while embedding is still off', pv.body.ok === true && /^\/embed\//.test(pv.body.url) && Date.parse(pv.body.expiresAt) - Date.now() <= 10 * 60_000 + 1000, show(pv.body));
    const pvToken = String(pv.body.url).slice('/embed/'.length);
    const top = await get(pvToken);
    ok('preview: opened top-level (not in an iframe) → refused', top.status === 403 && /inside Ordinate/.test(top.text), `${top.status}`);
    const cross = await get(pvToken, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' });
    ok('preview: framed by another site → refused', cross.status === 403);
    const forged = await get(pvToken, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' });
    ok('preview: the right Sec-Fetch headers WITHOUT a signed-in member (curl) → refused', forged.status === 403 && /inside Ordinate/.test(forged.text), `${forged.status}`);
    const stranger = await get(pvToken, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'x-forwarded-email': 'carol@acme.test' });
    ok('preview: a member without access to the project → not found', stranger.status === 404, `${stranger.status}`);
    const hostPreview = await get(hostSign(SECRET, { pub: site.id, dash: s.aid, exp: now() + 300, prv: 1 }), { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'x-forwarded-email': 'boss@acme.test' });
    ok('preview: a host signing `prv` with the org secret → refused (only the server can make a preview)', hostPreview.status === 403 && /not valid/.test(hostPreview.text), `${hostPreview.status}`);
    const inApp = await get(pvToken, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', referer: `${base}/admin?tab=embedding`, 'x-forwarded-email': 'bob@acme.test' });
    ok('preview: in a same-origin iframe → the page, frame-ancestors \'self\' only', inApp.status === 200 && inApp.csp === `${pageCsp(inApp.text)}; frame-ancestors 'self'` && inApp.xfo === null, `${inApp.status} ${inApp.csp.slice(-60)}`);

    const good = (extra: Record<string, unknown> = {}) => hostSign(SECRET, { pub: site.id, dash: s.aid, exp: now() + 600, ...extra });
    const off = await get(good());
    ok('route: embedding off → refused, and nobody may frame the refusal', off.status === 403 && off.csp.includes("frame-ancestors 'none'") && off.xfo === 'DENY' && /not available/.test(off.text), `${off.status} ${off.csp}`);

    const on = await boss.call('embed:save', { enabled: true, origins: [PORTAL, 'http://localhost:5173'] });
    ok('origins: saved, normalised', on.body.ok === true && JSON.stringify(on.body.settings.origins) === JSON.stringify([PORTAL, 'http://localhost:5173']), show(on.body));

    // ── The route ───────────────────────────────────────────────────────
    const ok1 = await get(good(), { referer: `${PORTAL}/accounts/42` });
    ok('route: on → the dashboard page', ok1.status === 200 && ok1.text.includes('id="ordinate-page"') && ok1.text.includes('Board'), `${ok1.status} ${ok1.text.slice(0, 200)}`);
    ok('route: CSP = the page\'s pinned policy + frame-ancestors <the org\'s sites>, no X-Frame-Options',
      ok1.csp === `${pageCsp(ok1.text)}; frame-ancestors ${PORTAL} http://localhost:5173` && ok1.xfo === null, ok1.csp.slice(-120));
    ok('route: no-store, noindex, no cookie set', ok1.r.headers.get('cache-control') === 'no-store' && ok1.r.headers.get('x-robots-tag') === 'noindex' && !ok1.r.headers.get('set-cookie'));
    ok('route: no Referer (a no-referrer host) is fine — frame-ancestors decides', (await get(good({ theme: 'light' }))).status === 200);
    const evil = await get(good({ hide: ['title'] }), { referer: 'https://evil.test/page' });
    ok('route: a Referer from a site not on the list → refused (framable by the allowed sites)', evil.status === 403 && evil.csp.includes(`frame-ancestors ${PORTAL}`), `${evil.status}`);

    const expect = async (label: string, token: string, status: number, framable: boolean, text?: RegExp) => {
      const r = await get(token);
      ok(`route: ${label} → ${status}${framable ? ', framable by the org\'s sites' : ', framable by nobody'}`,
        r.status === status && (framable ? r.csp.includes(`frame-ancestors ${PORTAL}`) : r.csp.includes("frame-ancestors 'none'") && r.xfo === 'DENY') && (!text || text.test(r.text)), `${r.status} ${r.csp.slice(-60)} ${r.text.slice(0, 160)}`);
    };
    await expect('expired', good({ exp: now() - 3600 }), 403, true, /expired/);
    await expect('exp more than 24 h ahead', good({ exp: now() + 3 * 86400 }), 403, true, /too long/);
    await expect('no exp', hostSign(SECRET, { pub: site.id }), 403, true);
    await expect('an unknown claim (parmas)', good({ parmas: { region: 'East' } }), 403, true);
    await expect('an empty lock', good({ params: { region: [] } }), 403, true);
    {
      const t = good({ params: { region: 'East' } });
      const [h, , sig] = t.split('.');
      await expect('a widened lock (the payload edited, the MAC kept)', `${h}.${b64({ pub: site.id, dash: s.aid, exp: now() + 600, params: { region: ['East', 'West'] } })}.${sig}`, 403, false, /not valid/);
      await expect('the lock removed (the payload edited, the MAC kept)', `${h}.${b64({ pub: site.id, dash: s.aid, exp: now() + 600 })}.${sig}`, 403, false);
    }
    await expect('alg none', `${b64({ alg: 'none', kid: 'acme' })}.${b64({ pub: site.id, exp: now() + 60 })}.`, 403, false);
    await expect('alg HS512', hostSign(SECRET, { pub: site.id, exp: now() + 60 }, { alg: 'HS512', kid: 'acme' }), 403, false);
    await expect('a bad signature', hostSign(SECRET + 'x', { pub: site.id, exp: now() + 60 }), 403, false, /not valid/);
    await expect('an org that does not exist (the same answer as a bad signature: no probe tells them apart)', hostSign(SECRET, { pub: site.id, exp: now() + 60 }, { alg: 'HS256', kid: 'globex' }), 403, false, /not valid/);
    // Another org with its own secret: its signature holds, but the link is acme's — not found in globex.
    await pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'Globex') ON CONFLICT DO NOTHING`);
    const GLOBEX = 'ord_embed_' + 'g'.repeat(43);
    await real.put('globex', 'embed.signing', 'org', GLOBEX);
    await pool.query(`INSERT INTO org_settings (org_id, embed_enabled, embed_origins) VALUES ('globex', true, ARRAY['https://globex.test'])`);
    const wrongOrg = await get(hostSign(GLOBEX, { pub: site.id, dash: s.aid, exp: now() + 60 }, { alg: 'HS256', kid: 'globex' }));
    ok('route: wrong org — globex\'s valid token naming acme\'s link → 404, framable only by globex\'s site', wrongOrg.status === 404 && wrongOrg.csp.includes('frame-ancestors https://globex.test'), `${wrongOrg.status} ${wrongOrg.csp.slice(-50)}`);
    await expect('signed with acme\'s secret, claiming globex', hostSign(SECRET, { pub: site.id, exp: now() + 60 }, { alg: 'HS256', kid: 'globex' }), 403, false);
    await expect('a link that was never published', good({ pub: crypto.randomUUID() }), 404, true, /no longer published/);
    await expect('a dashboard that is not in the link', good({ dash: crypto.randomUUID() }), 404, true);

    // ── Every other route keeps frame-ancestors 'none' ──────────────────
    for (const p of ['/', '/healthz', '/api/auth/me', `/p/${site.id}/`, '/sign-in']) {
      const r = await fetch(`${base}${p}`, { headers: { accept: 'text/html', 'x-forwarded-email': 'boss@acme.test' }, redirect: 'manual' });
      const csp = r.headers.get('content-security-policy') ?? '';
      ok(`CSP: ${p} keeps frame-ancestors 'none' and X-Frame-Options DENY`, csp.includes("frame-ancestors 'none'") && !csp.includes(PORTAL) && r.headers.get('x-frame-options') === 'DENY', `${r.status} ${csp}`);
    }

    // ── Locks reach the page; columns for the picker ────────────────────
    const lockedPage = await get(good({ params: { region: 'East' } }));
    ok('route: a locked token renders under its lock (no other region in the page)', lockedPage.status === 200 && lockedPage.text.includes('East') && !/North|South|West/.test(lockedPage.text.split('id="ordinate-page">')[1]?.split('</script>')[0] ?? 'North'));
    const cols = await alice.call('embed:columns', { projectId: pid, siteId: site.id, dashboardId: s.aid });
    ok('columns: the picker lists the dashboard\'s columns with how many tiles each covers', cols.body.ok && cols.body.columns.some((c: { name: string; tiles: number }) => c.name === 'region' && c.tiles === cols.body.tiles), show(cols.body));

    // ── Rotation kills every old token ──────────────────────────────────
    const before = good({ theme: 'dark' });
    ok('rotation: control — the token works before', (await get(before)).status === 200);
    const rot2 = await boss.call('embed:rotate');
    const SECRET2: string = rot2.body.secret;
    ok('rotation: a new secret, different from the old', rot2.body.ok && SECRET2 !== SECRET);
    await expect('rotation: the old token', before, 403, false, /not valid/);
    ok('rotation: a token signed with the new secret works', (await get(hostSign(SECRET2, { pub: site.id, dash: s.aid, exp: now() + 600 }))).status === 200);

    // ── Unpublish closes the embed ──────────────────────────────────────
    const unpub = await boss.call('publish:unpublish', { projectId: pid, id: site.id });
    ok('unpublish: the embed stops at once', unpub.body.ok && (await get(hostSign(SECRET2, { pub: site.id, dash: s.aid, exp: now() + 300 }))).status === 404);
    const again = (await boss.call('publish:run', { projectId: pid, dashboardIds: [s.aid] })).body.site;

    // ── Rate limits ─────────────────────────────────────────────────────
    const one = hostSign(SECRET2, { pub: again.id, dash: s.aid, exp: now() + 900 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await get(one)).status);
    ok('limits: one token past RATE_LIMIT_EMBED_PER_MINUTE → 429', codes.slice(0, 6).every((c) => c === 200) && codes.slice(6).every((c) => c === 429), codes.join(','));
    const orgCodes: number[] = [];
    for (let i = 0; i < 80 && !orgCodes.includes(429); i++) orgCodes.push((await get(hostSign(SECRET2, { pub: again.id, dash: s.aid, exp: now() + 2000 + i }))).status);
    ok('limits: the org past RATE_LIMIT_EMBED_ORG_PER_MINUTE → 429, whatever the token', orgCodes.includes(429) && orgCodes.filter((c) => c === 200).length >= 10, `${orgCodes.length} ${orgCodes.slice(-3)}`);

    // ── Audit ───────────────────────────────────────────────────────────
    const rows = (await pool.query<{ actor: string; outcome: string; target_ids: string[]; channel: string | null }>(
      `SELECT actor, outcome, target_ids::text[] AS target_ids, channel FROM audit_log WHERE action = 'embed_view' AND org_id = 'acme'`)).rows;
    ok('audit: embed views are rows — actor embed, ids of the link and the dashboard', rows.length > 10 && rows.every((r) => r.actor === 'embed' && r.channel === null) && rows.some((r) => r.outcome === 'ok' && r.target_ids.includes(site.id) && r.target_ids.includes(s.aid)));
    ok('audit: refusals after the MAC held are rows too (denied)', rows.some((r) => r.outcome === 'denied'));
    const dump = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    ok('audit: no token and no secret in any audit row', !dump.includes(SECRET) && !dump.includes(SECRET2) && !dump.includes(one.split('.')[2]));
    const rotations = (await pool.query(`SELECT 1 FROM audit_log WHERE action = 'rpc' AND channel = 'embed:rotate' AND outcome = 'ok'`)).rowCount;
    ok('audit: each rotation is an admin rpc row', rotations === 2);

    // ── Canary ──────────────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 200));
    const log = logLines.join('');
    const otherReplies = replies.filter((_, i) => i !== rotIndex && !replies[i].includes(SECRET2));
    ok('canary: the secret is in no log line', !log.includes(SECRET) && !log.includes(SECRET2) && !log.includes(SECRET.slice(10)));
    ok('canary: no token in any log line (masked as /embed/[redacted])', !log.includes(one.split('.')[2]) && !log.includes(good().split('.')[0] + '.') && log.includes('/embed/[redacted]'));
    ok('canary: the secret is in no reply but the one that made it', otherReplies.every((t) => !t.includes(SECRET)) && replies.filter((t) => t.includes(SECRET)).length === 1);
    ok('canary: the secret is in no page', pages.every((t) => !t.includes(SECRET) && !t.includes(SECRET2)));
    const tables = JSON.stringify([(await pool.query('SELECT * FROM records')).rows, (await pool.query('SELECT * FROM org_settings')).rows, (await pool.query('SELECT * FROM org_config')).rows]);
    ok('canary: the secret is in no records, org_settings or org_config row', !tables.includes(SECRET) && !tables.includes(SECRET2));
    const disk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? disk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    ok('canary: the secret is in no file under DATA_DIR', disk(DATA).every((f) => !fs.readFileSync(f).includes(SECRET2)));
  } finally {
    await app.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip embed DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return finish();
  }
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await suite(url);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
