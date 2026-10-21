// Email channels end to end on Postgres (docs/email/00-design.md §10): header
// sign-in on a scratch database, the real app, and an in-process fake relay
// (scripts/smtpFake.ts) behind STARTTLS + AUTH as SMTP_HOST.
//
//   save        an email channel names org people and teams by id; another
//               org's id is refused (control: same-org ids save); members are
//               never shown `to`, admins are
//   readers     a send reaches exactly the people on the channel who can read
//               the project NOW: a viewer, a team member, an org admin — not a
//               user without a grant, a disabled one, or a pending invitee
//               (control: signed in, they receive); losing a grant drops one
//               (control: a new grant adds one); teams expand and shrink
//   model       the email's figures are the strings the Slack rendering of the
//               SAME model holds; the whole text part equals a pure re-render;
//               an editor's note is attributed to the owner in both parts
//   alert       a fired rule's sentence arrives to the same readers
//   note        an editor rewriting the owner's note is credited ("Note from
//               <editor>"; control: the owner's own note names the owner); the
//               preview credits as saving would; a client cannot set it
//   limits      no_recipients, kept in the history; a list larger than one
//               project's share is its own refusal; a send over the share is
//               refused whole and does not count toward the pause (control: a
//               no_recipients run does); another project is not refused; an
//               alert has its own bucket; the test-email cap; Send now twice;
//               ALLOWED_EMAIL_DOMAINS (control)
//   partial     60 recipients, the second batch refused: 50 delivered, the run
//               sent as mail_partial, the failure count cleared
//   mail off    no relay: the kind is refused, the list says so, a send is
//               mail_off with no connection
//   secrets     the SMTP_PASSWORD canary in no log line, reply, record, audit
//               row, job or push (control: the relay did receive it)
//   one door    nothing in src/ but deliver.ts sends; no socket under
//               src/server but the SMTP client's (control: a planted call)
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-email-db.js

export {}; // module scope
import { randomBytes, randomUUID } from 'crypto';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import { finish, ok } from './selfcheck';
import { CERT, startFake, type Txn } from './smtpFake';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const mailEnv: typeof import('../src/server/mail/mailEnv') = require('../src/server/mail/mailEnv');
const email: typeof import('../src/server/mail/emailChannel') = require('../src/server/mail/emailChannel');
const run: typeof import('../src/server/subscriptions/run') = require('../src/server/subscriptions/run');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const subRpc: typeof import('../src/server/subscriptions/rpc') = require('../src/server/subscriptions/rpc');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const render: typeof import('../src/analysis/subscriptionRender') = require('../src/analysis/subscriptionRender');
const emailRender: typeof import('../src/analysis/subscriptionEmail') = require('../src/analysis/subscriptionEmail');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');
const store: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-email-db-'));
const PASS = 'smtp-pw-CANARY-e2e-41b7';
const USER = 'relay-user';
const PLAIN = Buffer.from(`\0${USER}\0${PASS}`).toString('base64');
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

/** The text and HTML parts of a message the relay received, decoded. */
function parts(t: Txn): { subject: string; text: string; html: string } {
  const head = t.data.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
  const subj = (/^Subject: (.*)$/m.exec(head)?.[1] ?? '').split(' ').map((w) => {
    const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w);
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : w + ' ';
  }).join('').trim();
  const body = [...t.data.matchAll(/Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)];
  const dec = (i: number): string => Buffer.from((body[i]?.[2] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { subject: subj, text: dec(0), html: dec(1) };
}

async function suite(adminUrl: string): Promise<void> {
  const dbName = `ordinate_email_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  pool.on('error', () => undefined);

  B.openLoopback();
  smtp.trustCaForTest(CERT);
  const fake = await startFake({ creds: { user: USER, pass: PASS } });
  const logLines: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, done) { logLines.push(String(chunk)); done(); } });
  const events: string[] = [];
  sse.setFanOut((_t, channel, data) => events.push(channel + ' ' + data));
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'info', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
    SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: USER, SMTP_PASSWORD: PASS, SMTP_FROM: 'Acme Analytics <bi@acme.test>',
  });
  const app = appMod.buildApp(cfg, logStream);
  const rewire = (mail: import('../src/server/mail/mailEnv').MailEnv | null, allowed: readonly string[] = []): void => email.wireMail(mail, pool, allowed, app.log);
  try {
    const base = await B.listen(app);
    const replies: string[] = [];
    const as = (who: string) => B.client(base, { 'x-forwarded-email': `${who}@acme.test` }, replies);
    for (const p of ['boss', 'alice', 'bob', 'carol', 'carol2', 'dave', 'erin']) await as(p).call('projects:list');
    const uid = async (who: string, domain = 'acme.test') => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@${domain}`])).rows[0].id;
    const boss = as('boss');
    const BOSS: B.Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'acme' } };
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    const s = await B.seed(BOSS, pid);
    const share = (member: object, role: string | null) => boss.call('project:share', { projectId: pid, member, role });
    await share({ userId: await uid('alice') }, 'viewer');
    await share({ userId: await uid('dave') }, 'viewer');
    await boss.call('admin:setRole', { userId: await uid('erin'), role: 'admin' });
    const east: string = (await boss.call('admin:createTeam', { name: 'East' })).body.id;
    await boss.call('admin:teamMember', { teamId: east, userId: await uid('carol'), member: true });
    await share({ teamId: east }, 'viewer');
    const pam: string = (await boss.call('admin:invite', { email: 'pam@acme.test', role: 'viewer' })).body.id;
    await share({ userId: pam }, 'viewer');
    await boss.call('admin:setDisabled', { userId: await uid('dave'), disabled: true });
    await pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'globex') ON CONFLICT DO NOTHING`);
    const gUser = (await pool.query<{ id: string }>(`INSERT INTO users (org_id, email, role, last_login_at) VALUES ('globex', 'gina@globex.test', 'admin', now()) RETURNING id`)).rows[0].id;

    // ── Save ─────────────────────────────────────────────────────────────
    const to = { userIds: [await uid('alice'), await uid('bob'), await uid('dave'), await uid('erin'), pam], teamIds: [east] };
    const foreign = await boss.call('channel:save', { name: 'Leads', kind: 'email', to: { ...to, userIds: [...to.userIds, gUser] } });
    ok('save: another org\'s user id is refused, in the catalog\'s words', foreign.status === 200 && foreign.body.ok === false && foreign.body.error === say.emailUnknownRecipients(), show(foreign.body));
    const saved = await boss.call('channel:save', { name: 'Leads', kind: 'email', to });
    ok('save: same-org people and a team save; the admin is shown `to`, ready, no secret', saved.body.ok && saved.body.channel.kind === 'email' && saved.body.channel.ready === true && saved.body.channel.secretSet === false && saved.body.channel.to.teamIds[0] === east, show(saved.body));
    const EM: string = saved.body.channel.id;
    ok('save: an email channel needs someone to send to', (await boss.call('channel:save', { name: 'Empty', kind: 'email', to: { userIds: [], teamIds: [] } })).body.error === say.emailNeedsRecipients());
    const memberView = (await as('alice').call('channel:list')).body;
    const adminView = (await boss.call('channel:list')).body;
    ok('list: a member sees the channel and canEmail, never its `to`; an admin does', memberView.canEmail === true && !('to' in memberView.channels.find((c: { id: string }) => c.id === EM)) && !!adminView.channels.find((c: { id: string }) => c.id === EM).to);
    ok('contract: an address can never be typed — a `to` with an email in it is 400', (await boss.call('channel:save', { name: 'X', kind: 'email', to: { userIds: ['alice@acme.test'], teamIds: [] } })).status === 400);

    // ── Readers at send time ─────────────────────────────────────────────
    const sub = (await boss.call('subscription:save', { projectId: pid, subscription: B.definition(s, [EM], { message: { title: '', note: 'Read the West row.', includeLink: true } }) })).body.subscription;
    const sendNow = () => boss.call('subscription:sendNow', { projectId: pid, id: sub.id });
    const last = (): Txn => fake.txns[fake.txns.length - 1];
    const rcpts = (): string => [...last().rcpts].sort().join();
    const first = await sendNow();
    ok('send: Send now goes out by email', first.body.ok === true && fake.txns.length === 1, show(first.body));
    ok('readers: exactly a viewer, a team member and an org admin — not a user without a grant, a disabled one or a pending invitee', rcpts() === 'alice@acme.test,carol@acme.test,erin@acme.test', rcpts());
    ok('relay: STARTTLS, then AUTH, then the message', fake.sessions[0].indexOf('STARTTLS') >= 0 && fake.sessions[0].indexOf(`AUTH PLAIN ${PLAIN}`) > fake.sessions[0].indexOf('STARTTLS'));

    // ── The model ────────────────────────────────────────────────────────
    const got = parts(last());
    const built = await B.context.runInContext(BOSS, 'built', () => run.buildMessage(pid, { ...sub, message: sub.message }));
    if ('code' in built) throw new Error('nothing built');
    const slack = render.renderSlack(built.model).model;
    const figures = [...slack.kpis.map((k) => k.value), ...slack.sections.flatMap((x) => x.rows.flat())];
    const missing = figures.filter((f) => !got.text.includes(f));
    ok(`model: all ${figures.length} figure strings of the Slack rendering are in the email's text — one model, no recomputation`, figures.length > 10 && missing.length === 0, missing);
    const again = emailRender.renderEmail(built.model, { channelName: 'Leads', accent: '', brand: 'Acme Analytics', lang: 'en' });
    ok('model: the text part equals a pure re-render of the same model, byte for byte', Object.is(got.text, again.text), [got.text.length, again.text.length]);
    ok('note: the owner\'s own note is attributed to the owner, in both parts', got.text.includes('Note from boss@acme.test: Read the West row.') && got.html.includes('Note from boss@acme.test:</strong> Read the West row.'));
    ok('subject and reason: the title, and why the reader has it', got.subject === built.model.title && got.text.includes(say.emailReason('Leads')) && got.html.includes('https://bi.example.com/analyses/'));

    // ── Access moves ─────────────────────────────────────────────────────
    await share({ userId: await uid('alice') }, null);
    await sendNow();
    ok('lost access: a reader whose grant was removed is dropped at send time', rcpts() === 'carol@acme.test,erin@acme.test', rcpts());
    await share({ userId: await uid('bob') }, 'viewer');
    await sendNow();
    ok('NEGATIVE CONTROL: a user on the channel who is granted the project now receives', rcpts().includes('bob@acme.test'), rcpts());
    await B.client(base, { 'x-forwarded-email': 'pam@acme.test' }).call('projects:list');
    await sendNow();
    ok('pending: once the invitee signs in (provision), they receive', rcpts().includes('pam@acme.test'), rcpts());
    await boss.call('admin:teamMember', { teamId: east, userId: await uid('carol2'), member: true });
    await sendNow();
    const withC2 = rcpts();
    await boss.call('admin:teamMember', { teamId: east, userId: await uid('carol2'), member: false });
    await sendNow();
    ok('teams: a new team member receives; removed, they do not', withC2.includes('carol2@acme.test') && !rcpts().includes('carol2@acme.test'), [withC2, rcpts()]);

    // ── An alert ─────────────────────────────────────────────────────────
    const rule = await B.context.runInContext(BOSS, 'rule', () => alertStore.saveRule(pid, { name: 'Revenue watch', datasetId: s.ds, metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true, channelIds: [EM] }));
    if (!rule) throw new Error('rule');
    const ev = { id: randomUUID(), ruleId: rule.id, ruleName: rule.name, datasetId: s.ds, at: new Date().toISOString(), value: 42, previous: null, delta: null, deltaPct: null, message: 'Revenue is above 1.', seen: false };
    const before = fake.txns.length;
    await B.context.runInContext(JOBS, 'job:tick:acme', () => Promise.all(schedules.deliverTickAlerts([{ projectId: pid, events: [ev] } as never], () => undefined)));
    const alertMail = parts(last());
    ok('alert: the fired rule\'s sentence arrives by email, to the same readers', fake.txns.length === before + 1 && alertMail.text.includes('Revenue is above 1.') && alertMail.subject === say.alertTitle('Revenue watch') && rcpts() === 'bob@acme.test,carol@acme.test,erin@acme.test,pam@acme.test', [rcpts(), alertMail.subject]);

    // ── The note is the writer's, not the owner's ────────────────────────
    await share({ userId: await uid('bob') }, 'editor');
    const edited = await as('bob').call('subscription:save', { projectId: pid, id: sub.id, subscription: B.definition(s, [EM], { message: { title: '', note: 'Ignore the East row.', includeLink: true } }) });
    ok('an editor who is not the owner rewrites the note; the owner stays', edited.body.ok && edited.body.subscription.owner === 'boss@acme.test' && edited.body.subscription.message.noteBy === 'bob@acme.test', show(edited.body));
    await as('bob').call('subscription:sendNow', { projectId: pid, id: sub.id });
    const byBob = parts(last());
    ok('note: the email names the WRITER — "Note from bob", in both parts — never the owner', byBob.text.includes('Note from bob@acme.test: Ignore the East row.') && byBob.html.includes('Note from bob@acme.test:</strong>') && !byBob.text.includes('Note from boss'));
    await boss.call('subscription:setEnabled', { projectId: pid, id: sub.id, enabled: false });
    await boss.call('subscription:setEnabled', { projectId: pid, id: sub.id, enabled: true });
    ok('note: switching it off and on (no new words) keeps the writer', (await boss.call('subscription:get', { projectId: pid, id: sub.id })).body.subscription.message.noteBy === 'bob@acme.test');
    const keep = await boss.call('subscription:preview', { projectId: pid, id: sub.id, draft: B.definition(s, [EM], { message: { title: '', note: 'Ignore the East row.', includeLink: true } }) });
    const mine = await boss.call('subscription:preview', { projectId: pid, id: sub.id, draft: B.definition(s, [EM], { message: { title: '', note: 'My words now.', includeLink: true } }) });
    ok('preview: the note as saving would credit it — the same words stay bob\'s; new words would be the editor\'s own', keep.body.email.model.noteBy === 'bob@acme.test' && mine.body.email.model.noteBy === 'boss@acme.test', [keep.body.email?.model.noteBy, mine.body.email?.model.noteBy]);
    ok('contract: a client cannot set noteBy itself', (await boss.call('subscription:save', { projectId: pid, id: sub.id, subscription: B.definition(s, [EM], { message: { title: '', note: 'x', includeLink: true, noteBy: 'ceo@acme.test' } }) })).status === 400);
    await share({ userId: await uid('bob') }, 'viewer');

    // ── Limits ───────────────────────────────────────────────────────────
    const nobody = (await boss.call('channel:save', { name: 'Nobody', kind: 'email', to: { userIds: [await uid('dave')], teamIds: [] } })).body.channel.id;
    const lonely = (await boss.call('subscription:save', { projectId: pid, subscription: B.definition(s, [nobody], { name: 'Lonely' }) })).body.subscription;
    const n0 = fake.txns.length;
    const lr = await boss.call('subscription:sendNow', { projectId: pid, id: lonely.id });
    ok('no_recipients: nobody on it can read the project — not sent, said so', lr.body.ok === false && lr.body.error === say.runText('no_recipients', { channel: 'Nobody' }) && fake.txns.length === n0, show(lr.body));
    const hist = (await boss.call('subscription:history', { projectId: pid, id: lonely.id })).body.runs;
    ok('history: a stored run with an email code survives being read back', hist.length === 1 && hist[0].text === say.runText('no_recipients', { channel: 'Nobody' }), show(hist));
    ok('NEGATIVE CONTROL: the store still drops a code it does not know', store.sanitizeRun({ history: [{ at: new Date().toISOString(), outcome: 'failed', code: 'not_a_code' }] }).history.length === 0);

    const readers = 4; // Leads reaches bob, carol, erin and pam now
    rewire(mailEnv.parseMail({ ...relaySrc(fake.port), RATE_LIMIT_EMAIL_ORG_PER_HOUR: String(readers * 2 - 2) }, true)); // a project's share: 3
    const tooBig = await sendNow();
    ok('a list larger than one project\'s share of the hour is its own refusal, not "this hour"', tooBig.body.ok === false && tooBig.body.error === say.runText('list_too_large', { channel: 'Leads' }) && fake.txns.length === n0, show(tooBig.body));
    rewire(mailEnv.parseMail({ ...relaySrc(fake.port), RATE_LIMIT_EMAIL_ORG_PER_HOUR: String(readers * 2) }, true)); // share 4
    email.resetLimitsForTest();
    const r1 = await sendNow();
    const r2 = await sendNow();
    ok('rate: a subscription within its share goes; the next would pass it and is refused whole', r1.body.ok === true && r2.body.ok === false && r2.body.error === say.runText('rate_limited', { channel: 'Leads' }) && fake.txns.length === n0 + 1, show(r2.body));
    const JOBS_RUN = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(JOBS, 'job:subscriptions:acme', fn);
    let slot = Date.now() + 60_000;
    const failuresOf = async (id: string): Promise<number> => (await B.context.runInContext(BOSS, 'read', () => store.getSubscription(pid, id)))!.run.failures;
    await JOBS_RUN(() => run.runSubscription(pid, sub.id, (slot += 60_000)));
    const limitedRun = (await B.context.runInContext(BOSS, 'read', () => store.getSubscription(pid, sub.id)))!.run;
    ok('a scheduled run refused only by the hourly budget does not count toward the pause', limitedRun.history[0].code === 'rate_limited' && limitedRun.history[0].trigger === 'schedule' && limitedRun.failures === 0, show(limitedRun.history[0]));
    await JOBS_RUN(() => run.runSubscription(pid, lonely.id, (slot += 60_000)));
    ok('NEGATIVE CONTROL: a scheduled run failing for another reason does count', (await failuresOf(lonely.id)) === 1);
    const pid2: string = (await boss.call('projects:create', { name: 'Second' })).body.id;
    const s2 = await B.seed(BOSS, pid2);
    const other = (await boss.call('subscription:save', { projectId: pid2, subscription: B.definition(s2, [EM], { name: 'Second board' }) })).body.subscription;
    const r3 = await boss.call('subscription:sendNow', { projectId: pid2, id: other.id });
    ok('one project spending its share does not refuse another project (its own share; the org still has room)', r3.body.ok === true && last().rcpts.join() === 'erin@acme.test', show(r3.body));
    await B.context.runInContext(JOBS, 'job:tick:acme', () => Promise.all(schedules.deliverTickAlerts([{ projectId: pid, events: [{ ...ev, id: randomUUID() }] } as never], () => undefined)));
    ok('NEGATIVE CONTROL: an alert, in its own bucket, still goes out', fake.txns.length === n0 + 3);
    rewire(cfg.mail);
    email.resetLimitsForTest();

    // ── A send where one batch fails is partial: sent, said, never a failure ──
    const bulkTeam = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', 'Bulk') RETURNING id`)).rows[0].id;
    for (let i = 0; i < 60; i++) {
      const u = (await pool.query<{ id: string }>(`INSERT INTO users (org_id, email, role, last_login_at) VALUES ('acme', $1, 'viewer', now()) RETURNING id`, [`bulk-${String(i).padStart(2, '0')}@acme.test`])).rows[0].id;
      await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [bulkTeam, u]);
    }
    await share({ teamId: bulkTeam }, 'viewer');
    const bulkCh = (await boss.call('channel:save', { name: 'Bulk list', kind: 'email', to: { userIds: [], teamIds: [bulkTeam] } })).body.channel.id;
    const bulk = (await boss.call('subscription:save', { projectId: pid, subscription: B.definition(s, [bulkCh], { name: 'Bulk board' }) })).body.subscription;
    rewire(null);
    await JOBS_RUN(() => run.runSubscription(pid, bulk.id, (slot += 60_000)));
    const failedOnce = await failuresOf(bulk.id);
    rewire(cfg.mail);
    const relayOpts = fake.opts;
    fake.opts = { ...relayOpts, rcpt: (a) => (/^bulk-5\d@/.test(a) ? '421 4.7.0 try later' : '250 ok') }; // the second batch: bulk-50 … bulk-59
    const nB = fake.txns.length;
    await JOBS_RUN(() => run.runSubscription(pid, bulk.id, (slot += 60_000)));
    fake.opts = relayOpts;
    const bulkRun = (await B.context.runInContext(BOSS, 'read', () => store.getSubscription(pid, bulk.id)))!.run;
    ok('partial: the first batch of 50 went, the refused second batch did not stop it', fake.txns.length === nB + 1 && fake.txns[nB].rcpts.length === 50);
    ok('partial: the run is SENT with what it missed, and clears the failure count', failedOnce === 1 && bulkRun.failures === 0 && bulkRun.history[0].outcome === 'sent' && bulkRun.history[0].code === 'mail_partial'
      && (await boss.call('subscription:history', { projectId: pid, id: bulk.id })).body.runs[0].text === say.runText('mail_partial', { channel: 'Bulk list', sent: 50, total: 60 }), show(bulkRun.history[0]));

    const tests: unknown[] = [];
    for (let i = 0; i < email.TEST_EMAILS_PER_HOUR; i++) tests.push((await boss.call('channel:test', { id: EM })).body.ok);
    const capped = await boss.call('channel:test', { id: EM });
    ok(`test: goes to the calling admin alone, with the channel's reach; the ${email.TEST_EMAILS_PER_HOUR + 1}th in an hour is refused`, tests.every((x) => x === true) && last().rcpts.join() === 'boss@acme.test'
      && parts(last()).text.includes('People on Leads who have signed in: 5') && capped.body.ok === false && capped.body.error === say.runText('rate_limited', { channel: 'Leads' }), [capped.body, parts(last()).text.slice(0, 400)]);
    const GLOBEX: B.Identity = { user: { email: 'gina@globex.test', role: 'admin' }, org: { id: 'globex' } };
    const gTest = await B.context.runInContext(GLOBEX, 'globex', async () => {
      const c = await B.channels.saveChannel({ name: 'G', kind: 'email', to: { userIds: [gUser], teamIds: [] } }, 'gina@globex.test');
      return c.ok ? (require('../src/server/subscriptions/deliver') as typeof import('../src/server/subscriptions/deliver')).deliver(c.channel, { kind: 'test' }) : null;
    });
    ok('NEGATIVE CONTROL: another org\'s test email is not counted against this one\'s cap', gTest?.ok === true && last().rcpts.join() === 'gina@globex.test', gTest);

    subRpc.setSendNowGapForTest(60_000);
    const once = await sendNow();
    const twice = await sendNow();
    subRpc.setSendNowGapForTest(0);
    ok('Send now: a second within the minute is refused', once.body.ok === true && twice.body.ok === false && twice.body.error === say.sendNowWait());

    await pool.query(`INSERT INTO users (org_id, email, role, last_login_at) VALUES ('acme', 'zed@other.test', 'viewer', now())`);
    const zed = await uid('zed', 'other.test');
    await share({ userId: zed }, 'viewer');
    await boss.call('channel:save', { id: EM, name: 'Leads', kind: 'email', to: { ...to, userIds: [...to.userIds, zed] } });
    rewire(cfg.mail, ['acme.test']);
    await sendNow();
    const fenced = rcpts();
    rewire(cfg.mail, []);
    await sendNow();
    ok('ALLOWED_EMAIL_DOMAINS: an address sign-in would refuse is not sent to (control: no domain rule → it is)', !fenced.includes('zed@other.test') && rcpts().includes('zed@other.test'), [fenced, rcpts()]);

    // ── Mail off ─────────────────────────────────────────────────────────
    rewire(null);
    const conns = fake.connections;
    const off = await sendNow();
    const offList = (await boss.call('channel:list')).body;
    const offSave = await boss.call('channel:save', { name: 'Late', kind: 'email', to });
    ok('mail off: the send is mail_off with no connection; canEmail false, the channel not ready; a new email channel is refused',
      off.body.ok === false && off.body.error === say.runText('mail_off') && fake.connections === conns
      && offList.canEmail === false && offList.channels.find((c: { id: string }) => c.id === EM).ready === false && offSave.body.error === say.emailNotSetUp(), show([off.body, offSave.body]));
    rewire(cfg.mail);

    // ── Secrets, audit, one door ─────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 100));
    const dump = async (table: string): Promise<string> => JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    const hay = [...logLines, ...replies, ...events, await dump('records'), await dump('audit_log'), await dump('jobs')];
    ok(`canary: SMTP_PASSWORD (and its AUTH forms) in no log line (${logLines.length}), reply (${replies.length}), push, record, audit row or job`,
      logLines.length > 20 && replies.length > 30 && !hay.some((h) => h.includes(PASS) || h.includes(PLAIN) || h.includes(Buffer.from(PASS).toString('base64'))));
    ok('NEGATIVE CONTROL: the relay did receive it', fake.sessions.some((l) => l.includes(`AUTH PLAIN ${PLAIN}`)));
    ok('no address in a reply: run history and replies never name a recipient', !replies.some((r) => r.includes('carol@acme.test')));
    const trail = await pool.query<{ target_ids: string[]; outcome: string }>(`SELECT target_ids::text[] AS target_ids, outcome FROM audit_log WHERE channel = 'subscription:send'`);
    ok('audit: an email send is a subscription:send row naming the channel', trail.rows.some((r) => r.target_ids.includes(EM) && r.outcome === 'ok'));
  } finally {
    await app.close().catch(() => undefined);
    await fake.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

function relaySrc(port: number): import('../src/server/mail/mailEnv').MailSrc {
  return { SMTP_HOST: 'localhost', SMTP_PORT: String(port), SMTP_SECURITY: undefined, SMTP_USER: USER, SMTP_PASSWORD: PASS, SMTP_FROM: 'Acme Analytics <bi@acme.test>', RATE_LIMIT_EMAIL_ORG_PER_HOUR: undefined };
}

/** Nothing in src/ sends but deliver.ts, and no socket under src/server is opened but by the SMTP client. */
const DOORS: Array<[RegExp, string[]]> = [
  [/\bpostToChannel\(|\bpostJson\(/, ['server/subscriptions/deliver.ts']],
  [/\bwebhookOf\(/, ['server/subscriptions/deliver.ts', 'app/channels.ts']],
  [/\bsendEmail\(/, ['server/subscriptions/deliver.ts', 'server/mail/emailChannel.ts']],
  [/\bsendOnce\(/, ['server/mail/emailChannel.ts', 'server/mail/smtp.ts']],
  [/\bsendBatches\(/, ['server/mail/emailChannel.ts']],
];
/** Any way to open a socket: `net.connect(`, `tls.connect(`, `createConnection(`, `new [net.]Socket(`, `new [tls.]TLSSocket(`, and the destructured `import { connect } from 'tls'` / `const { connect } = require('net')`. */
const SOCKET = [
  /\b(?:tls|net)\.connect\(|\bcreateConnection\(/,
  /\bnew\s+(?:net\.|tls\.)?(?:TLS)?Socket\s*\(/,
  /\bimport\s*\{[^}]*\b(?:connect|createConnection|Socket|TLSSocket)\b[^}]*\}\s*from\s*['"](?:node:)?(?:net|tls)['"]/,
  /\{[^}]*\b(?:connect|createConnection|Socket|TLSSocket)\b[^}]*\}\s*=\s*require\(\s*['"](?:node:)?(?:net|tls)['"]\s*\)/,
];
function oneDoor(files: Map<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, text] of files) {
    const f = file.split(path.sep).join('/');
    for (const [re, allowed] of DOORS) if (re.test(text) && !allowed.includes(f)) bad.push(`${f}: ${re.source}`);
    if (f.startsWith('server/') && f !== 'server/mail/smtp.ts' && SOCKET.some((re) => re.test(text))) bad.push(`${f}: a raw socket`);
  }
  return bad;
}

(async () => {
  // The door scan needs no database.
  const SRC = path.join(__dirname, '..', 'src');
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.set(path.relative(SRC, p), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(SRC);
  const bad = oneDoor(files);
  ok('one door: only deliver.ts posts, reads a webhook URL or reaches the SMTP client; only smtp.ts opens a socket under src/server', bad.length === 0, bad);
  const plant = (file: string, text: string): number => oneDoor(new Map([...files, [path.join(...file.split('/')), text]])).length;
  const plants: Array<[string, string, string]> = [
    ['a post', 'server/evil.ts', 'await postJson(u, b, c);'],
    ['a direct sendBatches', 'server/subscriptions/evil.ts', 'await sendBatches(to, data, id);'],
    ['tls.connect', 'server/evil.ts', 'tls.connect({ host });'],
    ['a destructured import', 'server/evil.ts', "import { connect as dial } from 'node:tls';\ndial({ host });"],
    ['a destructured require', 'server/evil.ts', "const { createConnection } = require('net');"],
    ['new net.Socket().connect', 'server/evil.ts', 'new net.Socket().connect(25, host);'],
    ['new TLSSocket', 'server/evil.ts', 'const t = new TLSSocket(s, {});'],
  ];
  const missed = plants.filter(([, file, text]) => plant(file, text) !== 1).map(([what]) => what);
  ok(`NEGATIVE CONTROL: each of ${plants.length} planted doors is found`, missed.length === 0, missed);
  ok('control: an import of BlockList / isIP from net is not a socket', plant('server/fine.ts', "import { BlockList, isIP } from 'net';") === 0);

  if (!process.env.DATABASE_URL) {
    console.log('skip email DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await suite(process.env.DATABASE_URL);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
