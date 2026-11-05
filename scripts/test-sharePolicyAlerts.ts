// A fired alert's post to Slack / Teams (src/server/subscriptions/alertPosts.ts) leaves the org, so its figure is
// shaped by the Share policy's `report` path as a sent KPI is (src/publish/kpiPolicy.ts). Server mode, dev sign-in,
// a LOCAL receiver (scripts/subscriptionHarness.ts): what the receiver gets is what Slack and Teams would.
//
//   drop     a rule over a marked column still posts, titled with the rule; its figure reads "Hidden by the share
//            policy", and the sentence and the breakdown quoting it are left out. An anomaly rule's sentence, which
//            carries no figure, stays.
//   mask     the figure passes, as every aggregate does: the posts are the unmarked ones byte for byte.
//
// Negative controls: a rule over a column nobody marked posts its figure beside it; the inbox (alerts:list) still
// holds every sentence; with nothing marked the posts are what develop posted (sha256 pin). Email is the same model.
//
//   npm run build:ts && node scripts/test-sharePolicyAlerts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const alertPosts: typeof import('../src/server/subscriptions/alertPosts') = require('../src/server/subscriptions/alertPosts');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const format: typeof import('../src/app/format') = require('../src/app/format');
const HIDDEN: string = require('../src/app/sharePolicy').HIDDEN_BY_POLICY;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-alerts-'));
const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 400);
const pin = (v: unknown): string => crypto.createHash('sha256').update(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U'), 'utf8').digest('hex');

// Salaries 91357 / 82469 / 70913 (payroll 244739); hours 1213 / 719 / 3037 (4969), nobody marks.
const ROWS = [['Ops', 91357, 1213], ['Lab', 82469, 719], ['Ops', 70913, 3037]];
const BREAKDOWN = 'Ops drove +91,357 of the change.'; // a period rule's breakdown (ipc/alertDiagnosis): it quotes the figure

(async () => {
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  B.openLoopback();
  format.setFormatPrefs({ locale: 'en-US' }); // the displays the pins read, whatever the machine's locale
  const rx = await B.receiver();
  B.channels.useChannelSecrets(B.memoryStore());
  delete process.env.ORDINATE_PUBLIC_URL;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const { call } = B.client(await B.listen(app));
  const asJob = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(JOBS, 'job:tick:default', fn);
  try {
    const P: string = (await call('projects:create', { name: 'Alert share' })).body.id;
    const S = (await B.context.runInContext(DEV, 'seed', () => datasets.saveDataset(P, { name: 'Staff', sourceKind: 'csv',
      columns: [{ name: 'team', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'hours', type: 'number' }], rows: ROWS })))!.id;
    const SL: string = (await call('channel:save', { name: 'Ops', kind: 'slack', webhookUrl: rx.url() })).body.channel.id;
    const TM: string = (await call('channel:save', { name: 'Leadership', kind: 'teams', webhookUrl: rx.url('/teams') })).body.channel.id;
    const save = async (id: string, name: string, column: string, label: string, over: object) => (await call('alerts:save', { projectId: P, rule: {
      id, name, datasetId: S, metric: { column, aggregation: 'sum', label }, channelIds: [SL, TM], ...over,
    } })).body.rule;
    const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; // fixed, so the pin holds run to run
    const pay = await save(U(1), 'Payroll above 1000', 'salary', 'Payroll', { compare: 'threshold', threshold: { op: '>', value: 1000 } });
    const hrs = await save(U(2), 'Hours above 10', 'hours', 'Hours', { compare: 'threshold', threshold: { op: '>', value: 10 } });
    const odd = await save(U(3), 'Odd payroll', 'salary', 'Payroll', { compare: 'anomaly' });
    const fired = await asJob(() => alertStore.evaluateProject(P));
    const ev = (ruleId: string) => fired.find((e) => e.ruleId === ruleId)!;
    ok('fixture: both threshold rules fire on the KPI door\'s figures', ev(pay.id)?.value === 244739 && ev(hrs.id)?.value === 4969, show(fired.map((e) => [e.ruleName, e.value])));
    // The same firings every run (a fresh id each, so the ledger posts them): the payroll one with a breakdown, and an anomaly.
    const events = [{ ...ev(pay.id), diagnosis: BREAKDOWN }, ev(hrs.id),
      { ...ev(pay.id), ruleId: odd.id, ruleName: odd.name, value: null, previous: null, delta: null, deltaPct: null, message: alerts.alertMessage(odd, null, null, 2) }];
    const PAYROLL = [alerts.fmtMetric(244739), '91,357', ev(pay.id).message];

    /** What the receiver got for one tick's posts, per rule. */
    const posted = async (action: 'drop' | 'mask' | 'include') => {
      await B.context.runInContext(DEV, 'policy', () => store.setPolicy(P, { report: action }));
      rx.hits.length = 0;
      const n = await asJob(() => alertPosts.postFiredAlerts(P, events.map((e, i) => ({ ...e, id: U(100 + i) }))));
      const bodies = rx.hits.map((h) => JSON.stringify(h.body));
      const of = (name: string): string[] => bodies.filter((b) => b.includes(name));
      return { n, bodies, pay: of('Payroll above 1000'), hrs: of('Hours above 10'), odd: of('Odd payroll') };
    };
    const leaks = (bodies: string[]): string[] => PAYROLL.filter((b) => bodies.some((x) => x.includes(JSON.stringify(b).slice(1, -1))));

    // ── nothing marked: the posts develop sent, pinned ──
    const before = await posted('drop');
    const PINNED = '35114ea2645233890111eabf4625bbdc39833e081f5e51c764bae03469ff8166'; // the posts develop 98176da9 sent for this fixture — re-pin only for a message format changed on purpose
    ok('PIN: with nothing marked, every post is the one sent before this change', pin(before.bodies) === PINNED, pin(before.bodies));
    ok('fixture: six posts (three rules × Slack and Teams), the payroll figure, sentence and breakdown in them', before.n === 6 && leaks(before.pay).length === PAYROLL.length, show(leaks(before.pay)));

    await B.context.runInContext(DEV, 'mark', () => catalog.setColumn(P, S, 'salary', { sensitivity: 'financial' }));

    // ── drop ──
    const drop = await posted('drop');
    ok('drop: every rule still posts to both channels, titled with the rule', drop.n === 6 && drop.pay.length === 2 && drop.odd.length === 2 && drop.hrs.length === 2, show(drop.bodies.map((b) => b.slice(0, 80))));
    ok('drop: the payroll post says the house wording where its figure was', drop.pay.every((b) => b.includes(HIDDEN)), show(drop.pay));
    ok('drop: …and carries no payroll figure, no sentence quoting it and no breakdown', leaks(drop.pay).length === 0 && !drop.pay.some((b) => b.includes('Ops drove')), show(leaks(drop.pay)));
    ok('drop: the anomaly rule over salary keeps its sentence (it carries no figure)', drop.odd.every((b) => b.includes(JSON.stringify(events[2].message).slice(1, -1))) && !drop.odd.some((b) => b.includes(HIDDEN)), show(drop.odd));
    ok('NEGATIVE CONTROL (drop): the hours post keeps its figure and its sentence', drop.hrs.every((b) => b.includes(alerts.fmtMetric(4969)) && !b.includes(HIDDEN)), show(drop.hrs));
    ok('drop: no payroll figure in any post', leaks(drop.bodies).length === 0, show(leaks(drop.bodies)));
    const inbox = await call('alerts:list', { projectId: P });
    ok('NEGATIVE CONTROL (drop): the inbox still holds the payroll sentence with its figure', JSON.stringify(inbox.body).includes(JSON.stringify(ev(pay.id).message).slice(1, -1)), show(inbox.body));
    // Loosely typed so this file also compiles against the composer before it took `withheld` (the red run).
    const compose: (...a: unknown[]) => { kpis: Array<{ value: string }>; note?: string } = alertPosts.alertMessageModel as never;
    const model = compose(P, pay, events[0], HIDDEN);
    ok('drop: the composer behind every channel (email too) writes the same withheld model', !JSON.stringify(model).includes('244') && model.kpis[0].value === HIDDEN && !model.note, show(model));

    // ── mask and include: the figure passes ──
    const mask = await posted('mask');
    ok('mask: the posts are the unmarked ones, byte for byte', pin(mask.bodies) === pin(before.bodies));
    const incl = await posted('include');
    ok('NEGATIVE CONTROL (include): the payroll figure is posted', leaks(incl.pay).length === PAYROLL.length);

    await B.context.runInContext(DEV, 'unmark', () => catalog.setColumn(P, S, 'salary', { sensitivity: 'none' }));
    const after = await posted('drop');
    ok('NEGATIVE CONTROL: with salary unmarked again, drop posts the unmarked posts byte for byte', pin(after.bodies) === pin(before.bodies));
  } finally {
    await app.close();
    await rx.close();
  }
})().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
