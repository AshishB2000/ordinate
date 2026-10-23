// @mentions in comments (docs/notifications/00-design.md §5.1, §5.5-5.13), on
// Postgres with header sign-in (scripts/notifyHarness.ts) and the fake SMTP relay.
//
//   token      the ONE parser (app/mentionToken.ts): escapes, case, an underscore,
//              a mention in link text, a forged placeholder, a label before a cut
//   no db      mentions off: the list says so, a token is refused, the picker is empty
//   picker     current readers only — a team member and an org admin appear; a
//              member with no grant, a disabled member and another org's never;
//              at most 8, the caller never, even when the caller sorts first;
//              a member with no grant is refused the picker itself (403)
//   refused    a non-reader on add, reply and edit: nothing stored, the SAME words
//              for an org member without access and an unknown address; 11
//              people in one piece (control: 10 pass)
//   told       a mentioned reader gets the push (to them alone), the email and the
//              Home row; names, never addresses; one audit row per recipient
//   quiet      an edit adding no mention, a self-mention, and a mention removed and
//              added back tell no one (control: an edit adding a new one tells once)
//   stored     a 6 000-character body with a mention at 5 500 tells nobody
//   opt-out    stops the email, not the row (control: back on, the email)
//   budget     the `mention` bucket holds; the row and the push still go
//   access     a reader who loses access before the send gets nothing (control:
//              one who still has access gets all three)
//   names      comment:list's `people`, Home's snippet (labelled before its cut),
//              a report's discussion page: "@Name" / "@former member"
//   gone       deleting a comment or a reply deletes its mention rows; a mention
//              edited out is marked seen when Home skips it; `unseen` is the DB's
//   home       mentions:list unseen first, readable projects only; ids that repeat
//              across projects are two rows, and mentions:seen marks one
//   rls        `mentions` as an ordinary role
//   slow mail  SMTP down, and SMTP stalling: comment:add answers at once, stores
//              the comment once, and the row and the push still happen
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-mentions.js

export {}; // module scope
import { randomUUID } from 'crypto';
import { finish, ok } from './selfcheck';
import { CERT, startFake } from './smtpFake';
import * as B from './subscriptionHarness';
import { BOSS, ORG, mailParts, ordinaryRole, refusedAs, seenAs, serverMode, show, until, withServer, type Bench, type Identity } from './notifyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tok: typeof import('../src/app/mentionToken') = require('../src/app/mentionToken');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const mailEnv: typeof import('../src/server/mail/mailEnv') = require('../src/server/mail/mailEnv');
const email: typeof import('../src/server/mail/emailChannel') = require('../src/server/mail/emailChannel');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const notify: typeof import('../src/server/mentions/notify') = require('../src/server/mentions/notify');
const store: typeof import('../src/server/mentions/store') = require('../src/server/mentions/store');
const orgDb: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const msg: typeof import('../src/server/mentionMessages') = require('../src/server/mentionMessages');
const { withCsrf } = require('./csrfPair') as typeof import('./csrfPair');

const at = (who: string): string => `${who}@acme.test`;
const m = (who: string): string => tok.mentionToken(at(who));
const me = (who: string, role: Identity['user']['role'] = 'viewer'): Identity => ({ user: { email: at(who), role }, org: { id: ORG } });

function tokenCases(): void {
  ok('token: an address is found, lower-cased, once', JSON.stringify(tok.mentionsIn('hi @(Ann.Lee@Acme.com) and @(ann.lee@acme.com)')) === '["ann.lee@acme.com"]');
  ok('token: \\@(…) is an escaped literal, not a mention', tok.mentionsIn('\\@(ann@acme.com)').length === 0 && tok.withMentionLabels('\\@(ann@acme.com)', () => 'X') === '@(ann@acme.com)');
  ok('token: an underscore in an address survives a stray one before it', JSON.stringify(tok.mentionsIn('order_total is off @(first_last@acme.com)')) === '["first_last@acme.com"]');
  ok('token: a mention in link text is still one, labelled as words', tok.withMentionLabels('[see @(ann@acme.com)](https://x.test)', () => '@Ann') === '[see @Ann](https://x.test)');
  ok('token: no `<`, `[` or space inside: `@(<b>@x.com)` is text', tok.mentionsIn('@(<b>@x.com) @([a]@x.com) @(a b@x.com)').length === 0);
  const forged = tok.protectMentions('\uE0000\uE001 @(ann@acme.com)');
  ok('token: a forged placeholder is replaced (U+FFFD), never deleted, before mentions are numbered', forged.addresses.length === 1 && (forged.text.match(/\uE000/g) ?? []).length === 1 && forged.text.startsWith('\uFFFD0\uFFFD '), JSON.stringify(forged));
  ok('token: deleting nothing means no token is made — `@` + U+E000 + `(…)` is no mention', tok.mentionsIn('@\uE000(ann@acme.com)').length === 0 && tok.protectMentions('@\uE000(ann@acme.com)').addresses.length === 0);
  const long = 'x'.repeat(190) + ' @(ann.lee@acme.com) tail';
  const cut = tok.commentSnippet(long, () => '@Ann Lee', 200);
  ok('token: the label is applied BEFORE the cut — a mention straddling 200 is never half an address', !cut.includes('acme') && cut.includes('@Ann'), cut);
  ok('token: a name from the address', tok.personName('ann.lee@acme.com') === 'Ann Lee' && tok.personName('j_smith+bi@acme.com') === 'J Smith Bi');
  ok('token: the picker only offers what a token carries', tok.tokenizable('ann@acme.com') && !tok.tokenizable('a(b@acme.com'));
}

async function noDatabase(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mentions-nodb-'));
  serverMode(DATA);
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }));
  const call = async (channel: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return r.statusCode === 200 ? wire.decode(r.body) as any : { status: r.statusCode }; // any: each channel's reply
  };
  try {
    const pid = (await call('projects:create', { name: 'No DB' })).id;
    const target = { kind: 'analysis', id: randomUUID() };
    const list = await call('comment:list', { projectId: pid });
    ok('no db: comment:list says mentions are off', list.ok === true && list.mentions === false, show(list));
    const add = await call('comment:add', { projectId: pid, target, body: `hi ${m('ann')}` });
    ok('no db: a body with a mention token is refused (no directory to check it against)', add.ok === false && add.error === msg.notAReader(), show(add));
    ok('no db: …and a body without one is stored', (await call('comment:add', { projectId: pid, target, body: 'plain words' })).ok === true);
    const scrubbed = await call('comment:add', { projectId: pid, target, body: 'odd \uE000 bytes @\uE001(x)' });
    const stored = scrubbed.comments?.at(-1)?.body as string | undefined;
    ok('write: the web\'s placeholder characters are never stored — replaced by U+FFFD, not deleted', stored === 'odd \uFFFD bytes @\uFFFD(x)', JSON.stringify(stored));
    const picker = await call('comment:mentionable', { projectId: pid, q: '' });
    ok('no db: the picker never offers anyone', picker.ok && picker.available === false && picker.people.length === 0, show(picker));
    const home = await call('mentions:list', undefined);
    ok('no db: Home has no "Mentioned you"', home.ok && home.available === false);
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function suite(b: Bench, fake: Awaited<ReturnType<typeof startFake>>): Promise<void> {
  const pushes: Array<{ user?: string; channel: string; data: string }> = [];
  sse.setFanOut((t, channel, data) => pushes.push({ user: t.user, channel, data }));
  const rewire = (src: Record<string, string>) => email.wireMail(mailEnv.parseMail({ SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: 'relay', SMTP_PASSWORD: 'relay-pw', SMTP_FROM: 'Acme Analytics <bi@acme.test>', ...src } as never, true), orgDb.orgDb(), [], { info: () => undefined, warn: () => undefined });
  try {
    const readers = Array.from({ length: 12 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
    await b.provision('ann', 'bea', 'cal', 'ted', 'ola', 'nog', 'dis', 'aaa', ...readers);
    const pid: string = (await b.as('boss').call('projects:create', { name: 'Mentions' })).body.id;
    for (const w of ['ann', 'bea', 'cal', 'dis', 'aaa', ...readers]) await b.share(pid, w, 'viewer');
    const team: string = (await b.as('boss').call('admin:createTeam', { name: 'Ops' })).body.id;
    await b.as('boss').call('admin:teamMember', { teamId: team, userId: await b.uid('ted'), member: true });
    await b.share(pid, { teamId: team }, 'viewer');
    await b.as('boss').call('admin:setRole', { userId: await b.uid('ola'), role: 'admin' });
    await b.as('boss').call('admin:setDisabled', { userId: await b.uid('dis'), disabled: true });
    await b.pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'globex') ON CONFLICT DO NOTHING`);
    await b.pool.query(`INSERT INTO users (org_id, email, role, last_login_at) VALUES ('globex', 'gina@globex.test', 'admin', now())`);
    const board = await b.run(BOSS, () => analysis.saveAnalysis(pid, { name: 'Revenue review', sheets: [{ name: 'S', cards: [] }] } as never));
    const target = { kind: 'analysis', id: board!.id };
    const as = (w: string) => b.as(w);
    const settle = async () => { await notify.mentionsSettled(); };
    const pushesTo = (w: string) => pushes.filter((p) => p.channel === 'mentions:new' && p.user === at(w)).length;
    const mailsTo = (w: string) => fake.txns.filter((t) => t.rcpts.includes(at(w))).length;
    const rowsOf = async (w: string) => Number((await b.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM mentions WHERE org_id = $1 AND user_email = $2`, [ORG, at(w)])).rows[0].n);

    // ── picker ────────────────────────────────────────────────────────────
    const pick = async (w: string, q: string) => (await as(w).call('comment:mentionable', { projectId: pid, q })).body as { ok: boolean; available: boolean; people: Array<{ email: string; name: string }> };
    const all = await pick('ann', '');
    ok('picker: mentions are on with a database', all.ok && all.available === true, show(all));
    const t = await pick('ann', 'ted');
    const o = await pick('ann', 'ola');
    ok('picker: a team member and an org admin appear', t.people.some((p) => p.email === at('ted')) && o.people.some((p) => p.email === at('ola')), show([t, o]));
    const nobody = [await pick('ann', 'nog'), await pick('ann', 'dis'), await pick('ann', 'gina')];
    ok('picker: a member with no grant, a disabled member and another org\'s never do', nobody.every((r) => r.people.length === 0), show(nobody));
    ok('picker: at most 8', all.people.length === 8, String(all.people.length));
    const aaa = await pick('aaa', 'a');
    ok('picker: the caller is never offered, even sorting first (filtered, then cut to 8)', aaa.people.length === 8 && !aaa.people.some((p) => p.email === at('aaa')), show(aaa.people.map((p) => p.email)));
    ok('picker: each comes with a name, not only an address', all.people.every((p) => p.name && !p.name.includes('@')));
    ok('picker NEGATIVE CONTROL: a member with no grant is refused the picker itself', (await as('nog').call('comment:mentionable', { projectId: pid, q: '' })).status === 403);

    // ── refused ───────────────────────────────────────────────────────────
    const count = async () => ((await as('boss').call('comment:list', { projectId: pid })).body.comments as unknown[]).length;
    const c0 = await count();
    const noGrant = await as('ann').call('comment:add', { projectId: pid, target, body: `look ${m('nog')}` });
    const unknown = await as('ann').call('comment:add', { projectId: pid, target, body: `look ${tok.mentionToken('nobody@acme.test')}` });
    const foreign = await as('ann').call('comment:add', { projectId: pid, target, body: `look ${tok.mentionToken('gina@globex.test')}` });
    ok('refused: a member with no grant, an unknown address and another org\'s member — refused, nothing stored',
      [noGrant, unknown, foreign].every((r) => r.body.ok === false) && (await count()) === c0, show([noGrant.body, unknown.body]));
    ok('refused: the SAME words whoever it was — nothing confirms an address is a member', noGrant.body.error === unknown.body.error && unknown.body.error === foreign.body.error && noGrant.body.error === msg.notAReader() && !noGrant.text.includes('nog@'));
    const base = (await as('ann').call('comment:add', { projectId: pid, target, body: 'a thread' })).body;
    const thread = base.comments.at(-1).id as string;
    ok('refused: a reply naming a non-reader', (await as('bea').call('comment:reply', { projectId: pid, id: thread, body: `re ${m('nog')}` })).body.ok === false);
    ok('refused: an edit adding a non-reader', (await as('ann').call('comment:edit', { projectId: pid, id: thread, body: `a thread ${m('nog')}` })).body.ok === false);
    const eleven = readers.slice(0, 11).map(m).join(' ');
    const ten = readers.slice(0, 10).map(m).join(' ');
    const tooMany = await as('ann').call('comment:add', { projectId: pid, target, body: `all: ${eleven}` });
    ok('flood: 11 distinct people in one piece are refused, in the catalog\'s words', tooMany.body.ok === false && tooMany.body.error === msg.tooManyMentions(10), show(tooMany.body));
    ok('flood CONTROL: 10 pass', (await as('ann').call('comment:add', { projectId: pid, target, body: `all: ${ten}` })).body.ok === true);
    await settle();

    // ── told ──────────────────────────────────────────────────────────────
    const [p0, e0, r0] = [pushesTo('bea'), mailsTo('bea'), await rowsOf('bea')];
    const pushedTo0 = pushes.filter((p) => p.channel === 'mentions:new').length;
    const told = await as('ann').call('comment:add', { projectId: pid, target, body: `**Look** ${m('bea')}, the North figure` });
    await settle();
    ok('told: the comment is stored', told.body.ok === true);
    ok('told: a push to bea\'s tabs — and to no one else', pushesTo('bea') === p0 + 1 && pushes.filter((p) => p.channel === 'mentions:new').length === pushedTo0 + 1);
    const notice = JSON.parse(pushes.filter((p) => p.channel === 'mentions:new').at(-1)!.data);
    ok('told: the push names who and where, with no address', notice.by === 'Ann' && notice.on === 'Revenue review' && !JSON.stringify(notice).includes('@acme'), JSON.stringify(notice));
    ok('told: an email to bea', mailsTo('bea') === e0 + 1);
    const mail = mailParts(fake.txns.at(-1)!.data);
    ok('told: the email\'s title, the words with "@Name", a link, no address in it', mail.subject === msg.mentionedYouOn('Ann', 'Revenue review') && mail.text.includes('Look @Bea, the North figure')
      && mail.text.includes('https://bi.example.com/analyses/') && !mail.text.includes('bea@acme') && mail.text.includes(msg.mentionEmailReason('Ann')), JSON.stringify(mail));
    ok('told: a Home row', (await rowsOf('bea')) === r0 + 1);
    const home = (await as('bea').call('mentions:list')).body;
    const row = home.items[0];
    ok('told: Home lists it unseen, by name, with the snippet named — never an address', home.available && row && row.seen === false && row.by === 'Ann' && row.snippet === 'Look @Bea, the North figure' && row.on.name === 'Revenue review', show(home));
    const trail = await b.pool.query<{ actor: string; targets: string[] }>(`SELECT actor, target_ids::text[] AS targets FROM audit_log WHERE channel = 'comment:mention' ORDER BY id DESC LIMIT 1`);
    const piece = told.body.comments.at(-1).id as string;
    ok('told: one audit row per recipient — the comment, the piece and the recipient', trail.rows[0]?.actor === at('ann') && trail.rows[0].targets.includes(piece) && trail.rows[0].targets.includes(await b.uid('bea')), show(trail.rows));

    // ── quiet ─────────────────────────────────────────────────────────────
    const quiet = async (label: string, fn: () => Promise<unknown>) => {
      const before = [pushes.filter((p) => p.channel === 'mentions:new').length, fake.txns.length, Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM mentions')).rows[0].n)];
      await fn();
      await settle();
      const after = [pushes.filter((p) => p.channel === 'mentions:new').length, fake.txns.length, Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM mentions')).rows[0].n)];
      ok(`quiet: ${label} tells no one`, JSON.stringify(before) === JSON.stringify(after), show([before, after]));
    };
    await quiet('an edit adding no mention', () => as('ann').call('comment:edit', { projectId: pid, id: piece, body: `**Look** ${m('bea')}, the North figure, again` }));
    await quiet('a self-mention', () => as('ann').call('comment:add', { projectId: pid, target, body: `note to self ${m('ann')}` }));
    await quiet('a mention removed and added back', async () => {
      await as('ann').call('comment:edit', { projectId: pid, id: piece, body: 'no one now' });
      await as('ann').call('comment:edit', { projectId: pid, id: piece, body: `back again ${m('bea')}` });
    });
    const cp = pushesTo('cal');
    await as('ann').call('comment:edit', { projectId: pid, id: piece, body: `back again ${m('bea')} and ${m('cal')}` });
    await settle();
    ok('quiet CONTROL: an edit adding a NEW mention tells that person once', pushesTo('cal') === cp + 1 && pushesTo('bea') === p0 + 1);
    const replied = await as('bea').call('comment:reply', { projectId: pid, id: piece, body: `thanks ${m('ann')}` });
    await settle();
    ok('told: a reply mentions too (to ann, its own piece)', replied.body.ok && pushesTo('ann') >= 1);

    // ── stored ────────────────────────────────────────────────────────────
    await quiet('a 6 000-character body with a mention at 5 500 (the store keeps 5 000)', () => as('ann').call('comment:add', { projectId: pid, target, body: 'y'.repeat(5500) + ' ' + m('cal') + ' ' + 'z'.repeat(400) }));

    // ── opt-out ───────────────────────────────────────────────────────────
    await as('bea').call('mentions:setPrefs', { emailMe: false });
    const prefs = (await as('bea').call('mentions:prefs')).body;
    ok('opt-out: the setting reads back off', prefs.available && prefs.mail && prefs.emailMe === false, show(prefs));
    const [ep, er] = [mailsTo('bea'), await rowsOf('bea')];
    await as('ann').call('comment:add', { projectId: pid, target, body: `again ${m('bea')}` });
    await settle();
    ok('opt-out: no email, but the Home row', mailsTo('bea') === ep && (await rowsOf('bea')) === er + 1);
    await as('bea').call('mentions:setPrefs', { emailMe: true });
    await as('ann').call('comment:add', { projectId: pid, target, body: `and again ${m('bea')}` });
    await settle();
    ok('opt-out CONTROL: turned back on, the email goes', mailsTo('bea') === ep + 1);

    // ── budget ────────────────────────────────────────────────────────────
    rewire({ RATE_LIMIT_EMAIL_ORG_PER_HOUR: '2' }); // a project's share: 1 mention email an hour
    email.resetLimitsForTest();
    const [eb, rb, pb] = [mailsTo('cal'), await rowsOf('cal'), pushesTo('cal')];
    await as('ann').call('comment:add', { projectId: pid, target, body: `one ${m('cal')}` });
    await settle();
    await as('ann').call('comment:add', { projectId: pid, target, body: `two ${m('cal')}` });
    await settle();
    ok('budget: the `mention` bucket holds — the second email in the hour is not sent', mailsTo('cal') === eb + 1, String(mailsTo('cal') - eb));
    ok('budget: …while its Home row and push still go', (await rowsOf('cal')) === rb + 2 && pushesTo('cal') === pb + 2);
    const budget: typeof import('../src/server/mail/budget') = require('../src/server/mail/budget');
    ok('budget: its own kind — the mention bucket is spent, the alert and subscription buckets are not',
      budget.hold(budget.sendBuckets(ORG, pid, 'mention', 2), 1) === null && budget.hold(budget.sendBuckets(ORG, pid, 'alert', 2), 1) !== null && budget.hold(budget.sendBuckets(ORG, pid, 'dashboard', 2), 1) !== null);
    rewire({});
    email.resetLimitsForTest();

    // ── access ────────────────────────────────────────────────────────────
    const piece2 = randomUUID();
    await b.share(pid, 'cal', null); // cal loses access between the write and the send
    const [lb, lc] = [[pushesTo('bea'), mailsTo('bea'), await rowsOf('bea')], [pushesTo('cal'), mailsTo('cal'), await rowsOf('cal')]];
    await b.run(me('ann'), () => notify.notifyMentions({ projectId: pid, commentId: piece2, id: piece2, target: target as never, author: at('ann'), body: `late ${m('bea')} ${m('cal')}` }, [at('bea'), at('cal')]));
    ok('access: a reader who lost access before the send gets nothing', JSON.stringify([pushesTo('cal'), mailsTo('cal'), await rowsOf('cal')]) === JSON.stringify(lc));
    ok('access CONTROL: one who still has access gets the push, the email and the row', pushesTo('bea') === lb[0] + 1 && mailsTo('bea') === lb[1] + 1 && (await rowsOf('bea')) === lb[2] + 1);

    // ── names ─────────────────────────────────────────────────────────────
    const listed = (await as('bea').call('comment:list', { projectId: pid })).body;
    ok('names: comment:list names current readers only — cal (gone) and nog (never) have no name', listed.mentions === true && listed.people[at('bea')] === 'Bea' && !(at('cal') in listed.people) && !(at('nog') in listed.people), show(listed.people));
    const overview = (await as('bea').call('home:overview', { projectId: pid })).body;
    const snippets = overview.comments.recent.map((r: { snippet: string }) => r.snippet).join(' | ');
    ok('names: Home\'s Recent comments say "@Bea" and "@former member", never an address', snippets.includes('@Bea') && snippets.includes('@former member') && !snippets.includes('@acme'), snippets);
    const reports: typeof import('../src/ipc/reportsServer') = require('../src/ipc/reportsServer');
    const discussion = await b.run(me('bea'), () => reports.pageDeps({}, pid).comments());
    const text = JSON.stringify(discussion.comments.map((c) => [c.body, ...(c.replies ?? []).map((r) => r.body)]));
    ok('names: a report\'s discussion page says "@Bea" and "@former member", never an address', text.includes('@Bea') && text.includes('@former member') && !/@\([^)]*@/.test(text) && !text.includes('cal@acme'), text.slice(0, 300));

    // ── gone ──────────────────────────────────────────────────────────────
    const rowOfPiece = async (piece: string) => Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM mentions WHERE piece_id = $1', [piece])).rows[0].n);
    const doomed = (await as('ann').call('comment:add', { projectId: pid, target, body: `delete me ${m('bea')}` })).body.comments.at(-1).id as string;
    await settle();
    ok('gone: setup — the mention has its row', (await rowOfPiece(doomed)) === 1);
    await as('ann').call('comment:delete', { projectId: pid, id: doomed });
    ok('gone: deleting the comment deletes its mention rows', (await rowOfPiece(doomed)) === 0);
    const thread2 = (await as('ann').call('comment:add', { projectId: pid, target, body: 'a thread to reply in' })).body.comments.at(-1).id as string;
    const rep = (await as('ann').call('comment:reply', { projectId: pid, id: thread2, body: `fyi ${m('bea')}` })).body.comments.find((c: { id: string }) => c.id === thread2).replies.at(-1).id as string;
    await settle();
    ok('gone: setup — the reply\'s mention has its row', (await rowOfPiece(rep)) === 1);
    await as('ann').call('comment:deleteReply', { projectId: pid, id: thread2, replyId: rep });
    ok('gone: deleting the reply deletes its mention rows', (await rowOfPiece(rep)) === 0);
    const edited = (await as('ann').call('comment:add', { projectId: pid, target, body: `edit me ${m('bea')}` })).body.comments.at(-1).id as string;
    await settle();
    await as('ann').call('comment:edit', { projectId: pid, id: edited, body: 'edit me, no one now' });
    const before = await b.pool.query<{ seen: boolean }>('SELECT seen_at IS NOT NULL AS seen FROM mentions WHERE piece_id = $1', [edited]);
    const homeNow = (await as('bea').call('mentions:list')).body;
    const afterGone = await b.pool.query<{ seen: boolean }>('SELECT seen_at IS NOT NULL AS seen FROM mentions WHERE piece_id = $1', [edited]);
    const dbUnseen = Number((await b.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM mentions WHERE user_email = $1 AND seen_at IS NULL`, [at('bea')])).rows[0].n);
    ok('gone: a mention edited out is skipped by Home and marked seen, so it never hides what is new', before.rows[0]?.seen === false && afterGone.rows[0]?.seen === true && !homeNow.items.some((x: { id: string }) => x.id === edited), show([before.rows, afterGone.rows]));
    ok('gone: `unseen` is the database\'s count after that', homeNow.unseen === dbUnseen, show([homeNow.unseen, dbUnseen]));

    // ── home ──────────────────────────────────────────────────────────────
    const h = (await as('bea').call('mentions:list')).body.items as Array<{ projectId: string; id: string; seen: boolean }>;
    ok('home: unseen first', h.length >= 2 && h.every((x, i) => i === 0 || !(x.seen === false && h[i - 1].seen === true)));
    await as('bea').call('mentions:seen', { projectId: h[0].projectId, id: h[0].id });
    const h2 = (await as('bea').call('mentions:list')).body.items as Array<{ id: string; seen: boolean }>;
    ok('home: mentions:seen {projectId, id} marks that one', h2.find((x) => x.id === h[0].id)?.seen === true && h2.filter((x) => !x.seen).length === h.filter((x) => !x.seen).length - 1);
    ok('home: another member cannot mark bea\'s row (their own rows only)', (await as('ann').call('mentions:seen', { projectId: h[1].projectId, id: h[1].id })).status === 200
      && (await as('bea').call('mentions:list')).body.items.find((x: { id: string }) => x.id === h[1].id)?.seen === h[1].seen);
    const drawn = (await as('bea').call('mentions:list')).body.items as Array<{ id: string; at: string; seen: boolean }>;
    const newestDrawn = drawn.reduce((m, x) => (x.at > m ? x.at : m), drawn[0].at);
    await new Promise((r) => setTimeout(r, 20));
    await as('ann').call('comment:add', { projectId: pid, target, body: `after the render ${m('bea')}` });
    await settle();
    await as('bea').call('mentions:seen', { through: newestDrawn });
    const after = (await as('bea').call('mentions:list')).body.items as Array<{ id: string; seen: boolean; snippet: string }>;
    ok('home: Mark all seen covers what Home drew — a mention that landed after it stays unseen', after.find((x) => x.snippet.startsWith('after the render'))?.seen === false && after.filter((x) => drawn.some((d) => d.id === x.id)).every((x) => x.seen), JSON.stringify(after.map((x) => [x.snippet.slice(0, 20), x.seen])));
    const pid2: string = (await as('boss').call('projects:create', { name: 'Elsewhere' })).body.id;
    const shared = randomUUID();
    await b.run(me('bea'), async () => {
      await store.recordMentions({ projectId: pid, pieceId: shared, commentId: shared, author: at('ann') }, [at('bea')]);
      await store.recordMentions({ projectId: pid2, pieceId: shared, commentId: shared, author: at('ann') }, [at('bea')]);
    });
    const twin = await b.pool.query<{ project_id: string }>('SELECT project_id::text FROM mentions WHERE piece_id = $1', [shared]);
    ok('home: a piece id that repeats across projects is two rows', twin.rows.length === 2);
    await as('bea').call('mentions:seen', { projectId: pid2, id: shared });
    const seenTwin = await b.pool.query<{ project_id: string; seen: boolean }>('SELECT project_id::text, seen_at IS NOT NULL AS seen FROM mentions WHERE piece_id = $1', [shared]);
    ok('home: mentions:seen marks the one in its project, not its twin', seenTwin.rows.find((r) => r.project_id === pid2)?.seen === true && seenTwin.rows.find((r) => r.project_id === pid)?.seen === false);
    ok('home: a project bea cannot read is not listed (her row there stays hidden)', !(await as('bea').call('mentions:list')).body.items.some((x: { projectId: string }) => x.projectId === pid2));
    ok('home: mentions:seen with half an id is refused by the contract', (await as('bea').call('mentions:seen', { id: shared })).status === 400);

    // ── rls ───────────────────────────────────────────────────────────────
    await b.pool.query(`INSERT INTO mentions (org_id, user_email, piece_id, project_id, comment_id, author) VALUES ('globex', 'gina@globex.test', $1, $1, $1, 'x@globex.test')`, [randomUUID()]);
    const role = await ordinaryRole(b, ['mentions'], ['users', 'project_grants', 'team_members']);
    const appPool = orgDb.orgDb();
    try {
      const allRows = (await b.pool.query<{ org_id: string }>('SELECT org_id FROM mentions')).rows;
      const acme = await seenAs(role, 'mentions', ORG);
      ok('rls mentions: as acme an ordinary role sees exactly acme\'s rows (not vacuous)', acme.length > 2 && acme.length === allRows.filter((r) => r.org_id === ORG).length && acme.every((r) => r.org_id === ORG));
      ok('rls mentions: with no setting, nothing', (await seenAs(role, 'mentions', null)).length === 0);
      ok('rls mentions: as globex, none of acme\'s', (await seenAs(role, 'mentions', 'globex')).every((r) => r.org_id === 'globex'));
      ok('rls mentions: a write for another org is refused (WITH CHECK)', await refusedAs(role, 'globex', `INSERT INTO mentions (org_id, user_email, piece_id, project_id, comment_id, author) VALUES ('acme', 'x@acme.test', $1, $1, $1, 'y')`, [randomUUID()]));
      orgDb.useOrgDb(role);
      const viaRole = await b.run(me('bea'), async () => (await store.recordMentions({ projectId: pid, pieceId: randomUUID(), commentId: randomUUID(), author: at('ann') }, [at('bea')])).length === 1 && (await store.listMine(5)).length > 0);
      ok('rls mentions: the store\'s own statements pass as an ordinary role', viaRole);
    } finally {
      orgDb.useOrgDb(appPool);
      await role.end();
    }

    // ── slow mail (last: a stalled relay keeps a send open) ────────────────
    for (const [label, apply] of [['SMTP down', () => rewire({ SMTP_PORT: '1' })], ['SMTP stalling', () => { rewire({}); fake.opts.stall = 'data'; }]] as const) {
      apply();
      const [rr, pp] = [await rowsOf('bea'), pushesTo('bea')];
      const c1 = await count();
      const t0 = Date.now();
      const r = await as('ann').call('comment:add', { projectId: pid, target, body: `${label} ${m('bea')}` });
      const ms = Date.now() - t0;
      ok(`slow mail (${label}): comment:add answers at once (${ms} ms) and stores the comment once`, r.body.ok === true && ms < 2000 && (await count()) === c1 + 1, show([ms, r.body.ok]));
      ok(`slow mail (${label}): the row and the push still happen`, await until(async () => (await rowsOf('bea')) === rr + 1 && pushesTo('bea') === pp + 1, 5000));
    }
  } finally {
    sse.setFanOut(null);
  }
}

(async () => {
  tokenCases();
  await noDatabase();
  B.openLoopback();
  smtp.trustCaForTest(CERT);
  const fake = await startFake({ creds: { user: 'relay', pass: 'relay-pw' } });
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  try {
    await withServer('mentions', { SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: 'relay', SMTP_PASSWORD: 'relay-pw', SMTP_FROM: 'Acme Analytics <bi@acme.test>' }, (b) => suite(b, fake));
  } finally {
    await fake.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
