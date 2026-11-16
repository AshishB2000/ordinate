// The rest of E9 (docs/team-folders/00-design.md "Dashboard requests, as built"), run by
// scripts/test-dashboardRequests.ts on its bench after its own sections — a helper, not a suite. Ops (team Ops: view;
// team Ops leads: edit) holds Orders and the approved dashboard "Returns Q4"; Everyone holds Plain.
//
//   withdraw   the requester's bell lists their open request (seen); they take it back: withdrawn, nothing made, the
//              approvers' rows go and their tabs are told; NEGATIVE CONTROLS: another viewer or an approver cannot,
//              nor while an approval holds it, and another request's rows stand; asked again, not "already sent"; audited
//   target     an existing dashboard: its approvers need Edit on its folder (NEGATIVE CONTROL: the editors of Everyone
//              only, who approve Plain alone, are not told, and are refused); approving adds a sheet to its draft and
//              publishes it, no new dashboard; a draft with unpublished edits is not published (the editor is told
//              why) until its next Publish; a dashboard the requester cannot open (a draft) or none is refused
//   folders    the requester is offered the folders they open (NEGATIVE CONTROL: the lead's own list has Finance); a
//              closed one is refused `closed`; the reviewer sees the suggestion and lands there by default, may pick
//              another choice, and a folder the requester cannot open is refused even to the org admin
//   answers    an SQL answer and a source table's answer are refused, each in its own sentence (control: a chart goes)
//   live       a chart on a Live dataset: the review's figures are the warehouse's through the door (Object.is), and
//              approving makes its visual and dashboard; NEGATIVE CONTROL: the warehouse down, nothing is made
//   cap        past OPEN_PER_PROJECT open in a project, refused typed (control: another person sends); withdrawing one
//              lets the same request go
//   delete     deleting a project drops its requests and their bell rows (control: another project's stay)

import { randomUUID } from 'crypto';
import { ok } from './selfcheck';
import { ORG, show, type Bench, type Identity } from './notifyHarness';

const requests: typeof import('../src/server/requests/requests') = require('../src/server/requests/requests');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const msg: typeof import('../src/server/requestMessages') = require('../src/server/requestMessages');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const analysisMod: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

type Any = any; // any: each channel's own reply, read field by field
const at = (who: string): string => (who.includes('@') ? who : `${who}@acme.test`);
const me = (who: string): Identity => ({ user: { email: at(who), role: who === 'boss' ? 'admin' : 'viewer' }, org: { id: ORG } });
const SALES = { category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Sales by region' };

export interface Shared {
  b: Bench;
  P: string;
  OPS: string;
  opsTeam: string;
  leadsTeam: string;
  orders: string;
  plain: string;
  thread: string;
  /** The viewer's chart answers on Plain. */
  tP: string;
  /** The approved, published "Returns Q4", in Ops. */
  DID: string;
  pushes: Array<{ user?: string; channel: string; data: string }>;
  sameFigures: (a: Any, b: Any) => boolean;
}

export async function more(s: Shared): Promise<void> {
  const { b, P, OPS, orders, plain, thread, pushes } = s;
  const newDay = () => counters.forgetForTest(ORG, 'request:'); // each section sends as on a day of its own
  const settle = () => requests.requestsSettled();
  let n = 0;
  /** A new chart answer of the viewer's on Orders, in their conversation: a set of charts not asked for yet. */
  const fresh = async (w = 'viv', threadId = thread, spec: object = { ...SALES, datasetId: orders }): Promise<string> => {
    const r = await b.as(w).call('answer:rerun', { projectId: P, threadId, spec: { ...spec, title: `Chart ${++n}` } });
    if (r.status !== 200 || !r.body.ok) throw new Error(`rerun: ${show(r.body)}`);
    return r.body.turns.at(-1).id;
  };
  const ask = (w: string, turnIds: string[], extra: object = {}) => b.as(w).call('request:create', { projectId: P, threadId: thread, turnIds, title: 'More', ...extra });
  const rowsOf = async (id: string) => (await b.pool.query<{ user_email: string; role: string; seen: boolean }>(
    'SELECT user_email, role, seen_at IS NOT NULL AS seen FROM dashboard_request_inbox WHERE org_id = $1 AND request_id = $2 ORDER BY user_email', [ORG, id])).rows;
  const approversOf = async (id: string) => (await rowsOf(id)).filter((r) => r.role === 'approver').map((r) => r.user_email).join();
  const row = async (id: string) => (await b.pool.query<{ state: string; title: string; target_id: string | null; decided_by: string | null }>(
    'SELECT state, title, target_id::text, decided_by FROM dashboard_requests WHERE org_id = $1 AND id = $2', [ORG, id])).rows[0];
  const reqCount = async () => Number((await b.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dashboard_requests')).rows[0].n);
  const boards = async () => ((await b.as('boss').call('analysis:gallery', { projectId: P })).body as Any[]).length;
  const visualsNow = async () => ((await b.as('boss').call('visual:list', { projectId: P })).body as Any[]).length;
  const stored = (id: string) => b.run(me('boss'), () => analysisMod.getStoredAnalysis(P, id));
  const placed = async (id: string) => (await b.pool.query<{ folder_id: string }>("SELECT folder_id::text FROM folder_items WHERE org_id = $1 AND kind = 'dashboard' AND item_id = $2", [ORG, id.toLowerCase()])).rows[0]?.folder_id ?? null;
  const refusal = (r: { status: number; text: string }): Any => { try { return { status: r.status, ...JSON.parse(r.text) }; } catch { return { status: r.status }; } };
  const pushed = (w: string, state: string) => pushes.filter((p) => p.channel === 'requests:changed' && p.user === at(w) && JSON.parse(p.data).state === state);

  // ── withdraw ──────────────────────────────────────────────────────────
  await newDay();
  const wt = await fresh();
  const w1 = await ask('viv', [wt], { title: 'Take it back' });
  const w2 = await ask('viv', [await fresh()], { title: 'Keep this one' });
  await settle();
  const W: string = w1.body.id;
  ok('withdraw: (two open requests, each in the approvers\' bells)', w1.body.ok === true && w2.body.ok === true && (await approversOf(W)) === `${at('boss')},${at('lead')}` && (await approversOf(w2.body.id)) === `${at('boss')},${at('lead')}`, show([w1.body, w2.body]));
  const mine = ((await b.as('viv').call('mentions:list')).body.requests as Any[]).find((x) => x.id === W);
  ok('withdraw: the requester\'s bell lists their open request, already seen (no badge)', mine?.mine === true && mine.state === 'open' && mine.seen === true, show(mine));
  const [boards0, visuals0] = [await boards(), await visualsNow()];
  const [vicW, leadW] = await Promise.all(['vic', 'lead'].map((w) => b.as(w).call('request:withdraw', { projectId: P, id: W })));
  ok('withdraw NEGATIVE CONTROL: another viewer, or an approver, cannot — in the words for a missing one — and it stays open',
    vicW.body.error === msg.requestGone() && leadW.body.error === msg.requestGone() && (await row(W)).state === 'open', show([vicW.body, leadW.body]));
  await b.pool.query('UPDATE dashboard_requests SET decided_by = $3, decided_at = now() WHERE org_id = $1 AND id = $2', [ORG, W, at('lead')]); // an approval under way
  const held = await b.as('viv').call('request:withdraw', { projectId: P, id: W });
  ok('withdraw NEGATIVE CONTROL: not while an approval holds it', held.body.error === msg.beingApproved() && (await row(W)).state === 'open', show(held.body));
  await b.pool.query('UPDATE dashboard_requests SET decided_by = NULL, decided_at = NULL WHERE org_id = $1 AND id = $2', [ORG, W]);
  const gone = await b.as('viv').call('request:withdraw', { projectId: P, id: W });
  await settle();
  ok('withdraw: the requester takes it back — withdrawn, and nothing is made', gone.body.ok === true && (await row(W)).state === 'withdrawn' && (await boards()) === boards0 && (await visualsNow()) === visuals0, show(gone.body));
  const told = [...pushed('lead', 'withdrawn'), ...pushed('boss', 'withdrawn')];
  ok('withdraw: the approvers\' bell rows go, and their tabs are told — the state, never the title', (await approversOf(W)) === '' && (await rowsOf(W)).length === 1
    && told.length === 2 && told.every((p) => JSON.parse(p.data).id === W && !p.data.includes('Take it back')), show([await rowsOf(W), told]));
  ok('withdraw NEGATIVE CONTROL: the other open request\'s rows stand', (await approversOf(w2.body.id)) === `${at('boss')},${at('lead')}`);
  const late = [await b.as('lead').call('request:approve', { projectId: P, id: W, publish: true }), await b.as('viv').call('request:withdraw', { projectId: P, id: W })];
  ok('withdraw: an approval or a second withdrawal after it makes nothing', late.every((r) => r.body.error === msg.alreadyDecided()) && (await boards()) === boards0, show(late.map((r) => r.body)));
  const anew = await ask('viv', [wt], { title: 'Take it back' });
  ok('withdraw: asking for the same charts again is a new request, not "already sent"', anew.body.ok === true && !anew.body.already && anew.body.id !== W, show(anew.body));
  const wpv = await b.as('lead').call('request:preview', { projectId: P, id: W });
  ok('withdraw: its review page says so, with nothing to approve', wpv.body.ok === true && wpv.body.request.state === 'withdrawn' && wpv.body.request.decidedBy === 'Viv' && wpv.body.creates === null, show(wpv.body));
  const trail = await b.pool.query<{ actor: string }>(`SELECT actor FROM audit_log WHERE channel = 'request:withdraw' ORDER BY id DESC LIMIT 1`);
  ok('withdraw: audited, as the requester', trail.rows[0]?.actor === at('viv'), show(trail.rows));

  // ── target ────────────────────────────────────────────────────────────
  await newDay();
  const sheets0 = (await stored(s.DID))!.sheets.length;
  const onto = await ask('viv', [s.tP], { dashboardId: s.DID, title: 'Ignored' });
  await settle();
  const O: string = onto.body.id;
  ok('target: the request names the dashboard, by its name', onto.body.ok === true && (await row(O)).title === 'Returns Q4' && (await row(O)).target_id === s.DID.toLowerCase(), show(onto.body));
  ok('target: its approvers need Edit on the dashboard\'s folder as well — the admin and the Ops lead; NEGATIVE CONTROL: the editors of Everyone only, who approve Plain alone, are not told',
    (await approversOf(O)) === `${at('boss')},${at('lead')}`, await approversOf(O));
  const opv = await b.as('lead').call('request:preview', { projectId: P, id: O });
  ok('target: the review says the charts go onto it, on a sheet of their own, in Ops, and Approve and publish publishes it', opv.body.ok === true && opv.body.creates.dashboard === 'Returns Q4'
    && opv.body.creates.folder === 'Ops' && opv.body.creates.onto?.sheet === msg.requestedBySheet('Viv') && opv.body.creates.onto.publishes === true && opv.body.choices.length === 0, show(opv.body.creates));
  const [edO, evO] = await Promise.all(['ed', 'ev'].map(async (w) => refusal(await b.as(w).call('request:approve', { projectId: P, id: O, publish: true }))));
  ok('target: an editor of Plain who cannot open the dashboard is refused `closed`, one who views Ops `edit`', edO.reason === 'closed' && evO.reason === 'edit', show([edO, evO]));
  const boards1 = await boards();
  const yes = await b.as('lead').call('request:approve', { projectId: P, id: O, publish: true });
  await settle();
  const after = await stored(s.DID);
  ok('target: approving adds the charts to its draft as one new sheet, makes no dashboard, and publishes it', yes.body.ok === true && yes.body.dashboardId === s.DID && yes.body.published === true
    && (await boards()) === boards1 && after?.sheets.length === sheets0 + 1 && after.sheets.at(-1)?.name === msg.requestedBySheet('Viv') && after.sheets.at(-1)?.cards.length === 1
    && after.published?.sheets.length === sheets0 + 1, show(yes.body));
  const copy = (await b.as('viv').call('analysis:open', { projectId: P, id: s.DID, published: true })).body;
  const toldO = ((await b.as('viv').call('mentions:list')).body.requests as Any[]).find((x) => x.id === O);
  ok('target: the requester reads the new sheet in the published copy, and is told', copy.ok === true && copy.analysis.sheets.length === sheets0 + 1 && toldO?.state === 'approved' && toldO.dashboardId === s.DID && toldO.seen === false, show(toldO));
  const edit = await b.as('lead').call('analysis:update', { projectId: P, id: s.DID, name: 'Returns Q4, in progress' });
  ok('target: (the Ops lead edits its draft and does not publish)', edit.body.ok === true && edit.body.status === 'edited', show(edit.body).slice(0, 200));
  const onto2 = await ask('viv', [await fresh()], { dashboardId: s.DID });
  await settle();
  const opv2 = await b.as('lead').call('request:preview', { projectId: P, id: onto2.body.id });
  ok('target: the review says Approve and publish will not publish a draft with unpublished edits', opv2.body.creates?.onto?.publishes === false, show(opv2.body.creates));
  const yes2 = await b.as('lead').call('request:approve', { projectId: P, id: onto2.body.id, publish: true });
  await settle();
  const after2 = await stored(s.DID);
  ok('target: …approving adds the charts to the draft, publishes nothing, and says why (NEGATIVE CONTROL: above, a draft without edits was published)', yes2.body.ok === true && yes2.body.published === false
    && yes2.body.why === msg.draftHadEdits() && after2?.sheets.length === sheets0 + 2 && after2.published?.sheets.length === sheets0 + 1 && (await row(onto2.body.id)).state === 'drafted', show(yes2.body));
  const pub = await b.as('lead').call('analysis:publish', { projectId: P, id: s.DID });
  await settle();
  ok('target: its next Publish approves the request and tells the requester', pub.body.ok === true && (await row(onto2.body.id)).state === 'approved' && pushed('viv', 'approved').some((p) => JSON.parse(p.data).id === onto2.body.id));
  const draftOnly: string = (await b.as('boss').call('analysis:create', { projectId: P, name: 'Unpublished' })).body.id;
  const rowsT = await reqCount();
  const [toDraft, toNone] = [await ask('viv', [s.tP], { dashboardId: draftOnly }), await ask('viv', [s.tP], { dashboardId: randomUUID() })];
  ok('target: a dashboard the requester cannot open (a draft) or none is refused in the same words, writing nothing (control: the published one went)',
    toDraft.body.error === msg.dashboardGone() && toNone.body.error === msg.dashboardGone() && (await reqCount()) === rowsT, show([toDraft.body, toNone.body]));
  ok('contract: an existing dashboard and a folder at once is refused (400)', (await ask('viv', [s.tP], { dashboardId: s.DID, folderId: OPS })).status === 400);

  // ── folders ───────────────────────────────────────────────────────────
  await newDay();
  const [SHARED, FIN] = [randomUUID(), randomUUID()];
  await b.pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $6), ($1, $2, $5, NULL, $7, $6)', [ORG, P, SHARED, 'Shared', FIN, at('boss'), 'Finance']);
  await b.pool.query("INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, 'view'), ($1, $2, $3, $5, 'edit'), ($1, $2, $6, $5, 'edit')", [ORG, P, SHARED, s.opsTeam, s.leadsTeam, FIN]);
  const names = (list: Any[]): string => list.map((f) => f.name).join();
  const [vf, lf] = await Promise.all(['viv', 'lead'].map(async (w) => (await b.as(w).call('request:folders', { projectId: P })).body));
  ok('folders: the requester is offered the folders they open — Everyone, Ops, Shared; NEGATIVE CONTROL: the Ops lead\'s own list has Finance too',
    vf.ok === true && names(vf.folders) === [msg.everyoneFolder(), 'Ops', 'Shared'].join() && names(lf.folders) === [msg.everyoneFolder(), 'Finance', 'Ops', 'Shared'].join(), show([vf, lf]));
  const rowsF = await reqCount();
  const fin = refusal(await ask('viv', [await fresh()], { folderId: FIN }));
  ok('folders: suggesting a folder the requester cannot open is refused `closed`, naming nothing and writing nothing', fin.status === 409 && fin.reason === 'closed' && !JSON.stringify(fin).includes('Finance') && (await reqCount()) === rowsF, show(fin));
  const sug = await ask('viv', [await fresh()], { folderId: SHARED, title: 'Suggested' });
  await settle();
  const spv = await b.as('lead').call('request:preview', { projectId: P, id: sug.body.id });
  ok('folders: the reviewer sees the suggestion, and approving lands it there by default (its data is in Ops)', spv.body.suggested === 'Shared' && spv.body.creates.folderId === SHARED && spv.body.creates.folder === 'Shared', show([spv.body.suggested, spv.body.creates]));
  ok('folders: the reviewer\'s choices are those they edit that the requester opens; NEGATIVE CONTROL: not Finance, which the reviewer edits', names(spv.body.choices) === [msg.everyoneFolder(), 'Ops', 'Shared'].join(), show(spv.body.choices));
  const boardsF = await boards();
  const bossFin = await b.as('boss').call('request:approve', { projectId: P, id: sug.body.id, publish: true, folderId: FIN });
  ok('folders: a folder the requester cannot open is refused, even to the org admin; nothing is made, nothing claimed', bossFin.body.error === msg.folderNotOffered('Viv') && (await boards()) === boardsF
    && (await row(sug.body.id)).state === 'open' && (await row(sug.body.id)).decided_by === null, show(bossFin.body));
  const sYes = await b.as('lead').call('request:approve', { projectId: P, id: sug.body.id, publish: true });
  ok('folders: approved as it stands, it lands in the suggested folder', sYes.body.ok === true && (await placed(sYes.body.dashboardId)) === SHARED, show(sYes.body));
  const pick = await ask('viv', [await fresh()], { folderId: SHARED, title: 'Picked' });
  await settle();
  const pYes = await b.as('lead').call('request:approve', { projectId: P, id: pick.body.id, publish: true, folderId: P });
  ok('folders: the reviewer picks another of the choices — Everyone — and it lands there', pYes.body.ok === true && (await placed(pYes.body.dashboardId)) === null && pYes.body.creates.folder === msg.everyoneFolder(), show(pYes.body));

  // ── answers ───────────────────────────────────────────────────────────
  await newDay();
  const append = (turn: object) => b.run(me('viv'), async () => (await copilot.appendTurn(P, { role: 'assistant', text: 'An answer.', ...turn } as never, thread))!.at(-1)!.id);
  const sqlTurn = await append({ sql: { text: 'SELECT region, sum(amount) FROM "Orders" GROUP BY 1', datasetIds: [orders], title: 'Orders in SQL' } });
  const tableTurn = await append({ answer: { ...SALES, datasetId: randomUUID(), table: randomUUID(), title: 'Warehouse sales' } });
  const chart = await fresh();
  const rowsA = await reqCount();
  const [sq, tb] = [await ask('viv', [chart, sqlTurn]), await ask('viv', [chart, tableTurn])];
  ok('answers: an SQL answer is refused in its own sentence, writing nothing', sq.body.ok === false && sq.body.error === msg.sqlNotAChart() && (await reqCount()) === rowsA, show(sq.body));
  ok('answers: a source table\'s answer is refused: an editor must keep the table first', tb.body.ok === false && tb.body.error === msg.keepTableFirst() && (await reqCount()) === rowsA, show(tb.body));
  ok('answers NEGATIVE CONTROL: the chart answer beside them goes', (await ask('viv', [chart])).body.ok === true);

  // ── live ──────────────────────────────────────────────────────────────
  fakeMod.registerLiveFake();
  const cols = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
  const live = await b.run(me('boss'), async () => {
    await fakeMod.loadWarehouseTable('req_live_sales', cols, [['North', 70001.13], ['South', 55555.55], ['East', 31337.71]]);
    const conn = await connections.saveConnection(P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    return (await liveRecord.saveLiveRecord(P, { name: 'Sales (live)', columns: cols, origin: { kind: 'connection', connId: conn!.id, table: 'req_live_sales' } }))!.id;
  });
  const LIVE = { ...SALES, datasetId: live, title: 'Live sales by region' };
  const lr = await ask('viv', [await fresh('viv', thread, LIVE)], { title: 'Live board' });
  await settle();
  ok('live: a chart answer on a Live dataset is requested as one on an extract', lr.body.ok === true, show(lr.body));
  queryCache.clear();
  fakeMod.resetFake();
  const lpv = await b.as('ed').call('request:preview', { projectId: P, id: lr.body.id });
  const ldoor = await b.run(me('ed'), () => answers.computeCard(P, { ...LIVE, title: lpv.body.cards?.[0]?.title } as never));
  ok('live: the review\'s figures are the warehouse\'s, through the door as the reviewer, Object.is', fakeMod.fake.calls.length > 0 && lpv.body.cards?.[0]?.ok === true && 'card' in ldoor && s.sameFigures(lpv.body.cards[0], ldoor.card), show(lpv.body.cards));
  queryCache.clear();
  fakeMod.fake.hook = async () => ({ ok: false, error: 'warehouse down' });
  const boardsL = await boards();
  const down = await b.as('ed').call('request:approve', { projectId: P, id: lr.body.id, publish: true });
  fakeMod.fake.hook = null;
  ok('live NEGATIVE CONTROL: the warehouse down, the chart cannot be drawn and nothing is made', down.body.ok === false && (await boards()) === boardsL && (await row(lr.body.id)).state === 'open', show(down.body));
  const lYes = await b.as('ed').call('request:approve', { projectId: P, id: lr.body.id, publish: true });
  const lv = ((await b.as('boss').call('visual:list', { projectId: P })).body as Any[]).filter((v) => v.datasetId === live);
  const lCopy = (await b.as('viv').call('analysis:open', { projectId: P, id: lYes.body.dashboardId, published: true })).body;
  ok('live: approved, its visual reads the Live dataset, and the requester opens the published dashboard', lYes.body.ok === true && lYes.body.published === true && lv.length === 1 && lCopy.ok === true, show(lYes.body));

  // ── cap ───────────────────────────────────────────────────────────────
  await newDay();
  const openNow = Number((await b.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM dashboard_requests WHERE org_id = $1 AND project_id = $2 AND requester = $3 AND state = 'open'", [ORG, P, at('viv')])).rows[0].n);
  await b.pool.query("INSERT INTO dashboard_requests (org_id, id, project_id, requester, title, charts) SELECT $1, gen_random_uuid(), $2, $3, 'Waiting', '[{}]'::jsonb FROM generate_series(1, $4)", [ORG, P, at('viv'), requests.OPEN_PER_PROJECT - openNow]);
  const capped = await fresh();
  const rowsC = await reqCount();
  const over = await ask('viv', [capped], { title: 'One more' });
  ok(`cap: past ${requests.OPEN_PER_PROJECT} open in a project, refused, typed, in the catalog's words, writing nothing`, over.body.ok === false && over.body.code === 'too_many_open'
    && over.body.error === msg.tooManyOpen(requests.OPEN_PER_PROJECT) && (await reqCount()) === rowsC, show(over.body));
  const vicTurn = await b.as('vic').call('answer:rerun', { projectId: P, spec: { category: 'kind', measures: [{ column: 'n', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Vic, again', datasetId: plain } });
  const vicGo = await b.as('vic').call('request:create', { projectId: P, threadId: vicTurn.body.threadId, turnIds: [vicTurn.body.turns.at(-1).id], title: 'Vic again' });
  ok('cap NEGATIVE CONTROL: another person in the project still sends — the cap is per person', vicGo.body.ok === true && typeof vicGo.body.id === 'string', show(vicGo.body));
  await b.as('viv').call('request:withdraw', { projectId: P, id: w2.body.id });
  const again = await ask('viv', [capped], { title: 'One more' });
  ok('cap: once one is withdrawn the same request goes — the refused one was given back, not "already sent"', again.body.ok === true && !again.body.already, show(again.body));
  await settle();

  // ── delete ────────────────────────────────────────────────────────────
  const Q: string = (await b.as('boss').call('projects:create', { name: 'Doomed' })).body.id;
  const QR = randomUUID();
  await b.pool.query("INSERT INTO dashboard_requests (org_id, id, project_id, requester, title, charts) VALUES ($1, $2, $3, $4, 'Doomed', '[{}]'::jsonb)", [ORG, QR, Q, at('viv')]);
  await b.pool.query("INSERT INTO dashboard_request_inbox (org_id, user_email, request_id, project_id, role) VALUES ($1, $2, $3, $4, 'approver')", [ORG, at('lead'), QR, Q]);
  const counts = async (pid: string) => (await b.pool.query<{ r: string; i: string }>(
    'SELECT (SELECT count(*) FROM dashboard_requests WHERE project_id = $1)::text AS r, (SELECT count(*) FROM dashboard_request_inbox WHERE project_id = $1)::text AS i', [pid])).rows[0];
  const keep = await counts(P);
  const del = await b.as('boss').call('projects:delete', { id: Q });
  const left = await counts(Q);
  ok('delete: deleting a project drops its dashboard requests and their bell rows', del.body?.ok === true && left.r === '0' && left.i === '0', show([del.body, left]));
  ok('delete NEGATIVE CONTROL: another project\'s stay', JSON.stringify(await counts(P)) === JSON.stringify(keep) && Number(keep.r) > 0 && Number(keep.i) > 0, show(keep));
}
