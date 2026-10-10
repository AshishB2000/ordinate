// Subscriptions over the server's RPC, and a run end to end — real HTTP, server
// mode, dev sign-in, records as files. Delivery goes to a LOCAL receiver
// (scripts/subscriptionHarness.ts); nothing here reaches Slack or Teams.
//
//   channels   refused without a secret store; saved with one — and no reply
//              ever carries the URL (`secretSet` only); https only; test message
//   preview    DIFFERENTIAL: a KPI is `analysis:tiles`' figure, its change is
//              `metric:compare`'s; a chart's rows are `visual:data`'s on the
//              share path 'report'; the Share policy hides a tile; a saved view
//   link       built from ORDINATE_PUBLIC_URL only — a client's Host / Origin
//              never reaches it; unset → no link and the reply says why
//   delivery   200; 429 honouring Retry-After; 5xx retried with backoff; a 4xx
//              final at once; a redirect not followed; an internal address
//              refused before any socket (NEGATIVE CONTROL: the allowed one posts)
//   tick       due → sent once; the same tick again → nothing; late → sent;
//              ≥ 6 h late → missed; the two conditions; five failed runs → paused,
//              the owner told over SSE, and switching it on starts over
//   canary     the webhook URL's secret is in NO reply, log line, record file,
//              run history or SSE event (NEGATIVE CONTROL: the receiver saw it)
//   scope      another project's id finds nothing; another org reads no channel
//
//   npm run build:ts && node scripts/test-subscriptions-server.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Writable } from 'stream';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const run: typeof import('../src/server/subscriptions/run') = require('../src/server/subscriptions/run');
const store: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const datasetRecord: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const fmt: typeof import('../src/app/format') = require('../src/app/format');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-subs-'));
const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'default' } };
const DAY = 86_400_000;
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

(async () => {
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  const { waits } = B.openLoopback();
  const rx = await B.receiver();
  const elsewhere = await B.receiver(); // where a redirect points: must never be reached

  const logLines: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, done) { logLines.push(String(chunk)); done(); } });
  const deliveryLog: string[] = [];
  B.deliver.useDeliveryLog({ warn: (obj, msg) => deliveryLog.push(msg + ' ' + JSON.stringify(obj)) });
  const events: Array<{ target: import('../src/server/sse').Target; channel: string; data: string }> = [];
  sse.setFanOut((target, channel, data) => events.push({ target, channel, data }));

  delete process.env.ORDINATE_PUBLIC_URL;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'info', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }), logStream);
  const base = await B.listen(app);
  const replies: string[] = [];
  const { call } = B.client(base, {}, replies);
  const direct = (channel: string, payload: unknown) =>
    B.context.runInContext(DEV, 'direct', async () => (rpc.handlers.get(channel) as import('../src/server/rpc').Handler)({}, payload)) as Promise<any>; // any: a handler's reply
  const asJob = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(JOBS, 'job:subscriptions:default', fn);

  try {
    const pid: string = (await call('projects:create', { name: 'Subscriptions' })).body.id;
    const s = await B.seed(DEV, pid);

    // ── channels ──────────────────────────────────────────────────────────
    const none = await call('channel:save', { name: 'Sales', kind: 'slack', webhookUrl: rx.url() });
    ok('channel:save without a secret store is REFUSED, in the catalog\'s words — nothing is written in the clear',
      none.status === 200 && none.body.ok === false && none.body.error === say.channelsNeedStore() && (await call('channel:list')).body.channels.length === 0, show(none.body));
    ok('channel:list says the server cannot keep webhook URLs', (await call('channel:list')).body.canStore === false);
    const secrets = B.memoryStore();
    B.channels.useChannelSecrets(secrets);

    const slack = await call('channel:save', { name: 'Sales team', kind: 'slack', webhookUrl: rx.url() });
    const teams = await call('channel:save', { name: 'Leadership', kind: 'teams', webhookUrl: rx.url(`/teams/${B.CANARY}`) });
    ok('channel:save: the reply is {id, name, kind, secretSet} — no URL', slack.body.ok && Object.keys(slack.body.channel).sort().join() === 'id,kind,name,secretSet' && slack.body.channel.secretSet === true && teams.body.channel.kind === 'teams', show(slack.body));
    const SL: string = slack.body.channel.id;
    const TM: string = teams.body.channel.id;
    const listed = await call('channel:list');
    ok('channel:list: both channels by name, each `secretSet`, `canStore` true', listed.body.canStore === true && listed.body.channels.map((c: { name: string }) => c.name).join() === 'Leadership,Sales team'
      && listed.body.channels.every((c: { secretSet: boolean }) => c.secretSet === true), show(listed.body));
    B.channels.allowHttpForTest(false);
    const plain = await call('channel:save', { name: 'Plain', kind: 'slack', webhookUrl: 'http://hooks.example.com/x' });
    const creds = await call('channel:save', { name: 'Creds', kind: 'slack', webhookUrl: 'https://user:pw@hooks.example.com/x' });
    const blank = await call('channel:save', { name: 'Blank', kind: 'slack' });
    B.channels.allowHttpForTest(true);
    ok('channel:save: http://, credentials in the URL and no URL are each refused with a sentence',
      plain.body.error === say.channelNeedsHttps() && creds.body.error === say.channelNeedsHttps() && blank.body.error === say.channelNeedsUrl(), show([plain.body, creds.body, blank.body]));
    const renamed = await call('channel:save', { id: SL, name: 'Sales', kind: 'slack' });
    ok('channel:save on an existing channel with no URL keeps the stored one', renamed.body.ok && renamed.body.channel.name === 'Sales' && renamed.body.channel.secretSet === true && secrets.dump().length === 2);
    ok('contract: a name is required; an unknown kind and an unknown field are 400',
      (await call('channel:save', { name: ' ', kind: 'slack', webhookUrl: rx.url() })).status === 400 && (await call('channel:save', { name: 'X', kind: 'email', webhookUrl: rx.url() })).status === 400
      && (await call('channel:save', { name: 'X', kind: 'slack', webhookUrl: rx.url(), secretSet: true })).status === 400);
    ok('no contract, no channel: there is no way to read a URL back', (await call('channel:webhook', { id: SL })).status === 404 && (await call('channel:get', { id: SL })).status === 404);

    const t1 = await call('channel:test', { id: SL });
    const t2 = await call('channel:test', { id: TM });
    ok('channel:test posts ONE fixed message to each platform in its own shape', t1.body.ok && t2.body.ok && rx.hits.length === 2
      && rx.hits[0].method === 'POST' && rx.hits[0].headers['content-type'] === 'application/json' && Array.isArray(rx.hits[0].body.blocks) && rx.hits[0].body.blocks[0].text.text === say.testTitle()
      && rx.hits[1].body.type === 'message' && rx.hits[1].body.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive', show(rx.hits.map((h) => h.url)));
    rx.hits.length = 0;

    // ── save / list / get ─────────────────────────────────────────────────
    const made = await call('subscription:save', { projectId: pid, subscription: B.definition(s, [SL, TM]) });
    ok('subscription:save: created, owned by the caller, enabled, with its schedule as a sentence and three next runs',
      made.status === 200 && made.body.ok && made.body.subscription.owner === 'dev@local' && made.body.subscription.enabled === true
      && made.body.subscription.scheduleText === 'Every day at 08:00 (UTC)' && made.body.subscription.nextRuns.length === 3 && made.body.subscription.dashboard === 'Board', show(made.body));
    const sid: string = made.body.subscription.id;
    ok('next runs are a day apart at 08:00 UTC, each with the server\'s own wording', made.body.subscription.nextRuns.every((r: { at: string; text: string }) => r.at.endsWith('T08:00:00.000Z') && /^\w{3},? \d{1,2} \w{3},? 08:00$/.test(r.text)), show(made.body.subscription.nextRuns));
    ok('contract: a browser cannot set the owner, the run state or `since` (strict → 400)',
      (await call('subscription:save', { projectId: pid, subscription: { ...B.definition(s, [SL]), owner: 'eve@x' } })).status === 400
      && (await call('subscription:save', { projectId: pid, subscription: { ...B.definition(s, [SL]), run: { failures: 0, history: [] } } })).status === 400
      && (await call('subscription:save', { projectId: pid, subscription: { ...B.definition(s, [SL]), since: '2000-01-01T00:00:00Z' } })).status === 400);
    ok('subscription:save refuses a dashboard that is not in this project, and a send with no channel left',
      (await call('subscription:save', { projectId: pid, subscription: B.definition(s, [SL], { analysisId: crypto.randomUUID() }) })).body.error === say.subscriptionNeedsDashboard()
      && (await call('subscription:save', { projectId: pid, subscription: B.definition(s, [crypto.randomUUID()]) })).body.error === say.subscriptionNeedsChannel());
    const list = await call('subscription:list', { projectId: pid });
    ok('subscription:list: the subscription, the channels to draw it with, no run yet', list.body.ok && list.body.subscriptions.length === 1 && list.body.subscriptions[0].lastRun === null && list.body.channels.length === 2 && list.body.subscriptions[0].paused === null);
    const other: string = (await call('projects:create', { name: 'Other' })).body.id;
    ok('scope: the id under ANOTHER project finds nothing — get, history, sendNow, setEnabled, delete',
      (await call('subscription:get', { projectId: other, id: sid })).body.ok === false && (await call('subscription:history', { projectId: other, id: sid })).body.ok === false
      && (await call('subscription:sendNow', { projectId: other, id: sid })).body.ok === false && (await call('subscription:setEnabled', { projectId: other, id: sid, enabled: false })).body.ok === false
      && (await call('subscription:list', { projectId: other })).body.subscriptions.length === 0 && rx.hits.length === 0
      && (await call('subscription:get', { projectId: pid, id: sid })).body.subscription.enabled === true);

    // ── preview — differential ────────────────────────────────────────────
    const pv = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL, TM]) });
    ok('preview: 200 with both platforms\' models, the dashboard\'s cards by title and type, the schedule sentence and next runs',
      pv.status === 200 && pv.body.ok && pv.body.slack && pv.body.teams && pv.body.nextRuns.length === 3 && pv.body.scheduleText === 'Every day at 08:00 (UTC)'
      && pv.body.cards.map((c: { title: string; type: string }) => `${c.type}:${c.title}`).join() === 'metric:Avg order,metric:amount,visual:Sales by region,visual:Monthly sales', show(pv.body.cards));
    const model = pv.body.slack.model;
    const tiles = await direct('analysis:tiles', { projectId: pid, params: [], items: [
      { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'avg', filters: [] },
      { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum', filters: [], metricId: s.rev, compare: { mode: 'custom', from: '2025-01-01', to: '2025-06-30' } },
    ] });
    ok('preview: a column KPI IS analysis:tiles\' figure, formatted by the server\'s formatter', model.kpis[0].label === 'Avg order' && model.kpis[0].value === fmt.formatValue(tiles[0].value, 'auto') && tiles[0].value === 215, show([model.kpis[0], tiles[0]]));
    ok('preview: a saved-metric KPI shows the metric\'s own name and display string', model.kpis[1].label === 'Revenue' && model.kpis[1].value === tiles[1].display, show([model.kpis[1], tiles[1].display]));
    const c = tiles[1].compare;
    ok('preview: the KPI\'s change IS metric:compare\'s — direction ▲, its percent, and "good" because the metric says up is good',
      c.ok && c.pct > 0 && model.kpis[1].change === say.changeText('▲', '+' + alerts.fmtPct(c.pct), c.label, true) && model.kpis[1].tone === 'good', show([model.kpis[1], c]));
    const viz = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: B.SALES, filters: [], params: [], share: 'report' });
    const byValue = viz.data.labels.map((l: string, i: number) => [l, viz.data.series[0].values[i]] as [string, number]).sort((a: [string, number], b: [string, number]) => b[1] - a[1]);
    const total = byValue.reduce((sum: number, r: [string, number]) => sum + r[1], 0);
    const sec = model.sections[0];
    ok('preview: a categorical chart\'s rows ARE visual:data\'s on the share path — biggest first, value and share',
      sec.title === 'Sales by region' && sec.rows.length === 4 && sec.rows.every((r: string[], i: number) => r[0] === byValue[i][0] && r[1] === fmt.formatValue(byValue[i][1], 'auto') && r[2] === alerts.fmtPct((byValue[i][1] / total) * 100)), show([sec.rows, byValue]));
    const cap = await direct('reports:caption', { input: { chartType: 'bar', data: viz.data, geo: null, pivot: null, projectId: pid, datasetId: s.ds, overrides: null } });
    ok('preview: the section\'s sentence IS reports:caption\'s', typeof cap === 'string' && cap.length > 0 && sec.caption === cap.replace(/\s+/g, ' ').trim().slice(0, 400), show([sec.caption, cap]));
    const trend = model.sections[1];
    ok('preview: a time series is its latest value, the change and the range', trend.title === 'Monthly sales' && trend.rows.length === 3 && trend.rows[0][0].startsWith(say.latestLabel()) && trend.rows[1][0] === say.changeLabel() && trend.rows[2][0] === say.rangeLabel(), show(trend));
    ok('preview: the subtitle dates the data; the footer names the subscription and its schedule',
      model.subtitle.some((x: string) => x.startsWith('Data as of ')) && model.footer === say.footerText('Weekly board', 'Every day at 08:00 (UTC)'), show([model.subtitle, model.footer]));
    ok('preview: sizes for the UI — Slack blocks and bytes, Teams bytes, no truncation note on a small message',
      pv.body.slack.blocks > 3 && pv.body.slack.bytes > 200 && pv.body.teams.bytes > 200 && pv.body.slack.notes.length === 0 && pv.body.teams.notes.length === 0);
    const picked = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL], { content: { mode: 'cards', cardIds: [s.kpiAvg, s.tile2] } }) });
    ok('preview: chosen cards only', picked.body.slack.model.kpis.length === 1 && picked.body.slack.model.sections.length === 1 && picked.body.slack.model.sections[0].title === 'Monthly sales');
    const gone = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL], { content: { mode: 'cards', cardIds: [crypto.randomUUID()] } }) });
    ok('preview: cards no longer on the dashboard → no message, and the reason', gone.body.ok && gone.body.slack === null && gone.body.empty === say.runText('no_content'));

    // The link is the server's own.
    ok('link: no public address → no link in the model, and a note for the UI saying why', model.link === undefined && pv.body.linkNote === say.noLinkNote());
    process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
    const spoofed = B.client(base, { 'x-forwarded-host': 'evil.example', origin: base, 'x-forwarded-proto': 'http' });
    const withLink = await spoofed.call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL]) });
    ok('link: built from ORDINATE_PUBLIC_URL — to the dashboard in the app; a client\'s forwarded host never reaches it',
      withLink.body.slack.model.link.url === `https://bi.example.com/analyses/${pid}/${s.aid}` && withLink.body.linkNote === null && !withLink.text.includes('evil.example'), show(withLink.body.slack.model.link));
    const off = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL], { message: { title: 'Custom title', note: 'For Monday', includeLink: false } }) });
    ok('message options: a title, a note, and "include link" off', off.body.slack.model.title === 'Custom title' && off.body.slack.model.note === 'For Monday' && off.body.slack.model.link === undefined);

    // The Share policy decides what leaves; a saved view narrows it.
    await call('privacy:decide', { projectId: pid, datasetId: s.ds, column: 'region', level: 'personal' });
    await call('privacy:setPolicy', { projectId: pid, policy: { report: 'drop' } });
    const hid = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL]) });
    ok('share policy: a tile the policy drops sends NO rows and says so; the other tile is untouched',
      hid.body.slack.model.sections[0].rows.length === 0 && hid.body.slack.model.sections[0].note === 'Hidden by the share policy' && hid.body.slack.model.sections[1].rows.length === 3, show(hid.body.slack.model.sections[0]));
    await call('privacy:setPolicy', { projectId: pid, policy: { report: 'mask' } });
    const masked = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL]) });
    ok('share policy: under "mask" the categories leave as tokens, never the values — the figures stay',
      masked.body.slack.model.sections[0].rows.length === 4 && masked.body.slack.model.sections[0].rows.every((r: string[]) => /^#[0-9a-f]+$/.test(r[0]))
      && !JSON.stringify(masked.body.slack.model.sections[0]).includes('West') && masked.body.slack.model.sections[0].rows[0][1] === sec.rows[0][1], show(masked.body.slack.model.sections[0].rows));
    await call('privacy:setPolicy', { projectId: pid, policy: { report: 'include' } });
    const viewId = crypto.randomUUID();
    await B.context.runInContext(DEV, 'view', async () => {
      const a = await analysis.getAnalysis(pid, s.aid);
      const now = new Date().toISOString();
      await analysis.updateAnalysis(pid, s.aid, { views: [{ id: viewId, name: 'West only', createdAt: now, updatedAt: now, state: { page: '', controls: {}, params: {}, selection: [{ type: 'filter', column: 'region', op: '=', value: 'West' }], tiles: {}, groupTabs: {}, asOf: null } }], sheets: a!.sheets } as never);
    });
    const viewed = await call('subscription:preview', { projectId: pid, draft: B.definition(s, [SL], { viewId }) });
    ok('saved view: the send carries the view\'s filters — one region left — names the view, and links to it',
      viewed.body.views.length === 1 && viewed.body.slack.model.sections[0].rows.length === 1 && viewed.body.slack.model.sections[0].rows[0][0] === 'West'
      && viewed.body.slack.model.subtitle.includes(say.viewText('West only')) && viewed.body.slack.model.link.url.endsWith(`?view=${viewId}`), show(viewed.body.slack.model.sections[0]));

    // ── Send now ──────────────────────────────────────────────────────────
    const sent = await call('subscription:sendNow', { projectId: pid, id: sid });
    ok('sendNow: posted once to each channel — Slack blocks to one, the Teams card to the other', sent.body.ok && sent.body.run.text === 'Sent to 2 channels.' && rx.hits.length === 2
      && Array.isArray(rx.hits[0].body.blocks) && rx.hits[1].body.attachments[0].content.type === 'AdaptiveCard', show([sent.body, rx.hits.length]));
    ok('sendNow: what Slack received is the previewed message', rx.hits[0].body.blocks[0].text.text === 'Board' && JSON.stringify(rx.hits[0].body).includes('Sales by region') && JSON.stringify(rx.hits[0].body).includes(`https://bi.example.com/analyses/${pid}/${s.aid}`));
    const hist = await call('subscription:history', { projectId: pid, id: sid });
    ok('history: one manual run, sent, as a sentence', hist.body.runs.length === 1 && hist.body.runs[0].trigger === 'manual' && hist.body.runs[0].outcome === 'sent' && hist.body.runs[0].text === 'Sent to 2 channels.', show(hist.body));
    rx.hits.length = 0;

    // ── delivery ──────────────────────────────────────────────────────────
    const post = (url: string) => B.deliver.postJson(url, '{"text":"hi"}', 'Sales');
    waits.length = 0;
    rx.script.push([429, { 'retry-after': '2' }, 'slow down'], [200]);
    const r429 = await post(rx.url());
    ok('delivery: a 429 waits for Retry-After (2 s) and then succeeds on the second attempt', r429.ok && r429.attempts === 2 && waits.join() === '2000', show([r429, waits]));
    waits.length = 0;
    rx.script.push([500, {}, 'oops'], [503, {}, 'still'], [200]);
    const r5 = await post(rx.url());
    ok('delivery: 5xx is retried with a backoff (1 s, 4 s) — third attempt delivers', r5.ok && r5.attempts === 3 && waits.join() === '1000,4000', show([r5, waits]));
    waits.length = 0;
    rx.script.push([500], [500], [500], [200]);
    const dead = await post(rx.url());
    ok('delivery: three failed attempts and it stops — no fourth', !dead.ok && dead.code === 'post_failed' && dead.status === 500 && dead.attempts === 3 && rx.script.length === 1, show(dead));
    rx.script.length = 0;
    waits.length = 0;
    rx.script.push([404, {}, 'no_service']);
    const revoked = await post(rx.url());
    ok('delivery: a 4xx is final at once (a revoked webhook is not retried)', !revoked.ok && revoked.status === 404 && revoked.attempts === 1 && waits.length === 0, show(revoked));
    rx.script.push([429, { 'retry-after': '9999' }], [200]);
    waits.length = 0;
    await post(rx.url());
    ok('delivery: an absurd Retry-After is capped at 30 s', waits.join() === '30000', waits.join());
    const before = elsewhere.hits.length;
    rx.script.push([302, { location: elsewhere.url('/stolen') }]);
    const redirected = await post(rx.url());
    ok('delivery: a redirect is NOT followed — the message goes nowhere the admin did not choose', !redirected.ok && redirected.code === 'refused' && elsewhere.hits.length === before, show(redirected));
    const hitsBefore = rx.hits.length;
    const internal = await post('http://10.0.0.5/hook');
    const meta = await post('http://169.254.169.254/latest/meta-data');
    ok('delivery: an internal address and the metadata address are refused by the SSRF guard before any socket', internal.code === 'refused' && internal.attempts === 1 && meta.code === 'refused');
    ok('NEGATIVE CONTROL: the receiver is reached only because 127.0.0.1/32 is in SSRF_ALLOW — without it, refused',
      (await post(rx.url())).ok && rx.hits.length === hitsBefore + 1 && await (async () => { process.env.SSRF_ALLOW = ''; const r = await post(rx.url()); process.env.SSRF_ALLOW = '127.0.0.1/32'; return r.code === 'refused'; })());
    const closed = await B.receiver();
    const deadUrl = closed.url();
    await closed.close();
    waits.length = 0;
    const down = await post(deadUrl);
    ok('delivery: a connection that cannot be made is retried, then `unreachable`', !down.ok && down.code === 'unreachable' && down.attempts === 3 && waits.length === 2, show(down));
    ok('delivery: what the remote said is in the LOG (status and body), with the URL cut out', deliveryLog.some((l) => l.includes('"status":404') && l.includes('no_service')) && deliveryLog.some((l) => l.includes('"status":500') && l.includes('oops')));
    ok('redactWebhook cuts the URL, its path and its query out of a string', B.deliver.redactWebhook(`failed POST ${rx.url()} and /services/${B.CANARY} again`, rx.url()) === 'failed POST [webhook] and [webhook] again');
    rx.hits.length = 0;
    rx.script.length = 0;

    // ── the tick ──────────────────────────────────────────────────────────
    const first = Math.ceil((Date.now() + 1000) / DAY) * DAY + 8 * 3_600_000; // the next 08:00 UTC that is not today's
    const slot = (k: number): number => first + k * DAY;
    const state = () => B.context.runInContext(DEV, 'read', () => store.getSubscription(pid, sid));
    ok('tick: before the slot nothing is due', (await asJob(() => run.tickSubscriptions(slot(0) - 60_000))) === 0 && rx.hits.length === 0);
    ok('tick: at the slot it is sent once, to both channels', (await asJob(() => run.tickSubscriptions(slot(0) + 20_000))) === 1 && rx.hits.length === 2);
    ok('tick: the same minute again — the slot is stamped, nothing is sent twice', (await asJob(() => run.tickSubscriptions(slot(0) + 50_000))) === 0 && rx.hits.length === 2);
    ok('tick: a repeated claim of the SAME slot (a retaken lease) does nothing', (await asJob(() => run.runSubscription(pid, sid, slot(0), slot(0) + 55_000))) === null && rx.hits.length === 2);
    ok('tick: the run is on the record — scheduled, sent, its slot', (await state())!.run.history[0].trigger === 'schedule' && (await state())!.run.history[0].slot === new Date(slot(0)).toISOString() && (await state())!.run.lastSlot === new Date(slot(0)).toISOString());
    rx.hits.length = 0;
    ok('late: the server back 5 h after the slot still sends', (await asJob(() => run.tickSubscriptions(slot(1) + 5 * 3_600_000))) === 1 && rx.hits.length === 2);
    rx.hits.length = 0;
    await asJob(() => run.tickSubscriptions(slot(2) + 7 * 3_600_000));
    ok('missed: back 7 h after the slot — recorded as missed, in words, and NOT sent', rx.hits.length === 0 && (await state())!.run.history[0].outcome === 'missed'
      && (await call('subscription:history', { projectId: pid, id: sid })).body.runs[0].text === say.runText('missed'));
    ok('missed: the slot is done — the next tick does not send it late', (await asJob(() => run.tickSubscriptions(slot(2) + 7 * 3_600_000 + 60_000))) === 0 && rx.hits.length === 0);

    // Conditions.
    await call('subscription:save', { projectId: pid, id: sid, subscription: B.definition(s, [SL], { conditions: { skipUnchanged: true, onlyWhenRefreshed: false } }) });
    ok('an edit keeps the owner and the history, and never fires for a slot that already passed', (await state())!.owner === 'dev@local' && (await state())!.run.history.length === 4);
    // The edit moved `since` to now (the real clock), so the slots below are still ahead of it.
    await asJob(() => run.tickSubscriptions(slot(3) + 1000));
    ok('skip when unchanged: the figures are those last sent → skipped, said so, nothing posted',
      rx.hits.length === 0 && (await state())!.run.history[0].outcome === 'skipped' && (await call('subscription:list', { projectId: pid })).body.subscriptions[0].lastRun.text === say.runText('unchanged'), show((await state())!.run.history[0]));
    await B.context.runInContext(DEV, 'edit', async () => {
      const a = await analysis.getAnalysis(pid, s.aid);
      a!.sheets[0].cards[0].metric!.aggregation = 'max';
      await analysis.updateAnalysis(pid, s.aid, { sheets: a!.sheets } as never);
    });
    await asJob(() => run.tickSubscriptions(slot(4) + 1000));
    ok('skip when unchanged: a figure changed → sent', rx.hits.length === 1 && (await state())!.run.history[0].outcome === 'sent');
    ok('NEGATIVE CONTROL: Send now ignores the condition — unchanged figures still go when someone asks', (await call('subscription:sendNow', { projectId: pid, id: sid })).body.ok === true && rx.hits.length === 2);
    rx.hits.length = 0;
    await call('subscription:save', { projectId: pid, id: sid, subscription: B.definition(s, [SL], { conditions: { skipUnchanged: false, onlyWhenRefreshed: true } }) });
    await asJob(() => run.tickSubscriptions(slot(5) + 1000));
    ok('only when refreshed: the data is as old as at the last send → skipped, said so', rx.hits.length === 0 && (await state())!.run.history[0].code === 'not_refreshed');
    await new Promise((r) => setTimeout(r, 5));
    await B.context.runInContext(DEV, 'refresh', () => datasetRecord.markRefresh(pid, s.ds, 'ok', null));
    await asJob(() => run.tickSubscriptions(slot(6) + 1000));
    ok('only when refreshed: after a refresh → sent', rx.hits.length === 1 && (await state())!.run.history[0].outcome === 'sent', show((await state())!.run.history[0]));
    rx.hits.length = 0;

    // Five failed runs in a row → paused.
    await call('subscription:save', { projectId: pid, id: sid, subscription: B.definition(s, [SL]) });
    rx.fallback = [500, {}, `internal error at /services/${B.CANARY}`];
    events.length = 0;
    for (let k = 7; k < 7 + store.PAUSE_AFTER - 1; k++) await asJob(() => run.tickSubscriptions(slot(k) + 1000));
    const four = (await state())!;
    ok(`pause: ${store.PAUSE_AFTER - 1} failed runs — still on, the count kept, each run's reason in words`, four.enabled && four.run.failures === store.PAUSE_AFTER - 1 && !four.run.paused
      && (await call('subscription:history', { projectId: pid, id: sid })).body.runs[0].text === say.runText('post_failed', { channel: 'Sales', status: 500 }), show(four.run.failures));
    await asJob(() => run.tickSubscriptions(slot(7 + store.PAUSE_AFTER - 1) + 1000));
    const paused = (await state())!;
    ok(`pause: the ${store.PAUSE_AFTER}th switches it off with the reason`, !paused.enabled && paused.run.paused?.code === 'post_failed' && paused.run.failures === store.PAUSE_AFTER);
    const view = (await call('subscription:list', { projectId: pid })).body.subscriptions[0];
    ok('pause: the list shows it paused, why, and no next run', view.enabled === false && view.paused.text === say.pausedText(store.PAUSE_AFTER) && view.paused.reason === say.runText('post_failed', { channel: 'Sales', status: 500 }) && view.nextRuns.length === 0, show(view.paused));
    const told = events.filter((e) => e.channel === 'subscriptions:paused');
    ok('pause: the OWNER is told over SSE — one event, to that user only, with the sentence', told.length === 1 && told[0].target.user === 'dev@local' && told[0].target.org === 'default'
      && (B.wire.decode(told[0].data) as { message: string }).message === say.pausedNotice('Weekly board', store.PAUSE_AFTER), show(told));
    const posts = rx.hits.length;
    await asJob(() => run.tickSubscriptions(slot(20) + 1000));
    ok('pause: a paused subscription sends nothing more', rx.hits.length === posts);
    rx.fallback = [200, {}, 'ok'];
    const back = await call('subscription:setEnabled', { projectId: pid, id: sid, enabled: true });
    ok('pause: switching it back on clears the reason and the count', back.body.subscription.enabled && back.body.subscription.paused === null && (await state())!.run.failures === 0);
    const before20 = (await state())!.run.history.length;
    await B.context.runInContext(DEV, 'fill', () => store.stampRun(pid, sid, (r) => ({ ...r, history: [...Array.from({ length: 30 }, (_, i) => ({ at: new Date(slot(30 + i)).toISOString(), trigger: 'schedule' as const, outcome: 'sent' as const, code: 'sent' as const })), ...r.history] })));
    ok(`history keeps the last ${store.MAX_HISTORY} runs, newest first (${before20} + 30 written)`, (await state())!.run.history.length === store.MAX_HISTORY
      && (await call('subscription:history', { projectId: pid, id: sid })).body.runs.length === store.MAX_HISTORY && (await state())!.run.history[0].at === new Date(slot(30)).toISOString());
    rx.hits.length = 0;

    // A run whose dashboard or channels are gone fails with a typed reason and sends nothing.
    const lonely = (await call('subscription:save', { projectId: pid, subscription: B.definition(s, [TM], { name: 'Lonely' }) })).body.subscription.id;
    const usage = await call('channel:usage', { id: TM });
    ok('channel:usage names the subscriptions that post to a channel, with their project', usage.body.subscriptions.map((u: { name: string; project: string }) => `${u.project}/${u.name}`).join() === 'Subscriptions/Lonely', show(usage.body));
    ok('channel:delete removes the channel AND its sealed URL', (await call('channel:delete', { id: TM })).body.ok && (await call('channel:list')).body.channels.length === 1 && secrets.dump().length === 1);
    const orphan = await call('subscription:sendNow', { projectId: pid, id: lonely });
    ok('a subscription whose only channel was deleted: not sent, and the reason', orphan.body.ok === false && orphan.body.error === say.runText('no_channels') && rx.hits.length === 0);

    // ── another org ───────────────────────────────────────────────────────
    const GLOBEX: B.Identity = { user: { email: 'bo@globex.test', role: 'admin' }, org: { id: 'globex' } };
    const theirs = await B.context.runInContext(GLOBEX, 'other-org', async () => ({
      channels: await B.channels.listChannels(), url: await B.channels.webhookOf(SL), one: await B.channels.getChannel(SL), subs: await store.listSubscriptions(pid),
    }));
    ok('another org sees no channel, reads no webhook URL by its id, and finds no subscription under the project id',
      theirs.channels.length === 0 && theirs.url === null && theirs.one === null && theirs.subs.length === 0);
    ok('NEGATIVE CONTROL: the owning org does read them', (await B.context.runInContext(DEV, 'own', () => B.channels.webhookOf(SL))) === rx.url());

    // ── the canary ────────────────────────────────────────────────────────
    const NEEDLE = 'webhook-canary-7f3a91c2';
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith('.json')) files.push(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      }
    };
    walk(DATA);
    await new Promise((r) => setTimeout(r, 50)); // the request log is written after the reply
    ok(`canary: no RPC reply carries the webhook secret (${replies.length} replies)`, replies.length > 40 && !replies.some((r) => r.includes(NEEDLE)));
    ok(`canary: no server log line carries it (${logLines.length} lines)`, logLines.length > 60 && !logLines.some((l) => l.includes(NEEDLE)));
    ok(`canary: no delivery log line carries it, though the remote ECHOED it in an error body (${deliveryLog.length} lines)`, deliveryLog.length > 8 && !deliveryLog.some((l) => l.includes(NEEDLE)) && deliveryLog.some((l) => l.includes('internal error at [webhook]')));
    ok(`canary: no record on disk — channel, subscription, run history — carries it (${files.length} files)`, files.length > 5 && !files.some((f) => f.includes(NEEDLE)));
    ok(`canary: no SSE event carries it (${events.length} events)`, events.length > 0 && !events.some((e) => e.data.includes(NEEDLE) || JSON.stringify(e.target).includes(NEEDLE)));
    ok('NEGATIVE CONTROL: the secret is real — the receiver was posted to at it, and the store holds it', secrets.dump().some((v) => v.includes(NEEDLE)) && elsewhere.hits.length === 0
      && (await (async () => { await call('channel:test', { id: SL }); return rx.hits.some((h) => h.url.includes(NEEDLE)); })()));
  } finally {
    await app.close();
    await rx.close();
    await elsewhere.close();
    sse.setFanOut(null);
    B.channels.useChannelSecrets(null);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
