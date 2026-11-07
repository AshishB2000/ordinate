// Status in the Assistant's vocabulary and on its answer cards (semantic layer part 4, D9/D10; cross-part item 8).
//
// 1. FACTS: certified metrics and terms first, a retired one only when the question names it, with "use X".
// 2. NEGATIVE CONTROL: with no status the facts text is byte-identical to before any status write.
// 3. The dashboard draft's metric block says certified too.
// 4. An answer card on a retired metric still computes the same figure and says what replaces it.
//
//   npm run build:ts && node scripts/test-statusAssistant.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-statusassistant-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const store: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
const notes: typeof import('../src/analysis/statusNotes') = require('../src/analysis/statusNotes');
const { pinOf } = require('../src/analysis/statusPin') as typeof import('../src/analysis/statusPin');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const draftFacts: typeof import('../src/ipc/draftFacts') = require('../src/ipc/draftFacts');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const planFacts: typeof import('../src/analysis/planFacts') = require('../src/analysis/planFacts');

const ADMIN = { user: { email: 'ana@acme.test', role: 'admin' as const }, org: { id: 'acme' } };
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'status-assistant', fn);

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Status assistant')).id;
    const D = (await datasets.saveDataset(P, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' as const }, { name: 'gross', type: 'number' as const }, { name: 'net', type: 'number' as const }, { name: 'qty', type: 'number' as const }],
      rows: [['EU', 10, 8, 1], ['ME', 20, 15, 2], ['US', 5, 4, 3]],
    }))!.id;
    const m = async (name: string, column: string) => (await metrics.saveMetric(P, { name, datasetId: D, definition: { column, aggregation: 'sum' } }))!.id;
    const [GROSS, NET, PLAIN] = [await m('Gross revenue', 'gross'), await m('Net revenue', 'net'), await m('Plain', 'qty')];
    const EMEA = (await terms.saveTerm(P, { name: 'EMEA', aliases: ['Europe'], description: '', datasetId: D, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME'] }] as never }))!.id;
    const certifyNow = (ref: string) => as(async () => store.certify(P, ref, (await pinOf(P, ref))!, ''));
    const factsOf = (q?: string): Promise<string> => as(async () => (await ipcCopilot.buildFacts(P, { kind: 'dataset', id: D }, undefined, q)).text);

    ok('namedIn is bounded by non-letters', !notes.namedIn('Gross revenues', ['Gross revenue']) && notes.namedIn('gross revenue?', ['Gross revenue']) && !notes.namedIn(undefined, ['x']));

    const baseline = await factsOf('how is revenue doing');
    const baselineNamed = await factsOf('what was Gross revenue');

    await certifyNow(`metric:${NET}`);
    await certifyNow(`term:${EMEA}`);
    await as(() => store.retire(P, `metric:${GROSS}`, `metric:${NET}`, ''));
    void PLAIN;
    const f = await factsOf('how is revenue doing');
    ok('certified first in the facts', f.includes('"Net revenue" (certified)') && f.indexOf('"Net revenue"') < f.indexOf('"Plain"'));
    ok('a retired metric the question does not name is not in the vocabulary', !f.includes('"Gross revenue"'));
    ok('a certified term says so', f.includes('"EMEA" (certified)'));
    const g = await factsOf('what was Gross revenue last month');
    ok('named exactly, a retired metric is kept and says what replaces it', g.includes('"Gross revenue" (retired; use "Net revenue")'));
    ok('the prompt tells the model to prefer certified', f.includes('Prefer a certified metric when several fit.'));

    await as(() => store.clearStatus(P, `metric:${NET}`));
    await as(() => store.clearStatus(P, `metric:${GROSS}`));
    await as(() => store.clearStatus(P, `term:${EMEA}`));
    ok('NEGATIVE CONTROL: with no status the facts text is byte-identical to before', (await factsOf('how is revenue doing')) === baseline && (await factsOf('what was Gross revenue')) === baselineNamed);
    ok('…and no status word is in it', !/\((certified|retired)/.test(baseline));

    await certifyNow(`metric:${NET}`);
    await as(() => store.retire(P, `metric:${GROSS}`, `metric:${NET}`, ''));
    const draft = await as(async () => { const ctx = await plan.loadPlanContext(P); return planFacts.buildFactsText(ctx, 'revenue', await draftFacts.loadDraftFacts(P, ctx)); });
    ok('the dashboard draft facts mark certified too', draft.includes('"Net revenue" (certified)'));
    ok('…and a retired one says what replaces it', draft.includes('"Gross revenue" (retired; use "Net revenue")'));

    await as(() => store.retire(P, `term:${EMEA}`, undefined, ''));
    ok('a retired term the question does not name is not in the vocabulary', !(await factsOf('how is revenue doing')).includes('"EMEA"'));
    ok('…one of its aliases names it, and it is kept as retired', (await factsOf('sales in europe?')).includes('"EMEA" (retired)'));

    // ── 4. the answer card ────────────────────────────────────────────────
    const spec = (metricId?: string, column = 'gross') => ({
      datasetId: D, title: 'Revenue by region', category: 'region', chartType: 'bar',
      measures: [{ column, aggregation: 'sum', ...(metricId ? { metricId } : {}) }], filters: [],
    }) as never;
    const card = await as(() => answers.computeCard(P, spec(GROSS)));
    const plain = await as(() => answers.computeCard(P, spec()));
    ok('the card computes the retired metric as asked', 'card' in card && 'card' in plain && JSON.stringify(card.card.data) === JSON.stringify(plain.card.data));
    ok('…and says what replaces it, in the app\'s words', (card as any).card.notes.includes('Gross revenue is retired; Net revenue replaces it.'));
    ok('NEGATIVE CONTROL: a certified metric adds no note', !((await as(() => answers.computeCard(P, spec(NET, 'net')))) as any).card.notes.some((n: string) => /retired/.test(n)));
    ok('NEGATIVE CONTROL: no metric, no note', !(plain as any).card.notes.some((n: string) => /retired/.test(n)));
    ok('specMetrics lists certified first and keeps the retired one', JSON.stringify((await as(() => answers.specMetrics(P))).map((x) => x.name)) === JSON.stringify(['Net revenue', 'Plain', 'Gross revenue']));
  });
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
