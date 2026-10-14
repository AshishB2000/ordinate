// A FOLLOW-UP QUESTION through the real `copilot:ask` handler — userData in a
// temp dir, the model stubbed at analyze.askCopilot (as test-answerFacts.ts).
//
//   1. Ask, then a follow-up whose action is {refine: true, filters: […]}: the
//      model call for the follow-up carried the PREVIOUS ANSWER block (names
//      only — no figure of the card, no value of a column marked personal), and
//      the stored turn's spec holds the old filters AND the new one on the same
//      dataset. The card's figures are the ones every filter together gives.
//   2. NEGATIVE CONTROL: in a NEW conversation the same action gets no block and
//      is an ordinary spec — refused for what it lacks.
//   3. A new subject keeps nothing but the dataset, and that only after the
//      screen's own.
//   4. A merge the validator refuses is refused — never cut back to the patch —
//      and the app's own reason is not read as a figure the model invented.
//   5. The block's settings and the number audit, on a reply that is kept.
//   6. No block when there is nothing to continue: no answer yet, the dataset
//      gone, a column gone or retyped. The lookup never reads a row.
//
//   npm run build:ts && node scripts/test-askFollowUp.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-followup-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const B: typeof import('../src/ai/previousAnswer') = require('../src/ai/previousAnswer');
const notes: typeof import('../src/ai/columnNotes') = require('../src/ai/columnNotes');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const copilotStore: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');

type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;

function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A value that exists only in a filter on a column marked personal. */
const CANARY = 'zq-canary-7731@example.test';
const COLS: import('../src/data/parse').ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'channel', type: 'text' },
  { name: 'segment', type: 'text' }, { name: 'email', type: 'text' }, { name: 'revenue', type: 'number' },
];
// Every filter of the follow-up excludes a row of its own, so a dropped one moves a figure.
const ROWS: import('../src/data/transforms').Cell[][] = [
  ['2024-10-02', 'West', 'Online', 'Enterprise', 'a@x.test', 1234.5],
  ['2024-11-15', 'East', 'Online', 'Enterprise', 'b@x.test', 987.25],
  ['2024-12-20', 'West', 'Retail', 'Enterprise', 'a@x.test', 456.75], // not Online
  ['2024-12-05', 'East', 'Online', 'SMB', 'c@x.test', 55.5],          // not Enterprise
  ['2024-11-03', 'West', 'Online', 'Enterprise', CANARY, 2468.25],    // the excluded customer
  ['2023-11-03', 'West', 'Online', 'Enterprise', 'a@x.test', 999],    // not last quarter
];

async function main(): Promise<void> {
  const p = await projects.createProject('Follow-ups');
  const pid = p!.id;
  const ds = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows: ROWS }))!;
  const budget = (await datasets.saveDataset(pid, {
    name: 'Budget', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'plan', type: 'number' }], rows: [['West', 10], ['East', 20]],
  }))!;
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'personal' });
  await catalog.setColumn(pid, ds.id, 'segment', { displayName: 'Customer Segment' }, COLS.map((c) => c.name));
  copilotIpc.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const whole = async (raw: unknown, title: string): Promise<AnswerSpec> => {
    const v = A.validateAnswerSpec(raw, await answers.specDatasets(pid), { title });
    if (!v.ok) throw new Error('fixture does not validate: ' + v.reason);
    return v.spec;
  };

  // The model, stubbed at its own boundary: every call is kept WHOLE — the
  // replayed turns, the facts and the question are all text a model was sent.
  const replies: any[] = [];
  const sent: { prior: { role: string; text: string }[]; facts: string; q: string }[] = [];
  (analyze as any).askCopilot = async (prior: { role: string; text: string }[], facts: string, q: string) => {
    sent.push({ prior, facts, q });
    return replies.shift();
  };
  (execConfig as any).executionReady = () => true;
  const answerWith = (intent: string, spec: unknown, text = 'Here it is.') =>
    ({ ok: true, text, suggestedAction: { kind: 'answer', intent, spec } });
  const narration = (text: string) => ({ ok: true, text, suggestedAction: { kind: 'none', intent: '' } });
  const lastOf = (r: any) => r.turns[r.turns.length - 1];

  // ── 1. Ask, then refine ───────────────────────────────────────────────────
  const FIRST = {
    dataset: 'Orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }],
    filters: [{ column: 'order_date', period: 'last_quarter' }, { column: 'segment', op: '=', value: 'Enterprise' }, { column: 'email', op: '!=', value: CANARY }],
  };
  replies.push(answerWith('enterprise revenue by region last quarter', FIRST), narration('West leads.'));
  const r1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'enterprise revenue by region last quarter, without our test account' });
  const a1: AnswerSpec = lastOf(r1).answer;
  ok('ask: the first answer is stored with its three filters', r1.ok && a1 && a1.filters.length === 3 && a1.datasetId === ds.id, JSON.stringify(lastOf(r1)));
  ok('ask: the first question of a conversation is told of no previous answer', !sent[0].facts.includes(B.PREVIOUS_ANSWER), sent[0].facts);
  const card1 = await call('answer:card', { projectId: pid, spec: a1 });

  const PATCH = { refine: true, filters: [{ column: 'channel', op: '=', value: 'online' }] };
  const INTENT = 'enterprise revenue by region last quarter, online only';
  replies.push(answerWith(INTENT, PATCH), narration('West still leads.'));
  const r2 = await call('copilot:ask', { projectId: pid, context: {}, question: 'now only online', threadId: r1.threadId });
  const a2: AnswerSpec = lastOf(r2).answer;
  const followUp = sent[2];

  const block = B.previousAnswerBlock(a1, 'Orders', new Set(['email'])).text;
  ok('follow-up: the model call carried the block, after the facts — the one the stored spec gives',
    followUp.q === 'now only online' && followUp.facts.endsWith('\n\n' + block) && followUp.facts.indexOf(B.PREVIOUS_ANSWER) > 0, followUp.facts);
  ok('follow-up: the block names the dataset, the columns and the filters in force',
    /dataset "Orders"; category "region"; measures sum\(revenue\); filters: "order_date" in last_quarter, "segment" = "Enterprise", "email" != /.test(block), block);

  // CANARY: the whole text of that call — replayed turns, facts, block, question.
  const everything = JSON.stringify(followUp);
  ok('canary: the value filtered on a personal column is nowhere in the follow-up\'s ask', !everything.includes(CANARY) && !everything.includes('canary'), everything);
  ok('canary: …the filter is there with its value withheld', block.includes(`"email" != ${notes.WITHHELD}`), block);
  ok('canary: …and the app still has it — the merge kept the value on the server (negative control)',
    JSON.stringify(a1).includes(CANARY) && JSON.stringify(a2).includes(CANARY));
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'none' });
  const unmarked = await answers.previousAnswer(pid, r1.turns);
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'personal' });
  ok('canary: unmarked, the same block prints it (negative control — the mark is what withholds it)', !!unmarked && unmarked.block.includes(CANARY));

  // NAMES ONLY: no figure of the card the user is looking at.
  const figures: number[] = [...card1.data.series.flatMap((s: { values: number[] }) => s.values), ...card1.headline.map((h: { value: number }) => h.value)];
  const displays: string[] = card1.headline.map((h: { display: string }) => h.display);
  ok('block: the card has figures to leak (the check is not vacuous)', card1.ok && figures.length >= 3 && figures.every((n) => typeof n === 'number'), JSON.stringify(card1.data));
  ok('block: none of the card\'s figures is in it', figures.every((n) => !block.includes(String(n))) && displays.every((d) => !block.includes(d)), block);
  ok('block: …though the facts-and-turns around it may carry figures, the block adds none to the ledger of an answer with no numeric setting',
    B.previousAnswerBlock(a1, 'Orders', new Set(['email'])).ledger.length === 0);

  // The stored spec: old filters, the new one, same dataset — the whole question, written out.
  const full = await whole({ ...FIRST, filters: [...FIRST.filters, PATCH.filters[0]] }, INTENT);
  ok('follow-up: the stored spec is the old filters and the new one on the same dataset', r2.ok && a2 && a2.datasetId === ds.id && a2.filters.length === 4
    && sameLeaves(a2.filters.slice(0, 3), a1.filters) && sameLeaves(a2.filters[3], { column: 'channel', op: '=', value: 'online' }), JSON.stringify(a2));
  ok('follow-up: …leaf for leaf the spec the whole question gives', sameLeaves(a2, full), JSON.stringify([a2, full]));
  ok('follow-up: the turn is in the same conversation, narrated from the new card', r2.threadId === r1.threadId && lastOf(r2).text === 'West still leads.'
    && /^Filtered to: .*channel = online\.$/m.test(sent[3].facts), sent[3].facts);

  // The card: every filter labelled, a carried one exactly as it was when it was asked.
  const card2 = await call('answer:card', { projectId: pid, spec: a2 });
  ok('card: the carried filters are labelled as they were, and the new one after them',
    card2.ok && card2.filterLabels.length === 4 && card1.filterLabels.every((l: string, i: number) => Object.is(card2.filterLabels[i], l))
    && card2.filterLabels[3] === 'channel = online', JSON.stringify(card2.filterLabels));
  ok('card: a carried filter on the personal column reads as an ordinary filter on it does',
    card1.filterLabels[2] === `email != ${CANARY}` && Object.is(card2.filterLabels[2], card1.filterLabels[2]), JSON.stringify(card1.filterLabels));
  const ref = vizData.buildVizData(COLS, ROWS, { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, [
    { type: 'filter', column: 'order_date', op: '>=', value: '2024-10-01' }, { type: 'filter', column: 'order_date', op: '<=', value: '2024-12-31' },
    { type: 'filter', column: 'segment', op: '=', value: 'Enterprise' }, { type: 'filter', column: 'email', op: '!=', value: CANARY },
    { type: 'filter', column: 'channel', op: '=', value: 'Online' },
  ]);
  const refMap = new Map(ref.data.labels.map((l, i) => [String(l), ref.data.series[0].values[i]]));
  ok('card: its figures are what every filter together gives (Object.is with buildVizData)',
    card2.data.labels.join() === 'West,East' && card2.data.labels.every((l: string, i: number) => Object.is(card2.data.series[0].values[i], refMap.get(l))),
    JSON.stringify(card2.data));
  ok('card: …and not the first answer\'s (the follow-up changed the answer on screen)', !Object.is(card2.data.series[0].values[0], card1.data.series[0].values[0]));

  // A second follow-up REPLACES a filter, naming its column the way people do.
  replies.push(answerWith('smb revenue by region last quarter, online only', { refine: true, filters: [{ column: 'Customer Segment', op: '=', value: 'SMB' }] }), narration('East only.'));
  const r3 = await call('copilot:ask', { projectId: pid, context: {}, question: 'and for SMB instead?', threadId: r1.threadId });
  const a3: AnswerSpec = lastOf(r3).answer;
  ok('follow-up: a filter named by the column\'s display name replaces the one on that column',
    r3.ok && a3 && sameLeaves(a3.filters, [a2.filters[0], a2.filters[2], a2.filters[3], { column: 'segment', op: '=', value: 'SMB' }]), JSON.stringify(a3));
  ok('follow-up: …and it was told of the answer before it, not the first one', sent[4].facts.includes('"channel" = "online"'), sent[4].facts);

  // ── 2. NEGATIVE CONTROL: a new conversation ───────────────────────────────
  const fresh = (await call('copilot:newThread', { projectId: pid })).thread.id as string;
  replies.push(answerWith(INTENT, PATCH));
  const before = sent.length;
  const n1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'now only online', threadId: fresh });
  const plain = A.validateAnswerSpec(PATCH, await answers.specDatasets(pid), {});
  ok('new conversation: the same follow-up gets no block', !sent[before].facts.includes(B.PREVIOUS_ANSWER), sent[before].facts);
  ok('new conversation: …and is an ordinary spec — refused for what it lacks, with the validator\'s reason, and no chart',
    n1.ok && !plain.ok && !lastOf(n1).answer && lastOf(n1).text === `Here it is.\n\n(No chart: ${plain.reason})` && sent.length === before + 1, lastOf(n1).text);

  // ── 3. A new subject ──────────────────────────────────────────────────────
  // No dataset named, two in the project, nothing on screen: the previous answer's.
  const SUBJECT = { category: 'channel', measures: ['revenue'] };
  replies.push(answerWith('revenue by channel', SUBJECT), narration('Online leads.'));
  const s1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'revenue by channel', threadId: r1.threadId });
  const sub: AnswerSpec = lastOf(s1).answer;
  ok('new subject: a full spec without `refine` keeps nothing of the previous answer — no filter, no split',
    s1.ok && sub && sub.category === 'channel' && sub.filters.length === 0 && sub.series === undefined, JSON.stringify(sub));
  ok('new subject: …but with no dataset named and none on screen, it is asked of the previous answer\'s', sub.datasetId === ds.id);
  replies.push(answerWith('revenue by channel', SUBJECT));
  const s2 = await call('copilot:ask', { projectId: pid, context: {}, question: 'revenue by channel', threadId: fresh });
  ok('new subject: …where a conversation with no answer yet has no such default (negative control)',
    !lastOf(s2).answer && /No chart: Unknown dataset/.test(lastOf(s2).text), lastOf(s2).text);
  replies.push(answerWith('plan by region', { category: 'region', measures: ['plan'] }), narration('East leads.'));
  const s3 = await call('copilot:ask', { projectId: pid, context: { kind: 'dataset', id: budget.id }, question: 'plan by region', threadId: r1.threadId });
  ok('new subject: the dataset on screen comes first, the previous answer\'s after it', lastOf(s3).answer?.datasetId === budget.id, JSON.stringify(lastOf(s3)));

  // ── 4. A refused merge ────────────────────────────────────────────────────
  const thread = async (spec: AnswerSpec): Promise<string> => {
    const id = (await copilotStore.createThread(pid))!.id;
    await copilotStore.appendTurn(pid, { role: 'user', text: 'a question' }, id);
    await copilotStore.appendTurn(pid, { role: 'assistant', text: '', answer: spec }, id);
    return id;
  };
  const eight = await whole({
    dataset: 'Orders', category: 'region', measures: ['revenue'],
    filters: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((v) => ({ column: 'email', op: '!=', value: `${v}@x.test` })),
  }, 'eight filters');
  const full8 = await thread(eight);
  // A patch that would validate ON ITS OWN: were the app to fall back to it, a chart would come.
  const NINTH = { refine: true, category: 'region', measures: ['revenue'], filters: [{ column: 'channel', op: '=', value: 'Online' }] };
  ok('refused: the patch alone is a valid spec (so a silent fallback would show)', A.validateAnswerSpec({ ...NINTH, dataset: 'Orders' }, await answers.specDatasets(pid), {}).ok);
  replies.push(answerWith('nine filters', NINTH, 'Adding that filter.'));
  const c1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'only online', threadId: full8 });
  ok('refused: a merge past the filter cap gets the validator\'s reason and no chart — never the patch alone',
    c1.ok && !lastOf(c1).answer && lastOf(c1).text === 'Adding that filter.\n\n(No chart: At most 8 filters.)', lastOf(c1).text);
  ok('refused: …and the app\'s own "8" is not read as a figure the model invented', c1.numberAudit.ok === true, JSON.stringify(c1.numberAudit));
  replies.push(answerWith('nine filters', NINTH, 'Revenue grew 12.4%.'));
  const c2 = await call('copilot:ask', { projectId: pid, context: {}, question: 'only online', threadId: full8 });
  ok('refused: …while a figure the model DID invent beside it is still caught (negative control)',
    lastOf(c2).text === 'Revenue grew 12.4%.\n\nContains a figure the app did not compute: 12.4%\n\n(No chart: At most 8 filters.)', lastOf(c2).text);

  // ── 5. The block's settings and the number audit ──────────────────────────
  const settings = await thread(await whole({
    dataset: 'Orders', category: 'region', measures: ['revenue'], top: 9, filters: [{ column: 'revenue', op: '>', value: 4321 }],
  }, 'the largest regions'));
  const REPEAT = 'That chart keeps the 9 largest regions with revenue above 4,321.';
  replies.push(narration(REPEAT));
  const g1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'what am I looking at?', threadId: settings });
  ok('audit: a reply that repeats the previous answer\'s settings is kept as written, unaccused',
    g1.ok && g1.numberAudit.ok === true && lastOf(g1).text === REPEAT, lastOf(g1).text);
  replies.push(narration(REPEAT));
  const g2 = await call('copilot:ask', { projectId: pid, context: {}, question: 'what am I looking at?', threadId: fresh });
  ok('audit: …where no previous answer said them, the same words are flagged (negative control)',
    g2.numberAudit.ok === false && g2.numberAudit.violations.some((v: { token: string }) => v.token === '4,321'), JSON.stringify(g2.numberAudit));
  replies.push(narration(REPEAT + ' Revenue came to 48,210.'));
  const g3 = await call('copilot:ask', { projectId: pid, context: {}, question: 'and the total?', threadId: settings });
  ok('audit: a made-up figure beside the settings is still caught',
    JSON.stringify(g3.numberAudit.violations.map((v: { token: string }) => v.token)) === '["48,210"]' && / did not compute: 48,210$/.test(lastOf(g3).text), lastOf(g3).text);

  // ── 6. Nothing to continue ────────────────────────────────────────────────
  const turnsOf = (...specs: (AnswerSpec | undefined)[]): import('../src/ai/copilot').CopilotTurn[] =>
    specs.map((answer, i) => ({ id: String(i), role: 'assistant' as const, text: 't', createdAt: '', ...(answer ? { answer } : {}) }));
  let hydrated = 0;
  const realGet = datasets.getDataset;
  (datasets as any).getDataset = async (...args: Parameters<typeof realGet>) => { hydrated++; return realGet(...args); };
  const found = await answers.previousAnswer(pid, turnsOf(a1));
  ok('lookup: an answer whose dataset and columns stand is found', !!found && sameLeaves(found.spec, a1) && found.block === block);
  ok('lookup: no turns, or none with an answer, is nothing', (await answers.previousAnswer(pid, [])) === null && (await answers.previousAnswer(pid, turnsOf(undefined))) === null);
  const later = await answers.previousAnswer(pid, turnsOf(a1, a2, undefined));
  ok('lookup: the MOST RECENT answer is the one, a later reply in prose aside', !!later && sameLeaves(later.spec, a2));
  const gone: [string, AnswerSpec][] = [
    ['category', { ...a1, category: 'territory' }],
    ['measure', { ...a1, measures: [{ column: 'margin', aggregation: 'sum' }] }],
    ['split', { ...a1, series: 'rep' }],
    ['filter', { ...a1, filters: [...a1.filters, { column: 'tier', op: '=', value: 'x' }] }],
  ];
  for (const [what, spec] of gone) {
    ok(`lookup: no block when the ${what} column is gone`, (await answers.previousAnswer(pid, turnsOf(spec))) === null);
  }
  ok('lookup: no block when a column no longer fits what the answer does with it (a sum over text)',
    (await answers.previousAnswer(pid, turnsOf({ ...a1, measures: [{ column: 'channel', aggregation: 'sum' }] }))) === null);
  ok('lookup: it read no rows — metadata and the catalog only', hydrated === 0, String(hydrated));
  (datasets as any).getDataset = realGet;

  replies.push(answerWith(INTENT, PATCH));
  const at = sent.length;
  const v1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'now only online', threadId: await thread({ ...a1, category: 'territory' }) });
  ok('lookup: through the handler, a vanished column means no block and the refine is an ordinary spec',
    !sent[at].facts.includes(B.PREVIOUS_ANSWER) && !lastOf(v1).answer && /No chart: Unknown dataset/.test(lastOf(v1).text), lastOf(v1).text);

  await datasets.deleteDataset(pid, ds.id);
  ok('lookup: no block when the dataset is gone', (await answers.previousAnswer(pid, turnsOf(a1))) === null);

  ok('the stub was asked exactly as often as it had replies', replies.length === 0, String(replies.length));
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
