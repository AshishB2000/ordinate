// Dashboard requests (docs/team-folders/00-design.md D20, "Dashboard requests"; src/server/requests/), on Postgres with
// header sign-in (scripts/notifyHarness.ts), the fake SMTP relay and a folder: Ops (team Ops: view; team Ops leads:
// edit) holds Orders, Everyone holds Plain.
//
//   contract   create is read (as editors:ask) and audited; preview, approve and decline are write; 1–12 turns, a
//              title, a note under 2 000 characters; a decline needs a note
//   no db      off: create says why, the bell has no requests
//   create     a viewer's own answer turns become one row; the approvers — Edit on every dataset the charts read — get a
//              bell row and a push with no title or note; NEGATIVE CONTROLS: an editor of Everyone only, an editor who
//              views Ops, another viewer and the requester are not told (on Plain, both editors are); audited
//   theirs     a viewer naming someone else's turn writes nothing (control: their own goes); a member with no grant 403
//   canary     the stored rows hold no figure of the charts (NEGATIVE CONTROL: the viewer's own kept turn does)
//   email      only to an approver who turned it on, with the title, the charts, the note and the review link
//   preview    the reviewer's figures are THE door's, Object.is, under the reviewer's access (NEGATIVE CONTROL: a row
//              rule makes the requester's own figures differ); what approving makes, by name; a row rule on the
//              requester puts "Viv sees fewer rows here" under each chart it holds (NEGATIVE CONTROL: on Plain, the same
//              rows, none), and none of her own figures is in the reply (canary)
//   refused    an editor who cannot open Orders: 409 closed, told nothing, nothing made; one who only views Ops: 409
//              edit; a viewer: 403 (control: an Ops lead may)
//   approve    exactly one dashboard and its visuals, as the preview listed them, in Ops, published; the requester told
//              in the bell, by push and email, and reads the published copy (control: before, they could not);
//              a second approval, and two at once, make no second dashboard
//   draft      Edit makes an unpublished dashboard and tells no one; its first Publish tells the requester
//   decline    needs a note; makes nothing; the requester is told with the note
//   dedupe     the same charts again the same day are "already sent" (control: other charts go)
//   limit      past REQUESTS_PER_DAY refused in the catalog's words, writing nothing; a duplicate still "already";
//              another person still sends, and their Plain request lands in Everyone; the next day it goes
//   seen       a row by its ids, and the badge counts requests
//   rls        both tables as an ordinary role
//   …and the rest of E9 (./dashboardRequestsMore.ts): withdraw, an existing dashboard, the folder picker, SQL and source
//   table answers, Live charts, the cap on open requests, and a project's deletion
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-dashboardRequests.js

export {}; // module scope
import { randomUUID } from 'crypto';
import { finish, ok } from './selfcheck';
import { CERT, startFake } from './smtpFake';
import * as B from './subscriptionHarness';
import { ORG, mailParts, ordinaryRole, refusedAs, seenAs, serverMode, show, withServer, type Bench, type Identity } from './notifyHarness';
import { more } from './dashboardRequestsMore';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const smtp: typeof import('../src/server/mail/smtp') = require('../src/server/mail/smtp');
const requests: typeof import('../src/server/requests/requests') = require('../src/server/requests/requests');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const msg: typeof import('../src/server/requestMessages') = require('../src/server/requestMessages');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
const api: typeof import('../src/api/index') = require('../src/api/index');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const { withCsrf } = require('./csrfPair') as typeof import('./csrfPair');

type Any = any; // any: each channel's own reply, read field by field
const at = (who: string): string => (who.includes('@') ? who : `${who}@acme.test`);
const me = (who: string): Identity => ({ user: { email: at(who), role: who === 'boss' ? 'admin' : 'viewer' }, org: { id: ORG } });
const SALES = { category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Sales by region' };
const AVG = { category: 'region', measures: [{ column: 'amount', aggregation: 'avg' }], filters: [], chartType: 'bar', title: 'Average order by region' };
const PLAIN = { category: 'kind', measures: [{ column: 'n', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Units by kind' };
const NOTE = 'For the Q4 review NOTECANARY';

function contractCases(): void {
  const c = api.contracts;
  const P = randomUUID();
  const good = { projectId: P, threadId: randomUUID(), turnIds: [randomUUID()], title: 'Returns Q4' };
  ok('contract: create is read (asking changes nothing in the project), audited and project-scoped; the rest are write',
    c['request:create'].access === 'read' && c['request:create'].audit === true && 'project' in c['request:create'] && c['request:create'].project(good) === P
      && ['request:preview', 'request:approve', 'request:decline'].every((ch) => c[ch as 'request:preview'].access === 'write'));
  ok('contract: 1–12 turns, a title of 1–120, a note under 2 000; nothing else', c['request:create'].input.safeParse({ ...good, note: 'n' }).success
    && !c['request:create'].input.safeParse({ ...good, turnIds: [] }).success && !c['request:create'].input.safeParse({ ...good, turnIds: Array.from({ length: 13 }, randomUUID) }).success
    && !c['request:create'].input.safeParse({ ...good, title: '  ' }).success && !c['request:create'].input.safeParse({ ...good, note: 'x'.repeat(2001) }).success
    && !c['request:create'].input.safeParse({ ...good, charts: [{}] }).success);
  ok('contract: a decline needs a note; an approval says whether it publishes, and may name a folder', !c['request:decline'].input.safeParse({ projectId: P, id: P, note: ' ' }).success
    && c['request:decline'].input.safeParse({ projectId: P, id: P, note: 'Not this quarter' }).success && !c['request:approve'].input.safeParse({ projectId: P, id: P }).success
    && c['request:approve'].input.safeParse({ projectId: P, id: P, publish: true, folderId: P }).success && !c['request:approve'].input.safeParse({ projectId: P, id: P, publish: true, folderId: 'Ops' }).success);
  ok('contract: withdraw is read (the requester\'s own), audited; the folder list is read', c['request:withdraw'].access === 'read' && c['request:withdraw'].audit === true
    && c['request:withdraw'].project({ projectId: P, id: P }) === P && c['request:folders'].access === 'read' && c['request:folders'].project({ projectId: P }) === P);
  ok('contract: a request names an existing dashboard or a folder for a new one — not both', c['request:create'].input.safeParse({ ...good, dashboardId: P }).success
    && c['request:create'].input.safeParse({ ...good, folderId: P }).success && !c['request:create'].input.safeParse({ ...good, dashboardId: P, folderId: P }).success);
}

async function noDatabase(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-requests-nodb-'));
  serverMode(DATA);
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }));
  const call = async (channel: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return r.statusCode === 200 ? (wire.decode(r.body) as Any) : { status: r.statusCode };
  };
  try {
    const pid = (await call('projects:create', { name: 'No DB' })).id;
    const r = await call('request:create', { projectId: pid, threadId: randomUUID(), turnIds: [randomUUID()], title: 'Returns' });
    ok('no db: a request says why (no user directory)', r.ok === false && r.error === msg.requestsOff(), show(r));
    const p = await call('request:preview', { projectId: pid, id: randomUUID() });
    ok('no db: a review says why too', p.ok === false && p.error === msg.requestsOff(), show(p));
    const w = await call('request:withdraw', { projectId: pid, id: randomUUID() });
    ok('no db: a withdrawal says why too', w.ok === false && w.error === msg.requestsOff(), show(w));
    const f = await call('request:folders', { projectId: pid });
    ok('no db: there are no folders to suggest', f.ok === true && Array.isArray(f.folders) && f.folders.length === 0, show(f));
    const list = await call('mentions:list', undefined);
    ok('no db: the bell has no requests', list.ok && Array.isArray(list.requests) && list.requests.length === 0, show(list));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

/** Every number and display string a card shows. */
function figuresOf(card: Any): string[] {
  const out = new Set<string>();
  for (const s of card.data.series) for (const v of s.values) if (typeof v === 'number' && Number.isFinite(v)) out.add(String(v));
  for (const h of card.headline) out.add(h.display);
  return [...out].filter((x) => x.length >= 4);
}

/** Two cards' figures, value by value with Object.is, and their labels. */
function sameFigures(a: Any, b: Any): boolean {
  const vals = (c: Any): unknown[] => c.data.series.flatMap((s: Any) => s.values);
  const x = vals(a);
  const y = vals(b);
  return x.length > 0 && x.length === y.length && x.every((v, i) => Object.is(v, y[i])) && JSON.stringify(a.data.labels) === JSON.stringify(b.data.labels)
    && JSON.stringify(a.headline) === JSON.stringify(b.headline);
}

async function suite(b: Bench, fake: Awaited<ReturnType<typeof startFake>>): Promise<void> {
  const pushes: Array<{ user?: string; channel: string; data: string }> = [];
  sse.setFanOut((t, channel, data) => pushes.push({ user: t.user, channel, data }));
  try {
    await b.provision('viv', 'vic', 'lead', 'ed', 'ev', 'nog');
    const P = (await b.as('boss').call('projects:create', { name: 'Sales' })).body.id as string;
    for (const w of ['viv', 'vic']) await b.share(P, w, 'viewer');
    for (const w of ['lead', 'ed', 'ev']) await b.share(P, w, 'editor');
    const team = async (name: string, ...who: string[]): Promise<string> => {
      const id: string = (await b.as('boss').call('admin:createTeam', { name })).body.id;
      for (const w of who) await b.as('boss').call('admin:teamMember', { teamId: id, userId: await b.uid(w), member: true });
      return id;
    };
    const opsTeam = await team('Ops', 'viv', 'vic', 'ev');
    const leadsTeam = await team('Ops leads', 'lead');
    const { orders, plain } = await b.run(me('boss'), async () => {
      const o = await datasetsMod.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
        rows: [['North', 70001.13], ['North', 6.2], ['South', 55555.55], ['East', 31337.71]] });
      const p = await datasetsMod.saveDataset(P, { name: 'Plain', sourceKind: 'csv', columns: [{ name: 'kind', type: 'text' }, { name: 'n', type: 'number' }], rows: [['a', 1], ['b', 2]] });
      if (!o || !p) throw new Error('seed datasets');
      return { orders: o.id, plain: p.id };
    });
    const OPS = randomUUID();
    await b.pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', [ORG, P, OPS, 'Ops', at('boss')]);
    await b.pool.query("INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, 'view'), ($1, $2, $3, $5, 'edit')", [ORG, P, OPS, opsTeam, leadsTeam]);
    await b.pool.query("INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, 'dataset', $3, $4, $5)", [ORG, P, orders.toLowerCase(), OPS, at('boss')]);

    // The viewer's own answers: two charts on Orders and one on Plain, in one conversation.
    const rerun = async (w: string, spec: object, threadId?: string): Promise<{ threadId: string; turnId: string }> => {
      const r = await b.as(w).call('answer:rerun', { projectId: P, ...(threadId ? { threadId } : {}), spec });
      if (r.status !== 200 || !r.body.ok) throw new Error(`rerun: ${show(r.body)}`);
      return { threadId: r.body.threadId, turnId: r.body.turns.at(-1).id };
    };
    const t1 = await rerun('viv', { ...SALES, datasetId: orders });
    const thread = t1.threadId;
    const t2 = await rerun('viv', { ...AVG, datasetId: orders }, thread);
    const tP = await rerun('viv', { ...PLAIN, datasetId: plain }, thread);

    const ask = (w: string, turnIds: string[], extra: object = {}, threadId = thread) => b.as(w).call('request:create', { projectId: P, threadId, turnIds, title: 'Returns Q4', ...extra });
    const reqRows = async (): Promise<number> => Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dashboard_requests')).rows[0].n);
    const inbox = async (w: string, id?: string): Promise<number> => Number((await b.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM dashboard_request_inbox WHERE org_id = $1 AND user_email = $2 AND ($3::uuid IS NULL OR request_id = $3::uuid)', [ORG, at(w), id ?? null])).rows[0].n);
    const unseen = async (w: string, id: string): Promise<number> => Number((await b.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM dashboard_request_inbox WHERE org_id = $1 AND user_email = $2 AND request_id = $3::uuid AND seen_at IS NULL', [ORG, at(w), id])).rows[0].n);
    const pushesTo = (w: string, state?: string) => pushes.filter((p) => p.channel === 'requests:changed' && p.user === at(w) && (!state || JSON.parse(p.data).state === state)).length;
    const mailsTo = (w: string) => fake.txns.filter((t) => t.rcpts.includes(at(w))).length;
    const bell = async (w: string) => (await b.as(w).call('mentions:list')).body as { ok: boolean; requests: Any[]; unseen: number };
    const boards = async (): Promise<Any[]> => (await b.as('boss').call('analysis:gallery', { projectId: P })).body;
    const visualsNow = async (): Promise<number> => ((await b.as('boss').call('visual:list', { projectId: P })).body as Any[]).length;
    const settle = () => requests.requestsSettled();
    const refusal = (r: { status: number; text: string }): Any => { try { return { status: r.status, ...JSON.parse(r.text) }; } catch { return { status: r.status }; } };

    // ── create ────────────────────────────────────────────────────────────
    await b.as('lead').call('mentions:setPrefs', { requestEmail: true });
    const mail0 = fake.txns.length;
    const r1 = await ask('viv', [t1.turnId, t2.turnId], { note: NOTE });
    await settle();
    const R1: string = r1.body.id;
    ok('create: the request is one row', r1.status === 200 && r1.body.ok === true && typeof R1 === 'string' && (await reqRows()) === 1, show(r1.body));
    ok('create: a bell row for each approver — Edit on Orders: the org admin and the Ops lead', (await inbox('boss', R1)) === 1 && (await inbox('lead', R1)) === 1);
    const unTold = [...await Promise.all(['ed', 'ev', 'vic'].map((w) => inbox(w, R1))), await unseen('viv', R1)];
    ok('create NEGATIVE CONTROL: an editor of Everyone only, an editor who views Ops, another viewer and the requester are told nothing', unTold.every((n) => n === 0) && ['ed', 'ev', 'vic', 'viv'].every((w) => pushesTo(w) === 0), show(unTold));
    ok('create: the requester\'s own row is written seen — their bell lists it, to withdraw, with no badge', (await inbox('viv', R1)) === 1);
    const notice = pushes.find((p) => p.channel === 'requests:changed' && p.user === at('lead'));
    ok('create: a push to each approver, naming who and where — never the title, a chart, the note or an address', pushesTo('lead') === 1 && pushesTo('boss') === 1 && !!notice
      && JSON.parse(notice.data).by === 'Viv' && JSON.parse(notice.data).on === 'Sales' && JSON.parse(notice.data).state === 'open' && !/Returns|NOTECANARY|Sales by region|@acme/.test(notice.data), notice?.data);
    const trail = await b.pool.query<{ actor: string }>(`SELECT actor FROM audit_log WHERE channel = 'request:create' ORDER BY id DESC LIMIT 1`);
    ok('create: audited, as the requester', trail.rows[0]?.actor === at('viv'), show(trail.rows));

    // ── email ─────────────────────────────────────────────────────────────
    ok('email: one, to the approver who turned it on', fake.txns.length === mail0 + 1 && mailsTo('lead') === 1, String(fake.txns.length - mail0));
    ok('email NEGATIVE CONTROL: the admin, who did not, gets none', mailsTo('boss') === 0);
    const mail = mailParts(fake.txns.at(-1)!.data);
    ok('email: the title, the charts, the note and the review link — no address', mail.subject === msg.askedForDashboard('Viv', 'Returns Q4', '2')
      && mail.text.includes('Sales by region') && mail.text.includes(NOTE) && mail.text.includes(`https://bi.example.com/requests/${P}/${R1}`) && mail.text.includes(msg.requestEmailReason()) && !mail.text.includes('viv@acme'), JSON.stringify(mail));

    // ── theirs ────────────────────────────────────────────────────────────
    const rows0 = await reqRows();
    const stolen = await ask('vic', [t1.turnId], { title: 'Mine now' });
    ok('theirs: a viewer naming another viewer\'s turn is refused, in the same words as a missing one, and nothing is written',
      stolen.body.ok === false && stolen.body.error === msg.notYourAnswer() && (await ask('viv', [randomUUID()])).body.error === msg.notYourAnswer() && (await reqRows()) === rows0, show(stolen.body));
    ok('theirs: a member with no grant on the project is refused (403)', (await ask('nog', [t1.turnId])).status === 403);

    // ── canary ────────────────────────────────────────────────────────────
    const vivCards = await b.run(me('viv'), async () => Promise.all([SALES, AVG].map((s) => answers.computeCard(P, { ...s, datasetId: orders } as never))));
    const figures = vivCards.flatMap((c) => ('card' in c ? figuresOf(c.card) : []));
    const stored = (await b.pool.query<{ t: string }>('SELECT row_to_json(r)::text AS t FROM dashboard_requests r')).rows.map((x) => x.t).join('\n')
      + (await b.pool.query<{ t: string }>('SELECT row_to_json(i)::text AS t FROM dashboard_request_inbox i')).rows.map((x) => x.t).join('\n');
    ok(`canary: the stored rows hold none of the charts' ${figures.length} figures — the chart forms only`, figures.length >= 4 && figures.every((f) => !stored.includes(f)) && stored.includes('Sales by region'), show(figures.filter((f) => stored.includes(f))));
    const turnBodies = (await b.pool.query<{ t: string }>('SELECT body AS t FROM assistant_turns WHERE org_id = $1', [ORG])).rows.map((x) => x.t).join('\n');
    ok('canary NEGATIVE CONTROL: the viewer\'s own kept turns do hold them (the canary can be seen)', figures.some((f) => turnBodies.includes(f)), show(figures));

    // ── preview ───────────────────────────────────────────────────────────
    // A row rule on Orders: the Ops team (the requester's) sees North only; editors see every row.
    const rule = await b.as('boss').call('dataset:setRowPolicy', { projectId: P, datasetId: orders, policy: { column: 'region', rules: [{ teamId: opsTeam, values: ['North'] }] } });
    ok('preview: (a row rule on Orders for the requester\'s team)', rule.status === 200, show(rule.body));
    const pv = await b.as('lead').call('request:preview', { projectId: P, id: R1 });
    const door = await b.run(me('lead'), async () => Promise.all([SALES, AVG].map((s) => answers.computeCard(P, { ...s, datasetId: orders } as never))));
    ok('preview: the request, by name, with the note', pv.body.ok === true && pv.body.request.by === 'Viv' && pv.body.request.title === 'Returns Q4' && pv.body.request.note === NOTE && pv.body.request.charts === 2 && !JSON.stringify(pv.body).includes('viv@acme'), show(pv.body));
    ok('preview: every chart\'s figures are the door\'s as the reviewer, Object.is', pv.body.cards.length === 2 && pv.body.cards.every((c: Any, i: number) => c.ok && 'card' in door[i] && sameFigures(c, (door[i] as Any).card)), show(pv.body.cards));
    const vivNow = await b.run(me('viv'), async () => answers.computeCard(P, { ...SALES, datasetId: orders } as never));
    ok('preview NEGATIVE CONTROL: the requester\'s own figures, under their row rule, differ — the review is the reviewer\'s access, not theirs', 'card' in vivNow && !sameFigures(pv.body.cards[0], vivNow.card), show('card' in vivNow ? vivNow.card.data : vivNow));
    ok('preview: under each chart on Orders, one line — the requester sees fewer rows there (their row lock is not the reviewer\'s)',
      pv.body.cards.every((c: Any) => c.fewerRows === msg.seesFewerRows('Viv')) && msg.seesFewerRows('Viv').startsWith('Viv '), show(pv.body.cards.map((c: Any) => c.fewerRows)));
    const vivRuled = await b.run(me('viv'), async () => Promise.all([SALES, AVG].map((s) => answers.computeCard(P, { ...s, datasetId: orders } as never))));
    const reviewerFigures = new Set(door.flatMap((c) => ('card' in c ? figuresOf(c.card) : [])));
    const theirsOnly = vivRuled.flatMap((c) => ('card' in c ? figuresOf(c.card) : [])).filter((f) => !reviewerFigures.has(f));
    ok(`preview canary: none of the requester's own ${theirsOnly.length} figures reaches the reviewer — the line is a comparison, never their figures`,
      theirsOnly.length > 0 && theirsOnly.every((f) => !JSON.stringify(pv.body).includes(f)), show(theirsOnly));
    ok('preview: what approving makes — a visual per chart, the dashboard, and Ops', JSON.stringify(pv.body.creates) === JSON.stringify({ visuals: ['Sales by region', 'Average order by region'], dashboard: 'Returns Q4', folder: 'Ops', folderId: OPS }), show(pv.body.creates));

    // ── refused ───────────────────────────────────────────────────────────
    const [boards0, visuals0] = [(await boards()).length, await visualsNow()];
    const edPv = refusal(await b.as('ed').call('request:preview', { projectId: P, id: R1 }));
    const edOk = refusal(await b.as('ed').call('request:approve', { projectId: P, id: R1, publish: true }));
    ok('refused: an editor who cannot open Orders is refused `closed` (409), and names nothing', edPv.status === 409 && edPv.code === 'folder' && edPv.reason === 'closed' && edOk.status === 409 && edOk.reason === 'closed' && !/Returns|Orders/.test(JSON.stringify([edPv, edOk])), show([edPv, edOk]));
    const evOk = refusal(await b.as('ev').call('request:approve', { projectId: P, id: R1, publish: true }));
    ok('refused: an editor who only views Ops is refused `edit` (409)', evOk.status === 409 && evOk.reason === 'edit', show(evOk));
    ok('refused: a viewer may not approve or decline (403)', (await b.as('vic').call('request:approve', { projectId: P, id: R1, publish: true })).status === 403 && (await b.as('viv').call('request:decline', { projectId: P, id: R1, note: 'x' })).status === 403);
    ok('refused: …and nothing was made', (await boards()).length === boards0 && (await visualsNow()) === visuals0);

    // ── approve ───────────────────────────────────────────────────────────
    await b.as('viv').call('mentions:setPrefs', { requestEmail: true });
    ok('approve: before it, the requester reads no such dashboard (control)', ((await b.as('viv').call('analysis:gallery', { projectId: P })).body as Any[]).every((a) => a.name !== 'Returns Q4'));
    const mail1 = fake.txns.length;
    const yes = await b.as('lead').call('request:approve', { projectId: P, id: R1, publish: true });
    await settle();
    const made = (await boards()).filter((a) => a.name === 'Returns Q4');
    ok('approve: exactly one dashboard and a visual per chart', yes.body.ok === true && yes.body.published === true && made.length === 1 && made[0].id === yes.body.dashboardId
      && (await boards()).length === boards0 + 1 && (await visualsNow()) === visuals0 + 2, show(yes.body));
    const DID: string = yes.body.dashboardId;
    const full = await b.run(me('boss'), async () => (require('../src/analysis/analysis') as typeof import('../src/analysis/analysis')).getStoredAnalysis(P, DID));
    const vis = ((await b.as('boss').call('visual:list', { projectId: P })).body as Any[]);
    const onBoard = (full?.sheets[0]?.cards ?? []).map((c: Any) => vis.find((v) => v.id === c.visualId));
    ok('approve: what was made is what the preview listed — its visuals by name, in order, on Orders', JSON.stringify(yes.body.creates) === JSON.stringify(pv.body.creates)
      && JSON.stringify(onBoard.map((v: Any) => v?.name)) === JSON.stringify(pv.body.creates.visuals) && onBoard.every((v: Any) => v?.datasetId === orders), show(onBoard));
    const placed = await b.pool.query<{ folder_id: string }>("SELECT folder_id::text FROM folder_items WHERE org_id = $1 AND project_id = $2 AND kind = 'dashboard' AND item_id = $3", [ORG, P, DID.toLowerCase()]);
    ok('approve: it landed in Ops, the folder of its data, and is published', placed.rows[0]?.folder_id === OPS && !!full?.published, show([placed.rows, !!full?.published]));
    const vb = await bell('viv');
    const mine = vb.requests.find((x) => x.id === R1);
    ok('approve: the requester is told — a bell row, approved, with the dashboard', !!mine && mine.mine === true && mine.state === 'approved' && mine.dashboardId === DID && mine.decidedBy === 'Lead' && mine.seen === false, show(vb.requests));
    ok('approve: …a push with no title, and an email with the link', pushesTo('viv', 'approved') === 1 && !pushes.filter((p) => p.user === at('viv')).some((p) => p.data.includes('Returns'))
      && mailsTo('viv') === 1 && fake.txns.length === mail1 + 1 && mailParts(fake.txns.at(-1)!.data).subject === msg.dashboardReady('Returns Q4')
      && mailParts(fake.txns.at(-1)!.data).text.includes(`https://bi.example.com/dashboards/${P}/${DID}`));
    const seenCopy = (await b.as('viv').call('analysis:open', { projectId: P, id: DID, published: true })).body;
    ok('approve: the requester opens its published copy, with both charts', seenCopy.ok === true && seenCopy.analysis.name === 'Returns Q4' && seenCopy.visuals.length === 2, show(seenCopy).slice(0, 200));
    const lb = (await bell('lead')).requests.find((x) => x.id === R1);
    ok('approve: the approvers\' row says it was approved, and is seen', lb?.state === 'approved' && lb.seen === true && lb.mine === false, show(lb));
    const again = await b.as('boss').call('request:approve', { projectId: P, id: R1, publish: true });
    ok('approve: a second approval makes nothing', again.body.ok === false && again.body.error === msg.alreadyDecided() && (await boards()).length === boards0 + 1, show(again.body));

    // Two approvals at once: one dashboard.
    const r3 = await ask('viv', [t1.turnId]);
    await settle();
    const before3 = (await boards()).length;
    const both = await Promise.all(['lead', 'boss'].map((w) => b.as(w).call('request:approve', { projectId: P, id: r3.body.id, publish: true })));
    ok('approve: two approvals at once make exactly one dashboard', both.filter((x) => x.body.ok === true).length === 1 && (await boards()).length === before3 + 1, show(both.map((x) => x.body)));

    // ── draft ─────────────────────────────────────────────────────────────
    const r4 = await ask('viv', [t2.turnId], { title: 'Averages' });
    await settle();
    const told4 = [pushesTo('viv'), await inbox('viv')];
    const draft = await b.as('lead').call('request:approve', { projectId: P, id: r4.body.id, publish: false });
    await settle();
    const drafted = await b.run(me('boss'), async () => (require('../src/analysis/analysis') as typeof import('../src/analysis/analysis')).getStoredAnalysis(P, draft.body.dashboardId));
    ok('draft: Edit makes the dashboard unpublished, and tells the requester nothing yet', draft.body.ok === true && draft.body.published === false && !!drafted && !drafted.published
      && JSON.stringify([pushesTo('viv'), await inbox('viv')]) === JSON.stringify(told4), show(draft.body));
    ok('draft: the requester cannot open it (control for the next line)', (await b.as('viv').call('analysis:open', { projectId: P, id: draft.body.dashboardId, published: true })).body.ok === false);
    const approvedPushes = pushesTo('viv', 'approved');
    const pub = await b.as('lead').call('analysis:publish', { projectId: P, id: draft.body.dashboardId });
    await settle();
    const row4 = (await bell('viv')).requests.find((x) => x.id === r4.body.id);
    ok('draft: its first Publish approves the request and tells the requester', pub.body.ok === true && row4?.state === 'approved' && row4.dashboardId === draft.body.dashboardId && pushesTo('viv', 'approved') === approvedPushes + 1, show(row4));

    // ── decline ───────────────────────────────────────────────────────────
    const r2 = await ask('viv', [tP.turnId], { title: 'Units' });
    await settle();
    ok('create: on Plain, in Everyone, both editors are told (the control for "an editor of Everyone only is not told")', (await inbox('ed', r2.body.id)) === 1 && (await inbox('ev', r2.body.id)) === 1);
    const pv2 = await b.as('ed').call('request:preview', { projectId: P, id: r2.body.id });
    ok('preview NEGATIVE CONTROL: on Plain, where no row rule holds the requester (the same rows as the reviewer), no line',
      pv2.body.ok === true && pv2.body.cards.length === 1 && pv2.body.cards[0].ok === true && !('fewerRows' in pv2.body.cards[0]), show(pv2.body.cards));
    const [boards2, visuals2] = [(await boards()).length, await visualsNow()];
    ok('decline: a note is required (400)', (await b.as('ed').call('request:decline', { projectId: P, id: r2.body.id, note: '' })).status === 400);
    const no = await b.as('ed').call('request:decline', { projectId: P, id: r2.body.id, note: 'We have this on the Units board already' });
    await settle();
    const row2 = (await bell('viv')).requests.find((x) => x.id === r2.body.id);
    ok('decline: nothing is made', no.body.ok === true && (await boards()).length === boards2 && (await visualsNow()) === visuals2, show(no.body));
    ok('decline: the requester is told, with the note', row2?.state === 'declined' && row2.answer === 'We have this on the Units board already' && pushesTo('viv', 'declined') === 1
      && mailParts(fake.txns.at(-1)!.data).subject === msg.requestDeclined('Units'), show(row2));
    ok('decline: an approval after it makes nothing', (await b.as('ed').call('request:approve', { projectId: P, id: r2.body.id, publish: true })).body.error === msg.alreadyDecided() && (await boards()).length === boards2);

    // ── dedupe ────────────────────────────────────────────────────────────
    const [rowsD, pushD] = [await reqRows(), pushes.length];
    const dup = await ask('viv', [t2.turnId, t1.turnId].reverse(), { title: 'Another name' });
    await settle();
    ok('dedupe: the same charts again the same day are "already sent", and write and tell nothing', dup.body.ok === true && dup.body.already === true && (await reqRows()) === rowsD && pushes.length === pushD, show(dup.body));

    // ── limit ─────────────────────────────────────────────────────────────
    await counters.take(ORG, [{ key: `request:from:${at('viv')}`, limit: requests.REQUESTS_PER_DAY, windowMs: 86_400_000 }], requests.REQUESTS_PER_DAY - 4); // four sent so far: the rest of the day used
    const rowsL = await reqRows();
    const over = await ask('viv', [t1.turnId, tP.turnId], { title: 'One too many' });
    ok(`limit: past ${requests.REQUESTS_PER_DAY} a day, refused in the catalog's words, writing nothing`, over.body.ok === false && over.body.code === 'rate_limited' && over.body.error === msg.tooManyRequests(requests.REQUESTS_PER_DAY) && (await reqRows()) === rowsL, show(over.body));
    ok('limit: a duplicate past the limit still answers "already sent"', (await ask('viv', [t1.turnId])).body.already === true);
    const vt = await rerun('vic', { ...PLAIN, datasetId: plain });
    const vicR = await b.as('vic').call('request:create', { projectId: P, threadId: vt.threadId, turnIds: [vt.turnId], title: 'Vic units' });
    await settle();
    ok('limit NEGATIVE CONTROL: another person still sends', vicR.body.ok === true && typeof vicR.body.id === 'string', show(vicR.body));
    const vicYes = await b.as('ed').call('request:approve', { projectId: P, id: vicR.body.id, publish: true });
    const vicPlaced = await b.pool.query("SELECT 1 FROM folder_items WHERE org_id = $1 AND kind = 'dashboard' AND item_id = $2", [ORG, String(vicYes.body.dashboardId).toLowerCase()]);
    ok('approve: a request on Plain lands in Everyone — no placement (the control for "it landed in Ops")', vicYes.body.ok === true && vicPlaced.rowCount === 0 && vicYes.body.creates.folder === msg.everyoneFolder(), show(vicYes.body));
    await counters.forgetForTest(ORG, 'request:from:'); // the day is over
    const next = await ask('viv', [t1.turnId, tP.turnId], { title: 'One too many' });
    ok('limit: the refused request was not marked sent — the next day, it goes', next.body.ok === true && !next.body.already, show(next.body));

    // ── seen ──────────────────────────────────────────────────────────────
    const lead0 = await bell('lead');
    const open = lead0.requests.find((x) => !x.seen);
    const meNow = (await (await fetch(`${b.base}/api/auth/me`, { headers: { 'x-forwarded-email': at('lead') } })).json()) as { mentionsUnseen?: number };
    ok('seen: the badge counts unseen requests (mentions:list and /api/auth/me alike)', !!open && lead0.unseen > 0 && meNow.mentionsUnseen === lead0.unseen, show([lead0.unseen, meNow.mentionsUnseen]));
    await b.as('lead').call('mentions:seen', { projectId: P, id: open!.id });
    const lead1 = await bell('lead');
    ok('seen: one row, by its ids', lead1.requests.find((x) => x.id === open!.id)?.seen === true && lead1.unseen === lead0.unseen - 1, show([lead0.unseen, lead1.unseen]));

    await more({ b, P, OPS, opsTeam, leadsTeam, orders, plain, thread, tP: tP.turnId, DID, pushes, sameFigures });

    // ── rls ───────────────────────────────────────────────────────────────
    const role = await ordinaryRole(b, ['dashboard_requests', 'dashboard_request_inbox']);
    try {
      for (const t of ['dashboard_requests', 'dashboard_request_inbox']) {
        ok(`rls ${t}: none with no org set, none of another org's, its own org's`,
          (await seenAs(role, t, null)).length === 0 && (await seenAs(role, t, 'globex')).length === 0 && (await seenAs(role, t, ORG)).length > 0);
      }
      ok('rls: a request for another org is refused (WITH CHECK)', await refusedAs(role, ORG, `INSERT INTO dashboard_requests (org_id, id, project_id, requester, title, charts) VALUES ('globex', $1, $2, 'y@globex.test', 't', '[{}]'::jsonb)`, [randomUUID(), P]));
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
    await withServer('requests', { SMTP_HOST: 'localhost', SMTP_PORT: String(fake.port), SMTP_USER: 'relay', SMTP_PASSWORD: 'relay-pw', SMTP_FROM: 'Acme Analytics <bi@acme.test>' }, (b) => suite(b, fake));
  } finally {
    await fake.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
