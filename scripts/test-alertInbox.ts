// Each member's own alert inbox (docs/notifications/00-design.md §5.2, §5.14),
// on Postgres with header sign-in (scripts/notifyHarness.ts).
//
//   own        A marks an event seen and B's stays unseen (control: A's count
//              drops); a viewer marks their own; a member with no grant is
//              refused (403); Mark all seen; the shared flag is never written
//   inherit    a member with no row starts from the shared flag; a first mark
//              keeps it (control: a shared-unseen event stays unseen)
//   late       an event stored after Mark all seen is unseen even when it was
//              evaluated before the click (control: one stored before is seen)
//   stamp      evaluateProject returns the stamped copies it stored; a
//              recordEvents batch is stamped in descending order, after the
//              newest stored event; rule.lastFiredAt keeps the evaluation's time
//   summary    the card in the app names what THAT member has not seen; a page
//              that leaves the app reads no one's inbox — two members with
//              different states get identical outbound sentences (control:
//              their in-app cards differ), and the outbound rule is not vacuous
//   rls        as an ordinary role: no rows without the setting, another org's
//              invisible, a write for another org refused, the store's own
//              statements pass (alert_inbox, alert_posts)
//   hiccup     the inbox store cannot answer: the bell and the Summary card still
//              work, on the shared flag, and the log says so
//   legacy     an imported event with an upper-case id or an unreadable time is
//              normalised on load, so a member can mark it seen (one and all)
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-alertInbox.js

export {}; // module scope
import { randomUUID } from 'crypto';
import { finish, ok } from './selfcheck';
import { BOSS, ORG, ordinaryRole, refusedAs, seenAs, show, withServer, type Bench, type Identity } from './notifyHarness';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const path: typeof import('path') = require('path');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const summary: typeof import('../src/ipc/summary') = require('../src/ipc/summary');
const inbox: typeof import('../src/server/alertInbox') = require('../src/server/alertInbox');
const orgDb: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');

const ANN: Identity = { user: { email: 'ann@acme.test', role: 'viewer' }, org: { id: ORG } };
const BEN: Identity = { user: { email: 'ben@acme.test', role: 'viewer' }, org: { id: ORG } };
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function event(datasetId: string, over: Partial<import('../src/analysis/alerts').AlertEvent> = {}): import('../src/analysis/alerts').AlertEvent {
  return {
    id: randomUUID(), ruleId: randomUUID(), ruleName: 'Revenue watch', datasetId, at: new Date().toISOString(),
    value: 5, previous: 4, delta: 1, deltaPct: 25, message: 'Revenue rose 25% to 5.', seen: false, ...over,
  };
}

async function suite(b: Bench): Promise<void> {
  await b.provision('ann', 'ben', 'nog');
  const pid: string = (await b.as('boss').call('projects:create', { name: 'Inbox' })).body.id;
  await b.share(pid, 'ann', 'viewer');
  await b.share(pid, 'ben', 'viewer');
  // A dataset that can be refreshed (a combination of two pasted ones), and a dashboard on it.
  const C = await b.run(BOSS, async () => {
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'n', type: 'number' as const }];
    const l = await datasets.saveDataset(pid, { name: 'North', sourceKind: 'paste', columns: cols, rows: [['north', 10]] });
    const r = await datasets.saveDataset(pid, { name: 'South', sourceKind: 'paste', columns: cols, rows: [['south', 20]] });
    return (await datasets.saveDataset(pid, { name: 'Both', sourceKind: 'combined', columns: cols, rows: [['north', 10]], origin: { kind: 'combined', leftId: l!.id, rightId: r!.id, mode: 'append' } }))!.id;
  });
  const board = await b.run(BOSS, () => analysis.saveAnalysis(pid, {
    name: 'Board', sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: C, column: 'n', aggregation: 'sum', label: 'N' } }] }],
  } as never));
  const refreshed = await b.as('boss').call('dataset:refresh', { projectId: pid, id: C });
  ok('setup: the combined dataset refreshes (it has a lastRefreshedAt for the outbound rule)', refreshed.body.ok === true, show(refreshed.body));

  // ── own / inherit ────────────────────────────────────────────────────
  const e1 = event(C, { seen: true, at: minutesAgo(3) }); // seen by everyone before 0020
  const e2 = event(C, { at: minutesAgo(2) });
  const e3 = event(C, { at: minutesAgo(1) });
  await b.run(BOSS, () => alertStore.recordEvents(pid, [e3, e2, e1]));
  const list = async (who: string) => (await b.as(who).call('alerts:list', { projectId: pid })).body as { unseen: number; events: Array<{ id: string; seen: boolean; at: string }> };
  const seenOf = async (who: string, id: string) => (await list(who)).events.find((e) => e.id === id)?.seen;
  ok('inherit: with no row, the shared flag decides — e1 seen, e2 and e3 not', (await list('ann')).unseen === 2 && (await seenOf('ann', e1.id)) === true && (await seenOf('ann', e2.id)) === false);
  const marked = await b.as('ann').call('alerts:markSeen', { projectId: pid, eventId: e2.id });
  ok('a viewer marks an event seen in their own inbox', marked.status === 200 && marked.body.ok === true, show(marked));
  ok('CONTROL: ann\'s count drops by one', (await list('ann')).unseen === 1);
  ok('ben\'s inbox is untouched by ann\'s click', (await list('ben')).unseen === 2 && (await seenOf('ben', e2.id)) === false);
  ok('inherit: ann\'s first mark kept what the shared flag had seen (e1)', (await seenOf('ann', e1.id)) === true);
  ok('inherit CONTROL: a shared-unseen event ann never marked stays unseen (e3)', (await seenOf('ann', e3.id)) === false);
  const shared = (await b.run(BOSS, () => alertStore.load(pid))).events;
  ok('the shared flag is never written with a database (e2 still unseen in the store)', shared.find((e) => e.id === e2.id)?.seen === false);
  const nog = await b.as('nog').call('alerts:markSeen', { projectId: pid, eventId: e3.id });
  ok('NEGATIVE CONTROL: a member with no grant on the project is refused before the handler', nog.status === 403, String(nog.status));
  await b.as('ben').call('alerts:markSeen', { projectId: pid, eventId: e3.id });
  ok('ben marks his own; ann still has e3 unseen', (await list('ben')).unseen === 1 && (await seenOf('ann', e3.id)) === false);

  // ── mark all, and the late event ─────────────────────────────────────
  await b.as('ann').call('alerts:markSeen', { projectId: pid });
  ok('mark all: ann has nothing unseen; ben is unchanged', (await list('ann')).unseen === 0 && (await list('ben')).unseen === 1);
  const late = event(C, { at: minutesAgo(30) }); // evaluated half an hour ago, stored only now
  await b.run(BOSS, () => alertStore.recordEvents(pid, [late]));
  ok('late: an event stored after Mark all seen is unseen even though it was evaluated before the click', (await seenOf('ann', late.id)) === false && (await list('ann')).unseen === 1);
  ok('late CONTROL: an event stored before the click stays seen', (await seenOf('ann', e3.id)) === true);

  // ── stamp ────────────────────────────────────────────────────────────
  const before = (await b.run(BOSS, () => alertStore.load(pid))).events;
  const newest = Math.max(...before.map((e) => Date.parse(e.at)));
  const x = event(C);
  const y = event(C);
  await b.run(BOSS, () => alertStore.recordEvents(pid, [x, y]));
  const after = (await b.run(BOSS, () => alertStore.load(pid))).events;
  const sx = after.find((e) => e.id === x.id)!;
  const sy = after.find((e) => e.id === y.id)!;
  ok('stamp: a recordEvents batch is stamped in descending order, after the newest stored event', Date.parse(sx.at) > Date.parse(sy.at) && Date.parse(sy.at) > newest && after[0].id === x.id, show([sx.at, sy.at, newest]));
  const rule = await b.run(BOSS, () => alertStore.saveRule(pid, { name: 'Any N', datasetId: C, metric: { column: 'n', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true }));
  const evalAt = Date.now() - 60_000;
  const fired = await b.run(BOSS, () => alertStore.evaluateProject(pid, C, evalAt));
  const stored = (await b.run(BOSS, () => alertStore.load(pid)));
  const st = stored.events.find((e) => e.id === fired[0]?.id);
  ok('stamp: evaluateProject returns the stamped copy it stored', fired.length === 1 && !!st && st.at === fired[0].at && Date.parse(st.at) > Date.parse(sx.at), show(fired));
  ok('stamp: the rule\'s lastFiredAt keeps the evaluation\'s own time', stored.rules.find((r) => r.id === rule!.id)?.lastFiredAt === new Date(evalAt).toISOString());

  // ── summary ──────────────────────────────────────────────────────────
  await b.as('ann').call('alerts:markSeen', { projectId: pid }); // ann has seen it all; ben has not
  const pages = (await b.run(BOSS, () => analysis.getAnalysis(pid, board!.id)))!.sheets;
  const card = async (who: string) => (await b.as(who).call('summary:compute', { projectId: pid, analysisId: board!.id, pages })).body as { ok: boolean; sentences: Array<{ kind: string; text: string }> };
  const annCard = await card('ann');
  const benCard = await card('ben');
  ok('summary: the card in the app names what THAT member has not seen — ben gets an alert sentence, ann none',
    annCard.ok && benCard.ok && !annCard.sentences.some((s) => s.kind === 'alert') && benCard.sentences.some((s) => s.kind === 'alert'), show([annCard, benCard]));
  const outbound = (who: Identity) => b.run(who, () => summary.computeSummary(pid, pages, { analysisId: board!.id, filters: [], params: new Map(), outbound: true }));
  const outAnn = await outbound(ANN);
  const outBen = await outbound(BEN);
  ok('summary: outbound reads no one\'s inbox — identical for two members with different states', JSON.stringify(outAnn) === JSON.stringify(outBen), show([outAnn, outBen]));
  ok('summary: …and is not vacuous — it names the alert that fired on the current data', outAnn.some((s) => s.kind === 'alert'), show(outAnn));
  await b.run(BOSS, () => alertStore.patchRule(pid, rule!.id, { enabled: false }));
  await b.as('boss').call('dataset:refresh', { projectId: pid, id: C });
  ok('summary: a refresh that fires nothing retires the alert from outbound pages', !(await outbound(ANN)).some((s) => s.kind === 'alert'));

  // ── a database hiccup ────────────────────────────────────────────────
  {
    const appPool = orgDb.orgDb();
    const { Pool } = require('pg') as typeof import('pg');
    const dead = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => undefined);
    orgDb.useOrgDb(dead);
    try {
      const bell = await b.as('ben').call('alerts:list', { projectId: pid });
      ok('hiccup: the inbox store cannot answer, and the bell still opens (on the shared flag)', bell.status === 200 && bell.body.ok === true && Array.isArray(bell.body.events), show(bell.body));
      const card = await b.as('ben').call('summary:compute', { projectId: pid, analysisId: board!.id, pages: (await b.run(BOSS, () => analysis.getAnalysis(pid, board!.id)))!.sheets });
      ok('hiccup: …and so does the Summary card', card.status === 200 && card.body.ok === true, show(card.body));
      ok('hiccup: …and the log says why', b.log.some((l) => l.includes('alert inbox not read')));
    } finally {
      orgDb.useOrgDb(appPool);
      await dead.end().catch(() => undefined);
    }
  }

  // ── legacy ───────────────────────────────────────────────────────────
  const UP = randomUUID().toUpperCase();
  const JUNK = randomUUID();
  const file = await b.run(BOSS, () => alertStore.load(pid));
  const legacy = { ...file, events: [{ ...event(C), id: UP }, { ...event(C), id: JUNK, at: 'last tuesday' }, ...file.events] };
  await b.run(BOSS, () => recordFs.writeFile(path.join(appPaths.userData(), 'projects', pid, 'alerts.json'), JSON.stringify(legacy), 'utf8'));
  const shown = (await list('ben')).events;
  ok('legacy: an upper-case id is listed lower-cased, an unreadable time as the epoch', shown.some((e) => e.id === UP.toLowerCase()) && shown.find((e) => e.id === JUNK)?.at === new Date(0).toISOString(), show(shown.slice(0, 3)));
  await b.as('ben').call('alerts:markSeen', { projectId: pid, eventId: UP.toLowerCase() });
  ok('legacy: the upper-case one, marked seen by the id the list gave, stays seen', (await seenOf('ben', UP.toLowerCase())) === true);
  await b.as('ben').call('alerts:markSeen', { projectId: pid });
  ok('legacy: Mark all seen covers the one with an unreadable time', (await seenOf('ben', JUNK)) === true && (await list('ben')).unseen === 0, show((await list('ben')).events.filter((e) => !e.seen)));
  ok('legacy (pure): sanitizeEvent keeps an id lower-case and a time canonical', alerts.sanitizeEvent({ ...event(C), id: UP, at: '2026-01-02T03:04:05Z' })?.id === UP.toLowerCase()
    && alerts.sanitizeEvent({ ...event(C), at: '2026-01-02T03:04:05Z' })?.at === '2026-01-02T03:04:05.000Z');

  // ── rls ──────────────────────────────────────────────────────────────
  await b.pool.query(`INSERT INTO orgs (id, name) VALUES ('globex', 'globex') ON CONFLICT DO NOTHING`);
  await b.pool.query(`INSERT INTO alert_inbox (org_id, user_email, project_id, seen_ids) VALUES ('globex', 'gina@globex.test', $1, '{}')`, [randomUUID()]);
  await b.pool.query(`INSERT INTO alert_posts (org_id, project_id, event_id) VALUES ('globex', $1, $2), ('acme', $1, $3)`, [randomUUID(), randomUUID(), randomUUID()]);
  const role = await ordinaryRole(b, ['alert_inbox', 'alert_posts']);
  try {
    for (const table of ['alert_inbox', 'alert_posts']) {
      const all = (await b.pool.query<{ org_id: string }>(`SELECT org_id FROM ${table}`)).rows;
      const acme = await seenAs(role, table, ORG);
      ok(`rls ${table}: as acme an ordinary role sees exactly acme's rows (not vacuous)`, acme.length >= 1 && acme.length === all.filter((r) => r.org_id === ORG).length && acme.every((r) => r.org_id === ORG), show([acme.length, all.length]));
      ok(`rls ${table}: with no setting, nothing`, (await seenAs(role, table, null)).length === 0);
      ok(`rls ${table}: as globex, none of acme's`, (await seenAs(role, table, 'globex')).every((r) => r.org_id === 'globex'));
    }
    ok('rls alert_inbox: a write for another org is refused (WITH CHECK)', await refusedAs(role, 'globex', `INSERT INTO alert_inbox (org_id, user_email, project_id) VALUES ('acme', 'x@acme.test', $1)`, [randomUUID()]));
    ok('rls alert_posts: a write for another org is refused (WITH CHECK)', await refusedAs(role, 'globex', `INSERT INTO alert_posts (org_id, project_id, event_id) VALUES ('acme', $1, $2)`, [randomUUID(), randomUUID()]));
    const appPool = orgDb.orgDb();
    orgDb.useOrgDb(role);
    try {
      const e = event(C);
      await b.run(BOSS, () => alertStore.recordEvents(pid, [e]));
      await b.run(BEN, async () => inbox.markSeenFor(pid, (await alertStore.load(pid)).events, e.id));
      const view = await b.run(BEN, () => inbox.seenView(pid));
      ok('rls: the inbox store\'s own statements pass as an ordinary role', view(e) === true);
    } finally {
      orgDb.useOrgDb(appPool);
    }
  } finally {
    await role.end();
  }
}

(async () => {
  await withServer('alertInbox', {}, suite);
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
