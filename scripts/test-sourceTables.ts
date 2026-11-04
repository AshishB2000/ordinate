// The source table doc store and the resolution of a dataset's source tables
// (docs/semantic-layer/02-source-tables.md: D1, D2, D4, D5, D9, D14, D15).
//
// 1. shape: D9 (which tables a dataset is built from, by its origin and its connection), the facts
//    caps, the doc and index sanitizers (they keep `facts` and `dismissed` a later PR writes).
// 2. store: create (idempotent by exact name, D2), save with the edit-conflict `base`, delete, the
//    crash between doc and index, the cap, a corrupt record, and what a facts write may not touch.
//
//   npm run build:ts && node scripts/test-sourceTables.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close } from './liveRouteHarness';
import { captureLogs } from './logCapture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

const { sanitizeOrigin }: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const { sourceTablesOf }: typeof import('../src/data/sourceTableOf') = require('../src/data/sourceTableOf');
const { sanitizeFacts, MAX_COMMENT, MAX_FACT_COLUMNS }: typeof import('../src/connectors/tableFacts') = require('../src/connectors/tableFacts');
const { sanitizeSourceDoc, sanitizeIndex }: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const { SAVE_KEYS }: typeof import('../src/analysis/recordDiff') = require('../src/analysis/recordDiff');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const { isRecordChanged }: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const messages: typeof import('../src/app/sourceTableMessages') = require('../src/app/sourceTableMessages');

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

async function storing(): Promise<void> {
  const { createSourceDoc, saveSourceDoc, readSourceDoc, listSourceIndex, deleteSourceDoc, updateSourceDoc, docPath, indexPath, MAX_SOURCE_DOCS } = store;
  const { P, C, C2 } = await H.as(H.ORG_A, async () => {
    await H.projects.init();
    const pid = (await H.projects.createProject('Source tables')).id;
    const conn = async (name: string) => (await H.connections.saveConnection(pid, { name, connectorId: H.fakeMod.LIVE_FAKE_ID, values: {} }))!.id;
    return { P: pid, C: await conn('Warehouse'), C2: await conn('Full') };
  });
  const inA = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
  const dir = (c: string) => path.join(H.DATA, 'orgs', 'acme', 'userData', 'projects', P, 'connections', c);
  const docsOnDisk = (c: string): number => (fs.existsSync(path.join(dir(c), 'tables')) ? fs.readdirSync(path.join(dir(c), 'tables')).filter((n) => n.endsWith('.json')).length : 0);
  const listed = (c = C) => inA(() => listSourceIndex(P, c));

  ok('paths are built from UUIDs only', ['../x', 'nope', ''].every((bad) => { try { docPath(P, C, bad); return false; } catch { return true; } }) && (() => { try { indexPath('..', C); return false; } catch { return true; } })());
  ok('a bad id reads as nothing (never a path)', (await inA(() => readSourceDoc(P, C, '../x'))) === null && (await inA(() => listSourceIndex('x', C))).length === 0 && (await inA(() => deleteSourceDoc(P, C, 'nope'))) === false
    && (await inA(() => saveSourceDoc(P, C, 'nope', { guide: 'x' }))) === null);
  ok('an empty connection lists nothing', (await listed()).length === 0);

  const a = await inA(() => createSourceDoc(P, C, 'ANALYTICS.ORDERS', { owner: 'Data platform' }));
  if (!a.ok) throw new Error('create refused: ' + a.error);
  ok('create: a doc and its entry', a.created && (await listed())[0].docId === a.docId && (await listed())[0].owner === 'Data platform' && docsOnDisk(C) === 1);
  const b = await inA(() => createSourceDoc(P, C, 'ANALYTICS.ORDERS', { owner: 'Someone else' }));
  ok('create: the same exact name returns that doc, unchanged', b.ok && b.docId === a.docId && b.created === false && (await inA(() => readSourceDoc(P, C, a.docId)))!.rec.owner === 'Data platform' && docsOnDisk(C) === 1);
  const lower = await inA(() => createSourceDoc(P, C, 'analytics.orders', {}));
  if (!lower.ok) throw new Error('create refused: ' + lower.error);
  ok('create: another case is another table (D2)', lower.docId !== a.docId && lower.created && (await listed()).length === 2);
  const padded = await inA(() => createSourceDoc(P, C, '  ANALYTICS.ORDERS  ', {}));
  ok('create: the name is trimmed at the ends, so padding finds the same doc', padded.ok && padded.docId === a.docId);
  const raced = await Promise.all([0, 1].map(() => inA(() => createSourceDoc(P, C, 'RACE', {}))));
  ok('create: two at once for one name make one doc and both answer it', raced.every((r) => r.ok) && raced[0].ok && raced[1].ok && raced[0].docId === raced[1].docId
    && raced.filter((r) => r.ok && r.created).length === 1 && (await listed()).filter((e) => e.table === 'RACE').length === 1 && docsOnDisk(C) === 3, JSON.stringify(raced));

  const t0 = (await inA(() => readSourceDoc(P, C, a.docId)))!.tag;
  const first = await inA(() => saveSourceDoc(P, C, a.docId, { guide: '# Filter on ORDER_DATE' }, t0));
  ok('save: the first save lands and answers the new tag', first !== null && first.rec.guide === '# Filter on ORDER_DATE' && first.tag !== t0 && first.tag === (await inA(() => readSourceDoc(P, C, a.docId)))!.tag);
  let stale: unknown = null;
  try { await inA(() => saveSourceDoc(P, C, a.docId, { guide: 'lost' }, t0)); } catch (e) { stale = e; }
  ok('save: a stale base is refused and nothing changes', isRecordChanged(stale) && (await inA(() => readSourceDoc(P, C, a.docId)))!.rec.guide === '# Filter on ORDER_DATE');
  ok('NEGATIVE CONTROL: the current tag saves, and so does no base at all', (await inA(() => saveSourceDoc(P, C, a.docId, { refresh: 'Hourly' }, first!.tag))) !== null && (await inA(() => saveSourceDoc(P, C, a.docId, { requiredFilters: 'ORDER_DATE' })))!.rec.refresh === 'Hourly');
  ok('save: the index follows (hasGuide)', (await listed()).find((e) => e.docId === a.docId)!.hasGuide === true && (await listed()).find((e) => e.docId === lower.docId)!.hasGuide === false);
  const sneaky = await inA(() => saveSourceDoc(P, C, a.docId, { guide: 'g', updatedBy: 'evil@x.test', table: 'OTHER', facts: {} } as never));
  ok('save: updatedBy is the caller, stamped here; the name and facts are not the payload\'s', sneaky!.rec.updatedBy === H.ORG_A.user.email && sneaky!.rec.table === 'ANALYTICS.ORDERS' && !('facts' in sneaky!.rec));
  ok('save: a field left out keeps its stored value; one sent empty clears it', (await inA(() => saveSourceDoc(P, C, a.docId, { owner: '' })))!.rec.requiredFilters === 'ORDER_DATE' && (await listed()).find((e) => e.docId === a.docId)!.owner === '');
  ok('save: a doc that is gone answers null', (await inA(() => saveSourceDoc(P, C, randomUUID(), { guide: 'x' }))) === null);

  // A facts write (PR 04) and a dismissal (PR 09) go through updateSourceDoc: they never move the edit tag, and a later save keeps them.
  const DS = randomUUID();
  const tagBefore = (await inA(() => readSourceDoc(P, C, a.docId)))!;
  const withFacts = await inA(() => updateSourceDoc(P, C, a.docId, (d) => ({ ...d, guide: 'SNEAKY', table: 'SNEAKY', updatedBy: 'evil', owner: 'Evil', facts: { columns: [{ name: 'ID', type: 'int' }], readAt: '2026-11-01T00:00:00Z', readBy: 'sam' }, dismissed: { [DS]: { table: 'AbCdEf012345' } } })));
  const afterFacts = (await inA(() => readSourceDoc(P, C, a.docId)))!;
  ok('update: facts and dismissals are stored', withFacts!.facts!.columns[0].name === 'ID' && afterFacts.rec.dismissed![DS].table === 'AbCdEf012345');
  ok('update: it cannot change the name, a typed field or who edited last', afterFacts.rec.table === 'ANALYTICS.ORDERS' && afterFacts.rec.guide === 'g' && afterFacts.rec.owner === '' && afterFacts.rec.updatedBy === tagBefore.rec.updatedBy && afterFacts.rec.updatedAt === tagBefore.rec.updatedAt);
  ok('update: the edit tag did not move, so an open editor saves without a 409', afterFacts.tag === tagBefore.tag && (await inA(() => saveSourceDoc(P, C, a.docId, { guide: 'g2' }, tagBefore.tag))) !== null);
  const resaved = (await inA(() => readSourceDoc(P, C, a.docId)))!.rec;
  ok('save after a facts write drops neither facts nor dismissals', resaved.facts?.readBy === 'sam' && resaved.dismissed?.[DS]?.table === 'AbCdEf012345');
  ok('update: the index entry carries when the facts were read', (await listed()).find((e) => e.docId === a.docId)!.readAt === '2026-11-01T00:00:00Z');
  ok('update: a doc that is gone answers null', (await inA(() => updateSourceDoc(P, C, randomUUID(), (d) => d))) === null);

  // The crash: the index write fails once.
  const real = recordFs.rename;
  const mutable = recordFs as { rename: typeof real };
  mutable.rename = async (f, t) => { if (t.endsWith('.tables.json')) { mutable.rename = real; throw new Error('crash'); } return real(f, t); };
  const docsBefore = docsOnDisk(C);
  const crashed = await inA(() => createSourceDoc(P, C, 'ANALYTICS.CRASH', {}).then((r) => r, () => ({ ok: false as const })));
  mutable.rename = real;
  ok('crash between doc and index: an error, an unlisted doc, never a dangling entry', !crashed.ok && !(await listed()).some((e) => e.table === 'ANALYTICS.CRASH') && docsOnDisk(C) === docsBefore + 1);
  const retried = await inA(() => createSourceDoc(P, C, 'ANALYTICS.CRASH', {}));
  ok('NEGATIVE CONTROL: the retry lists it, as a fresh doc', retried.ok && retried.created && (await listed()).some((e) => e.docId === (retried as { docId: string }).docId) && docsOnDisk(C) === docsBefore + 2);

  // Delete takes the entry out first.
  const realRm = recordFs.rm;
  const rmable = recordFs as { rm: typeof realRm };
  const victim = await inA(() => createSourceDoc(P, C, 'ANALYTICS.VICTIM', {}));
  if (!victim.ok) throw new Error('create refused');
  rmable.rm = async (p, o) => { if (p.endsWith(victim.docId + '.json')) { rmable.rm = realRm; throw new Error('crash'); } return realRm(p, o); };
  const deleteCrashed = await inA(() => deleteSourceDoc(P, C, victim.docId).then(() => false, () => true));
  rmable.rm = realRm;
  ok('crash during a delete: the entry is already gone, the doc is left unlisted', deleteCrashed && !(await listed()).some((e) => e.docId === victim.docId) && (await inA(() => readSourceDoc(P, C, victim.docId))) !== null);
  ok('delete: doc and entry go', (await inA(() => deleteSourceDoc(P, C, a.docId))) && !(await listed()).some((e) => e.docId === a.docId) && (await inA(() => readSourceDoc(P, C, a.docId))) === null);
  ok('delete: nothing to delete answers false', (await inA(() => deleteSourceDoc(P, C, a.docId))) === false);
  ok('delete: the name is free again', ((r) => r.ok && r.created && r.docId !== a.docId)(await inA(() => createSourceDoc(P, C, 'ANALYTICS.ORDERS', {}))));

  // A damaged record reads as missing, is logged (by file name, not by what it held) and is never fatal.
  const bad = randomUUID();
  fs.mkdirSync(path.join(dir(C), 'tables'), { recursive: true });
  const [badDoc, fullIndex] = await inA(async () => [docPath(P, C, bad), indexPath(P, C2)]);
  fs.writeFileSync(badDoc, '{');
  fs.writeFileSync(fullIndex, '{');
  const cap = captureLogs();
  const read = await inA(() => readSourceDoc(P, C, bad));
  const idx = await inA(() => listSourceIndex(P, C2));
  cap.restore();
  ok('a corrupt doc reads as missing, and a corrupt index as empty', read === null && idx.length === 0);
  ok('…and both are logged', cap.at('error').length === 2 && cap.at('error').every((l) => l.includes('[sourceTables]')), cap.lines.join(' | '));
  fs.writeFileSync(badDoc, JSON.stringify({ owner: 'no table' }));
  ok('a doc with no table reads as missing', (await inA(() => readSourceDoc(P, C, bad))) === null);

  // The cap: 2,000 entries are written straight into the index.
  const entry = (i: number) => ({ table: `t${i}`, docId: `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}`, owner: '', hasGuide: false });
  fs.writeFileSync(fullIndex, JSON.stringify(Array.from({ length: MAX_SOURCE_DOCS - 1 }, (_, i) => entry(i))));
  const last = await inA(() => createSourceDoc(P, C2, 'the-last-one', {}));
  ok('NEGATIVE CONTROL: with 1,999 documented, the 2,000th is made', last.ok && last.created && (await listed(C2)).length === MAX_SOURCE_DOCS);
  const over = await inA(() => createSourceDoc(P, C2, 'one-too-many', {}));
  ok('the 2,001st name is refused with a sentence, and leaves no doc', !over.ok && over.error === messages.sourceTablesFull() && over.error === 'This connection already documents 2,000 tables.' && docsOnDisk(C2) === 1 && (await listed(C2)).length === MAX_SOURCE_DOCS);
  ok('…but a name already documented still answers its doc', ((r) => r.ok && !r.created)(await inA(() => createSourceDoc(P, C2, 'the-last-one', {}))));
}

(async () => {
  shape();
  await storing();
  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
