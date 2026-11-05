// A source table's facts as suggestions (semantic layer part 2, PR 09; docs/semantic-layer/02-source-tables.md).
//
// 1. the rule: `suggestionsFor` is pure. Exact names, one answer per kind and name, a hash for a dismissal.
// 2. the channels: `catalog:suggestions` and `catalog:dismissSuggestion` over the real route. Never silent:
//    the catalog's bytes do not move on a read or a suggestion, and move on a planted auto-apply (the control).
//
//   npm run build:ts && node scripts/test-sourceSuggestions.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { suggestionsFor, hashOf }: typeof import('../src/analysis/sourceSuggestions') = require('../src/analysis/sourceSuggestions');
type Suggestion = import('../src/analysis/sourceSuggestions').Suggestion;

const C = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6d';
const D1 = 'a1b2c3d4-0000-4000-8000-0000000000a1';
const D2 = 'a1b2c3d4-0000-4000-8000-0000000000a2';
const DS = 'd5d5d5d5-0000-4000-8000-0000000000d5';
const EMPTY_DOC = { table: 'T', owner: '', refresh: '', requiredFilters: '', guide: '', updatedBy: '', updatedAt: '', schemaVersion: 1 as const };

function pure(): void {
  const doc = (facts: object, dismissed?: object) => ({ connId: C, docId: D1, table: 'T', doc: { ...EMPTY_DOC, facts: { readAt: 'x', readBy: 'y', columns: [], ...facts }, ...(dismissed ? { dismissed: { [DS]: dismissed } } : {}) } as never });
  const F = { comment: 'Order lines', columns: [{ name: 'discount', type: 'double', comment: 'Discount in USD, after tax' }, { name: 'region', type: 'text', comment: 'Sales region' }, { name: 'line_id', type: 'int', key: true }], primaryKey: { columns: ['line_id'], enforced: true } };
  const base = { datasetId: DS, columns: ['line_id', 'discount', 'region'], columnDocs: { region: { description: 'Region of sale' } }, description: '', key: '' };
  const kinds = (s: Suggestion[]) => s.map((x) => `${x.kind}:${x.column ?? ''}:${x.text}`).join('|');
  ok('a column with no meaning, the table comment, the key', kinds(suggestionsFor({ ...base, docs: [doc(F)] })) === 'column:discount:Discount in USD, after tax|table::Order lines|key::line_id');
  ok('a column that has a meaning gets none', !suggestionsFor({ ...base, docs: [doc(F)] }).some((s) => s.column === 'region'));
  ok('a renamed column gets none', !suggestionsFor({ ...base, columns: ['line_id', 'disc'], docs: [doc(F)] }).some((s) => s.kind === 'column'));
  ok('two tables, different comments for one name: none for that name only', ((s) => !s.some((x) => x.column === 'discount') && s.some((x) => x.kind === 'table'))(suggestionsFor({ ...base, docs: [doc(F), { ...doc({ columns: [{ name: 'discount', type: 'double', comment: 'Share of list price' }] }), docId: D2 }] })));
  ok('two tables, the same comment: one suggestion', suggestionsFor({ ...base, docs: [doc(F), { ...doc(F), docId: D2 }] }).filter((s) => s.column === 'discount').length === 1);
  ok('two tables, different table comments: none', !suggestionsFor({ ...base, docs: [doc(F), { ...doc({ comment: 'Other' }), docId: D2 }] }).some((s) => s.kind === 'table'));
  ok('two tables, different single keys: none', !suggestionsFor({ ...base, docs: [doc(F), { ...doc({ primaryKey: { columns: ['region'], enforced: false } }), docId: D2 }] }).some((s) => s.kind === 'key'));
  ok('a composite key suggests nothing', !suggestionsFor({ ...base, docs: [doc({ ...F, primaryKey: { columns: ['line_id', 'region'], enforced: true } })] }).some((s) => s.kind === 'key'));
  ok('a key whose column the dataset lacks suggests nothing', !suggestionsFor({ ...base, columns: ['discount'], docs: [doc(F)] }).some((s) => s.kind === 'key'));
  ok('a dataset with a key gets no key suggestion', !suggestionsFor({ ...base, key: 'line_id', docs: [doc(F)] }).some((s) => s.kind === 'key'));
  ok('a dataset with a description gets no table suggestion', !suggestionsFor({ ...base, description: 'Mine', docs: [doc(F)] }).some((s) => s.kind === 'table'));
  ok('a doc with no facts is skipped', suggestionsFor({ ...base, docs: [{ connId: C, docId: D1, table: 'T', doc: EMPTY_DOC as never }] }).length === 0);
  ok('a suggestion names its doc and table', ((s) => s.connId === C && s.docId === D1 && s.table === 'T' && s.datasetId === DS)(suggestionsFor({ ...base, docs: [doc(F)] })[0]));
  ok('a dismissal holds while the text is the same', !suggestionsFor({ ...base, docs: [doc(F, { table: hashOf('Order lines') })] }).some((s) => s.kind === 'table'));
  ok('a column dismissal holds for that column only', ((s) => !s.some((x) => x.column === 'discount') && s.some((x) => x.kind === 'key'))(suggestionsFor({ ...base, docs: [doc(F, { columns: { discount: hashOf('Discount in USD, after tax') } })] })));
  ok('a key dismissal holds', !suggestionsFor({ ...base, docs: [doc(F, { key: hashOf('line_id') })] }).some((s) => s.kind === 'key'));
  ok('NEGATIVE CONTROL: a changed comment is offered again', suggestionsFor({ ...base, docs: [doc({ ...F, comment: 'Order lines (net)' }, { table: hashOf('Order lines') })] }).some((s) => s.kind === 'table'));
  ok('hashOf: 12 url-safe chars, stable', /^[A-Za-z0-9_-]{12}$/.test(hashOf('x')) && hashOf('x') === hashOf('x') && hashOf('x') !== hashOf('y'));
}

(async () => {
  pure();
  finish();
})().catch((err: unknown) => { console.error(err); process.exit(1); });
