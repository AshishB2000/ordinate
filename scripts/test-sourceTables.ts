// The source table doc store and the resolution of a dataset's source tables
// (docs/semantic-layer/02-source-tables.md: D1, D2, D4, D5, D9, D14, D15).
//
// 1. shape: D9 (which tables a dataset is built from, by its origin and its connection), the facts
//    caps, the doc and index sanitizers (they keep `facts` and `dismissed` a later PR writes).
//
//   npm run build:ts && node scripts/test-sourceTables.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { sanitizeOrigin }: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const { sourceTablesOf }: typeof import('../src/data/sourceTableOf') = require('../src/data/sourceTableOf');
const { sanitizeFacts, MAX_COMMENT, MAX_FACT_COLUMNS }: typeof import('../src/connectors/tableFacts') = require('../src/connectors/tableFacts');
const { sanitizeSourceDoc, sanitizeIndex }: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const { SAVE_KEYS }: typeof import('../src/analysis/recordDiff') = require('../src/analysis/recordDiff');

const C = '0b9f3c2a-7d1e-4f5a-9c8d-1e2f3a4b5c6d';
const DS = '5d2e9b71-3a4c-4e6f-8a1b-2c3d4e5f6a7b';
const [U1, U2, U3] = ['a1b2c3d4-0000-4000-8000-0000000000a1', 'a1b2c3d4-0000-4000-8000-0000000000a2', 'a1b2c3d4-0000-4000-8000-0000000000a3'];

function shape(): void {
  const of = (o: object, c?: object) => JSON.stringify(sourceTablesOf(sanitizeOrigin({ kind: 'connection', connId: C, ...o }), c));
  ok('D9: a table import', of({ table: 'ANALYTICS.ORDERS' }) === '["ANALYTICS.ORDERS"]');
  ok('D9: a query with no link reads none', of({ sql: 'select 1' }) === '[]');
  ok('D9/D11: linked tables win over table', of({ table: 'orders', readsTables: ['PUBLIC.ORDERS'] }) === '["PUBLIC.ORDERS"]');
  ok('D9/D11: …and over a query, so a link is how a query gets its tables', of({ sql: 'select 1', readsTables: ['PUBLIC.ORDERS', 'PUBLIC.USERS'] }) === '["PUBLIC.ORDERS","PUBLIC.USERS"]');
  ok('D9: before the workbench, the connection\'s table', of({}, { table: 'public.t' }) === '["public.t"]' && of({}, { table: 'public.t', query: 'select 2' }) === '[]');
  ok('D9: …a blank saved table or query counts as none', of({}, { table: '  ' }) === '[]' && of({}, { table: 'public.t', query: '  ' }) === '["public.t"]');
  ok('D9: a connection that is gone has no fallback', of({}, undefined) === '[]');
  ok('D9: the origin\'s own selection wins over the connection\'s', of({ table: 'orders' }, { table: 'public.t' }) === '["orders"]' && of({ sql: 'select 1' }, { table: 'public.t' }) === '[]');
  ok('D9: a file, a combine, a SQL dataset: none', ['file', 'combined', 'sql', 'notebook'].every((k) => sourceTablesOf({ kind: k } as never, { table: 'public.t' }).length === 0));
  ok('D9: no origin: none', sourceTablesOf(undefined, { table: 'public.t' }).length === 0);

  const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'int' }));
  const clipped = sanitizeFacts({ comment: 'x'.repeat(3000), rowEstimate: NaN, columns: cols(2001) });
  ok('facts: strings clipped, a NaN estimate dropped, 2,001 columns cut', clipped !== null && clipped.comment!.length === MAX_COMMENT && !('rowEstimate' in clipped) && clipped.columns.length === MAX_FACT_COLUMNS);
  ok('facts: no columns array, no facts', sanitizeFacts({ comment: 'x' }) === null && sanitizeFacts(null) === null && sanitizeFacts('x') === null);
  const full = sanitizeFacts({
    comment: 'Orders', columns: [{ name: 'ID', type: 'NUMBER', nullable: false, comment: 'Key', key: true }, { name: 'D', type: 'DATE', key: false, nullable: 'yes', extra: 1 }],
    primaryKey: { columns: ['ID'], enforced: false }, partition: { columns: ['D'], method: 'RANGE', required: true }, clusterBy: ['D'], sortKey: ['D'],
    distribution: { style: 'KEY', columns: ['ID'] }, indexes: [{ name: 'pk', columns: ['ID'], unique: true, kind: 'btree' }, { name: 5 }],
    rowEstimate: 48_200_000, bytes: 12_400_000_000, lastModified: '2026-11-01T10:00:00Z',
  })!;
  ok('facts: a full read keeps every field', full.columns[0].key === true && full.columns[0].nullable === false && full.primaryKey!.enforced === false && full.partition!.required === true
    && full.clusterBy![0] === 'D' && full.sortKey![0] === 'D' && full.distribution!.style === 'KEY' && full.indexes!.length === 1 && full.rowEstimate === 48_200_000 && full.bytes === 12_400_000_000
    && full.lastModified === '2026-11-01T10:00:00Z', JSON.stringify(full));
  ok('facts: a bad field is dropped, never kept (key:false, nullable:"yes", an unknown key, an index with no columns)', !('key' in full.columns[1]) && !('nullable' in full.columns[1]) && !('extra' in full.columns[1]), JSON.stringify(full.columns[1]));
  const bad = sanitizeFacts({ columns: cols(1), rowEstimate: -1, bytes: Infinity, lastModified: 'yesterday', primaryKey: { columns: [], enforced: true }, clusterBy: [], indexes: 'x', partition: { columns: 'D' } })!;
  ok('facts: a negative or infinite figure, a date that is not one, an empty key and a malformed field are dropped',
    Object.keys(bad).join() === 'columns', JSON.stringify(bad));
  ok('facts: key lists are capped at 32 columns, indexes at 50', ((f) => f.primaryKey!.columns.length === 32 && f.indexes!.length === 50)(sanitizeFacts({
    columns: cols(1), primaryKey: { columns: Array.from({ length: 40 }, (_, i) => `k${i}`), enforced: true },
    indexes: Array.from({ length: 60 }, (_, i) => ({ name: `i${i}`, columns: ['a'], unique: false })),
  })!));
  ok('facts: sanitizing twice is sanitizing once', JSON.stringify(sanitizeFacts(full)) === JSON.stringify(full) && JSON.stringify(sanitizeFacts(clipped)) === JSON.stringify(clipped));

  ok('doc: no table, no doc', sanitizeSourceDoc({ owner: 'a' }) === null && sanitizeSourceDoc({ table: '   ' }) === null && sanitizeSourceDoc(null) === null && sanitizeSourceDoc({ table: 'x'.repeat(1001) }) === null);
  const doc = sanitizeSourceDoc({
    table: ' T ', owner: 'o'.repeat(100), refresh: 'r', requiredFilters: 'f', guide: 'g'.repeat(9000), updatedBy: 'u', updatedAt: 'now',
    facts: { columns: [{ name: 'a', type: 'int' }], readAt: 'x', readBy: 'y' },
    dismissed: { [DS]: { columns: { discount: 'AbCdEf012345', bad: 'the comment text' }, table: 'short', key: 'ZyXwVu987654' }, 'not-an-id': { table: 'AbCdEf012345' } },
  })!;
  ok('doc: the table is trimmed at the ends only and every field is clipped', doc.table === 'T' && doc.owner.length === 80 && doc.guide.length === 8000 && doc.schemaVersion === 1);
  ok('doc: facts and dismissals survive a read (a later PR writes them)', doc.facts!.columns.length === 1 && doc.facts!.readAt === 'x' && doc.facts!.readBy === 'y' && doc.dismissed![DS].columns!.discount === 'AbCdEf012345' && doc.dismissed![DS].key === 'ZyXwVu987654', JSON.stringify(doc));
  ok('doc: a dismissal that is not a short hash is dropped, and so is a dataset id that is not one', !('bad' in doc.dismissed![DS].columns!) && !('table' in doc.dismissed![DS]) && Object.keys(doc.dismissed!).join() === DS, JSON.stringify(doc.dismissed));
  ok('doc: sanitizing twice is sanitizing once', JSON.stringify(sanitizeSourceDoc(doc)) === JSON.stringify(doc));
  ok('doc: a doc with neither facts nor dismissals has neither key', !('facts' in sanitizeSourceDoc({ table: 'T' })!) && !('dismissed' in sanitizeSourceDoc({ table: 'T', dismissed: { [DS]: { columns: { a: 'bad' } } } })!));
  ok('doc: a column named __proto__ is data, not a prototype', ((d) => Object.keys(d.dismissed![DS].columns!).join() === '__proto__' && ({} as { polluted?: unknown }).polluted === undefined)(
    sanitizeSourceDoc({ table: 'T', dismissed: JSON.parse(`{"${DS}":{"columns":{"__proto__":"AbCdEf012345"}}}`) })!));

  ok('index: a second entry for one exact name is dropped, case kept', sanitizeIndex([{ table: 'T', docId: U1 }, { table: 'T', docId: U2 }, { table: 't', docId: U3 }]).map((e) => e.docId).join() === `${U1},${U3}`);
  ok('index: an entry without a valid doc id or a name is dropped; the rest is rebuilt key by key',
    JSON.stringify(sanitizeIndex([{ table: 'T', docId: 'nope' }, { table: '', docId: U1 }, { table: ' A ', docId: U2, owner: 'o', hasGuide: 1, readAt: 'x', extra: 1 }, 7]))
    === JSON.stringify([{ table: 'A', docId: U2, owner: 'o', hasGuide: false, readAt: 'x' }]));
  ok('index: not a list reads as empty; capped at 2,000', sanitizeIndex({}).length === 0 && sanitizeIndex(Array.from({ length: 2100 }, (_, i) => ({ table: `t${i}`, docId: `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}` }))).length === 2000);
  ok('the edit tag covers the four human fields only', SAVE_KEYS.sourceTable.join() === 'owner,refresh,requiredFilters,guide');
}

(async () => {
  shape();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
