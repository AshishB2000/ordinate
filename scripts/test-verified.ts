// Verified questions (semantic layer part 3 D5, D7, D9): a question with its checked answer SPEC, never a
// figure — real modules, the real RPC route in server mode (dev sign-in) over a temp DATA_DIR.
//
//   § record   one line, the spec without `matched`, its title the question; the key squashes; a clash is
//              found across phrasings; a term or a period is no value filter; sanitizing is idempotent;
//              Trash round-trips under the question; a stale base refuses; a corrupt file is skipped; a restore
//              whose key a live question holds is refused (NEGATIVE CONTROL: no clash restores); two saves of one
//              question at once: one lands
//   § retired  (part 4, cross-part check item 8) a question on a retired metric still runs (verifiedProblem
//              null), its card is marked and its notes say what replaces the metric. NEGATIVE CONTROL: certified,
//              no retired note.
//   § metric   a question on a metric that is redefined, given a filter, or deleted no longer runs and marks nothing.
//              NEGATIVE CONTROL: put back as it was, it runs (and § retired: a retired one still runs).
// What a row-restricted viewer reads of a verified question is pinned in scripts/test-rowPolicySafetyNet.ts.
//
//   npm run build:ts && node scripts/test-verified.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-verified-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const R: typeof import('../src/analysis/verifiedRules') = require('../src/analysis/verifiedRules');
const S: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const recordKinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');

type Identity = import('../src/server/context').Identity;
const TEST_USER = 'ana@acme.test';
const ADMIN: Identity = { user: { email: TEST_USER, role: 'admin' }, org: { id: 'acme' } };
const COLUMNS = [
  { name: 'region', type: 'text' as const }, { name: 'segment', type: 'text' as const },
  { name: 'amount', type: 'number' as const }, { name: 'order_date', type: 'date' as const },
];
const ROWS = [['West', 'SMB', 10, '2026-01-05'], ['East', 'SMB', 20, '2026-02-05'], ['West', 'Ent', 5, '2026-03-05'], ['North', 'Ent', 1, '2026-04-05']];
const T = '2026-11-05T00:00:00.000Z';
const V = '5f0c2d1e-1111-4222-8333-444455556666';
const TERM = '7d2c1f4e-1111-4222-8333-444455556666';

const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
  const call = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'verified', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

  const { P, D } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Verified')).id;
    const d = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    if (!d) throw new Error('fixture not saved');
    return { P, D: d.id };
  });
  const SPEC = { datasetId: D, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'x' };

  // ── § record ──────────────────────────────────────────────────────────────
  const raw = {
    id: V, projectId: P, question: ' Revenue by\nregion ', phrasings: ['revenue per region', 'Revenue  by region!', ''],
    spec: { ...SPEC, matched: [{ column: 'region', said: 'west', value: 'West' }] },
    verifiedBy: 'a', verifiedAt: T, createdAt: T, updatedAt: T, schemaVersion: 1,
  };
  const q = R.sanitizeVerified(raw);
  if (!q) throw new Error('not sanitized');
  ok('one line, spec without matched, title is the question', q.question === 'Revenue by region' && !('matched' in q.spec) && q.spec.title === 'Revenue by region', JSON.stringify(q));
  ok('a phrasing with the question\'s own key, or none, is dropped', q.phrasings.join('|') === 'revenue per region', q.phrasings.join('|'));
  ok('sanitizing twice is sanitizing once', JSON.stringify(R.sanitizeVerified(R.sanitizeVerified(raw))) === JSON.stringify(q));
  ok('NEGATIVE CONTROL: no spec, no question, no id is no record', R.sanitizeVerified({ ...raw, spec: { datasetId: 'nope' } }) === null
    && R.sanitizeVerified({ ...raw, question: '  ' }) === null && R.sanitizeVerified({ ...raw, id: 'x' }) === null);
  ok('the key squashes', R.questionKey('Revenue by region?') === R.questionKey('revenue  BY region'));
  ok('a clash is found across phrasings', R.keyClash([q], ['Revenue per region!']) === 'Revenue per region!');
  ok('NEGATIVE CONTROL: no clash with itself, or with another question', R.keyClash([q], ['Revenue per region'], V) === null && R.keyClash([q], ['Revenue by segment']) === null);
  ok('a term or a period is no value filter', !R.hasValueFilter({ ...q.spec, filters: [{ term: TERM }, { column: 'order_date', period: 'last_quarter' }, { column: 'region', op: 'not_empty' }] })
    && R.hasValueFilter({ ...q.spec, filters: [{ column: 'region', op: '=', value: 'West' }] }));

  await as(async () => {
    await S.writeVerified(P, q);
    ok('stored and read back', (await S.getVerified(P, V))?.question === 'Revenue by region' && (await S.listVerified(P)).length === 1);
    const del = await trash.trashRecord(P, 'verified', V);
    const listed = (await trash.list(P)).some((e) => e.type === 'verified' && e.id === V && e.name === 'Revenue by region');
    const goneNow = (await S.getVerified(P, V)) === null && (await S.listVerified(P)).length === 0;
    const back = await trash.restore(P, 'verified', V);
    ok('Trash: delete → listed under its question → restore', del.ok && del.name === 'Revenue by region' && listed && goneNow && back.ok
      && back.restored[0]?.name === 'Revenue by region' && (await S.getVerified(P, V))?.question === 'Revenue by region', JSON.stringify({ del, listed, goneNow, back }));
    const stale = await caught(() => S.writeVerified(P, { ...q, note: 'x' }, 'stale'));
    ok('a stale base refuses (409 record_changed)', editConflict.isRecordChanged(stale), String(stale));
    const read = await S.readVerified(P, V);
    const moved = await S.writeVerified(P, { ...q, note: 'net of refunds' }, read?.tag);
    ok('NEGATIVE CONTROL: the open tag saves, and the record keeps when it was made', moved?.note === 'net of refunds' && moved.createdAt === T);
    const dir = path.join(recordKinds.projectDir(P), recordKinds.RECORD_DIR.verified);
    await recordFs.writeFile(path.join(dir, '00000000-0000-4000-8000-000000000001.json'), '{ not json', 'utf8');
    ok('a corrupt file is skipped', (await S.listVerified(P)).length === 1);
  });

  // ── § runs: worked out from metadata on each read, never repaired ─────────
  const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
  const VS: typeof import('../src/ipc/verifiedState') = require('../src/ipc/verifiedState');
  const msg: typeof import('../src/analysis/verifiedMessages') = require('../src/analysis/verifiedMessages');
  const reimport = (cols: typeof COLUMNS, drop?: string) => as(() => datasets.updateDatasetData(P, D, {
    columns: cols.filter((c) => c.name !== drop), rows: ROWS.map((r) => r.filter((_, i) => cols[i].name !== drop)),
  }));
  const hydrates = async (fn: () => Promise<unknown>): Promise<boolean> => {
    let n = 0;
    const real = datasets.getDataset;
    (datasets as any).getDataset = async (...a: unknown[]) => { n += 1; return (real as any)(...a); }; // any: the spy passes the call through
    try { await fn(); } finally { (datasets as any).getDataset = real; } // any: as above
    return n > 0;
  };
  await as(async () => {
    const problem = async (x: typeof q) => VS.verifiedProblem(x, await VS.verifiedEnv(P));
    ok('a working question has no problem', (await problem(q)) === null);
    await reimport(COLUMNS, 'region');
    ok('a dropped column: no longer runs, with the reason', (await problem(q)) === msg.verifiedColumnGone('region', 'Orders'), String(await problem(q)));
    ok('never repaired: the stored spec still names it', (await S.getVerified(P, V))?.spec.category === 'region');
    await reimport(COLUMNS);
    ok('restored, it runs again', (await problem(q)) === null);
    await reimport(COLUMNS.map((c) => (c.name === 'amount' ? { ...c, type: 'text' as const } : c)));
    ok('a column its measure no longer fits: the validator\'s reason', (await problem(q)) === '"amount" is text, so it cannot be summed.', String(await problem(q)));
    await reimport(COLUMNS);
    const term = await terms.saveTerm(P, { name: 'Small business', datasetId: D, filters: [{ type: 'filter', column: 'segment', op: '=', value: 'SMB' }] });
    if (!term) throw new Error('no term');
    const qTerm = { ...q, id: '5f0c2d1e-2222-4222-8333-444455556666', question: 'SMB revenue by region', spec: { ...q.spec, filters: [{ term: term.id }] } };
    ok('NEGATIVE CONTROL: with its term, it runs', (await problem(qTerm)) === null);
    await trash.trashRecord(P, 'term', term.id);
    ok('a deleted term: no longer runs', (await problem(qTerm)) === msg.verifiedTermGone());
    ok('a deleted dataset: no longer runs', (await problem({ ...q, spec: { ...q.spec, datasetId: '00000000-0000-4000-8000-000000000002' } })) === msg.verifiedDatasetGone());
    let states: Awaited<ReturnType<typeof VS.verifiedStates>> = [];
    ok('metadata only: nothing hydrated', !(await hydrates(async () => { states = await VS.verifiedStates(P); })));
    ok('states: each question, whether it runs, and nothing hidden from an admin', states.length === 1 && states[0].problem === null && states[0].hidden === false, JSON.stringify(states));
    await trash.trashRecord(P, 'verified', V); // § channels starts from none
  });

  // ── § channels: verified:list, verified:save, verified:delete ─────────────
  const rawRecord = (id: string) => as(async () => recordFs.readFile(path.join(recordKinds.projectDir(P), 'verified', id + '.json'), 'utf8'));
  const cardFigure = async (id: string): Promise<string> => {
    const rec = JSON.parse(await rawRecord(id));
    return JSON.stringify((await call('answer:card', { projectId: P, spec: rec.spec })).body?.data?.series);
  };
  const s = await call('verified:save', { projectId: P, input: { question: 'Revenue by region', phrasings: ['Sales per region'], note: 'Net of refunds', spec: { ...SPEC, matched: [{ column: 'region', said: 'west', value: 'West' }] } } });
  const id: string = s.body?.question?.id ?? '';
  ok('saved: the card\'s spec, no figure', s.body?.ok === true && !/\b(data|headline|bullets|series)\b/.test(await rawRecord(id)) && !(await rawRecord(id)).includes('"matched"'), s.text.slice(0, 300));
  const f1 = await cardFigure(id);
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS, rows: [...ROWS, ['West', 'SMB', 100, '2026-05-05']] }));
  const f2 = await cardFigure(id);
  ok('no stored figure: new rows, new figure', f1.length > 2 && !Object.is(f1, f2), `${f1} | ${f2}`);
  const noDraw = await call('verified:save', { projectId: P, input: { question: 'x', spec: { ...SPEC, category: 'nope' } } });
  ok('a spec that no longer runs cannot be verified', noDraw.body?.ok === false && noDraw.body.field === 'spec' && noDraw.body.error === msg.verifiedColumnGone('nope', 'Orders'), noDraw.text);
  const unread = await call('verified:save', { projectId: P, input: { question: 'x', spec: { datasetId: D } } });
  ok('a spec that does not read cannot be verified', unread.body?.ok === false && unread.body.field === 'spec' && unread.body.error === msg.verifiedNotRead(), unread.text);
  const taken = await call('verified:save', { projectId: P, input: { question: 'revenue by REGION?', spec: SPEC } });
  ok('a taken question is refused', taken.body?.ok === false && taken.body.field === 'question' && taken.body.error === msg.verifiedTaken('revenue by REGION?'), taken.text);
  const takenP = await call('verified:save', { projectId: P, input: { question: 'Revenue by segment', phrasings: ['sales PER region'], spec: { ...SPEC, category: 'segment' } } });
  ok('a taken phrasing is refused beside the phrasings', takenP.body?.ok === false && takenP.body.field === 'phrasings' && takenP.body.error === msg.verifiedTaken('sales PER region'), takenP.text);
  const noWords = await call('verified:save', { projectId: P, input: { question: '???', spec: SPEC } });
  ok('a question with no words is refused', noWords.body?.ok === false && noWords.body.field === 'question' && noWords.body.error === msg.verifiedNoWords(), noWords.text);
  ok('edit with a stale tag is 409', (await call('verified:save', { projectId: P, id, base: 'stale', input: { question: 'Revenue by region', spec: SPEC } })).status === 409);
  const list = await call('verified:list', { projectId: P });
  const row = list.body?.questions?.[0];
  ok('list: describe, filters, runs, who, the spec and a tag', list.body?.ok === true && list.body.broken === 0 && row?.runs === true && row.describe === 'sum of amount by region'
    && row.verifiedBy === TEST_USER && row.datasetName === 'Orders' && row.note === 'Net of refunds' && row.phrasings[0] === 'Sales per region'
    && row.spec?.category === 'region' && typeof row.tag === 'string' && !('problem' in row), list.text.slice(0, 400));
  const edited = await call('verified:save', { projectId: P, id, base: row?.tag, input: { question: 'Revenue by region', note: '', spec: { ...SPEC, filters: [{ column: 'region', op: 'in', values: ['West', 'East'] }] } } });
  ok('edit with the open tag lands in place: same id, the new spec, the note cleared, a new tag', edited.body?.ok === true && edited.body.question.id === id
    && edited.body.question.filters.join() === 'region in West, East' && !('note' in edited.body.question) && edited.body.question.tag !== row?.tag, edited.text.slice(0, 300));
  ok('NEGATIVE CONTROL: the old tag is now stale', (await call('verified:save', { projectId: P, id, base: row?.tag, input: { question: 'Revenue by region', spec: SPEC } })).status === 409);
  ok('an edit of a question that is gone says so', (await call('verified:save', { projectId: P, id: '00000000-0000-4000-8000-000000000003', input: { question: 'Other', spec: SPEC } })).body?.error === msg.verifiedGone());
  const segQ = await call('verified:save', { projectId: P, input: { question: 'Revenue by segment', spec: { ...SPEC, category: 'segment' } } });
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS.filter((c) => c.name !== 'segment'), rows: ROWS.map((r) => [r[0], r[2], r[3]]) }));
  const broken = await call('verified:list', { projectId: P });
  const bRow = (broken.body?.questions ?? []).find((x: { id: string }) => x.id === segQ.body?.question?.id);
  ok('list: a question that no longer runs is counted, with its reason', broken.body?.broken === 1 && bRow?.runs === false && bRow.problem === msg.verifiedColumnGone('segment', 'Orders'), broken.text.slice(0, 400));
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS, rows: ROWS }));
  const del = await call('verified:delete', { projectId: P, id });
  const inTrash = (await call('trash:list', { projectId: P })).body;
  ok('delete goes to Trash, under its question', del.body?.ok === true && Array.isArray(inTrash) && inTrash.some((e: { type: string; id: string; name: string }) => e.type === 'verified' && e.id === id && e.name === 'Revenue by region'), JSON.stringify(inTrash).slice(0, 300));
  ok('…and leaves the list', !(await call('verified:list', { projectId: P })).body.questions.some((x: { id: string }) => x.id === id));
  const inList = async (x: string): Promise<boolean> => (await call('verified:list', { projectId: P })).body.questions.some((r: { id: string }) => r.id === x);
  const holder = await call('verified:save', { projectId: P, input: { question: 'Total amount by region', phrasings: ['revenue BY region'], spec: SPEC } });
  const refused = await call('trash:restore', { projectId: P, type: 'verified', id });
  const stillIn = ((await call('trash:list', { projectId: P })).body ?? []).some((e: { id: string }) => e.id === id);
  ok('restore refuses a question a live phrasing now holds, and it stays in the Trash', holder.body?.ok === true && refused.body?.ok === false
    && refused.body.error === msg.verifiedRestoreTaken('Revenue by region') && stillIn && !(await inList(id)), refused.text);
  await call('verified:delete', { projectId: P, id: holder.body?.question?.id });
  const back = await call('trash:restore', { projectId: P, type: 'verified', id });
  ok('NEGATIVE CONTROL: with no clash it restores', back.body?.ok === true && (await inList(id)), back.text);
  await call('verified:delete', { projectId: P, id }); // § mark starts without it
  const race = await Promise.all(['Margin by region', 'margin by REGION?'].map((question) => call('verified:save', { projectId: P, input: { question, spec: SPEC } })));
  const landed = race.filter((r) => r.body?.ok === true);
  ok('two saves of one question at once: one lands, the other is refused as taken', landed.length === 1
    && race.some((r) => r.body?.ok === false && r.body.field === 'question'), race.map((r) => r.text.slice(0, 120)).join(' | '));
  for (const r of landed) await call('verified:delete', { projectId: P, id: r.body.question.id });
  ok('a bad id is refused at the contract', (await call('verified:delete', { projectId: P, id: 'nope' })).status === 400);

  // ── § mark: "✓ Verified" by comparison only, worked out at every draw ─────
  const answerSpec: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
  const card = async (spec: unknown) => (await call('answer:card', { projectId: P, spec })).body;
  const SEG = { ...SPEC, category: 'segment' }; // the spec of segQ, "Revenue by segment"
  const VQ: string = segQ.body?.question?.id ?? '';
  const marked = await card(SEG);
  ok('the identical spec is marked, with the question, who and when', marked?.verified?.id === VQ && marked.verified.question === 'Revenue by segment'
    && marked.verified.by === TEST_USER && !Number.isNaN(Date.parse(marked.verified.at)), JSON.stringify(marked?.verified));
  ok('another chart type is still that answer', (await card({ ...SEG, chartType: 'bar' }))?.verified?.id === VQ);
  ok('a client cannot claim it', (await card({ ...SPEC, verified: { id: VQ, question: 'x', by: 'x', at: T } }))?.verified === undefined);
  ok('…and a stored turn keeps no mark', !('verified' in (answerSpec.sanitizeStoredSpec({ ...SEG, verified: { id: VQ } }) ?? {})));
  ok('one filter off is not marked', (await card({ ...SEG, filters: [{ column: 'region', op: '=', value: 'West' }] }))?.verified === undefined);
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS.map((c) => (c.name === 'amount' ? { ...c, type: 'text' as const } : c)), rows: ROWS }));
  const drawn = await card(SEG);
  ok('broken (its measure no longer fits): the card draws, unmarked', drawn?.ok === true && drawn.verified === undefined, JSON.stringify(drawn).slice(0, 200));
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS, rows: ROWS }));
  ok('NEGATIVE CONTROL: restored, the mark is back', (await card(SEG))?.verified?.id === VQ);
  // A verified chip reruns the question's own spec: drawn as stored, never moved to a near value under its ✓.
  const WSPEC = { ...SPEC, filters: [{ column: 'region', op: '=', value: 'West' }] };
  const wq = await call('verified:save', { projectId: P, input: { question: 'Revenue in the West', spec: WSPEC } });
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS, rows: ROWS.map((r) => (r[0] === 'West' ? ['Wests', ...r.slice(1)] : r)) }));
  const rerunSpec = async (spec: object) => {
    const turns = (await call('answer:rerun', { projectId: P, spec })).body?.turns ?? [];
    return turns[turns.length - 1]?.answer ?? null;
  };
  const chipSpec = await rerunSpec(WSPEC);
  ok('a verified question\'s own spec reruns as stored: no near value', chipSpec?.filters?.[0]?.value === 'West' && !chipSpec.matched, JSON.stringify(chipSpec));
  const nearSpec = await rerunSpec({ ...WSPEC, category: 'segment' });
  ok('NEGATIVE CONTROL: any other spec still finds the near value', nearSpec?.filters?.[0]?.value === 'Wests', JSON.stringify(nearSpec));
  await as(() => datasets.updateDatasetData(P, D, { columns: COLUMNS, rows: ROWS }));
  await call('verified:delete', { projectId: P, id: wq.body?.question?.id });

  // ── § retired (part 4; cross-part check item 8): a verified question on a retired metric keeps running ──
  const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const statusStore: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
  const { pinOf }: typeof import('../src/analysis/statusPin') = require('../src/analysis/statusPin');
  const statusMsg: typeof import('../src/analysis/statusMessages') = require('../src/analysis/statusMessages');
  const state: typeof import('../src/ipc/verifiedState') = require('../src/ipc/verifiedState');
  const { GROSS, NET } = await as(async () => {
    const save = async (name: string) => (await metricsMod.saveMetric(P, { name, datasetId: D, definition: { column: 'amount', aggregation: 'max' } }))!.id;
    return { GROSS: await save('Gross revenue'), NET: await save('Net revenue') };
  });
  const GSPEC = { ...SPEC, measures: [{ column: 'amount', aggregation: 'max', metricId: GROSS }], title: 'Largest gross revenue by region' };
  const gq = await call('verified:save', { projectId: P, input: { question: 'Largest gross revenue by region', spec: GSPEC } });
  const GQ: string = gq.body?.question?.id ?? '';
  const certifyNow = (ref: string) => as(async () => statusStore.certify(P, ref, (await pinOf(P, ref))!, ''));
  await certifyNow(`metric:${NET}`);
  await as(() => statusStore.retire(P, `metric:${GROSS}`, `metric:${NET}`, ''));
  const problem = await as(async () => state.verifiedProblem((await S.getVerified(P, GQ))!, await state.verifiedEnv(P)));
  ok('retired: verifiedProblem is null (the question names its metric, so it still runs)', !!GQ && problem === null, `${gq.text?.slice(0, 200)} ${problem}`);
  const retiredCard = await card(GSPEC);
  ok("…its card draws, marked verified, and its notes say what replaces the metric", retiredCard?.ok === true && retiredCard.verified?.id === GQ
    && retiredCard.notes.includes(statusMsg.retiredUse('Gross revenue', 'Net revenue')), JSON.stringify(retiredCard?.notes));
  await as(async () => { await statusStore.clearStatus(P, `metric:${GROSS}`); });
  await certifyNow(`metric:${GROSS}`);
  const certifiedCard = await card(GSPEC);
  ok('NEGATIVE CONTROL: certified, the card is marked and carries no retired note', certifiedCard?.verified?.id === GQ && !certifiedCard.notes.some((n: string) => /retired/.test(n)), JSON.stringify(certifiedCard?.notes));

  // ── § metric: a question on a metric is that metric as it was verified ──
  const drift = async (label: string, change: () => Promise<unknown>, undo: () => Promise<unknown>) => {
    await as(change);
    const p = await as(async () => state.verifiedProblem((await S.getVerified(P, GQ))!, await state.verifiedEnv(P)));
    const c = await card(GSPEC);
    ok(`metric ${label}: no longer runs, and the card is not marked`, p === msg.verifiedMetricChanged() && c?.verified === undefined, `${p} ${JSON.stringify(c?.verified)}`);
    await as(undo);
  };
  const DEF = { column: 'amount', aggregation: 'max' as const };
  await drift('redefined', () => metricsMod.updateMetric(P, GROSS, { definition: { column: 'amount', aggregation: 'sum' } }), () => metricsMod.updateMetric(P, GROSS, { definition: DEF }));
  await drift('given a filter', () => metricsMod.updateMetric(P, GROSS, { filters: [{ type: 'filter', column: 'segment', op: '=', value: 'SMB' }] }), () => metricsMod.updateMetric(P, GROSS, { filters: [] }));
  ok('NEGATIVE CONTROL: put back as it was, it runs and is marked', (await card(GSPEC))?.verified?.id === GQ);
  await drift('deleted', () => metricsMod.deleteMetric(P, GROSS), async () => undefined);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
