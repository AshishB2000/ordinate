// Answers keep the figures they had (docs/assistant/00-design.md, "Scale rules"): an answer turn stores its card as
// computed (src/ai/answerSnapshot.ts), a conversation brings it back only while the caller's access holds
// (src/ipc/answerSnapshots.ts), and Refresh computes it again. Through the real handlers; the model stubbed.
//
// File leg (copilot.json, no database), as an admin and a viewer:
//   1. An answer keeps its card: the stored card is Object.is-equal, leaf by leaf, to `answer:card` on the same spec.
//   2. REOPEN runs no figure query (spied: the answer door `withLockOf`, `getDataset`, the Live door) and returns the
//      stored figures. NEGATIVE CONTROL: with the snapshot removed, the card the conversation lacks is computed.
//   3. An answer from `copilot:ask` keeps its card too.
//   4. ACCESS: a column hidden from the viewer since → the history carries no stored figure (its canary never in the
//      reply), Refresh computes it under the new access, says the access changed, and replaces the snapshot.
//      NEGATIVE CONTROL: an answer on a dataset whose access held still comes back.
//   5. A dataset deleted since → no stored figure in the reply; Refresh says it is gone.
//   6. REFRESH replaces the snapshot and keeps firstAsked; another member's Refresh of the same ids is refused and
//      changes nothing.
//   7. An answer stored before snapshots gets one on its first open, dated then (never backdated); a card past 64 KB
//      keeps none and is "Live" on every open.
//   8. A relative period keeps its days: "Yesterday" asked on Nov 1 still reads Oct 31 on Nov 15, with the same
//      figures; Refresh moves it to Nov 14.
//   9. The file store keeps the field; an over-cap or corrupt snapshot is dropped on read and on write, never fatal.
// Database leg (the rows, the real RPC route, real grants: scripts/rowPolicyHarness.ts), with DATABASE_URL:
//  10. The turn's body keeps it; a corrupt one is dropped, the turn kept.
//  11. ACCESS: a row access rule added since → east's history carries no stored figure (no West in it), Refresh is
//      Object.is-equal to east's card now and says why. NEGATIVE CONTROL: the editor's answer, access unchanged, comes back.
//  12. Refresh is the owner's: east cannot refresh the editor's turn.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-answerSnapshots.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshots-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const snap: typeof import('../src/ai/answerSnapshot') = require('../src/ai/answerSnapshot');
const msgs: typeof import('../src/ai/answerSnapshotMessages') = require('../src/ai/answerSnapshotMessages');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const rowDoors: Record<string, unknown> = require('../src/ipc/rowDoors');
const liveAnswers: Record<string, unknown> = require('../src/ipc/liveAnswers');

type Role = import('../src/server/context').Identity['user']['role'];
type Turn = { id: string; role: string; answer?: { datasetId: string }; card?: any; snapshot?: unknown; createdAt: string }; // any: the card as wired

// ── figure spies: every computeCard enters `withLockOf`; a hydration is `getDataset`; a Live answer is `liveCardFor` ──
const figures = { doors: 0, rows: 0, live: 0 };
const spy = (mod: Record<string, unknown>, name: string, key: keyof typeof figures): void => {
  const real = mod[name] as (...a: unknown[]) => unknown;
  mod[name] = (...a: unknown[]) => { figures[key]++; return real(...a); };
};
spy(rowDoors, 'withLockOf', 'doors');
spy(datasets as unknown as Record<string, unknown>, 'getDataset', 'rows');
spy(liveAnswers, 'liveCardFor', 'live');
const counted = async <T>(fn: () => Promise<T>): Promise<{ out: T; n: number }> => {
  const before = figures.doors + figures.rows + figures.live;
  const out = await fn();
  return { out, n: figures.doors + figures.rows + figures.live - before };
};

function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
/** A card's computed part: without what is worked out at every delivery and what the conversation says of it. */
const figuresOf = (c: any): unknown => { // any: a card reply
  const { learn: _l, savedVisualId: _s, verified: _v, snapshot: _k, ...rest } = c ?? {};
  return rest;
};
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? String(v);
const answerTurns = (turns: Turn[]): Turn[] => turns.filter((t) => t.role === 'assistant' && t.answer);

const CANARY = 'KEPT_CANARY_42';
const COLS = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'secret', type: 'text' as const }];
const ROWS = [[CANARY, 10, '2026-10-31', 's1'], ['East', 20, '2026-10-31', 's2'], [CANARY, 5, '2026-11-14', 's3'], ['East', 7, '2026-11-14', 's4'], ['North', -0, '2026-10-30', 's5']];
const spec = (datasetId: string, extra: object = {}) => ({ datasetId, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region', ...extra });

// ── the file leg ────────────────────────────────────────────────────────
let req = 0;
const as = <T>(who: string, role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${who}@acme.test`, role }, org: { id: 'acme' } }, `s${++req}`, fn);

async function fileLeg(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  copilotIpc.register();
  const ADMIN = 'ana', VIEWER = 'vic', OTHER = 'ola';
  const role = (who: string): Role => (who === VIEWER ? 'viewer' : 'admin');
  const call = (who: string, ch: string, payload: object): Promise<any> => as(who, role(who), () => handlers.get(ch)!({}, payload)); // any: each handler's reply
  const { P, orders, hidden, gone, big } = await as(ADMIN, 'admin', async () => {
    await projects.init();
    const P = (await projects.createProject('Snapshots'))!.id;
    const mk = async (name: string, rows: unknown[][] = ROWS, cols = COLS) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols, rows: rows as never }))!.id;
    const many = Array.from({ length: 60 }, (_, i) => [`label_${String(i).padStart(3, '0')}_${'x'.repeat(1500)}`, i]); // an answer draws 50 at most: long ones
    return { P, orders: await mk('Orders'), hidden: await mk('Payroll'), gone: await mk('Scratch'), big: await mk('Wide', many, [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }]) };
  });
  const thread = async (who: string): Promise<string> => (await call(who, 'copilot:newThread', { projectId: P })).thread.id;
  const rerun = async (who: string, tid: string, s: object): Promise<Turn> => {
    const r = await call(who, 'answer:rerun', { projectId: P, threadId: tid, spec: s });
    if (!r.ok) throw new Error('fixture: rerun ' + show(r));
    return r.turns.at(-1);
  };
  const history = (who: string, tid: string) => call(who, 'copilot:history', { projectId: P, threadId: tid });
  const refresh = (who: string, tid: string, turnId: string) => call(who, 'answer:refresh', { projectId: P, threadId: tid, turnId });
  /** Reopening as the web does: the conversation, then a refresh for each answer it brought no card for. */
  const reopen = async (who: string, tid: string) => {
    const h = await history(who, tid);
    const drawn: any[] = []; // any: card replies
    for (const t of answerTurns(h.turns)) drawn.push(t.card ?? (await refresh(who, tid, t.id)));
    return { h, drawn };
  };

  // 1. An answer keeps its card, the very one `answer:card` draws.
  const T1 = await thread(ADMIN);
  const a1 = await rerun(ADMIN, T1, spec(orders));
  const fresh = await call(ADMIN, 'answer:card', { projectId: P, spec: spec(orders) });
  ok('1. the reply\'s answer turn carries its card, kept now', !!a1.card?.snapshot?.asOf && a1.card.snapshot.firstAsked === undefined, show(a1.card?.snapshot));
  ok('1. DIFFERENTIAL: the kept card is Object.is-equal, leaf by leaf, to answer:card on the same spec', fresh.ok && sameLeaves(figuresOf(a1.card), figuresOf(fresh)), show([a1.card?.data, fresh.data]));
  ok('1. no reply carries a snapshot itself', !JSON.stringify(a1).includes('"access"') && !('snapshot' in a1));

  // 2. Reopening runs no figure query and returns the stored figures.
  const r2 = await counted(() => reopen(ADMIN, T1));
  ok('2. reopen: 0 figure queries (answer door, hydration, Live door)', r2.n === 0, `${r2.n}`);
  ok('2. …and the stored figures, as stored', sameLeaves(figuresOf(r2.out.drawn[0]), figuresOf(a1.card)));
  await as(ADMIN, 'admin', () => copilot.setSnapshot(P, T1, a1.id, a1.answer as never, null));
  const r2b = await counted(() => reopen(ADMIN, T1));
  ok('2. NEGATIVE CONTROL: with the snapshot removed, the card is computed (1 answer door) and kept again', r2b.n >= 1 && !r2b.out.h.turns.at(-1).card && !!r2b.out.drawn[0].snapshot?.asOf, `${r2b.n} ${show(r2b.out.drawn[0].snapshot)}`);
  ok('2. …and the next open runs none', (await counted(() => reopen(ADMIN, T1))).n === 0);

  // 3. copilot:ask keeps its card too (the model stubbed: one answer action).
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async () => ({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'amount by region', spec: { dataset: 'Orders', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }] } } });
  const T3 = await thread(ADMIN);
  const asked = await call(ADMIN, 'copilot:ask', { projectId: P, threadId: T3, context: { kind: 'dataset', id: orders }, question: 'amount by region' });
  ok('3. an asked answer carries its kept card', asked.ok && !!asked.turns.at(-1)?.card?.snapshot?.asOf, show(asked).slice(0, 300));
  ok('3. …and reopening it runs no figure query', (await counted(() => reopen(ADMIN, T3))).n === 0);

  // 4. Access: a column hidden from the viewer since.
  const TV = await thread(VIEWER);
  const v1 = await rerun(VIEWER, TV, spec(hidden));
  const TV2 = await thread(VIEWER);
  const v2 = await rerun(VIEWER, TV2, spec(orders));
  ok('4. the viewer\'s answer kept its card, the canary in it', v1.card?.snapshot?.asOf && JSON.stringify(v1.card.data).includes(CANARY));
  await as(ADMIN, 'admin', () => rec.serialized(rec.datasetFilePath(P, hidden), (raw) => {
    raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'secret', visibleTo: [{ teamId: '99999999-9999-4999-8999-999999999999' }] }], 'ana@acme.test', new Date().toISOString());
    return true;
  }));
  const h4 = await history(VIEWER, TV);
  const t4 = answerTurns(h4.turns)[0];
  ok('4. ACCESS CHANGED: the history carries no stored figure — no card, the canary nowhere in the reply', h4.ok && !t4.card && !JSON.stringify(h4).includes(CANARY), show(h4));
  const f4 = await refresh(VIEWER, TV, t4.id);
  const now4 = await call(VIEWER, 'answer:card', { projectId: P, spec: spec(hidden) });
  ok('4. Refresh computes it under the new access and says why', f4.ok && f4.snapshot?.accessChanged === true && sameLeaves(figuresOf(f4), figuresOf(now4)), show(f4.snapshot));
  ok('4. …and replaces the snapshot: the next open brings it back, no notice', !!answerTurns((await history(VIEWER, TV)).turns)[0].card && !answerTurns((await history(VIEWER, TV)).turns)[0].card.snapshot.accessChanged);
  ok('4. NEGATIVE CONTROL: on a dataset whose access held, the viewer\'s kept card comes back', sameLeaves(figuresOf(answerTurns((await history(VIEWER, TV2)).turns)[0].card), figuresOf(v2.card)));

  // 5. A dataset deleted since.
  const T5 = await thread(ADMIN);
  const g5 = await rerun(ADMIN, T5, spec(gone));
  await as(ADMIN, 'admin', () => datasets.deleteDataset(P, gone));
  const h5 = await history(ADMIN, T5);
  ok('5. DATASET GONE: no card, no stored figure in the reply', !answerTurns(h5.turns)[0].card && !JSON.stringify(h5).includes(CANARY), show(h5));
  const f5 = await refresh(ADMIN, T5, g5.id);
  ok('5. …and Refresh says it is gone', f5.ok === false && f5.reason === 'The dataset this answer was built on no longer exists.', show(f5));

  // 6. Refresh replaces the snapshot, keeps firstAsked; another member cannot.
  const before = answerTurns((await history(ADMIN, T3)).turns)[0];
  await new Promise((r) => setTimeout(r, 20));
  const f6 = await refresh(ADMIN, T3, before.id);
  const after = answerTurns((await history(ADMIN, T3)).turns)[0];
  ok('6. Refresh: a new asOf, the same firstAsked (the turn\'s createdAt)', f6.ok && after.card.snapshot.asOf > before.card.snapshot.asOf && after.card.snapshot.asOf === f6.snapshot.asOf
    && (await as(ADMIN, 'admin', () => copilot.findTurn(P, T3, before.id)))?.snapshot?.firstAsked === before.createdAt, show([before.card.snapshot, after.card.snapshot]));
  const theirs = await refresh(OTHER, T3, before.id);
  ok('6. another member refreshing the owner\'s ids is refused', theirs.ok === false && theirs.reason === msgs.answerNotThere(), show(theirs));
  ok('6. …and the owner\'s snapshot is unchanged', answerTurns((await history(ADMIN, T3)).turns)[0].card.snapshot.asOf === after.card.snapshot.asOf);

  // 7. An answer from before snapshots; a card past the cap.
  const T7 = await thread(ADMIN);
  await as(ADMIN, 'admin', async () => {
    await copilot.appendTurn(P, { role: 'user', text: 'amount by region' }, T7);
    await copilot.appendTurn(P, { role: 'assistant', text: '', answer: spec(orders) as never }, T7);
  });
  const old = answerTurns((await history(ADMIN, T7)).turns)[0];
  const t0 = Date.now();
  const f7 = await refresh(ADMIN, T7, old.id);
  ok('7. an older answer brings no card, and its first open keeps one dated then, never backdated', !old.card && f7.ok && Date.parse(f7.snapshot.asOf) >= t0 - 5 && Date.parse(f7.snapshot.asOf) <= Date.now(), show(f7.snapshot));
  ok('7. …which the next open brings', !!answerTurns((await history(ADMIN, T7)).turns)[0].card);
  const T7b = await thread(ADMIN);
  const w = await rerun(ADMIN, T7b, spec(big));
  const stored = await as(ADMIN, 'admin', () => copilot.findTurn(P, T7b, w.id));
  ok('7. a card past 64 KB keeps none', !w.card && !stored?.snapshot && JSON.stringify((await call(ADMIN, 'answer:card', { projectId: P, spec: spec(big) })).data).length > snap.SNAPSHOT_MAX_BYTES);
  const f7b = await refresh(ADMIN, T7b, w.id);
  ok('7. …and is computed on each open, labelled Live (asOf null)', f7b.ok && f7b.snapshot.asOf === null && !(await as(ADMIN, 'admin', () => copilot.findTurn(P, T7b, w.id)))?.snapshot, show(f7b.snapshot));

  // 8. A relative period keeps its days.
  process.env.ORDINATE_TODAY = '2026-11-01';
  const T8 = await thread(ADMIN);
  const y = await rerun(ADMIN, T8, spec(orders, { filters: [{ column: 'day', period: 'yesterday' }] }));
  process.env.ORDINATE_TODAY = '2026-11-15';
  const y2 = answerTurns((await history(ADMIN, T8)).turns)[0].card;
  ok('8. "Yesterday" asked Nov 1 keeps Oct 31 on Nov 15, figures and all', show(y2.snapshot.periods) === show([{ name: 'Yesterday', from: '2026-10-31', to: '2026-10-31' }]) && sameLeaves(figuresOf(y2), figuresOf(y.card)), show(y2.snapshot));
  const y3 = await refresh(ADMIN, T8, y.id);
  ok('8. …Refresh resolves it today: Nov 14, other figures', show(y3.snapshot.periods) === show([{ name: 'Yesterday', from: '2026-11-14', to: '2026-11-14' }]) && !sameLeaves(y3.data, y.card.data), show([y3.snapshot, y3.data]));
  delete process.env.ORDINATE_TODAY;

  // 9. The file store keeps, caps and drops the field.
  const raw = await as(ADMIN, 'admin', async () => JSON.parse(await fs.promises.readFile(copilot.copilotFilePath(P), 'utf8')));
  ok('9. copilot.json keeps the snapshot on the turn', JSON.stringify(raw).includes('"snapshot"') && JSON.stringify(raw).includes('"access"'));
  const good = await as(ADMIN, 'admin', async () => (await copilot.findTurn(P, T1, a1.id))!.snapshot!);
  const BAD = [
    ['an over-cap card', { ...good, card: { ok: true, data: { labels: ['x'.repeat(snap.SNAPSHOT_MAX_BYTES)], series: [] } } }],
    ['a forged access', { ...good, access: 'not-a-hash' }],
    ['a card that is no card', { ...good, card: { ok: false } }],
    ['a malformed wire tag', { ...good, card: { $: 'nope' } }],
    ['no time', { ...good, asOf: 'yesterday-ish' }],
    ['a period that is not one', { ...good, periods: [{ name: 'x', from: 'soon', to: 'later' }] }],
  ] as const;
  for (const [what, s] of BAD) {
    const turns = copilot.normalizeTurns([{ id: 'x', role: 'assistant', text: '', createdAt: good.asOf, answer: spec(orders), snapshot: s }]);
    ok(`9. on read, ${what} is dropped, the turn kept`, turns.length === 1 && !!turns[0].answer && turns[0].snapshot === undefined);
  }
  ok('9. NEGATIVE CONTROL: the good one is kept on read', copilot.normalizeTurns([{ id: 'x', role: 'assistant', text: '', createdAt: good.asOf, answer: spec(orders), snapshot: good }])[0].snapshot?.access === good.access);
  const T9 = await thread(ADMIN);
  await as(ADMIN, 'admin', () => copilot.appendTurn(P, { role: 'assistant', text: '', answer: spec(orders) as never, snapshot: BAD[0][1] as never }, T9));
  ok('9. on write, an over-cap snapshot is not stored', !(await as(ADMIN, 'admin', () => copilot.loadHistory(P, T9)))[0].snapshot);
  const odd = snap.makeSnapshot({ ok: true, data: { labels: ['a', 'b', 'c'], series: [{ name: 's', values: [-0, NaN, Infinity] }] } }, { asOf: good.asOf, firstAsked: good.asOf }, good.access, []);
  const back = odd && (snap.cardOf(JSON.parse(JSON.stringify(odd))) as { data: { series: { values: number[] }[] } } | null);
  ok('9. a -0, a NaN and an Infinity survive the JSON a turn is stored as (wire-encoded)', !!back && [-0, NaN, Infinity].every((v, i) => Object.is(back.data.series[0].values[i], v)));
  ok('9. makeSnapshot: a card past the cap is none', snap.makeSnapshot({ ok: true, data: { labels: ['y'.repeat(snap.SNAPSHOT_MAX_BYTES)], series: [] } }, { asOf: good.asOf, firstAsked: good.asOf }, good.access, []) === null);
}

// ── the database leg ────────────────────────────────────────────────────
async function dbLeg(): Promise<void> {
  if (process.env.DATABASE_URL) handlers.clear(); // the world registers every handler itself; the file leg registered the Assistant's
  const W = await H.world('the answer snapshots on rows');
  if (!W) return;
  try {
    const { P, plain } = W;
    const must = (r: H.Reply, what: string): any => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`fixture: ${what} ${r.text.slice(0, 300)}`); return r.body; }; // any: a reply
    const thread = async (who: string) => must(await W.call(who, 'copilot:newThread', { projectId: P }), 'thread').thread.id as string;
    const byRegion = spec(plain, { measures: [{ column: 'sales', aggregation: 'sum' }] });
    const [TE, TD] = [await thread('east'), await thread('ed')];
    const e1 = must(await W.call('east', 'answer:rerun', { projectId: P, threadId: TE, spec: byRegion }), 'east rerun').turns.at(-1);
    const d1 = must(await W.call('ed', 'answer:rerun', { projectId: P, threadId: TD, spec: byRegion }), 'ed rerun').turns.at(-1);
    ok('10. rows: an answer keeps its card, West among its labels', !!e1.card?.snapshot?.asOf && e1.card.data.labels.includes('West'), show(e1.card?.data));
    const body = (await W.pool.query<{ body: string }>('SELECT body FROM assistant_turns WHERE id = $1', [e1.id])).rows[0]?.body ?? '';
    ok('10. …in the turn\'s body', JSON.parse(body).snapshot?.access?.length === 64);
    const reopened = await counted(() => W.call('east', 'copilot:history', { projectId: P, threadId: TE }));
    ok('10. reopening runs no figure query and brings the stored figures', reopened.n === 0 && sameLeaves(figuresOf(answerTurns(reopened.out.body.turns)[0].card), figuresOf(e1.card)), `${reopened.n}`);

    // 12 first, while both are kept: the owner's only.
    const theirs = await W.call('east', 'answer:refresh', { projectId: P, threadId: TD, turnId: d1.id });
    ok('12. east refreshing the editor\'s turn is refused, nothing written', theirs.body?.ok === false && theirs.body.reason === msgs.answerNotThere()
      && (await W.pool.query<{ body: string }>('SELECT body FROM assistant_turns WHERE id = $1', [d1.id])).rows[0].body.includes(d1.card.snapshot.asOf), theirs.text.slice(0, 200));

    // 11. A row access rule on Plain since: team East → East.
    must(await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: plain, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } }), 'rules');
    const h11 = await W.call('east', 'copilot:history', { projectId: P, threadId: TE });
    ok('11. ACCESS CHANGED: east\'s history carries no stored figure — no card, no West', h11.status === 200 && !answerTurns(h11.body.turns)[0].card && !h11.text.includes('West'), h11.text.slice(0, 300));
    const f11 = await W.call('east', 'answer:refresh', { projectId: P, threadId: TE, turnId: e1.id });
    const now11 = await W.call('east', 'answer:card', { projectId: P, spec: byRegion });
    ok('11. Refresh: east\'s card now, Object.is-equal to answer:card, and says the access changed', f11.body?.ok && f11.body.snapshot?.accessChanged === true && sameLeaves(figuresOf(f11.body), figuresOf(now11.body)) && !f11.text.includes('West'), f11.text.slice(0, 300));
    const dh = await W.call('ed', 'copilot:history', { projectId: P, threadId: TD });
    ok('11. NEGATIVE CONTROL: the editor\'s access is unchanged, so their kept card (West in it) comes back', sameLeaves(figuresOf(answerTurns(dh.body.turns)[0].card), figuresOf(d1.card)) && dh.text.includes('West'));

    await W.pool.query('UPDATE assistant_turns SET body = $2 WHERE id = $1', [d1.id, JSON.stringify({ ...JSON.parse(body), snapshot: { card: { $: 'broken' }, asOf: 'x' } })]);
    const hc = await W.call('ed', 'copilot:history', { projectId: P, threadId: TD });
    ok('10. a corrupt snapshot in the body is dropped: the turn is there, with its spec and no card', hc.status === 200 && answerTurns(hc.body.turns).length === 1 && !answerTurns(hc.body.turns)[0].card, hc.text.slice(0, 200));
  } finally {
    await W.close();
  }
}

(async () => {
  await fileLeg();
  await dbLeg();
})()
  .catch((e) => ok('the answer snapshot suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
