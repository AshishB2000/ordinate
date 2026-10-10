// An alert rule that names Slack / Teams channels (src/server/subscriptions/
// alertPosts.ts) — server mode, dev sign-in, a LOCAL receiver
// (scripts/subscriptionHarness.ts). Nothing here reaches Slack or Teams.
//
//   rule       `channelIds` is clamped (UUIDs, no repeats, at most 10), kept by
//              an evaluation and by an edit, absent when there are none
//   fire       what the tick does with a fired rule (schedules.deliverTickAlerts):
//              the bell's push as before, AND a post to each named channel
//              carrying the event's OWN sentence and the figure the alert
//              formats, with a link to the dashboard the rule was made on
//   quiet      a rule naming no channel posts nothing (NEGATIVE CONTROL: the
//              same event with a channel does); a removed channel is skipped;
//              a channel that fails does not fail the tick
//   escaping   a rule name with `<!channel>` in it cannot ping (NEGATIVE
//              CONTROL: the name does reach the message, as text)
//   usage      Admin's delete warning names the rule
//
//   npm run build:ts && node scripts/test-alertChannels.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const alertPosts: typeof import('../src/server/subscriptions/alertPosts') = require('../src/server/subscriptions/alertPosts');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const render: typeof import('../src/analysis/subscriptionRender') = require('../src/analysis/subscriptionRender');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-alertch-'));
const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── the rule's field ────────────────────────────────────────────────────────
const base = { id: U(1), datasetId: U(2), metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 10 } };
const clamp = (channelIds: unknown) => alerts.sanitizeRule({ ...base, channelIds })?.channelIds;
ok('rule: channel ids are kept — UUIDs only, lower-cased, no repeats', JSON.stringify(clamp([U(3), U(3).toUpperCase(), 'nope', 7, '../etc', U(4)])) === JSON.stringify([U(3), U(4)]));
ok(`rule: at most ${alerts.MAX_RULE_CHANNELS} channels`, clamp(Array.from({ length: 30 }, (_, i) => U(100 + i)))?.length === alerts.MAX_RULE_CHANNELS);
ok('rule: none → the field is absent (a rule from before channels is "none")', clamp([]) === undefined && clamp('x') === undefined && !('channelIds' in (alerts.sanitizeRule(base) as object)));
const withCh = alerts.sanitizeRule({ ...base, channelIds: [U(3)] })!;
ok('rule: an evaluation keeps the channels', JSON.stringify(alerts.evaluateRule({ rule: withCh, value: 50, previous: null, now: Date.now(), eventId: U(9) }).rule.channelIds) === JSON.stringify([U(3)]));

(async () => {
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  B.openLoopback();
  const rx = await B.receiver();
  B.channels.useChannelSecrets(B.memoryStore());
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base2 = await B.listen(app);
  const replies: string[] = [];
  const { call } = B.client(base2, {}, replies);
  const asJob = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(JOBS, 'job:tick:default', fn);
  try {
    const pid: string = (await call('projects:create', { name: 'Alerts' })).body.id;
    const s = await B.seed(DEV, pid);
    const SL: string = (await call('channel:save', { name: 'Ops', kind: 'slack', webhookUrl: rx.url() })).body.channel.id;
    const TM: string = (await call('channel:save', { name: 'Leadership', kind: 'teams', webhookUrl: rx.url(`/teams/${B.CANARY}`) })).body.channel.id;

    const rule = (channelIds: string[], over: Record<string, unknown> = {}) => ({
      id: crypto.randomUUID(), name: 'Revenue above 10', datasetId: s.ds, metric: { column: 'amount', aggregation: 'sum', label: 'Revenue' }, compare: 'threshold',
      threshold: { op: '>', value: 10 }, createdFrom: { analysisId: s.aid, cardId: s.kpiRev }, ...(channelIds.length ? { channelIds } : {}), ...over,
    });
    const saved = await call('alerts:save', { projectId: pid, rule: rule([SL, TM]) });
    ok('alerts:save keeps the channels a rule names', saved.body.ok && JSON.stringify(saved.body.rule.channelIds) === JSON.stringify([SL, TM]), show(saved.body));
    const listed = await call('alerts:list', { projectId: pid });
    ok('alerts:list returns them, for the dialog to tick', JSON.stringify(listed.body.rules[0].channelIds) === JSON.stringify([SL, TM]));
    const edited = await call('alerts:save', { projectId: pid, rule: { ...saved.body.rule, name: 'Revenue is high', channelIds: [SL, TM] } });
    ok('an edit keeps them', edited.body.rule.name === 'Revenue is high' && edited.body.rule.channelIds.length === 2);
    const usage = await call('channel:usage', { id: SL });
    ok('channel:usage names the alert rule that posts to a channel, with its project', usage.body.alerts.map((u: { name: string; project: string }) => `${u.project}/${u.name}`).join() === 'Alerts/Revenue is high' && usage.body.subscriptions.length === 0, show(usage.body));

    // ── a firing, as the tick delivers it ────────────────────────────────
    const fired = await asJob(() => alertStore.evaluateProject(pid));
    ok('the rule fires on its figure (the KPI door\'s)', fired.length === 1 && fired[0].value === 10320 && fired[0].message.length > 10, show(fired));
    const pushes: Array<[string, string]> = [];
    const sent = await asJob(() => Promise.all(schedules.deliverTickAlerts([{ projectId: pid, events: fired }], (p, ch) => void pushes.push([p, ch]))));
    ok('tick: the bell\'s push goes out as before', JSON.stringify(pushes) === JSON.stringify([[pid, 'alerts:fired']]));
    ok('tick: AND one post to each channel the rule names', sent[0] === 2 && rx.hits.length === 2 && Array.isArray(rx.hits[0].body.blocks) && rx.hits[1].body.attachments[0].content.type === 'AdaptiveCard', show([sent, rx.hits.length]));
    const slackText = JSON.stringify(rx.hits[0].body);
    ok('post: the alert\'s OWN sentence, word for word', slackText.includes(JSON.stringify(render.slackEscape(fired[0].message)).slice(1, -1)), show([fired[0].message, slackText]));
    ok('post: titled with the rule, carrying the figure as the alert formats it', rx.hits[0].body.blocks[0].text.text === say.alertTitle('Revenue is high')
      && slackText.includes(`*Revenue*\\n${alerts.fmtMetric(fired[0].value)}`), slackText.slice(0, 400));
    ok('post: links to the dashboard the rule was made on — the server\'s own address', slackText.includes(`https://bi.example.com/analyses/${pid}/${s.aid}`)
      && JSON.stringify(rx.hits[1].body.attachments[0].content.actions) === JSON.stringify([{ type: 'Action.OpenUrl', title: 'Open in Ordinate', url: `https://bi.example.com/analyses/${pid}/${s.aid}` }]));
    ok('post: the same model as the pure composer gives for the event', JSON.stringify(rx.hits[0].body) === JSON.stringify(render.renderSlack(alertPosts.alertMessageModel(pid, edited.body.rule, fired[0])).payload));
    rx.hits.length = 0;

    // ── quiet paths ───────────────────────────────────────────────────────
    const plain = (await call('alerts:save', { projectId: pid, rule: rule([], { name: 'No channel' }) })).body.rule;
    const ev = (ruleId: string, name: string) => ({ ...fired[0], id: crypto.randomUUID(), ruleId, ruleName: name });
    ok('a rule that names no channel posts nothing', (await asJob(() => alertPosts.postFiredAlerts(pid, [ev(plain.id, plain.name)]))) === 0 && rx.hits.length === 0);
    ok('NEGATIVE CONTROL: the same event on the rule WITH channels posts', (await asJob(() => alertPosts.postFiredAlerts(pid, [ev(edited.body.rule.id, 'x')]))) === 2 && rx.hits.length === 2);
    rx.hits.length = 0;
    ok('an event of no known rule (a quality check\'s) posts nothing', (await asJob(() => alertPosts.postFiredAlerts(pid, [ev(crypto.randomUUID(), 'q')]))) === 0 && rx.hits.length === 0);
    await call('channel:delete', { id: TM });
    ok('a channel removed since is skipped — the other still gets the post', (await asJob(() => alertPosts.postFiredAlerts(pid, [ev(edited.body.rule.id, 'x')]))) === 1 && rx.hits.length === 1);
    rx.hits.length = 0;
    rx.fallback = [500, {}, 'down'];
    let threw = false;
    const failed = await asJob(() => alertPosts.postFiredAlerts(pid, [ev(edited.body.rule.id, 'x')])).catch(() => { threw = true; return -1; });
    ok('a channel that fails does not fail the tick: three attempts, then 0 posts and no throw', !threw && failed === 0 && rx.hits.length === 3, show([threw, failed, rx.hits.length]));
    rx.fallback = [200, {}, 'ok'];
    rx.hits.length = 0;

    // ── escaping ──────────────────────────────────────────────────────────
    const evil = (await call('alerts:save', { projectId: pid, rule: rule([SL], { name: '<!channel> <@U123> wake up', metric: { column: 'amount', aggregation: 'sum', label: '<https://evil.example|Revenue>' } }) })).body.rule;
    await asJob(() => alertPosts.postFiredAlerts(pid, [{ ...ev(evil.id, evil.name), message: 'Revenue is <!here> at 10.3K' }]));
    const got = JSON.stringify(rx.hits[0]?.body ?? {});
    ok('escaping: a rule name, a label or a sentence cannot ping a channel or forge a link', rx.hits.length === 1 && !/<!\w+|<@\w+|<https?:[^>]*\|/.test(got), got.slice(0, 300));
    ok('NEGATIVE CONTROL: they do reach the message — as text', got.includes('&lt;!channel&gt;') && got.includes('&lt;@U123&gt;') && got.includes('&lt;!here&gt;') && got.includes('‹!channel›'));

    ok('canary: no reply carries a webhook secret', replies.length > 8 && !replies.some((r) => r.includes('webhook-canary-7f3a91c2')));
  } finally {
    await app.close();
    await rx.close();
    B.channels.useChannelSecrets(null);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
