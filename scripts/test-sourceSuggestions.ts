// A source table's facts as suggestions (semantic layer part 2, PR 09; docs/semantic-layer/02-source-tables.md).
//
// 1. the rule: `suggestionsFor` is pure. Exact names, one answer per kind and name, a hash for a dismissal.
// 2. the channels: `catalog:suggestions` and `catalog:dismissSuggestion` over the real route. Never silent:
//    the catalog's bytes do not move on a read or a suggestion, and move on a planted auto-apply (the control).
//
//   npm run build:ts && node scripts/test-sourceSuggestions.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, hydrated, type Reply } from './liveRouteHarness';

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

async function channels(): Promise<void> {
  const { fakeMod, fake, ORG_A } = H;
  const path: typeof import('path') = require('path');
  const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
  const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const api: typeof import('../src/api/index') = require('../src/api/index');
  const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
  const s = await H.as(ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject('Suggestions')).id;
    await fakeMod.loadWarehouseTable('wh_orders', [{ name: 'line_id', type: 'number' }, { name: 'discount', type: 'number' }, { name: 'region', type: 'text' }], [[1, 2, 'EU']] as never);
    const conn = await H.connections.saveConnection(P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    if (!conn) throw new Error('connection not saved');
    const live = async (name: string) => {
      const r = await H.liveRecord.saveLiveRecord(P, { name, columns: [{ name: 'line_id', type: 'number' }, { name: 'discount', type: 'number' }, { name: 'region', type: 'text' }], origin: { kind: 'connection', connId: conn.id, table: 'wh_orders' } });
      if (!r) throw new Error('not saved');
      return r.id;
    };
    const [L, L2, L3] = [await live('Orders'), await live('Orders two'), await live('Orders three')];
    await catalog.setColumn(P, L, 'region', { description: 'Region of sale' });
    const doc = await store.createSourceDoc(P, conn.id, 'wh_orders', {});
    if (!doc.ok) throw new Error(doc.error);
    const facts = (comment: string) => ({ comment, columns: [{ name: 'discount', type: 'double', comment: 'Discount in USD, after tax' }, { name: 'region', type: 'text', comment: 'Sales region' }, { name: 'line_id', type: 'int', key: true as const }], primaryKey: { columns: ['line_id'], enforced: true }, readAt: '2026-11-01T00:00:00.000Z', readBy: 'sam' });
    await store.updateSourceDoc(P, conn.id, doc.docId, (d) => ({ ...d, facts: facts('Order lines') }));
    return { P, C: conn.id, D: doc.docId, L, L2, L3, facts };
  });
  const { P, C, D, L, L2, L3 } = s;
  const bytes = () => H.as(ORG_A, () => recordFs.readFile(path.join(appPaths.userData(), 'projects', P, 'catalog.json'), 'utf8'));
  const docText = () => H.as(ORG_A, () => recordFs.readFile(store.docPath(P, C, D), 'utf8'));
  const sug = async (id: string): Promise<Reply[]> => (await post('catalog:suggestions', { projectId: P, datasetId: id })).value.suggestions;
  const n0 = fake.catalogCalls;
  const h0 = hydrated.length;

  const c0 = await bytes();
  const c1 = await bytes();
  const got = (await post('catalog:suggestions', { projectId: P, datasetId: L })).value;
  const c2 = await bytes();
  ok('never silent: the catalog is byte-identical before, and after catalog:suggestions', c0 === c1 && c1 === c2);
  ok('suggestions: discount, the table comment, the key (region has a meaning)', got.ok === true && got.suggestions.map((x: Reply) => x.kind + ':' + (x.column ?? '')).join() === 'column:discount,table:,key:', JSON.stringify(got));
  // The planted auto-apply, on a second dataset of the same table, so L's later asserts stay clean.
  const p0 = await bytes();
  await H.as(ORG_A, () => catalog.setColumn(P, L3, 'discount', { description: got.suggestions[0].text }));
  ok('NEGATIVE CONTROL: a planted setColumn in the path is caught by the same comparison', p0 !== (await bytes()));

  await post('catalog:setColumn', { projectId: P, datasetId: L, column: 'discount', patch: { description: got.suggestions[0].text } }); // Use
  ok('Use: the meaning is the dataset\'s own, and the suggestion is gone', (await post('catalog:columns', { projectId: P, datasetId: L })).value.columns.discount.description === 'Discount in USD, after tax' && !(await sug(L)).some((x) => x.column === 'discount'));

  const tableSug = (await sug(L)).find((x) => x.kind === 'table') as Reply;
  const dis = await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: D, kind: 'table', hash: tableSug.hash });
  ok('Dismiss: ok', dis.value.ok === true, dis.body);
  ok('Dismiss sticks, for this dataset only', !(await sug(L)).some((x) => x.kind === 'table') && (await sug(L2)).some((x) => x.kind === 'table'));
  ok('Dismiss stores the hash, never the text', ((raw) => raw.includes(tableSug.hash) && !JSON.stringify(JSON.parse(raw).dismissed).includes('Order lines'))(await docText()));
  await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: D, kind: 'column', column: '__proto__', hash: 'AbCdEf012345' });
  ok('Dismiss of a column named __proto__ is data, not a prototype', ((raw) => Object.keys(JSON.parse(raw).dismissed[L].columns).join() === '__proto__')(await docText()));

  await H.as(ORG_A, () => store.updateSourceDoc(P, C, D, (d) => ({ ...d, facts: s.facts('Order lines (net)') })));
  ok('a changed comment returns', (await sug(L)).some((x) => x.kind === 'table' && x.text === 'Order lines (net)'));
  const total = (await post('catalog:suggestions', { projectId: P })).value;
  ok('the project total is the server\'s, and counts the datasets with one', total.total === (await sug(L)).length + (await sug(L2)).length + (await sug(L3)).length && total.datasets === 3, JSON.stringify([total.total, total.datasets]));
  ok('records only: no warehouse call, nothing hydrated', fake.catalogCalls === n0 && hydrated.length === h0);
  ok('a hash that is not 12 url-safe chars is refused at the door', (await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: D, kind: 'table', hash: 'the text itself' })).status === 400);
  ok('a column suggestion with no column is refused at the door', (await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: D, kind: 'column', hash: 'AbCdEf012345' })).status === 400);
  const gone = (await post('catalog:dismissSuggestion', { projectId: P, datasetId: L, connId: C, docId: '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6e', kind: 'key', hash: 'AbCdEf012345' })).value;
  ok('a doc that is gone gets the sentence', gone.ok === false && typeof gone.error === 'string');
  const contracts = api.contracts as unknown as Record<string, { access: string; project(i: unknown): unknown }>;
  ok('contracts: both write, scoped by projectId', ['catalog:suggestions', 'catalog:dismissSuggestion'].every((n) => contracts[n]?.access === 'write' && contracts[n].project({ projectId: P }) === P));

  // The cap: one doc keeps 500 datasets' dismissals. A dataset no longer listed loses its own first; still full is a sentence, never a silent ok.
  const others = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const plant = () => H.as(ORG_A, () => store.updateSourceDoc(P, C, D, (d) => ({ ...d, dismissed: { ...d.dismissed, ...Object.fromEntries(others.map((id) => [id, { table: 'AbCdEf012345' }])) } })));
  const dismissed = async (): Promise<Record<string, Reply>> => JSON.parse(await docText()).dismissed;
  const dismiss = async (datasetId: string, kind = 'table') => (await post('catalog:dismissSuggestion', { projectId: P, datasetId, connId: C, docId: D, kind, hash: 'AbCdEf012345' })).value;
  await plant();
  const pruned = await dismiss(L2);
  ok('dismiss cap: the dismissals of datasets that are gone go, so a new one fits', pruned.ok === true && ((d) => L2 in d && L in d && !others.some((id) => id in d))(await dismissed()), JSON.stringify(pruned));
  const realList = H.datasets.listDatasets;
  (H.datasets as { listDatasets: unknown }).listDatasets = async (p: string) => [...(await realList(p)), ...others.map((id) => ({ id }))];
  try {
    await plant();
    const full = await dismiss(L3);
    ok('dismiss cap: full of listed datasets: the sentence, nothing stored', full.ok === false && full.error === 'These notes already keep dismissed suggestions for 500 datasets.' && !(L3 in (await dismissed())), JSON.stringify(full));
    ok('NEGATIVE CONTROL: a dataset already on the full doc can still dismiss', (await dismiss(L, 'key')).ok === true && (await dismissed())[L].key === 'AbCdEf012345');
  } finally {
    (H.datasets as { listDatasets: unknown }).listDatasets = realList;
  }
}

(async () => {
  pure();
  await channels();
  await close();
  finish();
})().catch((err: unknown) => { console.error(err); process.exit(1); });
