// The "Matched …" line (docs/assistant/00-design.md step 4 A, phase C): an answer turn's card says how it came to a
// verified question's chart — `verified.kind` 'matched' (asked word for word) or 'based_on' (the model drew an
// example it was shown) — with the verifier's name and the question AS VERIFIED. Worked out at every delivery
// (src/ipc/verifiedMark.ts), never stored. Through the real handlers; the model stubbed.
//
// File leg (no database), as an admin and a viewer:
//   1. Exact match (a phrasing, other case and punctuation) → matched, "Maria", the verified wording.
//   2. A model answer drawing an example's chart → based_on. NEGATIVE CONTROL: one drawing another chart, with that
//      example in its prompt, claims nothing; one drawing it without it among its examples gets the plain badge.
//   3. The viewer gets the name, as verified:list names the verifier to them; no verifier recorded → by ''.
//   4. The question deleted → reopened, no turn claims it. NEGATIVE CONTROL: restored, it is claimed again.
// Database leg (the index, real grants: scripts/rowPolicyHarness.ts), with DATABASE_URL:
//   5. The editor's exact match is matched; a hidden question (a West value filter, east's rows closed) is never named
//      to east, matched or based on. NEGATIVE CONTROL: the editor's same turn names it. Deleted → no line.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-matchedLine.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-matchedline-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const verifiedIpc: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');

type Role = import('../src/server/context').Identity['user']['role'];
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? String(v);
const COLS = [{ name: 'region', type: 'text' as const }, { name: 'segment', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
const ROWS = [['West', 'SMB', 10], ['East', 'Ent', 20], ['West', 'Ent', 5]];

/** The model's next answer: a chart of `category`, by name, as an answer action carries it. */
let drawBy = 'region';
(execConfig as { executionReady: unknown }).executionReady = async () => true;
(analyze as { askCopilot: unknown }).askCopilot = async () => ({
  ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'amount', spec: { dataset: 'Orders', category: drawBy, measures: [{ column: 'amount', aggregation: 'sum' }] } },
});

let req = 0;
const as = <T>(who: string, role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${who}@acme.test`, role }, org: { id: 'acme' } }, `m${++req}`, fn);

async function fileLeg(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  copilotIpc.register();
  verifiedIpc.register();
  const role = (who: string): Role => (who === 'vic' ? 'viewer' : 'admin');
  const call = (who: string, ch: string, payload: object): Promise<any> => as(who, role(who), () => handlers.get(ch)!({}, payload)); // any: each handler's reply
  const { P, D } = await as('maria', 'admin', async () => {
    await projects.init();
    const P = (await projects.createProject('Matched'))!.id;
    return { P, D: (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows: ROWS as never }))!.id };
  });
  const SPEC = { datasetId: D, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'x' };
  const saved = await call('maria', 'verified:save', { projectId: P, input: { question: 'Revenue by region', phrasings: ['sales per region'], spec: SPEC } });
  const V: string = saved.question?.id ?? '';
  if (!V) throw new Error('fixture: ' + show(saved));
  const ask = async (who: string, question: string, threadId?: string) => {
    const r = await call(who, 'copilot:ask', { projectId: P, context: { kind: 'dataset', id: D }, question, ...(threadId ? { threadId } : {}) });
    return { r, turn: r.turns?.at(-1), mark: r.turns?.at(-1)?.card?.verified };
  };

  // 1. Exact match.
  const m = await ask('maria', 'SALES per region?!');
  ok('1. exact match: matched, the verifier by name, the question as verified (not as asked)', m.r.ok && m.r.guidance?.verifiedId === V
    && show(m.mark) === show({ id: V, question: 'Revenue by region', by: 'Maria', at: saved.question.verifiedAt, kind: 'matched' }), show(m.mark));

  // 2. Model answers.
  const T = m.r.threadId;
  drawBy = 'region';
  const b = await ask('maria', 'how much per region', T);
  ok('2. a model answer drawing the example\'s chart: based_on', b.r.ok && b.r.guidance?.examples?.includes(V) && b.r.guidance.verifiedId === undefined
    && b.mark?.kind === 'based_on' && b.mark.by === 'Maria' && b.mark.question === 'Revenue by region', show([b.r.guidance, b.mark]));
  drawBy = 'segment';
  const n = await ask('maria', 'how much per segment', T);
  ok('2. NEGATIVE CONTROL: the example in its prompt, another chart drawn: no line, no badge', n.r.ok && n.r.guidance?.examples?.includes(V) && !!n.turn?.card && n.mark === undefined, show([n.r.guidance, n.mark]));
  drawBy = 'region';
  const plain = await as('maria', 'admin', async () => copilot.appendTurn(P, { role: 'assistant', text: '', answer: SPEC as never, guidance: { instructions: 0, examples: [] } }, T));
  const plainId = plain?.at(-1)?.id ?? '';
  const pr = await call('maria', 'answer:refresh', { projectId: P, threadId: T, turnId: plainId });
  ok('2. NEGATIVE CONTROL: its chart, but not among its examples: the plain badge, no kind', pr.ok && pr.verified?.id === V && !('kind' in pr.verified), show(pr.verified));

  // 3. Viewers, and no verifier recorded.
  const listed = (await call('vic', 'verified:list', { projectId: P })).questions.find((q: { id: string }) => q.id === V);
  const vm = await ask('vic', 'Revenue by region');
  ok('3. a viewer gets the name: verified:list names the verifier to them already', listed?.verifiedBy === 'maria@acme.test' && vm.mark?.kind === 'matched' && vm.mark.by === 'Maria', show([listed?.verifiedBy, vm.mark]));
  const W = { ...SPEC, category: 'segment' };
  const anon = await call('maria', 'verified:save', { projectId: P, input: { question: 'Revenue by segment', spec: W } });
  await as('maria', 'admin', async () => { await store.writeVerified(P, { ...(await store.getVerified(P, anon.question.id))!, verifiedBy: '' }); });
  const am = await ask('vic', 'revenue by segment');
  ok('3. no verifier recorded: matched, by \'\' (the card reads "a verified question")', am.mark?.kind === 'matched' && am.mark.by === '' && am.mark.question === 'Revenue by segment', show(am.mark));

  // 4. Deleted since: reopened, nothing claims it.
  const history = async () => (await call('maria', 'copilot:history', { projectId: P, threadId: T })).turns.filter((t: { card?: unknown }) => t.card);
  const before = (await history()).map((t: any) => t.card.verified?.kind ?? null); // any: a turn as wired
  await as('maria', 'admin', () => trash.trashRecord(P, 'verified', V));
  const after = (await history()).map((t: any) => t.card.verified ?? null);
  // The third drew segments: "Revenue by segment" (3.) badges it, unclaimed; the fourth is the plain badge of 2.
  ok('4. deleted: a reopened conversation claims it nowhere', show(before) === show(['matched', 'based_on', null, null])
    && after.every((v: { id?: string } | null) => v?.id !== V) && show(after.map((v: { kind?: string } | null) => v?.kind ?? null)) === show([null, null, null, null]), show([before, after]));
  ok('4. …and the matched turn still says it was a verified match (Not what I asked follows that, not the line)',
    (await history())[0].guidance?.verifiedId === V && !(await history())[1].guidance?.verifiedId);
  await as('maria', 'admin', () => trash.restore(P, 'verified', V));
  ok('4. NEGATIVE CONTROL: restored, it is claimed again', show((await history()).map((t: any) => t.card.verified?.kind ?? null)) === show(before));
}

async function dbLeg(): Promise<void> {
  if (process.env.DATABASE_URL) handlers.clear(); // the world registers every handler itself
  const W = await H.world('the matched line on rows');
  if (!W) return;
  try {
    const { P, orders } = W;
    const must = (r: H.Reply, what: string): any => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`fixture: ${what} ${r.text.slice(0, 300)}`); return r.body; }; // any: a reply
    const SPEC = { datasetId: orders, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'x' };
    const WEST = { ...SPEC, filters: [{ column: 'customer', op: '=', value: `${H.W_CANARY}_1` }] };
    const open = must(await W.call('boss', 'verified:save', { projectId: P, input: { question: 'Sales by region', spec: SPEC } }), 'open').question.id as string;
    const hidden = must(await W.call('boss', 'verified:save', { projectId: P, input: { question: 'West customers', spec: WEST } }), 'hidden').question.id as string;
    const ask = async (who: string, question: string) => (await W.call(who, 'copilot:ask', { projectId: P, context: { kind: 'dataset', id: orders }, question })).body;
    const e = await ask('ed', 'sales BY region');
    ok('5. rows: the editor\'s exact match is matched, by the verifier\'s name', e?.ok && e.turns.at(-1).card?.verified?.kind === 'matched' && e.turns.at(-1).card.verified.by === 'Boss', show(e?.turns?.at(-1)?.card?.verified));
    // A turn claiming the hidden question every way, as each of them: east's refresh never names it.
    const claim = async (who: string) => {
      const t = (await W.call(who, 'copilot:newThread', { projectId: P })).body.thread.id as string;
      const turns = await W.as(who, () => copilot.appendTurn(P, { role: 'assistant', text: '', answer: WEST as never, guidance: { verifiedId: hidden, instructions: 0, examples: [hidden] } }, t));
      return (await W.call(who, 'answer:refresh', { projectId: P, threadId: t, turnId: turns!.at(-1)!.id })).body;
    };
    const east = await claim('east');
    ok('5. a hidden question is never named to east: no line, no badge, no wording', east?.ok === true && east.verified === undefined && !JSON.stringify(east).includes('West customers'), show(east?.verified));
    ok('5. NEGATIVE CONTROL: the editor\'s same turn names it', (await claim('ed'))?.verified?.kind === 'matched');
    must(await W.call('boss', 'verified:delete', { projectId: P, id: open }), 'delete');
    const h = (await W.call('ed', 'copilot:history', { projectId: P, threadId: e.threadId })).body;
    ok('5. rows: deleted, the reopened turn claims nothing', h.turns.filter((t: { card?: { verified?: unknown } }) => t.card).every((t: { card: { verified?: unknown } }) => t.card.verified === undefined)
      && h.turns.some((t: { card?: unknown }) => t.card), show(h.turns.map((t: { card?: { verified?: unknown } }) => t.card?.verified)));
  } finally {
    await W.close();
  }
}

(async () => {
  await fileLeg();
  await dbLeg();
})()
  .catch((e) => ok('the matched line suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
