// "Ask an editor" (docs/assistant/00-design.md, phase G; src/server/mentions/asks.ts, `editors:ask`),
// on Postgres with header sign-in (scripts/notifyHarness.ts) and the fake SMTP relay.
//
//   no db      off: the send says why, the bell has no asks, the switch reads off
//   contract   read (as comment:add), audited, project-scoped; a reason off the list, an empty
//              question and a note over 1 000 characters are refused
//   told       the project's editors and admins — a direct grant, a team's, an org admin — get a row
//              and a push; NEGATIVE CONTROLS: the asker, another viewer, another project's editor and
//              a disabled editor get nothing; the push carries no question or note
//   bell       an editor's mentions:list lists it by name with the reason's words and the note, and the
//              badge counts it; another viewer's list never holds the note (control: the editor's does)
//   email      no one has it until they turn it on; then one email, to that editor alone, with the
//              question, the reason, the note and a link to where it is fixed (Relationships for a link)
//   dedupe     the same question again (case and spacing aside) the same day is "already sent": no row,
//              no push (control: the same words with another reason are sent)
//   limit      a person's 11th send in a day is refused in the catalog's words and writes nothing; a
//              duplicate still answers "already sent"; another person still sends; the refused one is
//              not marked sent (control: once the day is over, it goes)
//   seen       one row, then all of them, through mentions:seen
//   access     a member with no grant is refused (403); a viewer may not ask for an alert (403)
//   demoted    an editor made a viewer no longer lists the asks (control: made an editor again, does)
//   rls        `editor_asks` as an ordinary role
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-askEditor.js

export {}; // module scope
import { randomUUID } from 'crypto';
import { finish, ok } from './selfcheck';
import { CERT, startFake } from './smtpFake';
import * as B from './subscriptionHarness';
import { ORG, mailParts, ordinaryRole, refusedAs, seenAs, serverMode, show, withServer, type Bench } from './notifyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const asks: typeof import('../src/server/mentions/asks') = require('../src/server/mentions/asks');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const msg: typeof import('../src/server/mentionMessages') = require('../src/server/mentionMessages');
const api: typeof import('../src/api/index') = require('../src/api/index');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const { withCsrf } = require('./csrfPair') as typeof import('./csrfPair');

const at = (who: string): string => (who.includes('@') ? who : `${who}@acme.test`);

function contractCases(): void {
  const c = api.contracts['editors:ask'];
  const P = randomUUID();
  const good = { projectId: P, question: 'returns by reason', reason: 'missing' as const };
  ok('contract: read, as comment:add — asking changes nothing in the project — and audited', c.access === 'read' && c.audit === true && api.contracts['comment:add'].access === 'read');
  ok('contract: project-scoped by projectId', 'project' in c && c.project(good) === P);
  ok('contract: the three reasons, a note, nothing else', ['missing', 'link', 'copy'].every((reason) => c.input.safeParse({ ...good, reason, note: 'n' }).success)
    && !c.input.safeParse({ ...good, reason: 'other' }).success && !c.input.safeParse({ ...good, to: ['x@acme.test'] }).success);
  ok('contract: an empty question and a note over 1 000 characters are refused', !c.input.safeParse({ ...good, question: '   ' }).success && !c.input.safeParse({ ...good, note: 'x'.repeat(1001) }).success);
}

async function noDatabase(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askeditor-nodb-'));
  serverMode(DATA);
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }));
  const call = async (channel: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return r.statusCode === 200 ? wire.decode(r.body) as any : { status: r.statusCode }; // any: each channel's reply
  };
  try {
    const pid = (await call('projects:create', { name: 'No DB' })).id;
    const r = await call('editors:ask', { projectId: pid, question: 'returns', reason: 'missing' });
    ok('no db: the send says why (no user directory)', r.ok === false && r.error === msg.asksOff(), show(r));
    const list = await call('mentions:list', undefined);
    ok('no db: the bell has no asks', list.ok && Array.isArray(list.asks) && list.asks.length === 0, show(list));
    const prefs = await call('mentions:prefs', undefined);
    ok('no db: "Email me when a viewer asks for data" reads off', prefs.ok && prefs.requestEmail === false, show(prefs));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function suite(b: Bench, fake: Awaited<ReturnType<typeof startFake>>): Promise<void> {
  const pushes: Array<{ user?: string; channel: string; data: string }> = [];
  sse.setFanOut((t, channel, data) => pushes.push({ user: t.user, channel, data }));
  try {
    await b.provision('ann', 'vic', 'ed', 'tam', 'ola', 'oz', 'dis', 'nog');
    const P = (await b.as('boss').call('projects:create', { name: 'Sales' })).body.id as string;
    const P2 = (await b.as('boss').call('projects:create', { name: 'Ops' })).body.id as string;
    for (const w of ['ann', 'vic']) await b.share(P, w, 'viewer');
    for (const w of ['ed', 'dis']) await b.share(P, w, 'editor');
    await b.share(P2, 'oz', 'editor');
    const team: string = (await b.as('boss').call('admin:createTeam', { name: 'Analysts' })).body.id;
    await b.as('boss').call('admin:teamMember', { teamId: team, userId: await b.uid('tam'), member: true });
    await b.share(P, { teamId: team }, 'editor');
    await b.as('boss').call('admin:setRole', { userId: await b.uid('ola'), role: 'admin' });
    await b.as('boss').call('admin:setDisabled', { userId: await b.uid('dis'), disabled: true });

    const EDITORS = ['boss', 'ola', 'ed', 'tam'];
    const NOT = ['ann', 'vic', 'oz', 'dis', 'nog'];
    const send = (w: string, body: Record<string, unknown>, project = P) => b.as(w).call('editors:ask', { projectId: project, ...body });
    const rows = async (w: string): Promise<number> => Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM editor_asks WHERE org_id = $1 AND user_email = $2', [ORG, at(w)])).rows[0].n);
    const allRows = async (): Promise<number> => Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM editor_asks')).rows[0].n);
    const pushesTo = (w: string) => pushes.filter((p) => p.channel === 'asks:new' && p.user === at(w)).length;
    const askPushes = () => pushes.filter((p) => p.channel === 'asks:new').length;
    const mailsTo = (w: string) => fake.txns.filter((t) => t.rcpts.includes(at(w))).length;
    const bell = async (w: string) => (await b.as(w).call('mentions:list')).body as { ok: boolean; asks: Array<Record<string, any>>; unseen: number }; // any: a row's fields, read one by one
    const settle = () => asks.asksSettled();

    // ── told ──────────────────────────────────────────────────────────────
    const mail0 = fake.txns.length;
    const NOTE = 'For the Q4 review, SECRET-NOTE-1';
    const r1 = await send('ann', { question: 'Returns by reason last month', reason: 'missing', note: NOTE });
    await settle();
    ok('told: the send is ok', r1.status === 200 && r1.body.ok === true && !r1.body.already, show(r1.body));
    const counts = await Promise.all([...EDITORS, ...NOT].map(rows));
    ok('told: a row for each editor and admin — a direct grant, a team\'s, an org admin, the project\'s admin', counts.slice(0, EDITORS.length).every((n) => n === 1), show(counts));
    ok('told NEGATIVE CONTROL: the asker, another viewer, another project\'s editor, a disabled editor and a member with no grant get no row', counts.slice(EDITORS.length).every((n) => n === 0), show(counts));
    ok('told: a push to each editor\'s tabs', EDITORS.every((w) => pushesTo(w) === 1));
    ok('told NEGATIVE CONTROL: no push to another viewer or another project\'s editor', NOT.every((w) => pushesTo(w) === 0) && askPushes() === EDITORS.length);
    const notice = JSON.parse(pushes.find((p) => p.channel === 'asks:new')!.data);
    ok('told: the push names who, where and why — never the question, the note or an address', notice.by === 'Ann' && notice.on === 'Sales' && notice.reason === 'missing'
      && !JSON.stringify(notice).includes('SECRET') && !JSON.stringify(notice).includes('Returns') && !JSON.stringify(notice).includes('@acme'), JSON.stringify(notice));
    ok('email: nobody turned it on, so no email at all', fake.txns.length === mail0);
    const trail = await b.pool.query<{ actor: string }>(`SELECT actor FROM audit_log WHERE channel = 'editors:ask' ORDER BY id DESC LIMIT 1`);
    ok('told: the send is audited, as the asker', trail.rows[0]?.actor === at('ann'), show(trail.rows));

    // ── bell ──────────────────────────────────────────────────────────────
    const edBell = await bell('ed');
    const row = edBell.asks[0];
    ok('bell: the editor\'s list holds it by name, with the question, the reason\'s words and the note, unseen', edBell.ok && row && row.projectId === P && row.by === 'Ann'
      && row.question === 'Returns by reason last month' && row.reason === 'missing' && row.why === msg.askReasonMissing() && row.note === NOTE && row.seen === false, show(edBell));
    ok('bell: never an address', !JSON.stringify(edBell).includes('ann@acme'));
    const me = (await (await fetch(`${b.base}/api/auth/me`, { headers: { 'x-forwarded-email': at('ed') } })).json()) as { mentionsUnseen?: unknown };
    ok('bell: the badge counts it (mentions:list\'s unseen, and /api/auth/me\'s)', edBell.unseen === 1 && me.mentionsUnseen === 1, show([edBell.unseen, me.mentionsUnseen]));
    const others = await Promise.all(['vic', 'oz', 'ann'].map(bell));
    ok('bell NEGATIVE CONTROL: another viewer, another project\'s editor and the asker list no ask — the note never reaches them', others.every((x) => x.ok && x.asks.length === 0 && !JSON.stringify(x).includes('SECRET-NOTE')), show(others));

    // ── email ─────────────────────────────────────────────────────────────
    await b.as('ed').call('mentions:setPrefs', { requestEmail: true });
    const prefs = (await b.as('ed').call('mentions:prefs')).body;
    ok('email: the switch reads back on, and the mention switch is untouched', prefs.requestEmail === true && prefs.emailMe === true, show(prefs));
    const mail1 = fake.txns.length;
    await send('ann', { question: 'Revenue by warehouse zone', reason: 'link', note: 'Zones are in the regions table' });
    await settle();
    ok('email: one email, to the editor who turned it on', fake.txns.length === mail1 + 1 && mailsTo('ed') === 1, String(fake.txns.length - mail1));
    ok('email NEGATIVE CONTROL: the editors and admins who did not turn it on get none', ['boss', 'ola', 'tam'].every((w) => mailsTo(w) === 0));
    const mail = mailParts(fake.txns.at(-1)!.data);
    ok('email: its title, the question, the reason, the note and a link to Relationships — no address', mail.subject === msg.askedForData('Ann', 'Sales')
      && mail.text.includes('Revenue by warehouse zone') && mail.text.includes(msg.askReasonLink()) && mail.text.includes('Zones are in the regions table')
      && mail.text.includes(`https://bi.example.com/model/${P}?tab=relationships`) && mail.text.includes(msg.askEmailReason()) && !mail.text.includes('ann@acme'), JSON.stringify(mail));

    // ── dedupe ────────────────────────────────────────────────────────────
    const [rows0, push0] = [await allRows(), askPushes()];
    const again = await send('ann', { question: '  returns BY reason   last month ', reason: 'missing' });
    await settle();
    ok('dedupe: the same question again the same day is "already sent"', again.body.ok === true && again.body.already === true, show(again.body));
    ok('dedupe: …and writes and tells nothing', (await allRows()) === rows0 && askPushes() === push0);
    const other = await send('ann', { question: 'Returns by reason last month', reason: 'copy' });
    await settle();
    ok('dedupe NEGATIVE CONTROL: the same words with another reason are sent', other.body.ok === true && !other.body.already && (await allRows()) === rows0 + EDITORS.length);

    // ── limit ─────────────────────────────────────────────────────────────
    for (let i = 4; i <= asks.ASKS_PER_DAY; i++) await send('ann', { question: `Question number ${i}`, reason: 'missing' });
    await settle();
    const [rows1, push1] = [await allRows(), askPushes()];
    const over = await send('ann', { question: 'One too many', reason: 'missing' });
    await settle();
    ok(`limit: a person's ${asks.ASKS_PER_DAY + 1}th send in a day is refused, in the catalog's words`, over.body.ok === false && over.body.code === 'rate_limited' && over.body.error === msg.tooManyAsks(asks.ASKS_PER_DAY), show(over.body));
    ok('limit: …and writes and tells nothing', (await allRows()) === rows1 && askPushes() === push1);
    ok('limit: a duplicate past the limit still answers "already sent"', (await send('ann', { question: 'Question number 4', reason: 'missing' })).body.already === true);
    ok('limit NEGATIVE CONTROL: another person still sends', (await send('vic', { question: 'One too many', reason: 'missing' })).body.ok === true);
    await counters.forgetForTest(ORG, 'ask:from:'); // the day is over
    const next = await send('ann', { question: 'One too many', reason: 'missing' });
    await settle();
    ok('limit: the refused send was not marked sent — the next day, it goes', next.body.ok === true && !next.body.already, show(next.body));

    // ── seen ──────────────────────────────────────────────────────────────
    const list = await bell('ed');
    const first = list.asks[0];
    await b.as('ed').call('mentions:seen', { projectId: first.projectId, id: first.id });
    const after = await bell('ed');
    ok('seen: one row, by its ids', after.asks.find((x) => x.id === first.id)?.seen === true && after.unseen === list.unseen - 1, show([list.unseen, after.unseen]));
    const newest = after.asks.reduce((m, x) => (x.at > m ? x.at : m), after.asks[0].at);
    await b.as('ed').call('mentions:seen', { through: newest });
    const none = await bell('ed');
    ok('seen: "Mark all seen" through the newest shown marks every ask', none.unseen === 0 && none.asks.every((x) => x.seen), show(none.unseen));
    ok('seen: the caller\'s own — another editor\'s are untouched', (await bell('tam')).unseen > 0);

    // ── access ────────────────────────────────────────────────────────────
    ok('access: a member with no grant on the project is refused (403)', (await send('nog', { question: 'x', reason: 'missing' })).status === 403);
    ok('access: a project viewer may not ask for an alert from an answer (403, as alerts:save)', (await b.as('ann').call('alerts:fromAnswer', { projectId: P, spec: { datasetId: randomUUID() } })).status === 403);

    // ── demoted ───────────────────────────────────────────────────────────
    await b.share(P, 'ed', 'viewer');
    ok('demoted: an editor made a viewer no longer lists the asks, nor counts them', (await bell('ed')).asks.length === 0 && (await bell('ed')).unseen === 0);
    await b.share(P, 'ed', 'editor');
    ok('demoted CONTROL: made an editor again, they are listed', (await bell('ed')).asks.length > 0);

    // ── rls ───────────────────────────────────────────────────────────────
    const role = await ordinaryRole(b, ['editor_asks']);
    try {
      ok('rls: an ordinary role sees no row with no org set, none of another org\'s, and its own org\'s',
        (await seenAs(role, 'editor_asks', null)).length === 0 && (await seenAs(role, 'editor_asks', 'globex')).length === 0 && (await seenAs(role, 'editor_asks', ORG)).length > 0);
      ok('rls: a row for another org is refused (WITH CHECK)', await refusedAs(role, ORG, `INSERT INTO editor_asks (org_id, user_email, id, project_id, asker, question, reason) VALUES ('globex', 'x@globex.test', $1, $2, 'y@globex.test', 'q', 'missing')`, [randomUUID(), P]));
    } finally {
      await role.end();
    }
  } finally {
    sse.setFanOut(null);
  }
}

(async () => {
  contractCases();
  await noDatabase();
  B.openLoopback();
  smtp.trustCaForTest(CERT);
  const fake = await startFake({ creds: { user: 'relay', pass: 'relay-pw' } });
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  try {
    await withServer('askeditor', { SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: 'relay', SMTP_PASSWORD: 'relay-pw', SMTP_FROM: 'Acme Analytics <bi@acme.test>' }, (b) => suite(b, fake));
  } finally {
    await fake.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
