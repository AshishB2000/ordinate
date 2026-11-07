// Glossary terms expanded at the doors (semantic D11, ../src/analysis/termExpand.ts) — real stores in a
// temp DATA_DIR: Orders → Customers many-to-one, both with `region`, and an unrelated Other.
//
//   own dataset      a term becomes its plain steps, in place
//   another dataset  each step carries `datasetId` (only the join planner applies it), after the others
//   refused          deleted (its name from the Trash), purged, unrelated, a column gone, a newer release's key
//   a scope term     (`fromControl`) that does not apply is left out with a note, never refused
//   no mark          expanded steps never carry `fromControl`; step 04's rewrite keeps a term's mark
//   markScopeTerms   marks a dashboard scope's terms only
//
//   npm run build:ts && node scripts/test-termExpand.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-termexpand-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const { expandTerms }: typeof import('../src/analysis/termExpand') = require('../src/analysis/termExpand');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const msg: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const termStep: typeof import('../src/data/termStep') = require('../src/data/termStep');
const { markScopeTerms }: typeof import('../src/data/filterList') = require('../src/data/filterList');
const { rewriteControlPeriods }: typeof import('../src/analysis/metricTime') = require('../src/analysis/metricTime');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');

type FilterStep = import('../src/data/transforms').FilterStep;
type TermStep = import('../src/data/termStep').TermStep;
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };

const rejects = (p: Promise<unknown>): Promise<{ reason?: string; message?: string; code?: string }> =>
  p.then(() => ({}), (e: unknown) => (termStep.isTermNotExpandedError(e) ? e : { message: String(e) }));

(async () => {
  context.enterServerMode(DATA);
  await context.runInContext(ADMIN, 'termExpand', async () => {
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
    const trash: typeof import('../src/app/trash') = require('../src/app/trash');
    await projects.init();
    const P = (await projects.createProject('Expand')).id;
    const save = async (name: string, columns: { name: string; type: 'text' | 'number' | 'date' }[], rows: unknown[][]) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows: rows as never }))!.id;
    const ORDERS = await save('Orders', [{ name: 'cust', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'ship_date', type: 'date' }], [['c1', 'US', 5, '2024-01-02']]);
    const CUST = await save('Customers', [{ name: 'cust', type: 'text' }, { name: 'region', type: 'text' }, { name: 'since', type: 'date' }], [['c1', 'EU', '2020-01-01']]);
    const OTHER = await save('Other', [{ name: 'region', type: 'text' }], [['EU']]);
    await rels.saveRelationship(P, { from: { datasetId: ORDERS, column: 'cust' }, to: { datasetId: CUST, column: 'cust' }, cardinality: 'many_to_one' });

    const EMEA_F = { type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME', 'AF'] } as FilterStep;
    const RECENT_F = { type: 'filter', column: 'since', op: 'period', period: { preset: 'last_n_days', n: 90 } } as unknown as FilterStep;
    const mk = async (name: string, filters: unknown[], datasetId = CUST) => (await terms.saveTerm(P, { name, datasetId, filters }))!.id;
    const EMEA = await mk('EMEA', [EMEA_F]);
    const RECENT = await mk('Recent', [RECENT_F]);
    const OLD = await mk('Old term', [EMEA_F]);
    const STALE = await mk('Stale', [{ type: 'filter', column: 'tier', op: 'not_empty' }]); // a column Customers no longer has
    await trash.trashRecord(P, 'term', OLD);
    const F0 = { type: 'filter', column: 'amount', op: '>', value: 0 } as FilterStep;
    const T = (term: string, extra: object = {}) => ({ type: 'term', term, ...extra }) as unknown as FilterStep;

    const e = await expandTerms(P, ORDERS, [F0, T(EMEA)]);
    ok('a Customers term from Orders: pinned steps, after the others', stableStringify(e.steps) === stableStringify([F0, { ...EMEA_F, datasetId: CUST }]) && e.notes.length === 0, stableStringify(e));
    const own = await expandTerms(P, CUST, [T(EMEA), F0]);
    ok('own-dataset term: plain steps, in place', stableStringify(own.steps) === stableStringify([EMEA_F, F0]) && own.steps[0].datasetId === undefined, stableStringify(own));
    ok('NEGATIVE CONTROL: plain filters come back as they are', (await expandTerms(P, ORDERS, [F0])).steps[0] === F0);
    const del = await rejects(expandTerms(P, ORDERS, [T(OLD)]));
    ok('deleted: refused with its name from Trash', del.reason === 'deleted' && del.message === msg.termDeleted('Old term') && del.code === 'term', JSON.stringify(del));
    const purged = await rejects(expandTerms(P, ORDERS, [T('00000000-0000-4000-8000-000000000123')]));
    ok('purged: refused, no name to give', purged.reason === 'deleted' && purged.message === msg.termPurged());
    ok('deleted under a control is refused too, never skipped', (await rejects(expandTerms(P, ORDERS, [T(OLD, { fromControl: true })]))).reason === 'deleted');
    const far = await rejects(expandTerms(P, OTHER, [T(EMEA)]));
    ok('unrelated dataset: refused', far.reason === 'unreachable' && far.message === msg.termUnreachable('EMEA', 'Customers', 'Other'), JSON.stringify(far));
    ok('unrelated under a control: left out, noted', stableStringify(await expandTerms(P, OTHER, [T(EMEA, { fromControl: true }), T(EMEA, { fromControl: true })])) === stableStringify({ steps: [], notes: [msg.termNotApplied('EMEA', 'Other')] }));
    ok('against the relationship\'s direction (Customers → Orders): refused, its rows would repeat', (await rejects(expandTerms(P, CUST, [T(await mk('US orders', [{ type: 'filter', column: 'region', op: '=', value: 'US' }], ORDERS))]))).reason === 'unreachable');
    const gone = await rejects(expandTerms(P, ORDERS, [T(STALE)]));
    ok('a column gone: refused with the column\'s name, never a wider figure', gone.reason === 'column_gone' && gone.message === msg.termColumnGone('Stale', 'tier', 'Customers'), JSON.stringify(gone));
    ok('a column gone under a control: a note', (await expandTerms(P, ORDERS, [T(STALE, { fromControl: true })])).notes[0] === msg.termNotApplied('Stale', 'Orders'));
    ok('a term step with a key this release does not know is unreadable, never guessed at', (await rejects(expandTerms(P, CUST, [T(EMEA, { negate: true })]))).reason === 'unreadable');
    ok('NEGATIVE CONTROL: a malformed term and a newer release\'s step stay unreadable', (await rejects(expandTerms(P, CUST, [{ type: 'term' } as unknown as FilterStep]))).reason === 'unreadable'
      && (await rejects(expandTerms(P, CUST, [{ type: 'future_x' } as unknown as FilterStep]))).reason === 'unreadable');
    const marked = await expandTerms(P, CUST, [T(RECENT, { fromControl: true })]);
    ok('expanded steps never carry fromControl (a term\'s dates are a fixed filter)', marked.steps.length === 1 && !marked.steps.some((s) => 'fromControl' in s), stableStringify(marked));
    const CTRL = { type: 'filter', column: 'ship_date', op: 'period', period: { preset: 'last_n_days', n: 30 }, fromControl: true } as unknown as FilterStep;
    ok('step 04\'s rewrite keeps a term\'s mark', (rewriteControlPeriods([T(EMEA, { fromControl: true }), CTRL], 'ship_date')[0] as unknown as TermStep).fromControl === true);
    ok('a dashboard\'s scope marks its terms only', stableStringify(markScopeTerms([F0, T(EMEA)])) === stableStringify([F0, T(EMEA, { fromControl: true })])
      && markScopeTerms([F0])[0] === F0);
    let edited = await expandTerms(P, CUST, [T(EMEA)]);
    await terms.updateTerm(P, EMEA, { filters: [{ type: 'filter', column: 'region', op: '=', value: 'EU' }] });
    const after = await expandTerms(P, CUST, [T(EMEA)]);
    ok('an edit changes the next expansion (read every time, no cache)', stableStringify(edited.steps) !== stableStringify(after.steps) && after.steps[0].op === '=');
    edited = after;
    ok('a caught refusal naming a term is typed by the route\'s tagger', termStep.tagTermRefusals<{ ok: false; error: string; code?: string; reason?: string }>({ ok: false, error: msg.termDeleted('Old term') }).reason === 'deleted');
  });
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
