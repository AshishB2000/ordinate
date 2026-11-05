// A glossary `term` filter step (semantic layer, PR 05a) is a step this pod does not know how to
// expand. Every reader that cannot read it REFUSES the figure with a typed `code: 'term'` — never
// skips it, never drops it. This suite grows task by task; part 1: the JS fold and Prepare; part 2:
// the resident predicate, the Live compiler and the answer spec's steps.
//
//   § fold    a term reaching applyPipeline throws TermNotExpandedError (typed, with the catalog's
//             sentence); an unknown Prepare step still skips with its warning; Prepare never keeps a term
//   § engines the resident predicate, every Live adapter and the answer spec's steps throw the same
//             error; an unknown column still skips with its warning (negative control)
//
//   npm run build:ts && node scripts/test-termGuards.js

import { ok, finish } from './selfcheck';
import type { FilterStep, TableData, TransformStep } from '../src/data/transforms';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { AnswerSpec } from '../src/ai/answerSpec';
import type { VizEncoding } from '../src/analysis/visuals';

const { applyPipeline, sanitizeSteps } = require('../src/data/transforms') as typeof import('../src/data/transforms');
const ts: typeof import('../src/data/termStep') = require('../src/data/termStep');
const msgs: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const { filterPredicate, filterPredicates }: typeof import('../src/engine/residentFilter') = require('../src/engine/residentFilter');
const { filterCannotWarn }: typeof import('../src/ipc/visualsResident') = require('../src/ipc/visualsResident');
const { fromVizEncoding, fromMetric, fromAnswerSpec, adaptFilter }: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const { specFilterSteps }: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const { isTermNotExpandedError, isTermStep, TermNotExpandedError, termRefusal, TERM_CODE } = ts;

const SRC: TableData = {
  columns: [{ name: 'a', type: 'number' }],
  rows: [[1], [2], [3]],
};

// ── § fold ──────────────────────────────────────────────────────────────────
const T = { type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666' } as unknown as FilterStep;
let thrown: unknown = null;
try { applyPipeline(SRC, [T]); } catch (e) { thrown = e; }
ok('a term step reaching applyPipeline throws, typed', isTermNotExpandedError(thrown) && (thrown as InstanceType<typeof TermNotExpandedError>).reason === 'not_expanded');
ok('the thrown error carries the catalog sentence and the code', (thrown as Error).message === msgs.termNotExpanded() && (thrown as { code?: unknown }).code === TERM_CODE);
const r = applyPipeline(SRC, [{ type: 'nope' } as unknown as TransformStep]);
ok('NEGATIVE CONTROL: an unknown Prepare step still skips with its warning', r.rowCount === SRC.rows.length && r.warnings[0] === 'Unknown step type "nope" skipped');
ok('Prepare never accepts a term', sanitizeSteps([T]).length === 0);
ok('sanitizeSteps is re-exported unchanged', sanitizeSteps([{ type: 'filter', column: 'a', op: '=', value: 1 }]).length === 1);

// ── the type, the typing, the refusal ───────────────────────────────────────
ok('isTermStep: type term and a string term', isTermStep(T) && isTermStep({ type: 'term', term: 'x', fromControl: true }));
ok('NEGATIVE CONTROL: isTermStep refuses a non-string term, another type, null', !isTermStep({ type: 'term', term: 5 }) && !isTermStep({ type: 'filter', term: 'x' }) && !isTermStep(null) && !isTermStep('term'));
ok('the default message is the unreadable sentence for "unreadable"', new TermNotExpandedError('unreadable').message === msgs.termUnreadable());
ok('the other reasons take the not-expanded sentence unless given one', new TermNotExpandedError('deleted').message === msgs.termNotExpanded() && new TermNotExpandedError('deleted', 'gone').message === 'gone');
ok('isTermNotExpandedError also recognises a copy of the class by name and code', isTermNotExpandedError({ name: 'TermNotExpandedError', code: 'term' }) && !isTermNotExpandedError(new Error('x')) && !isTermNotExpandedError(null));
const refusal = termRefusal(new TermNotExpandedError('unreadable'));
ok('termRefusal is {ok:false, code, reason, error}', refusal.ok === false && refusal.code === 'term' && refusal.reason === 'unreadable' && refusal.error === msgs.termUnreadable());

// ── § engines ───────────────────────────────────────────────────────────────
const U = '7d2c1f4e-1111-4222-8333-444455556666';
const throwsTerm = (fn: () => unknown): boolean => {
  try { fn(); } catch (e) { return isTermNotExpandedError(e) && (e as InstanceType<typeof TermNotExpandedError>).reason === 'not_expanded'; }
  return false;
};
const COLS = [{ name: 'region', type: 'text' }, { name: 'sales', type: 'number' }] as const;
const LIVE_COLS: LiveColumn[] = COLS.map((c) => ({ ...c }));
const ENC: VizEncoding = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] };
const SPEC: AnswerSpec = { datasetId: 'd', category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 't' };
const ROWS = [['East', 1], ['West', 2]];

ok('Live chart compile throws on a term', throwsTerm(() => fromVizEncoding(ENC, [T], LIVE_COLS)));
ok('Live KPI compile throws on a term', throwsTerm(() => fromMetric({ column: 'sales', aggregation: 'sum' }, [T], LIVE_COLS)));
ok('Live answer compile throws on a term', throwsTerm(() => fromAnswerSpec({ ...SPEC, filters: [{ term: U }] }, LIVE_COLS)));
ok('resident predicate throws on a term', throwsTerm(() => filterPredicate([...COLS], T, [])));
ok('answer steps throw on a term', throwsTerm(() => specFilterSteps({ filters: [{ term: U }] }, [...COLS], ROWS)));
ok('a term in a resident list throws, and the resident warning gate hands it to the JS fold (which throws)', throwsTerm(() => filterPredicates([...COLS], [T], [])) && filterCannotWarn(T, new Set(['region', 'sales'])) === false);
// A malformed `type: 'term'` step (no id, a non-string id) is kept by the list sanitizer and refused by the JS
// fold, so every engine refuses it too — 'unreadable', since there is no term to expand. Never a skip.
const reasonOf = (fn: () => unknown): string | null => {
  try { fn(); } catch (e) { return isTermNotExpandedError(e) ? e.reason : null; }
  return null;
};
const BAD = [{ type: 'term' }, { type: 'term', term: 5 }] as unknown as FilterStep[];
for (const b of BAD) {
  const tag = JSON.stringify(b);
  ok(`resident predicate throws unreadable on ${tag}`, reasonOf(() => filterPredicate([...COLS], b, [])) === 'unreadable');
  ok(`Live KPI throws unreadable on ${tag}`, reasonOf(() => fromMetric({ column: 'sales', aggregation: 'sum' }, [b], LIVE_COLS)) === 'unreadable');
  ok(`Live chart throws unreadable on ${tag}`, reasonOf(() => fromVizEncoding(ENC, [b], LIVE_COLS)) === 'unreadable');
  ok(`Live answer and answer steps throw unreadable on ${tag}`, reasonOf(() => fromAnswerSpec({ ...SPEC, filters: [b as never] }, LIVE_COLS)) === 'unreadable'
    && reasonOf(() => specFilterSteps({ filters: [b as never] }, [...COLS], ROWS)) === 'unreadable');
  ok(`the JS fold refuses ${tag} too`, isTermNotExpandedError((() => { try { applyPipeline(SRC, [b]); } catch (e) { return e; } return null; })()));
}
ok('a term inside the Live lock throws', throwsTerm(() => fromAnswerSpec(SPEC, LIVE_COLS, { lock: [T] }))
  && reasonOf(() => fromAnswerSpec(SPEC, LIVE_COLS, { lock: [BAD[0]] })) === 'unreadable');
ok('a well-formed term is not_expanded, not unreadable', reasonOf(() => filterPredicate([...COLS], T, [])) === 'not_expanded' && reasonOf(() => specFilterSteps({ filters: [{ term: U }] }, [...COLS], ROWS)) === 'not_expanded');
ok('NEGATIVE CONTROL: an unknown column still skips with its warning', (() => {
  const w: string[] = [];
  return adaptFilter({ type: 'filter', column: 'zz', op: '=', value: 1 }, LIVE_COLS, {}, w) === null && w[0] === 'Filter skipped: unknown column "zz"';
})());
ok('NEGATIVE CONTROL: the resident predicate still skips an unknown column and still compiles a known one', filterPredicate([...COLS], { type: 'filter', column: 'zz', op: '=', value: 1 }, []) === null
  && typeof filterPredicate([...COLS], { type: 'filter', column: 'sales', op: '>', value: 1 }, []) === 'string');
ok('NEGATIVE CONTROL: a term-free list still compiles on every Live adapter', fromVizEncoding(ENC, [], LIVE_COLS).ok === true && fromMetric({ column: 'sales', aggregation: 'sum' }, [], LIVE_COLS).ok === true);

finish();
