// The source table doc store and the resolution of a dataset's source tables
// (docs/semantic-layer/02-source-tables.md: D1, D2, D4, D5, D9, D14, D15).
//
// 1. shape: D9 (which tables a dataset is built from, by its origin and its connection), the facts
//    caps, the doc and index sanitizers (they keep `facts` and `dismissed` a later PR writes).
// 2. store: create (idempotent by exact name, D2), save with the edit-conflict `base`, delete, the
//    crash between doc and index, the cap, a corrupt record, and what a facts write may not touch.
// 3. strip: sourceTodoOf (D5), the pure part of "To fill in next".
// 4. channels: the four `write` contracts over the real RPC route (D14): the list as the union of the
//    index and the tables datasets are built from (D4, D9), the strip, open, save (create / edit /
//    409), delete, a connection of another project; and that none of it touches a warehouse or a
//    dataset's rows. The viewer's 403 on each is in test-sourceNamesHidden (it needs Postgres roles).
// 5. read: `sourceTable:read` (p2-04, D6, D15): the facts stored with who and when, one catalog call
//    and nothing else touched, 60 an hour per connection, a connector with no catalog, a secret in a
//    comment. The cross-pod limit is in test-sourceNamesHidden.
//
//   npm run build:ts && node scripts/test-sourceTables.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, hydrates, type Reply } from './liveRouteHarness';
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
const list: typeof import('../src/app/sourceTableList') = require('../src/app/sourceTableList');
const api: typeof import('../src/api/index') = require('../src/api/index');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
type SourceRow = import('../src/app/sourceTableList').SourceRow;
type SourceConn = import('../src/app/sourceTableList').SourceConn;

// What a save tells the project's open editors (src/app/editConflict.ts), by spy.
const pushes: Array<{ channel: string; payload: { projectId: string; type: string; id: string; tag: string } }> = [];
(schedules as { pushToWriters: typeof schedules.pushToWriters }).pushToWriters = (_p, channel, payload) => { pushes.push({ channel, payload: payload as never }); };

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
  ok('save: the editors of the project hear the new tag', pushes.length > 0 && pushes[pushes.length - 1].channel === 'hub:record-saved'
    && JSON.stringify(pushes[pushes.length - 1].payload) === JSON.stringify({ projectId: P, type: 'sourceTable', id: a.docId, tag: first!.tag }), JSON.stringify(pushes.slice(-1)));
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
  const pushed = pushes.length;
  const withFacts = await inA(() => updateSourceDoc(P, C, a.docId, (d) => ({ ...d, guide: 'SNEAKY', table: 'SNEAKY', updatedBy: 'evil', owner: 'Evil', facts: { columns: [{ name: 'ID', type: 'int' }], readAt: '2026-11-01T00:00:00Z', readBy: 'sam' }, dismissed: { [DS]: { table: 'AbCdEf012345' } } })));
  const afterFacts = (await inA(() => readSourceDoc(P, C, a.docId)))!;
  ok('update: facts and dismissals are stored', withFacts!.facts!.columns[0].name === 'ID' && afterFacts.rec.dismissed![DS].table === 'AbCdEf012345');
  ok('update: it cannot change the name, a typed field or who edited last', afterFacts.rec.table === 'ANALYTICS.ORDERS' && afterFacts.rec.guide === 'g' && afterFacts.rec.owner === '' && afterFacts.rec.updatedBy === tagBefore.rec.updatedBy && afterFacts.rec.updatedAt === tagBefore.rec.updatedAt);
  ok('update: …and no open editor is told to reload', pushes.length === pushed);
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

// ── 3. The strip ───────────────────────────────────────────────────────────

function strip(): void {
  const { sourceTodoOf, readsFactsOf, SOURCE_TODO_SHOWN, STALE_DAYS } = list;
  const NOW = Date.parse('2026-11-04T12:00:00Z');
  const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();
  const row = (table: string, o: Partial<SourceRow> = {}): SourceRow => ({ docId: randomUUID(), table, owner: 'Data', hasGuide: true, readAt: iso(1), datasetIds: [], ...o });
  const conn = (rows: SourceRow[], o: Partial<SourceConn> = {}): SourceConn => ({ connId: randomUUID(), name: 'Warehouse', connectorId: 'live-fake', readsFacts: true, rows, ...o });
  const kinds = (cs: SourceConn[]) => sourceTodoOf(cs, NOW).todo.map((t) => t.kind);

  ok('the strip shows 4 and the numbers are the spec\'s', SOURCE_TODO_SHOWN === 4 && STALE_DAYS === 30);
  const SIX_GAPS = [conn([
    row('R1', { docId: undefined, owner: '', hasGuide: false, readAt: undefined, datasetIds: [randomUUID()] }), // no doc
    row('R2', { owner: '', readAt: undefined }), // never read, no owner
    row('R3', { hasGuide: false }),
    row('R4', { readAt: iso(40) }), // read too long ago
    row('R5', { hasGuide: false }),
  ])];
  const six = sourceTodoOf(SIX_GAPS, NOW);
  ok('sourceTodoOf: four by rank, then how many more', JSON.stringify(six.todo.map((t) => t.kind)) === '["used_no_doc","never_read","no_owner","no_guide"]' && six.more === 2, JSON.stringify(six));
  ok('…a kind keeps row order (R3 before R5), and a chip says where to go', six.todo[3].table === 'R3' && six.todo[3].connId === SIX_GAPS[0].connId && six.todo[3].docId === SIX_GAPS[0].rows[2].docId && six.todo[0].docId === undefined);
  ok('…a row with no doc has only that gap (no owner or guide chip for notes that do not exist yet)', six.todo.filter((t) => t.table === 'R1').length === 1);
  const ALL_FILLED = [conn([row('A'), row('B', { datasetIds: [randomUUID()] })])];
  ok('NEGATIVE CONTROL: nothing missing, no strip', sourceTodoOf(ALL_FILLED, NOW).todo.length === 0 && sourceTodoOf(ALL_FILLED, NOW).more === 0 && sourceTodoOf([], NOW).todo.length === 0);
  ok('stale: more than 30 days is stale, 30 is not', kinds([conn([row('X', { readAt: iso(30) })])]).length === 0 && kinds([conn([row('X', { readAt: iso(31) })])]).join() === 'stale_read');
  ok('stale: a read date that is not a date is no claim', kinds([conn([row('X', { readAt: 'x' })])]).length === 0);
  ok('never read and stale apply only where a read exists (readsFacts)', kinds([conn([row('X', { readAt: undefined }), row('Y', { readAt: iso(99) })], { readsFacts: false })]).length === 0 && kinds([conn([row('X', { readAt: undefined })])]).join() === 'never_read');
  ok('the kinds rank across connections, then connection order', kinds([conn([row('G', { hasGuide: false })]), conn([row('U', { docId: undefined })])]).join() === 'used_no_doc,no_guide');
  ok('readsFacts: a connector with tableFacts or describeTable', !readsFactsOf(null) && !readsFactsOf({} as never) && readsFactsOf({ describeTable: () => null } as never) && readsFactsOf({ tableFacts: () => null } as never));
}

// ── 4. The channels ────────────────────────────────────────────────────────

async function channels(): Promise<void> {
  const { fakeMod, fake, ORG_A } = H;
  const T = fakeMod.ORDERS_TABLE;
  const seed = await H.as(ORG_A, async () => {
    const pid = (await H.projects.createProject('Source channels')).id;
    const other = (await H.projects.createProject('Elsewhere')).id;
    const empty = (await H.projects.createProject('Nothing yet')).id;
    // Connections list newest first: the older one is built first, so the Live one leads the strip.
    const legacy = await H.connections.saveConnection(pid, { name: 'Legacy DB', connectorId: fakeMod.LIVE_FAKE_ID, values: {}, table: 'public.legacy' });
    const unused = await H.connections.saveConnection(pid, { name: 'Unused', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    if (!legacy || !unused) throw new Error('connection not saved');
    const old = await H.datasets.saveDataset(pid, { name: 'Legacy orders', sourceKind: 'postgres', columns: [{ name: 'a', type: 'text' }], rows: [['x']], origin: { kind: 'connection', connId: legacy.id } });
    if (!old) throw new Error('dataset not saved');
    await new Promise((r) => setTimeout(r, 5));
    const live = await H.liveOver(pid, { table: T }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const query = await H.liveRecord.saveLiveRecord(pid, { name: 'A query', columns: [{ name: 'x', type: 'number' }], origin: { kind: 'connection', connId: live.connId, sql: 'select 1 as x' } });
    if (!query) throw new Error('live dataset not saved');
    const docOnly = await store.createSourceDoc(pid, live.connId, 'ANALYTICS.ONLY_DOC', { owner: 'Data' });
    if (!docOnly.ok) throw new Error(docOnly.error);
    // A Databricks and a ClickHouse connection with one doc each: saved, listed, never contacted.
    const wake = (await H.projects.createProject('Real engines')).id;
    const dbx = await H.connections.saveConnection(wake, { name: 'Lakehouse', connectorId: 'databricks-sql', values: {} });
    const clickhouse = await H.connections.saveConnection(wake, { name: 'Clicks', connectorId: 'clickhouse', values: {} });
    if (!dbx || !clickhouse) throw new Error('connection not saved');
    for (const c of [dbx, clickhouse]) if (!(await store.createSourceDoc(wake, c.id, 'sales.orders', { owner: 'Data' })).ok) throw new Error('doc not saved');
    return { PW: wake, DBX: dbx.id, CH: clickhouse.id, P: pid, P2: other, P3: empty, C: live.connId, liveId: live.liveId, sqlLiveId: query.id, C0: legacy.id, C3: unused.id, oldId: old.id, onlyDoc: docOnly.docId };
  });
  const { P, P2, P3, C, C0, C3, liveId, sqlLiveId, oldId, PW, DBX, CH } = seed;
  const copy = await post('dataset:copyLive', { projectId: P, datasetId: liveId });
  const copyId = String(copy.value?.dataset?.id ?? '');
  ok('setup: a Live view, its copy, a query view, a pre-workbench dataset and a documented table with no dataset', copy.value?.ok === true && copyId !== '', copy.body.slice(0, 200));

  // The contracts.
  const names = ['sourceTable:list', 'sourceTable:get', 'sourceTable:save', 'sourceTable:delete'];
  const contracts = api.contracts as unknown as Record<string, { access: string; input: { safeParse(v: unknown): { success: boolean } }; project(i: unknown): unknown }>;
  const sample: Record<string, object> = {
    'sourceTable:list': { projectId: P }, 'sourceTable:get': { projectId: P, connId: C, docId: C }, 'sourceTable:delete': { projectId: P, connId: C, docId: C },
    'sourceTable:save': { projectId: P, connId: C, table: 't', patch: {} },
  };
  ok('contracts: the four channels, all write, scoped by projectId', names.every((n) => contracts[n]?.access === 'write' && contracts[n].project(sample[n]) === P));
  ok('contracts: a strict input — an extra key or a non-UUID is refused, the valid one passes', names.every((n) => contracts[n].input.safeParse(sample[n]).success && !contracts[n].input.safeParse({ ...sample[n], extra: 1 }).success && !contracts[n].input.safeParse({ ...sample[n], projectId: '../x' }).success));
  const save = contracts['sourceTable:save'].input;
  const edit = { projectId: P, connId: C, docId: C, patch: { guide: 'x' } };
  ok('contracts: save is a create (a table) or an edit (a docId), never both or neither', save.safeParse(edit).success && !save.safeParse({ ...edit, table: 't' }).success && !save.safeParse({ projectId: P, connId: C, patch: {} }).success);
  ok('contracts: a blank or over-long name, and over-long fields, are refused', !save.safeParse({ ...sample['sourceTable:save'], table: '   ' }).success && !save.safeParse({ ...sample['sourceTable:save'], table: 'x'.repeat(1001) }).success
    && !save.safeParse({ ...edit, patch: { guide: 'x'.repeat(8001) } }).success && !save.safeParse({ ...edit, patch: { owner: 'x'.repeat(81) } }).success && !save.safeParse({ ...edit, patch: { dismissed: {} } }).success && !save.safeParse({ ...edit, patch: { facts: {} } }).success);

  // Nothing here asks a warehouse: the fake's catalog calls are spied, and its Live statements counted.
  const touched: string[] = [];
  const def = registry.getConnector(fakeMod.LIVE_FAKE_ID) as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['listTables', 'describeTable', 'run']) { const real = def[m].bind(def); def[m] = (...a: unknown[]) => { touched.push(m); return real(...a); }; }
  const calls0 = fake.calls.length;

  const L = (await post('sourceTable:list', { projectId: P })).value;
  const rowsOf = (c: string): Reply[] => L.connections.find((x: Reply) => x.connId === c)?.rows ?? [];
  ok('list: ok, with a connection per connection that has a row, in listConnections order', L.ok === true && L.connections.map((c: Reply) => c.connId).join() === (await H.as(ORG_A, () => H.connections.listConnections(P))).map((c) => c.id).filter((id) => id !== C3).join(), JSON.stringify(L.connections.map((c: Reply) => c.name)));
  ok('list: a Live view and its copy are one row', ((r) => r.datasetIds.length === 2 && r.docId === undefined && r.owner === '' && r.hasGuide === false)(rowsOf(C).find((r) => r.table === T)!));
  ok('list: a query with no link is in no row', !rowsOf(C).some((r) => r.datasetIds.includes(sqlLiveId)));
  ok('list: documented first, then used', rowsOf(C).map((r) => r.table).join() === `ANALYTICS.ONLY_DOC,${T}`, JSON.stringify(rowsOf(C)));
  ok('list: …a documented row carries its doc id, owner and no datasets', ((r) => r.docId === seed.onlyDoc && r.owner === 'Data' && r.hasGuide === false && r.datasetIds.length === 0 && !('readAt' in r))(rowsOf(C)[0]));
  ok('list: the pre-workbench fallback is the connection\'s own table', rowsOf(C0).length === 1 && rowsOf(C0)[0].table === 'public.legacy' && rowsOf(C0)[0].datasetIds.join() === oldId);
  ok('list: a connection with no row is left out, and so is its name', !L.connections.some((c: Reply) => c.connId === C3));
  ok('list: a connection\'s head says what it reads (a fake warehouse can describe a table, wakes nothing)', ((c: Reply) => c.name === 'Legacy DB' && c.connectorId === fakeMod.LIVE_FAKE_ID && c.readsFacts === true && !('factsWake' in c))(L.connections.find((c: Reply) => c.connId === C0)));
  const W = (await post('sourceTable:list', { projectId: PW })).value;
  const head = (id: string): Reply => W.connections.find((c: Reply) => c.connId === id);
  ok('list: Databricks says a read can start the warehouse (so the button can warn)', W.connections.length === 2 && head(DBX).connectorId === 'databricks-sql' && head(DBX).readsFacts === true && head(DBX).factsWake === true, JSON.stringify(W.connections));
  ok('list: NEGATIVE CONTROL: ClickHouse reads facts and wakes nothing', head(CH).connectorId === 'clickhouse' && head(CH).readsFacts === true && !('factsWake' in head(CH)), JSON.stringify(head(CH)));
  ok('strip: a used table with no doc leads', L.todo[0].kind === 'used_no_doc' && L.todo[0].table === T && L.todo[0].docId === undefined && L.todo[0].connId === C);
  ok('strip: …then the other gaps, by rank', L.todo.map((t: Reply) => t.kind).join() === 'used_no_doc,used_no_doc,never_read,no_guide' && L.more === 0, JSON.stringify(L.todo));
  const none = (await post('sourceTable:list', { projectId: P3 })).value;
  ok('list: a project with nothing is an empty tab, not an error', none.ok === true && none.connections.length === 0 && none.todo.length === 0 && none.more === 0);

  const s = (await post('sourceTable:save', { projectId: P, connId: C, table: T, patch: { owner: 'Data' } })).value;
  ok('save (create): ok, a doc id, created, and the tag', s.ok === true && /^[0-9a-f-]{36}$/.test(s.docId) && s.created === true && typeof s.tag === 'string' && s.tag.length > 20, JSON.stringify(s));
  const again = (await post('sourceTable:save', { projectId: P, connId: C, table: `  ${T}  `, patch: { owner: 'Someone else' } })).value;
  ok('save (create): the same exact name returns that doc, unchanged', again.ok === true && again.docId === s.docId && again.created === false && again.tag === s.tag);
  const g = (await post('sourceTable:get', { projectId: P, connId: C, docId: s.docId })).value;
  ok('get: built from it, in dataset order', g.ok === true && g.datasets.map((d: Reply) => d.id).join() === [liveId, copyId].join() && g.datasets.map((d: Reply) => d.name).join() === 'Live,Live (copy)', JSON.stringify(g.datasets));
  ok('get: rebuilt key by key, no dismissed', JSON.stringify(Object.keys(g.doc).sort()) === '["docId","guide","owner","refresh","requiredFilters","table","updatedAt","updatedBy"]' && g.doc.table === T && g.doc.owner === 'Data' && g.doc.docId === s.docId);
  ok('get: the tag is the stored one, the stamp is the caller', g.tag === s.tag && g.doc.updatedBy === ORG_A.user.email);
  ok('get: the connection it is on, and what a read can do', JSON.stringify(g.connection) === JSON.stringify({ connId: C, name: 'Fake warehouse', connectorId: fakeMod.LIVE_FAKE_ID, readsFacts: true }));
  const lst = (await post('sourceTable:list', { projectId: P })).value;
  ok('list: the row is now documented and keeps its datasets', ((r) => r.docId === s.docId && r.owner === 'Data' && r.datasetIds.length === 2)(lst.connections.find((c: Reply) => c.connId === C).rows.find((r: Reply) => r.table === T)) && !lst.todo.some((t: Reply) => t.table === T && t.kind === 'used_no_doc'));

  // Facts and dismissals (PR 04, PR 09) are stored on the doc: get gives the facts, never the dismissals.
  await H.as(ORG_A, () => store.updateSourceDoc(P, C, s.docId, (d) => ({ ...d, facts: { columns: [{ name: 'region', type: 'VARCHAR', key: true }], rowEstimate: 240, readAt: '2026-11-01T00:00:00.000Z', readBy: 'sam' }, dismissed: { [liveId]: { table: 'AbCdEf012345', columns: { amount: 'ZyXwVu987654' } } } })));
  const withFacts = await post('sourceTable:get', { projectId: P, connId: C, docId: s.docId });
  ok('get: the facts come with it, the dismissals never do', withFacts.value.doc.facts.columns[0].name === 'region' && withFacts.value.doc.facts.readBy === 'sam' && !withFacts.body.includes('dismissed') && !withFacts.body.includes('AbCdEf012345') && !withFacts.body.includes('ZyXwVu987654'));
  ok('get: a read of the warehouse does not change the tag an open editor holds', withFacts.value.tag === s.tag);
  const afterRead = (await post('sourceTable:list', { projectId: P })).value;
  ok('list: the row\'s read date comes from the index, and the strip stops asking for a first read of it', afterRead.connections.find((c: Reply) => c.connId === C).rows.find((r: Reply) => r.table === T).readAt === '2026-11-01T00:00:00.000Z'
    && !afterRead.todo.some((t: Reply) => t.table === T && t.kind === 'never_read') && afterRead.todo.some((t: Reply) => t.table === 'ANALYTICS.ONLY_DOC' && t.kind === 'never_read'));

  // Saving.
  const saved = await post('sourceTable:save', { projectId: P, connId: C, docId: s.docId, patch: { guide: '# Filter on ORDER_DATE' }, base: s.tag });
  ok('save (edit): ok, the doc id and the NEW tag', saved.value.ok === true && saved.value.docId === s.docId && saved.value.tag !== s.tag && !('created' in saved.value), saved.body);
  const stale = await post('sourceTable:save', { projectId: P, connId: C, docId: s.docId, patch: { guide: 'lost' }, base: s.tag });
  ok('save: a stale base answers 409 record_changed, with the current tag, and nothing changes', stale.status === 409 && stale.value.code === 'record_changed' && stale.value.tag === saved.value.tag
    && (await post('sourceTable:get', { projectId: P, connId: C, docId: s.docId })).value.doc.guide === '# Filter on ORDER_DATE', stale.body);
  ok('NEGATIVE CONTROL: the current tag saves', (await post('sourceTable:save', { projectId: P, connId: C, docId: s.docId, patch: { refresh: 'Hourly' }, base: saved.value.tag })).value.ok === true);
  ok('save: a doc that is gone answers a sentence', ((r) => r.ok === false && r.error === 'Those notes are gone.')((await post('sourceTable:save', { projectId: P, connId: C, docId: randomUUID(), patch: { guide: 'x' } })).value));
  ok('a connection of another project is refused, and nothing is made', ((r) => r.ok === false && r.error === 'That connection is gone.')((await post('sourceTable:save', { projectId: P2, connId: C, table: 't', patch: {} })).value)
    && (await post('sourceTable:get', { projectId: P2, connId: C, docId: s.docId })).value.ok === false && (await post('sourceTable:delete', { projectId: P2, connId: C, docId: s.docId })).value.ok === false
    && (await H.as(ORG_A, () => store.listSourceIndex(P2, C))).length === 0);

  // Metadata only.
  const probe = await hydrates(liveId, async () => { await post('sourceTable:list', { projectId: P }); await post('sourceTable:get', { projectId: P, connId: C, docId: s.docId }); });
  ok('metadata only: no dataset was hydrated, no warehouse statement and no catalog call', !probe.hydrated && fake.calls.length === calls0 && touched.length === 0, `${touched.join()} ${fake.calls.length - calls0}`);
  await post('connection:listTables', { projectId: P, connId: C });
  ok('NEGATIVE CONTROL: the spy sees a catalog call when one is made', touched.includes('listTables'));

  // Deleting.
  ok('delete: ok, and the row falls back to a used table with no doc', (await post('sourceTable:delete', { projectId: P, connId: C, docId: s.docId })).value.ok === true
    && ((r) => r.docId === undefined && r.datasetIds.length === 2)((await post('sourceTable:list', { projectId: P })).value.connections.find((c: Reply) => c.connId === C).rows.find((r: Reply) => r.table === T)));
  ok('delete: the doc is gone and so is a second delete', (await post('sourceTable:get', { projectId: P, connId: C, docId: s.docId })).value.error === 'Those notes are gone.' && (await post('sourceTable:delete', { projectId: P, connId: C, docId: s.docId })).value.ok === false);
  const bad = await post('sourceTable:save', { projectId: P, connId: C, patch: {} });
  ok('a call that is neither create nor edit is refused before a handler (400)', bad.status === 400);
}

// ── 5. The read ────────────────────────────────────────────────────────────

async function reads(): Promise<void> {
  const { fakeMod, fake, ORG_A } = H;
  const T = fakeMod.ORDERS_TABLE;
  const GUIDE = '# Filter on day';
  registry.registerTestConnector({
    id: 'sources-no-catalog', label: 'No catalog (tests)', family: 'sources-test', category: 'Apps & SaaS', readOnly: true, fields: [],
    async listTables() { return { ok: true, tables: [] }; }, async run() { return { ok: false, error: 'not here' }; },
  });
  const seed = await H.as(ORG_A, async () => {
    const pid = (await H.projects.createProject('Source reads')).id;
    const live = await H.liveOver(pid, { table: T }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const second = await H.liveOver(pid, { table: T }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' });
    const saas = await H.connections.saveConnection(pid, { name: 'No catalog', connectorId: 'sources-no-catalog', values: {} });
    if (!saas) throw new Error('connection not saved');
    const make = async (connId: string, table: string) => { const r = await store.createSourceDoc(pid, connId, table, { owner: 'Data', guide: GUIDE }); if (!r.ok) throw new Error(r.error); return r.docId; };
    return { P: pid, C: live.connId, liveId: live.liveId, D: await make(live.connId, T), C2: second.connId, D2: await make(second.connId, T), SAAS: saas.id, D3: await make(saas.id, 'anything') };
  });
  const { P, C, C2, SAAS, D, D2, D3, liveId } = seed;
  const read = (connId = C, docId = D) => post('sourceTable:read', { projectId: P, connId, docId });
  const contract = (api.contracts as unknown as Record<string, { access: string; project(i: unknown): unknown }>)['sourceTable:read'];
  ok('contract: write, scoped by projectId', contract?.access === 'write' && contract.project({ projectId: P }) === P);

  const tagBefore = (await post('sourceTable:get', { projectId: P, connId: C, docId: D })).value.tag;
  const n0 = fake.catalogCalls;
  const live0 = JSON.stringify(H.liveCounts());
  const runs0 = fake.calls.length;
  await post('sourceTable:list', { projectId: P });
  await post('sourceTable:get', { projectId: P, connId: C, docId: D });
  ok('opening reads no warehouse', fake.catalogCalls === n0);

  const r = await hydrates(liveId, () => read());
  const got = r.value.value;
  ok('read: facts stored with who and when', got.ok === true && got.doc.facts.readBy === ORG_A.user.email && typeof got.doc.facts.readAt === 'string' && got.doc.facts.comment === 'Orders, one row per line', r.value.body.slice(0, 300));
  ok('read: one catalog call, no Live statement, nothing hydrated', fake.catalogCalls === n0 + 1 && fake.calls.length === runs0 && JSON.stringify(H.liveCounts()) === live0 && !r.hydrated);
  ok('read: the reply is the doc view, with no dismissals', JSON.stringify(Object.keys(got.doc).sort()) === '["docId","facts","guide","owner","refresh","requiredFilters","table","updatedAt","updatedBy"]' && !r.value.body.includes('dismissed'));
  ok('read: the index carries readAt (the strip drops never_read)', !(await post('sourceTable:list', { projectId: P })).value.todo.some((t: Reply) => t.docId === D && t.kind === 'never_read'));
  const after = (await post('sourceTable:get', { projectId: P, connId: C, docId: D })).value;
  ok('read: the human fields and the tag are untouched', after.doc.guide === GUIDE && after.doc.owner === 'Data' && after.tag === tagBefore && after.doc.facts.readAt === got.doc.facts.readAt);

  fake.factsHook = async (ctx) => ({ ok: true, comment: `pw ${ctx.secrets.password}`, columns: [{ name: 'a', type: 'int' }], bytes: 1_288_490_188 });
  const sized = await read();
  ok('read: the server formats the size (the web never divides it), in :read and in :get', sized.value.doc.facts.sizeLabel === '~1.2 GB' && (await post('sourceTable:get', { projectId: P, connId: C, docId: D })).value.doc.facts.sizeLabel === '~1.2 GB');
  const stored = await H.as(ORG_A, () => store.readSourceDoc(P, C, D));
  ok('read: a password in a comment reaches neither the reply nor the doc', !sized.body.includes(H.SECRET_CANARY) && sized.body.includes('pw ***') && !JSON.stringify(stored).includes(H.SECRET_CANARY));
  fake.factsHook = async () => ({ ok: false, error: 'permission denied for table' });
  const failed = await read();
  ok('read: a warehouse refusal is the sentence, and the stored facts stay', failed.value.ok === false && failed.value.error === 'permission denied for table' && (await H.as(ORG_A, () => store.readSourceDoc(P, C, D)))!.rec.facts!.comment === `pw ***`);

  // 60 an hour, per connection. One read (the first) and the two above were taken; failed reads count.
  for (let i = 4; i <= 60; i++) await read();
  const refused = (await read()).value;
  ok('the 61st read in an hour is refused, with the wait, and never reached the warehouse', refused.ok === false && /^This connection's tables were read 60 times in the last hour\. Try again in \d+ min\.$/.test(refused.error) && refused.retryAfterSec > 0 && fake.catalogCalls === n0 + 60, JSON.stringify(refused));
  ok('NEGATIVE CONTROL: another connection is not limited (its read reaches the warehouse)', (await read(C2, D2)).value.error === 'permission denied for table');
  fake.factsHook = null;
  ok('NEGATIVE CONTROL: …and reads', (await read(C2, D2)).value.ok === true);
  ok('no catalog: the sentence', (await read(SAAS, D3)).value.error === messages.factsNotReadable() && messages.factsNotReadable() === 'This source has no catalog Ordinate can read. Write its notes by hand.');
  ok('a doc that is gone, and a connection that is not there', (await read(C, randomUUID())).value.error === 'Those notes are gone.' && (await post('sourceTable:read', { projectId: P, connId: randomUUID(), docId: D })).value.error === 'Those notes are gone.');
}

(async () => {
  shape();
  await storing();
  strip();
  await channels();
  await reads();
  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
