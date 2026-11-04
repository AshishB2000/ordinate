// A glossary `term` filter step (semantic layer, PR 05a) is a step this pod does not know how to
// expand. Every reader that cannot read it REFUSES the figure with a typed `code: 'term'` — never
// skips it, never drops it. This suite grows task by task; part 1: the JS fold and Prepare.
//
//   § fold   a term reaching applyPipeline throws TermNotExpandedError (typed, with the catalog's
//            sentence); an unknown Prepare step still skips with its warning; Prepare never keeps a term
//
//   npm run build:ts && node scripts/test-termGuards.js

import { ok, finish } from './selfcheck';
import type { FilterStep, TableData, TransformStep } from '../src/data/transforms';

const { applyPipeline, sanitizeSteps } = require('../src/data/transforms') as typeof import('../src/data/transforms');
const ts: typeof import('../src/data/termStep') = require('../src/data/termStep');
const msgs: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
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

finish();
