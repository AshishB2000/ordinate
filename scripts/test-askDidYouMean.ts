// "DID YOU MEAN" through the real handlers — `copilot:ask`, `answer:card`,
// `answer:rerun` — userData in a temp dir, the model stubbed at
// analyze.askCopilot (as test-askFollowUp.ts).
//
//   1. A VALUE THE DATA HOLDS. A spec whose filter says "tech" (or "Tecnology")
//      is stored as the value it matched, and — DIFFERENTIAL — its card's data
//      is, value for value (Object.is), the card of the spec that says
//      "Technology". The card says what it did; a reload draws the same card.
//      A value stored in another case is left as asked, as it always was. Two
//      candidates, or under 3 characters → nothing changes (negative controls).
//   2. CANARY. A value on a column marked personal that the APP matched — the
//      model never wrote it whole — is in no model call: not the narration of
//      its card, not the follow-up's PREVIOUS ANSWER block. The card a person
//      sees shows it. Unmarked, the same facts print it (negative control).
//   3. A REFUSED ANSWER. An unknown measure → the reply reads exactly as it did,
//      and the stored turn carries the app's options; a reload keeps them.
//      `answer:rerun` with an option appends a normal answer turn, with ONE
//      model call (its narration). Nothing near, or a cap → no options. A
//      refused follow-up's option keeps the carried filters; an option that is
//      the previous chart again is not offered.
//   4. AN EMPTY ANSWER. No rows because of a value → the card carries the
//      sentence and the nearest stored values, computed at card time and never
//      stored. None for a marked column (negative control: unmarked, it has
//      them), none for a value nothing is near.
//
//   npm run build:ts && node scripts/test-askDidYouMean.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-didyoumean-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const B: typeof import('../src/ai/previousAnswer') = require('../src/ai/previousAnswer');
const notes: typeof import('../src/ai/columnNotes') = require('../src/ai/columnNotes');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');

type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;
type Card = import('../src/ipc/answers').AnswerCard;

const show = (v: unknown): string => JSON.stringify(v);
function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
/** Two cards draw the same chart: every label, every value, every headline figure — Object.is, nothing rounded. */
const sameData = (a: Card, b: Card): boolean => a.ok && b.ok && sameLeaves(a.data, b.data) && sameLeaves(a.headline, b.headline) && a.chartType === b.chartType;

/** A value that exists only in the data: the model is made to write all of it but the last letter. */
const CANARY = 'zq-canary-7731@example.test';
const SAID = CANARY.slice(0, -1);
const COLS: import('../src/data/parse').ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'category', type: 'text' }, { name: 'region', type: 'text' },
  { name: 'email', type: 'text' }, { name: 'net_sales', type: 'number' }, { name: 'sales_tax', type: 'number' },
];
const ROWS: import('../src/data/transforms').Cell[][] = [
  ['2024-10-02', 'Technology', 'West', 'a@x.test', 1234.5, 10],
  ['2024-11-15', 'Furniture', 'East', 'b@x.test', 987.25, 20],
  ['2024-12-20', 'Technology', 'East', CANARY, 456.75, 30],
  ['2024-12-05', 'Office Supplies', 'West', 'c@x.test', 55.5, 40],
  ['2024-11-03', 'Technology', 'West', 'a@x.test', 2468.25, 50],
  ['2023-11-03', 'Furniture', 'West', 'b@x.test', 999, 60],
];

async function main(): Promise<void> {
  const pid = (await projects.createProject('Did you mean'))!.id;
  const ds = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows: ROWS }))!;
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'personal' });
  await catalog.setColumn(pid, ds.id, 'sales_tax', { displayName: 'Sales Tax' }, COLS.map((c) => c.name));
  copilotIpc.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const whole = async (raw: unknown, title: string): Promise<AnswerSpec> => {
    const v = A.validateAnswerSpec(raw, await answers.specDatasets(pid), { title });
    if (!v.ok) throw new Error('fixture does not validate: ' + v.reason);
    return v.spec;
  };
  const card = (spec: unknown): Promise<Card> => call('answer:card', { projectId: pid, spec });
  const thread = async (): Promise<string> => (await call('copilot:newThread', { projectId: pid })).thread.id;

  // The model, stubbed at its own boundary: every call kept whole.
  const replies: any[] = [];
  const sent: { prior: { role: string; text: string }[]; facts: string; q: string }[] = [];
  (analyze as any).askCopilot = async (prior: { role: string; text: string }[], facts: string, q: string) => {
    sent.push({ prior, facts, q });
    return replies.shift();
  };
  (execConfig as any).executionReady = () => true;
  const answerWith = (intent: string, spec: unknown, text = 'Here it is.') => ({ ok: true, text, suggestedAction: { kind: 'answer', intent, spec } });
  const narration = (text: string) => ({ ok: true, text, suggestedAction: { kind: 'none', intent: '' } });
  const lastOf = (r: any) => r.turns[r.turns.length - 1];
  const BY_REGION = { dataset: 'Orders', category: 'region', measures: [{ column: 'net_sales', aggregation: 'sum' }] };
  /** Ask in a NEW conversation; the model answers with this spec. `narrated`: a chart came, so it is narrated too. */
  const ask = async (spec: unknown, narrated = true, intent = 'revenue by region'): Promise<any> => {
    replies.push(answerWith(intent, spec), ...(narrated ? [narration('West leads.')] : []));
    return call('copilot:ask', { projectId: pid, context: {}, question: intent, threadId: await thread() });
  };

  // ── 1. A value the data holds ─────────────────────────────────────────────
  const r1 = await ask({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: 'tech' }] });
  const a1: AnswerSpec = lastOf(r1).answer;
  ok('match: the stored spec keeps what was matched to, and what was said',
    r1.ok && show(a1.filters) === show([{ column: 'category', op: '=', value: 'Technology' }]) && show(a1.matched) === show([{ column: 'category', said: 'tech', value: 'Technology' }]), show(a1));
  const c1 = await card(a1);
  ok('match: the card says what it did, first among its notes, and labels the filter by the stored value',
    c1.ok && c1.notes[0] === 'Matched "tech" to Technology in category.' && show(c1.filterLabels) === '["category = Technology"]', show([c1.notes, c1.filterLabels]));
  ok('match: the narration read the stored value (an unmarked column)', /^Filtered to: category = Technology\.$/m.test(sent[1].facts), sent[1].facts);

  const rExact = await ask({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: 'Technology' }] });
  const aExact: AnswerSpec = lastOf(rExact).answer;
  const cExact = await card(aExact);
  ok('differential: the card has figures to differ by (the check is not vacuous)',
    cExact.ok && cExact.data.labels.join() === 'West,East' && cExact.data.series[0].values.every((v) => typeof v === 'number') && !('matched' in aExact), show(cExact.data));
  ok('differential: "tech" computes the same card data as "Technology" — Object.is on every value', sameData(c1, cExact), show([c1.data, cExact.data]));
  const rEdit = await ask({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: 'Tecnology' }] });
  ok('differential: …and so does "Tecnology", one edit away', sameData(await card(lastOf(rEdit).answer), cExact) && lastOf(rEdit).answer.matched[0].said === 'Tecnology');
  const cOther = await card(await whole({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: 'Furniture' }] }, 'revenue by region'));
  ok('differential: …where another category is another chart (negative control)', cOther.ok && !sameData(cOther, cExact));

  const rCase = await ask({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: ' TECHNOLOGY' }] });
  const aCase: AnswerSpec = lastOf(rCase).answer;
  const cCase = await card(aCase);
  ok('exact: a value stored in another case is left as asked — no match recorded, no note, the same chart',
    show(aCase.filters) === show([{ column: 'category', op: '=', value: ' TECHNOLOGY' }]) && !('matched' in aCase) && cCase.notes.length === 0 && sameData(cCase, cExact), show(aCase));

  const rList = await ask({ ...BY_REGION, filters: [{ column: 'category', op: 'not in', values: ['Furnitur', 'offic'] }] });
  const aList: AnswerSpec = lastOf(rList).answer;
  ok('match: each value of a `not in` list, with a line for each',
    show(aList.filters) === show([{ column: 'category', op: 'not in', values: ['Furniture', 'Office Supplies'] }])
    && show((await card(aList)).notes) === show(['Matched "Furnitur" to Furniture in category.', 'Matched "offic" to Office Supplies in category.'])
    && sameData(await card(aList), cExact), show(aList));

  const again = (await call('copilot:history', { projectId: pid, threadId: r1.threadId })).turns;
  const reloaded: AnswerSpec = again[again.length - 1].answer;
  ok('reload: the stored turn gives the spec back whole', sameLeaves(reloaded, a1), show(reloaded));
  const c1b = await card(reloaded);
  ok('reload: …and it draws the same card, with the same note', sameData(c1b, c1) && sameLeaves(c1b.notes, c1.notes) && sameLeaves(c1b.filterLabels, c1.filterLabels));

  const rTwo = await ask({ ...BY_REGION, filters: [{ column: 'region', op: '=', value: 'est' }] });
  const aTwo: AnswerSpec = lastOf(rTwo).answer;
  ok('two candidates → nothing changes: "est" is one edit from West AND East (negative control)',
    show(aTwo.filters) === show([{ column: 'region', op: '=', value: 'est' }]) && !('matched' in aTwo), show(aTwo));
  const rShort = await ask({ ...BY_REGION, filters: [{ column: 'category', op: '=', value: 'fu' }] });
  ok('under 3 characters → nothing changes (negative control)', show(lastOf(rShort).answer.filters) === show([{ column: 'category', op: '=', value: 'fu' }]) && !('matched' in lastOf(rShort).answer));

  // ── 2. Canary: a value the APP matched on a marked column ─────────────────
  const from = sent.length;
  const rc = await ask({ ...BY_REGION, filters: [{ column: 'email', op: '!=', value: SAID }] }, true, 'revenue by region without our test account');
  const ac: AnswerSpec = lastOf(rc).answer;
  ok('canary: the app matched the value — the stored spec holds what the model never wrote whole',
    show(ac.filters) === show([{ column: 'email', op: '!=', value: CANARY }]) && ac.matched?.[0].value === CANARY, show(ac));
  replies.push(answerWith('revenue by region without our test account, west only', { refine: true, filters: [{ column: 'region', op: '=', value: 'West' }] }), narration('West only.'));
  const rf = await call('copilot:ask', { projectId: pid, context: {}, question: 'now only west', threadId: rc.threadId });
  const mine = sent.slice(from);
  const everything = show(mine);
  ok('canary: both turns asked and narrated (four model calls), and the follow-up was told of the previous answer',
    rf.ok && mine.length === 4 && mine[2].facts.includes(B.PREVIOUS_ANSWER) && lastOf(rf).answer.filters.length === 2, String(mine.length));
  ok('canary: the matched value is in NO model call — neither turn\'s ask, nor the narration of either card', !everything.includes(CANARY) && !everything.includes('canary'), everything);
  ok('canary: …the filter is there with its value withheld, in the narration and in the block',
    mine[1].facts.includes(`\nFiltered to: email != ${notes.WITHHELD}.\n`) && mine[2].facts.includes(`"email" != ${notes.WITHHELD}`), mine[1].facts);
  const cc = await card(ac);
  ok('canary: the card a person sees shows the real value, in its filter and in its note',
    cc.ok && cc.filterLabels[0] === `email != ${CANARY}` && cc.notes[0] === `Matched "${SAID}" to ${CANARY} in email.`, show([cc.filterLabels, cc.notes]));
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'none' });
  const unmarked = await answers.computeCard(pid, ac);
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'personal' });
  ok('canary: unmarked, the same facts print it (negative control — the mark is what withholds it)', !('ok' in unmarked) && unmarked.factsText.includes(`email != ${CANARY}`));

  // ── 3. A refused answer ───────────────────────────────────────────────────
  const before = sent.length;
  const rr = await ask({ dataset: 'Orders', category: 'region', measures: ['sum(sales)'] }, false, 'sales by region');
  const refused = lastOf(rr);
  ok('refused: the reply reads exactly as it did', rr.ok && refused.text === 'Here it is.\n\n(No chart: Unknown measure column "sales".)' && !refused.answer && sent.length === before + 1, refused.text);
  const byHand = [await whole({ dataset: 'Orders', category: 'region', measures: ['sum(net_sales)'] }, 'sales by region'), await whole({ dataset: 'Orders', category: 'region', measures: ['sum(sales_tax)'] }, 'sales by region')];
  ok('refused: the stored turn carries the app\'s options — the part, what was said, each a complete spec (differential: the spec the right name gives)',
    !!refused.suggest && refused.suggest.part === 'measure' && refused.suggest.said === 'sales' && refused.suggest.options.length === 2
    && refused.suggest.options.every((o: { spec: AnswerSpec }, i: number) => sameLeaves(o.spec, byHand[i])), show(refused.suggest));
  ok('refused: an option is labelled by the column\'s display name when it has one, else its name',
    show(refused.suggest.options.map((o: { label: string }) => o.label)) === '["net_sales","Sales Tax"]', show(refused.suggest));
  const kept = (await call('copilot:history', { projectId: pid, threadId: rr.threadId })).turns;
  ok('refused: a reload keeps the options', sameLeaves(kept[kept.length - 1].suggest, refused.suggest), show(kept[kept.length - 1]));

  replies.push(narration('West leads.'));
  const calls = sent.length;
  const picked = refused.suggest.options[0];
  const run = await call('answer:rerun', { projectId: pid, threadId: rr.threadId, spec: picked.spec, label: picked.label });
  ok('rerun: an option appends a normal answer turn — the label as the question, the option\'s spec as the answer',
    run.ok && run.threadId === rr.threadId && run.turns.length === 4 && run.turns[2].role === 'user' && run.turns[2].text === 'net_sales'
    && sameLeaves(lastOf(run).answer, picked.spec) && lastOf(run).text === 'West leads.' && !('suggest' in lastOf(run)), show(run.turns));
  ok('rerun: no model call decided anything — one call, the narration of the app\'s chart', sent.length === calls + 1 && sent[calls].q.startsWith('Narrate this chart answer'));
  const direct = await card(byHand[0]);
  ok('rerun: its card is the card of the question asked with the right name (Object.is on every value)',
    direct.ok && direct.data.labels.length === 2 && sameData(await card(lastOf(run).answer), direct), show(direct.data));

  const none = lastOf(await ask({ dataset: 'Orders', category: 'region', measures: ['sum(zzzz)'] }, false));
  ok('refused: nothing near → no options, and the reply as it was', none.text === 'Here it is.\n\n(No chart: Unknown measure column "zzzz".)' && !('suggest' in none), show(none));
  const cap = lastOf(await ask({ dataset: 'Orders', category: 'region', measures: ['net_sales', 'net_sales', 'net_sales', 'net_sales', 'sales'] }, false));
  ok('refused: a cap is not a name — no options (negative control)', cap.text === 'Here it is.\n\n(No chart: At most 4 measures.)' && !('suggest' in cap), show(cap));

  // A refused FOLLOW-UP, in the conversation of the first answer (category = Technology).
  replies.push(answerWith('tech revenue by region, by category', { refine: true, series: 'categry' }, 'Splitting it.'));
  const f1 = lastOf(await call('copilot:ask', { projectId: pid, context: {}, question: 'split that by category', threadId: r1.threadId }));
  ok('follow-up: a refused one is offered the split it meant, over the MERGED spec — the carried filter is in the option',
    f1.text === 'Splitting it.\n\n(No chart: Unknown split column "categry".)' && !!f1.suggest && f1.suggest.part === 'series' && f1.suggest.options.length === 1
    && f1.suggest.options[0].label === 'category' && f1.suggest.options[0].spec.series === 'category' && sameLeaves(f1.suggest.options[0].spec.filters, a1.filters), show(f1));
  replies.push(answerWith('tech revenue by region', { refine: true, category: 'regio' }));
  const f2 = lastOf(await call('copilot:ask', { projectId: pid, context: {}, question: 'by region', threadId: r1.threadId }));
  ok('follow-up: an option that is the previous chart again is not offered',
    f2.text === 'Here it is.\n\n(No chart: Unknown category column "regio".)' && !('suggest' in f2), show(f2));

  // An option still carries the filter values as the model said them: matched when it is run.
  const both = lastOf(await ask({ dataset: 'Orders', category: 'region', measures: ['sum(sales)'], filters: [{ column: 'category', op: '=', value: 'tech' }] }, false));
  replies.push(narration('West leads.'));
  const ran = await call('answer:rerun', { projectId: pid, spec: both.suggest.options[0].spec, label: both.suggest.options[0].label });
  ok('rerun: a said value in an option is matched like an answer\'s — and the chart is the exact one\'s',
    both.suggest.options[0].spec.filters[0].value === 'tech' && lastOf(ran).answer.filters[0].value === 'Technology' && lastOf(ran).answer.matched.length === 1
    && sameData(await card(lastOf(ran).answer), cExact), show(lastOf(ran).answer));

  // ── 4. An empty answer ────────────────────────────────────────────────────
  const cTwo = await card(aTwo);
  ok('empty: no rows because of a value → the sentence and the nearest stored values, each a complete spec',
    cTwo.ok && cTwo.data.labels.length === 0 && cTwo.noMatch?.text === 'No rows match region = "est".'
    && show(cTwo.noMatch.options.map((o) => [o.label, o.spec.filters])) === show([['West', [{ column: 'region', op: '=', value: 'West' }]], ['East', [{ column: 'region', op: '=', value: 'East' }]]])
    && cTwo.noMatch.options.every((o) => sameLeaves({ ...o.spec, filters: [] }, { ...aTwo, filters: [] })), show(cTwo.noMatch));
  ok('empty: computed at card time, never stored on the turn', !('suggest' in lastOf(rTwo)) && !('noMatch' in lastOf(rTwo)) && !('noMatch' in aTwo));
  replies.push(narration('East.'));
  const east = await call('answer:rerun', { projectId: pid, threadId: rTwo.threadId, spec: cTwo.noMatch!.options[1].spec, label: cTwo.noMatch!.options[1].label });
  const cEast = await card(lastOf(east).answer);
  ok('empty: an option, run, is the chart of that value (Object.is with the card asked for it outright)',
    cEast.ok && cEast.data.labels.join() === 'East' && !cEast.noMatch
    && sameData(cEast, await card(await whole({ ...BY_REGION, filters: [{ column: 'region', op: '=', value: 'East' }] }, 'revenue by region'))), show(cEast.data));
  ok('empty: a card WITH rows offers none (negative control)', !('noMatch' in c1) && !('noMatch' in cExact));

  const cFar = await card(await whole({ ...BY_REGION, filters: [{ column: 'region', op: '=', value: 'Atlantis' }] }, 'revenue by region'));
  ok('empty: none for a value nothing is near', cFar.ok && cFar.data.labels.length === 0 && !('noMatch' in cFar), show(cFar.noMatch));
  const emailSpec = await whole({ ...BY_REGION, filters: [{ column: 'email', op: '=', value: 'x.test' }] }, 'revenue by region');
  const cMarked = await card(emailSpec);
  ok('empty: none for a column marked personal — no suggestion is built from its values', cMarked.ok && cMarked.data.labels.length === 0 && !('noMatch' in cMarked) && !show(cMarked).includes('@x.test'), show(cMarked.noMatch));
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'none' });
  const cUnmarked = await card(emailSpec);
  await catalog.setColumn(pid, ds.id, 'email', { sensitivity: 'personal' });
  ok('empty: …unmarked, the same card offers three (negative control — the mark is what holds them back)',
    cUnmarked.ok && cUnmarked.noMatch?.options.map((o) => o.label).join() === 'a@x.test,b@x.test,c@x.test', show(cUnmarked.noMatch));

  ok('the stub was asked exactly as often as it had replies', replies.length === 0, String(replies.length));
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
