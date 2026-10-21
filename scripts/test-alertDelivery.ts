// One alert send path (docs/notifications/00-design.md §5.3-5.4): every way a
// rule can fire posts to its channels exactly as the tick does, once per event,
// on Postgres with header sign-in, a local Slack receiver and the fake SMTP
// relay. Nothing reaches a real Slack or mail server.
//
//   paths      dataset:refresh, input:save, snapshots:restore, fresh on ask (a
//              real dashboard:metric ask of a stale copy), a refresh URL (a real
//              HTTP POST), the MCP/CLI refresh handler, a pipeline's alert step
//              (pipelines:run) and the tick: each posts ONCE to Slack and ONCE by
//              email, with an alerts:post audit row whose actor proves the
//              context that posted (the member, the hook's creator,
//              jobs@system). NEGATIVE CONTROL: a rule with no channels, firing
//              on every path too, posts nothing
//   both       a breach seen by the tick and a ↻ at once posts once
//   ledger     the same event delivered twice posts once (control: a second
//              event posts again); a claim the database cannot answer posts
//              nothing and leaves an `error` audit row; alert_posts' own claim
//              passes as an ordinary role
//   push-only  a quality event and a pipeline failure push `alerts:fired` and
//              post nothing; quality events are still recorded after the rename
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-alertDelivery.js

export {}; // module scope
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { finish, ok } from './selfcheck';
import { CERT, startFake } from './smtpFake';
import * as B from './subscriptionHarness';
import { BOSS, JOBS, ORG, ordinaryRole, show, until, withServer, type Bench, type Identity } from './notifyHarness';

const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const connIpc: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
const foRecord: typeof import('../src/data/freshOnAskRecord') = require('../src/data/freshOnAskRecord');
const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
const handlers: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const alertPosts: typeof import('../src/server/subscriptions/alertPosts') = require('../src/server/subscriptions/alertPosts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const alertsIpc: typeof import('../src/ipc/alerts') = require('../src/ipc/alerts');
const quality: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');
const orgDb: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');

/** A message's Subject, its encoded words decoded (as scripts/test-email-db.ts reads it). */
function subjectOf(data: string): string {
  const head = data.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
  return (/^Subject: (.*)$/m.exec(head)?.[1] ?? '').split(' ').map((w) => {
    const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w);
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : w + ' ';
  }).join('').trim();
}

const who = (name: string): Identity => ({ user: { email: `${name}@acme.test`, role: 'editor' }, org: { id: ORG } });

// The source behind the fresh-on-ask dataset: a connection whose fetch answers from here.
const ROWS = [['1', '1', 'North', '10'], ['2', '2', 'South', '20'], ['3', '3', 'North', '30'], ['4', '4', 'East', '5']];
connIpc.runSavedText = (async () => ({ ok: true, header: ['id', 'updated', 'region', 'amount'], body: ROWS, truncated: false })) as typeof connIpc.runSavedText;
connIpc.refreshConnectionInto = (async () => ({ ok: false, error: 'no full re-fetch here' })) as typeof connIpc.refreshConnectionInto;

async function suite(b: Bench, fake: Awaited<ReturnType<typeof startFake>>): Promise<void> {
  const rx = await B.receiver();
  const pushes: string[] = [];
  sse.setFanOut((_t, channel) => pushes.push(channel)); // one pod here: every publish, seen
  try {
    await b.provision('eve', 'sam', 'hank', 'max', 'pia', 'vic');
    const pid: string = (await b.as('boss').call('projects:create', { name: 'Delivery' })).body.id;
    for (const e of ['eve', 'sam', 'hank', 'max', 'pia']) await b.share(pid, e, 'editor');
    await b.share(pid, 'vic', 'viewer');
    const slack = (await b.as('boss').call('channel:save', { name: 'Ops', kind: 'slack', webhookUrl: rx.url() })).body;
    const mail = (await b.as('boss').call('channel:save', { name: 'Leads', kind: 'email', to: { userIds: [await b.uid('boss')], teamIds: [] } })).body;
    ok('setup: a Slack channel and an email channel', slack.ok && mail.ok, show([slack, mail]));
    const channels = [slack.channel.id as string, mail.channel.id as string];

    // Three datasets: C (refreshable, scheduled, keeps snapshots), I (an input table), F (a connection copy with fresh on ask).
    const ids = await b.run(BOSS, async () => {
      const cols = [{ name: 'region', type: 'text' as const }, { name: 'n', type: 'number' as const }];
      const l = await datasets.saveDataset(pid, { name: 'North', sourceKind: 'paste', columns: cols, rows: [['north', 10]] });
      const r = await datasets.saveDataset(pid, { name: 'South', sourceKind: 'paste', columns: cols, rows: [['south', 20]] });
      const C = (await datasets.saveDataset(pid, { name: 'Both', sourceKind: 'combined', columns: cols, rows: [['north', 10]], origin: { kind: 'combined', leftId: l!.id, rightId: r!.id, mode: 'append' } }))!.id;
      await datasets.setAutoRefresh(pid, C, { every: 'hourly', lastAutoAt: new Date().toISOString() }); // scheduled: refreshes keep snapshots; not due yet
      const conn = await conns.saveConnection(pid, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } });
      const fcols = [{ name: 'id', type: 'number' as const }, { name: 'updated', type: 'number' as const }, { name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
      const F = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'postgres', columns: fcols, rows: ROWS.slice(0, 3).map((x) => [Number(x[0]), Number(x[1]), x[2], Number(x[3])]), origin: { kind: 'connection', connId: conn!.id, table: 'orders' } }))!.id;
      await datasets.writeIncremental(pid, F, () => ({ enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: 3, runsSinceFull: 1, log: [] }));
      const fo = await foRecord.setFreshOnAsk(pid, F, { maxStalenessSec: 300 });
      if (!fo.ok) throw new Error(fo.error);
      return { C, F };
    });
    const created = await b.as('eve').call('input:create', { projectId: pid, name: 'Targets', columns: [{ name: 'region', type: 'text' }, { name: 'n', type: 'number' }] });
    const I: string = created.body.id;
    await b.as('eve').call('input:save', { projectId: pid, id: I, batches: [{ label: 'Add', ops: [{ t: 'ins', at: 0, rows: [['north', '7']] }] }] });

    // A rule with channels and one without, on each dataset. `k` bumps the threshold: a changed condition re-arms (alertStore.saveRule).
    let k = 0;
    const rules: Array<{ id: string; name: string; datasetId: string; column: string; posts: boolean }> = [];
    for (const [d, column, tag] of [[ids.C, 'n', 'C'], [I, 'n', 'I'], [ids.F, 'amount', 'F']] as const) {
      for (const posts of [true, false]) {
        const name = `${tag} ${posts ? 'posted' : 'quiet'}`;
        const r = await b.as('boss').call('alerts:save', { projectId: pid, rule: { name, datasetId: d, metric: { column, aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true, ...(posts ? { channelIds: channels } : {}) } });
        if (!r.body.ok) throw new Error('rule ' + show(r.body));
        rules.push({ id: r.body.rule.id, name, datasetId: d, column, posts });
      }
    }
    const rearm = async (): Promise<void> => {
      k += 0.001;
      for (const r of rules) {
        await b.as('boss').call('alerts:save', { projectId: pid, rule: { id: r.id, name: r.name, datasetId: r.datasetId, metric: { column: r.column, aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: k }, enabled: true, ...(r.posts ? { channelIds: channels } : {}) } });
      }
    };
    const slackFor = (name: string) => rx.hits.filter((h) => JSON.stringify(h.body).includes(name)).length;
    const mailFor = (name: string) => fake.txns.filter((t) => subjectOf(t.data) === say.alertTitle(name)).length;
    const lastPostActor = async (): Promise<string | null> => (await b.pool.query<{ actor: string }>(`SELECT actor FROM audit_log WHERE channel = 'alerts:post' ORDER BY id DESC LIMIT 1`)).rows[0]?.actor ?? null;
    const trailCount = async (): Promise<number> => Number((await b.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE channel = 'alerts:post'`)).rows[0].n);

    /** Fire `path`, then: exactly one Slack post and one email for the dataset's posted rule, none for the quiet one, one audit row by `actor`. */
    const onePost = async (label: string, tag: 'C' | 'I' | 'F', actor: string, path: () => Promise<unknown>): Promise<void> => {
      await rearm();
      const [s0, m0, t0] = [slackFor(`${tag} posted`), mailFor(`${tag} posted`), await trailCount()];
      const quiet0 = slackFor(`${tag} quiet`) + mailFor(`${tag} quiet`);
      const quietId = rules.find((r) => r.name === `${tag} quiet`)!.id;
      const firedQuiet = async () => (await b.run(BOSS, () => alertStore.load(pid))).events.filter((e) => e.ruleId === quietId).length;
      const q0 = await firedQuiet();
      await path();
      await until(async () => slackFor(`${tag} posted`) > s0 && mailFor(`${tag} posted`) > m0, 20_000);
      await alertPosts.postsSettled();
      const [s1, m1, t1] = [slackFor(`${tag} posted`), mailFor(`${tag} posted`), await trailCount()];
      ok(`${label}: posts once to Slack and once by email`, s1 - s0 === 1 && m1 - m0 === 1, show({ slack: s1 - s0, mail: m1 - m0 }));
      ok(`${label}: one alerts:post audit row, by ${actor} — the context that posted`, t1 - t0 === 1 && (await lastPostActor()) === actor, show({ rows: t1 - t0, actor: await lastPostActor() }));
      ok(`${label} NEGATIVE CONTROL: the rule with no channels fired too, and posted nothing`, (await firedQuiet()) === q0 + 1 && slackFor(`${tag} quiet`) + mailFor(`${tag} quiet`) === quiet0, show([q0, await firedQuiet()]));
    };

    await onePost('dataset:refresh', 'C', 'boss@acme.test', () => b.as('boss').call('dataset:refresh', { projectId: pid, id: ids.C }));
    await onePost('input:save', 'I', 'eve@acme.test', () => b.as('eve').call('input:save', { projectId: pid, id: I, batches: [{ label: 'Edit', ops: [{ t: 'set', r: 0, c: 1, cells: [['9']] }] }] }));
    const stamps = (await b.as('boss').call('snapshots:list', { projectId: pid, datasetId: ids.C })).body;
    const stamp = stamps.items?.[0]?.stamp;
    ok('setup: the scheduled dataset kept a snapshot to restore', typeof stamp === 'string', show(stamps));
    await onePost('snapshots:restore', 'C', 'sam@acme.test', () => b.as('sam').call('snapshots:restore', { projectId: pid, datasetId: ids.C, stamp }));
    await onePost('fresh on ask (a real ask of a stale copy)', 'F', 'jobs@system', async () => {
      await b.run(BOSS, () => record.serialized(record.datasetFilePath(pid, ids.F), (raw) => { raw.lastRefreshedAt = new Date(Date.now() - 3_600_000).toISOString(); }));
      return b.as('vic').call('dashboard:metric', { projectId: pid, datasetId: ids.F, column: 'amount', aggregation: 'sum' });
    });
    const hook = (await b.as('hank').call('refreshHook:create', { projectId: pid, datasetId: ids.C })).body;
    ok('setup: a refresh URL, made by hank', hook.ok === true && typeof hook.token === 'string', show(hook));
    await onePost('a refresh URL (a real HTTP POST)', 'C', 'hank@acme.test', async () => {
      const res = await fetch(`${b.base}/api/hooks/refresh/${hook.token}`, { method: 'POST' });
      ok('refresh URL: the call was accepted', res.status >= 200 && res.status < 300, String(res.status));
    });
    // The refresh command is the automation registry's (no MCP tool exposes it over /api/mcp): driven as its member would.
    await onePost('the MCP/CLI refresh handler', 'C', 'max@acme.test', () => b.run(who('max'), () => handlers.datasetsRefresh({ projectId: pid, progress: () => undefined } as never, ids.C)));
    const graph = (await b.as('pia').call('pipelines:get', { projectId: pid })).body;
    const node = (graph.nodes ?? graph.graph?.nodes ?? []).find((n: { kind: string; name: string }) => n.kind === 'alert' && n.name === 'C posted');
    ok('setup: the pipeline shows the rule as an alert step', !!node, show(graph).slice(0, 300));
    await onePost('a pipeline\'s alert step (pipelines:run)', 'C', 'pia@acme.test', () => b.as('pia').call('pipelines:run', { projectId: pid, nodeId: node.id }));
    await onePost('the tick', 'C', 'jobs@system', async () => {
      await b.run(BOSS, () => datasets.setAutoRefresh(pid, ids.C, { every: 'hourly', lastAutoAt: new Date(Date.now() - 7_200_000).toISOString() }));
      await b.run(JOBS, () => scheduler.tickNow());
    });

    // ── both ──────────────────────────────────────────────────────────────
    await rearm();
    const s0 = slackFor('C posted');
    await b.run(BOSS, () => datasets.setAutoRefresh(pid, ids.C, { every: 'hourly', lastAutoAt: new Date(Date.now() - 7_200_000).toISOString() }));
    await Promise.all([b.run(JOBS, () => scheduler.tickNow()), b.as('boss').call('dataset:refresh', { projectId: pid, id: ids.C })]);
    await until(() => slackFor('C posted') > s0, 20_000);
    await alertPosts.postsSettled();
    await new Promise((r) => setTimeout(r, 300));
    await alertPosts.postsSettled();
    ok('a breach seen by the tick and a ↻ at once posts once', slackFor('C posted') - s0 === 1, String(slackFor('C posted') - s0));

    // ── ledger ────────────────────────────────────────────────────────────
    const posted = rules.find((r) => r.name === 'C posted')!;
    const ev = (): import('../src/analysis/alerts').AlertEvent => ({ id: randomUUID(), ruleId: posted.id, ruleName: posted.name, datasetId: ids.C, at: new Date().toISOString(), value: 30, previous: null, delta: null, deltaPct: null, message: 'C posted is above 0.', seen: false });
    const same = ev();
    const first = await b.run(JOBS, () => alertPosts.postFiredAlerts(pid, [same]));
    const again = await b.run(JOBS, () => alertPosts.postFiredAlerts(pid, [same]));
    ok('ledger: the same event delivered twice posts once (2 channels, then 0)', first === 2 && again === 0, show([first, again]));
    ok('ledger CONTROL: a second event posts again', (await b.run(JOBS, () => alertPosts.postFiredAlerts(pid, [ev()]))) === 2);
    const appPool = orgDb.orgDb();
    const dead = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    dead.on('error', () => undefined);
    orgDb.useOrgDb(dead);
    const hits0 = rx.hits.length;
    let blind: number;
    try {
      blind = await b.run(JOBS, () => alertPosts.postFiredAlerts(pid, [ev()]));
    } finally {
      orgDb.useOrgDb(appPool);
      await dead.end().catch(() => undefined);
    }
    const errRow = (await b.pool.query<{ outcome: string }>(`SELECT outcome FROM audit_log WHERE channel = 'alerts:post' ORDER BY id DESC LIMIT 1`)).rows[0];
    ok('ledger: a claim the database cannot answer posts nothing, and the trail says error', blind === 0 && rx.hits.length === hits0 && errRow?.outcome === 'error', show([blind, errRow]));
    const role = await ordinaryRole(b, ['alert_posts']);
    try {
      orgDb.useOrgDb(role);
      ok('rls alert_posts: the claim passes as an ordinary role', (await b.run(JOBS, () => alertPosts.postFiredAlerts(pid, [ev()]))) === 2);
    } finally {
      orgDb.useOrgDb(appPool);
      await role.end();
    }

    // ── push-only ─────────────────────────────────────────────────────────
    const pushed0 = pushes.filter((c) => c === 'alerts:fired').length;
    const h0 = rx.hits.length;
    const qualityEvents = async () => (await b.run(BOSS, () => alertStore.load(pid))).events.filter((e) => e.ruleName === 'Data quality').length;
    const before = await qualityEvents();
    const failing = await b.run(BOSS, () => quality.saveRule(pid, ids.C, { kind: 'range', column: 'n', args: { min: 1000, max: 2000 }, severity: 'fail' }));
    ok('push-only: a failing quality rule is saved and run', failing.ok, show(failing));
    ok('push-only: its event is recorded after the rename (the sink resolves pushAlertEvents)', (await qualityEvents()) === before + 1, show([before, await qualityEvents()]));
    await b.run(BOSS, () => alertsIpc.pushAlertEvents(pid, [{ ...ev(), ruleId: randomUUID(), ruleName: 'Pipeline', message: 'Pipeline: "x" failed.' }]));
    await new Promise((r) => setTimeout(r, 200));
    await alertPosts.postsSettled();
    ok('push-only: quality and pipeline events push alerts:fired and post nothing', pushes.filter((c) => c === 'alerts:fired').length > pushed0 && rx.hits.length === h0, show({ pushes: pushes.filter((c) => c === 'alerts:fired').length - pushed0, posts: rx.hits.length - h0 }));
  } finally {
    sse.setFanOut(null);
    await rx.close();
  }
}

(async () => {
  B.openLoopback();
  smtp.trustCaForTest(CERT);
  const fake = await startFake({ creds: { user: 'relay', pass: 'relay-pw' } });
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  try {
    await withServer('alertDelivery', {
      SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: 'relay', SMTP_PASSWORD: 'relay-pw', SMTP_FROM: 'Acme Analytics <bi@acme.test>',
      FRESH_ON_ASK_WAIT_MS: '4000',
    }, (b) => suite(b, fake));
  } finally {
    await fake.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
