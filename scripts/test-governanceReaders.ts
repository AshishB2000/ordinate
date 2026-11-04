// Governance readers (semantic layer part 4, release A): a pod of this release KEEPS what a newer one
// writes and refuses what it cannot apply. Nothing here writes `status` or `columnAccess`.
//
//   § status   the catalog's `status` section survives every catalog write, sanitized not opaque:
//              a bad ref, a kind status does not cover, a bad replacement are dropped; an unreadable pin
//              or versionKey (missing, not a string, malformed) drops that one field and keeps the entry;
//              sanitizing twice gives what sanitizing once gives
//   § columnAccess  a dataset record's `columnAccess` survives every writer (persist, the metadata writers,
//              fresh on ask, dataset:setRowPolicy, Trash and restore, a re-import, an input table's save, the
//              Live writers, the mode switch both ways) and is born on every copy (savedFrom, "Make a copy" of
//              a Live dataset), raw; a copy closed only by an upstream dataset's rules is born with closed row
//              rules, one with only its own columnAccess is not; a source with rules that goes to the Trash
//              mid-copy, or whose record is gone by the time its rules are read, never gives an open copy.
//              NEGATIVE CONTROL: with 'columnAccess' taken out of KEPT_RECORD_KEYS, the writers drop it.
//              Runs in server mode (the fake warehouse), after § status, which runs outside it.
//
//   npm run build:ts && node scripts/test-governanceReaders.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-governance-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');
const { parseStatusRef, sanitizeStatus } = require('../src/app/statusDocs') as typeof import('../src/app/statusDocs');

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [U1, U2, U3, U4, U5, U6, U7, U8, U9] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid);
const PIN = 'p'.repeat(43);

async function main(): Promise<void> {
  // ── status ─────────────────────────────────────────────────────────────────
  const M = `metric:${U1}`, T = `term:${U2}`, D = `dataset:${U3}`;
  const RAW = { schemaVersion: 1, tags: {}, records: {}, columns: {}, status: {
    [M]: { status: 'certified', by: 'ana@acme.com', at: '2026-11-03T10:00:00.000Z', note: 'ok', pin: PIN, versionKey: '2026-11-03T10-00-00-000Z' },
    [T]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `term:${U4}` },
    [D]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `metric:${U4}` },
    [`visual:${U5}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: PIN },
    [`metric:${U6}`]: { status: 'certified', by: 'a', at: 'b', note: '' },
  } as Record<string, unknown> };
  const out = catalog.sanitizeCatalog(RAW);
  ok('keeps a certified metric and a retired term verbatim', stableStringify(out.status![M]) === stableStringify(RAW.status[M]) && out.status![T].replacedBy === `term:${U4}`);
  ok('a replacement of another kind is dropped, the retirement kept', out.status![D].status === 'retired' && !('replacedBy' in out.status![D]));
  ok('a kind status does not cover is dropped', !(`visual:${U5}` in out.status!));
  ok('a certified entry with no pin is kept, without one', out.status![`metric:${U6}`].status === 'certified' && !('pin' in out.status![`metric:${U6}`]));

  const P = (await projects.createProject('Governance'))!.id;
  const file = path.join(tmpUserData, 'projects', P, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(RAW));
  await catalog.setDoc(P, `dataset:${U3}`, { description: 'x' }); // the write every old pod makes
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The planted visual: entry and the dataset: replacement of another kind are in the file we wrote; only a rewrite drops them.
  ok('the unrelated write rewrote the file: its record is there, the planted invalid entry and field are gone',
    back.records[D].description === 'x' && !(`visual:${U5}` in back.status) && !('replacedBy' in back.status[D]));
  ok('an unrelated catalog write keeps the section', stableStringify(back.status[M]) === stableStringify(RAW.status[M]) && back.status[T].replacedBy === `term:${U4}`);
  ok('NEGATIVE CONTROL: no section in, none out (byte-identical catalog)', !('status' in catalog.sanitizeCatalog({ ...RAW, status: undefined })) && !('status' in catalog.emptyCatalog()));

  // A corrupt field is skipped, never fatal. `__proto__` must be a real own key (an object literal sets the prototype instead).
  const badRaw = {
    [`metric:${U1}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: 'short', versionKey: 'not-a-key' },
    [`metric:${U2}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: 42, versionKey: '2026-11-03T10-00-00-000Z' },
    [`metric:${U9}`]: { status: 'certified', by: 'a', at: 'b', note: '', versionKey: 7 },
    [`term:${U3}`]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `term:${U3}` },
    [`term:${U4}`]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: 7, pin: PIN },
    [`dataset:${U5}`]: { status: 'paused', by: 'a', at: 'b', note: '' },
    [`dataset:${U6}`]: 'junk',
    [`dataset:${U7}`]: { status: 'certified', by: 'x'.repeat(200), at: 'y'.repeat(200), note: 'z'.repeat(900), pin: PIN },
    'metric:not-an-id': { status: 'retired', by: 'a', at: 'b', note: '' },
  } as Record<string, unknown>;
  Object.defineProperty(badRaw, '__proto__', { value: { status: 'retired', by: 'a', at: 'b', note: '' }, enumerable: true, configurable: true, writable: true });
  ok('the planted __proto__ is an own key of the raw status', Object.keys(badRaw).includes('__proto__'));
  const bad = catalog.sanitizeCatalog({ status: badRaw }).status!;
  const certified = [`metric:${U1}`, `metric:${U2}`, `metric:${U9}`];
  ok('an unreadable pin or versionKey (malformed, not a string, missing) drops that field, not the entry',
    certified.every((k) => bad[k].status === 'certified' && !('pin' in bad[k])) && !('versionKey' in bad[`metric:${U1}`]) && !('versionKey' in bad[`metric:${U9}`])
    && bad[`metric:${U2}`].versionKey === '2026-11-03T10-00-00-000Z');
  ok('a replacement by itself or a non-ref is dropped, a pin on a retired entry is not kept', !('replacedBy' in bad[`term:${U3}`]) && !('replacedBy' in bad[`term:${U4}`]) && !('pin' in bad[`term:${U4}`]));
  ok('an unknown status, a non-object doc, a bad id and __proto__ are dropped', !(`dataset:${U5}` in bad) && !(`dataset:${U6}` in bad) && !('metric:not-an-id' in bad) && !Object.keys(bad).includes('__proto__')
    && Object.keys(bad).length === 6);
  const twice = sanitizeStatus(sanitizeStatus(badRaw));
  ok('IDEMPOTENT: sanitizing twice equals sanitizing once, over every malformed case', stableStringify(twice) === stableStringify(bad) && stableStringify(sanitizeStatus(bad)) === stableStringify(bad));
  ok('each certified entry with an unreadable pin survives both passes, without its pin', certified.every((k) => twice[k]?.status === 'certified' && !('pin' in twice[k])));
  ok('by, at and note are clipped to 80, 40 and 500', bad[`dataset:${U7}`].by.length === 80 && bad[`dataset:${U7}`].at.length === 40 && bad[`dataset:${U7}`].note.length === 500);
  ok('a status that is not an object reads as no section', !('status' in catalog.sanitizeCatalog({ status: [1] })) && !('status' in catalog.sanitizeCatalog({ status: 'x' })));
  ok('parseStatusRef: a covered kind and a uuid, nothing else', parseStatusRef(`term:${U8}`)?.kind === 'term' && parseStatusRef(`term:${U8}`)?.id === U8
    && parseStatusRef(`visual:${U8}`) === null && parseStatusRef(`:${U8}`) === null && parseStatusRef(U8) === null && parseStatusRef(7) === null);

  await columnAccess();
}

async function columnAccess(): Promise<void> {
  // ── columnAccess ───────────────────────────────────────────────────────────
  const H: typeof import('./liveQueryHarness') = require('./liveQueryHarness'); // enters server mode
  const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
  const trash: typeof import('../src/app/trash') = require('../src/app/trash');
  const access: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
  const { savedFrom } = access;
  const { copyLiveDataset, setDatasetMode } = require('../src/ipc/liveDatasets') as typeof import('../src/ipc/liveDatasets');
  const { setFreshOnAsk } = require('../src/data/freshOnAskRecord') as typeof import('../src/data/freshOnAskRecord');
  const inputTables: typeof import('../src/data/inputTable/store') = require('../src/data/inputTable/store');
  const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
  const { handlers } = require('../src/server/rpc') as typeof import('../src/server/rpc');
  const { datasets, liveDataset, fakeMod } = H;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
  // dataset:setRowPolicy checks the team is the org's with one Postgres count: a pool answering 1 stands in for it.
  (require('../src/ipc/rowPolicy') as typeof import('../src/ipc/rowPolicy')).register(() => ({ query: async () => ({ rows: [{ n: 1 }] }) }) as unknown as import('pg').Pool);
  try {
    const TEAM = uuid(10);
    const COLS = [{ name: 'dept', type: 'text' as const }, { name: 'salary', type: 'number' as const }];
    const ROWS = [['Ops', 10], ['Eng', 20]];
    const CA = { columns: [{ column: 'salary', visibleTo: [TEAM] }], readersHash: 'h', updatedBy: 'boss@x', updatedAt: '2026-11-04T00:00:00.000Z' };
    const CLOSED = { column: '', rules: [], stepsHash: '' };
    const P = await as(async () => { await H.projects.init(); return (await H.projects.createProject('Column access')).id; });
    const save = (name: string) => as(async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: COLS, rows: ROWS }))!.id);
    const raw = (id: string) => as(async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, id), 'utf8')) as Record<string, unknown>);
    const plant = (id: string) => as(() => rec.serialized(rec.datasetFilePath(P, id), (r) => { r.columnAccess = CA; return true; }));
    const kept = async (id: string) => stableStringify((await raw(id)).columnAccess) === stableStringify(CA);
    const copyOf = async (source: string) => (await as(() => savedFrom(P, source, () => datasets.saveDataset(P, { name: 'copy', sourceKind: 'combined', columns: COLS, rows: ROWS }))))!.id;
    const liveCopyOf = async (source: string) => {
      const r = await as(() => copyLiveDataset({ projectId: P, datasetId: source }));
      return r.ok && 'dataset' in r && r.dataset ? r.dataset.id : `not copied: ${JSON.stringify(r)}`;
    };
    const setRules = async (id: string, column: string, value: string) =>
      ((await handlers.get('dataset:setRowPolicy')!(null, { projectId: P, datasetId: id, policy: { column, rules: [{ teamId: TEAM, values: [value] }] } })) as { ok?: boolean }).ok === true;
    const live = async () => (await as(() => H.liveOver(P, { table: fakeMod.ORDERS_TABLE }, fakeMod.ORDERS_COLUMNS, fakeMod.LIVE_FAKE_ID, { fixture: 'orders' }))).liveId;

    const DS = await save('Pay');
    await plant(DS);
    await as(() => datasets.updateSteps(P, DS, [{ type: 'filter', column: 'dept', op: 'not_empty' }]));
    ok('a data write (persist) keeps columnAccess', await kept(DS));
    const WRITERS: [string, (id: string) => Promise<boolean>][] = [
      ['markRefresh', (id) => rec.markRefresh(P, id, 'ok', null)],
      ['setAutoRefresh', async (id) => (await rec.setAutoRefresh(P, id, { every: null })) !== false],
      ['writeQuality', async (id) => (await rec.writeQuality(P, id, () => undefined)) !== false],
      ['writeIncremental', async (id) => (await rec.writeIncremental(P, id, () => undefined)) !== false],
      ['setFreshOnAsk', async (id) => (await setFreshOnAsk(P, id, null)).ok],
      ['dataset:setRowPolicy (its serialized save)', (id) => setRules(id, 'dept', 'Ops')],
      ['trash → restore', async (id) => (await trash.trashRecord(P, 'dataset', id)).ok && (await trash.restore(P, 'dataset', id)).ok],
      ['a re-import over the same id (updateDatasetData)', async (id) => (await datasets.updateDatasetData(P, id, { columns: COLS, rows: ROWS })) !== null],
    ];
    for (const [name, write] of WRITERS) {
      await plant(DS);
      const wrote = await as(() => write(DS));
      ok(`${name} keeps columnAccess`, wrote && (await kept(DS)), `wrote: ${wrote}`);
    }
    const ruled = (await raw(DS)).rowPolicy;
    ok('setup: the dataset has row access rules now', !!ruled && (ruled as { column?: string }).column === 'dept');
    const created = await as(() => inputTables.createInputTable(P, { name: 'Ledger', columns: [{ name: 'dept', type: 'text' }] }));
    const IN = created.ok ? created.id : '';
    await plant(IN);
    const saved = await as(() => inputTables.saveInputBatches(P, IN, [{ label: 'Add', ops: [{ t: 'ins', at: 0, rows: [['Ops']] }] }]));
    ok('an input table\'s save keeps columnAccess', saved.ok && saved.rows.length === 1 && (await kept(IN)), JSON.stringify(saved).slice(0, 160));

    const LV = await live();
    const LIVE_WRITERS: [string, (id: string) => Promise<boolean>][] = [
      ['bumpEpoch', async (id) => (await liveDataset.bumpEpoch(P, id)) !== false],
      ['writeSchemaSync', (id) => liveDataset.writeSchemaSync(P, id, { columns: fakeMod.ORDERS_COLUMNS, profile: { columns: [] }, missingColumns: [], syncedAt: new Date().toISOString(), changed: true })],
      ['setMaxCacheAge', async (id) => (await liveDataset.setMaxCacheAge(P, id, 60)) !== false],
      ['stampSyncAttempt', (id) => liveDataset.stampSyncAttempt(P, id, new Date().toISOString())],
      // Live → extract is the one persist of a Live record (toExtractRecord); extract → Live is a serialized rewrite (toLiveRecord).
      ['the switch to an extract (dataset:setMode)', async (id) => ((await setDatasetMode({ projectId: P, datasetId: id, mode: 'extract' })) as { ok?: boolean; mode?: string }).mode === 'extract'],
      ['the switch back to Live (dataset:setMode)', async (id) => ((await setDatasetMode({ projectId: P, datasetId: id, mode: 'live', confirmDrop: true })) as { ok?: boolean; mode?: string }).mode === 'live'],
    ];
    for (const [name, write] of LIVE_WRITERS) {
      await plant(LV);
      const wrote = await as(() => write(LV));
      ok(`Live: ${name} keeps columnAccess`, wrote && (await kept(LV)), `wrote: ${wrote}`);
    }

    // The copies: born with the source's rules on their first write.
    await plant(LV);
    const liveCopy = await liveCopyOf(LV);
    ok('a copyLive copy is born with the source\'s columnAccess, and no closed row rules', (await kept(liveCopy)) && !('rowPolicy' in (await raw(liveCopy))), liveCopy);
    const LV2 = await live();
    // No writer gives a Live dataset a parent; a hand edit can: a union step on the dataset with rules.
    await as(() => rec.serialized(rec.datasetFilePath(P, LV2), (r) => { r.steps = [{ type: 'union', datasetId: DS }]; return true; }));
    const closedLiveCopy = await liveCopyOf(LV2);
    ok('a copyLive copy of a Live dataset closed by an upstream dataset\'s rules is born closed', stableStringify((await raw(closedLiveCopy)).rowPolicy) === stableStringify(CLOSED), closedLiveCopy);

    const copy = await copyOf(DS);
    ok('a copy is born with the source\'s columnAccess (first write), and its row rules', (await kept(copy)) && stableStringify((await raw(copy)).rowPolicy) === stableStringify(ruled));
    const OWN = await save('Own column rules');
    await plant(OWN);
    const ownCopy = await copyOf(OWN);
    ok('a copy of a source with only its own columnAccess keeps it, and gets no closed row rules', (await kept(ownCopy)) && !('rowPolicy' in (await raw(ownCopy))));
    const BUILT = await save('Built on Pay');
    await as(() => datasets.updateSteps(P, BUILT, [{ type: 'union', datasetId: DS }]));
    await plant(BUILT);
    const builtCopy = await copyOf(BUILT);
    ok('a copy of a source closed by an upstream dataset\'s rules keeps its columnAccess and is born closed',
      (await kept(builtCopy)) && stableStringify((await raw(builtCopy)).rowPolicy) === stableStringify(CLOSED));
    const PLAIN = await save('Plain');
    const plainCopy = await raw(await copyOf(PLAIN));
    ok('a copy of a source with no rules carries none', !('columnAccess' in plainCopy) && !('rowPolicy' in plainCopy));

    // A source with rules that goes to the Trash mid-copy (here: once the warehouse has answered) still hands its rules over.
    const midCopyTrash = async (source: string) => {
      const realRun = connectionRun.runConnection;
      (connectionRun as { runConnection: unknown }).runConnection = async (...args: Parameters<typeof realRun>) => {
        const out = await realRun(...args);
        await trash.trashRecord(P, 'dataset', source);
        return out;
      };
      try { return await liveCopyOf(source); } finally { (connectionRun as { runConnection: unknown }).runConnection = realRun; }
    };
    const RULED_LIVE = await live();
    await as(() => setRules(RULED_LIVE, 'region', 'East'));
    await plant(RULED_LIVE);
    const liveRules = (await raw(RULED_LIVE)).rowPolicy;
    const trashedCopy = await midCopyTrash(RULED_LIVE);
    ok('setup: the source was trashed mid-copy', !(await as(() => datasets.getDatasetMeta(P, RULED_LIVE))) && !!liveRules);
    ok('a copy whose source with rules went to the Trash mid-copy is born with its row rules and its columnAccess',
      stableStringify((await raw(trashedCopy)).rowPolicy) === stableStringify(liveRules) && (await kept(trashedCopy)), trashedCopy);
    const OPEN_LIVE = await live();
    const openCopy = await raw(await midCopyTrash(OPEN_LIVE));
    ok('NEGATIVE CONTROL: the same copy of an open source is open', !('rowPolicy' in openCopy) && !('columnAccess' in openCopy));
    const TRASHED_OWN = await save('Own column rules, trashed');
    await plant(TRASHED_OWN);
    await as(() => trash.trashRecord(P, 'dataset', TRASHED_OWN));
    ok('a copy of a source with only columnAccess, trashed before its rules are read, keeps it', await kept(await copyOf(TRASHED_OWN)));
    // Its rules judged, then its record gone from the live store and the Trash before they are read: closed, never open.
    const GONE = await save('Gone');
    await as(() => setRules(GONE, 'dept', 'Ops'));
    const goneRules = await as(async () => {
      await access.policyClosed(P, GONE); // the request remembers this read
      await fs.promises.rm(rec.datasetFilePath(P, GONE));
      return access.rulesForCopyOf(P, GONE);
    });
    ok('a source with rules whose record is gone when its rules are read gives the closed policy', stableStringify(goneRules) === stableStringify({ rowPolicy: CLOSED }), JSON.stringify(goneRules));

    // NEGATIVE CONTROL: the real guard, with 'columnAccess' taken out of KEPT_RECORD_KEYS, drops it on every persist and copy.
    const keys = rec.KEPT_RECORD_KEYS as unknown as string[];
    const at = keys.indexOf('columnAccess');
    keys.splice(at, 1);
    try {
      await plant(DS);
      await as(() => datasets.updateSteps(P, DS, [{ type: 'filter', column: 'dept', op: 'not_empty' }]));
      const persisted = !(await kept(DS));
      await plant(DS);
      await as(() => datasets.updateDatasetData(P, DS, { columns: COLS, rows: ROWS }));
      const reimported = !(await kept(DS));
      await plant(OWN);
      const uncopied = !(await kept(await copyOf(OWN)));
      ok('NEGATIVE CONTROL: without columnAccess in KEPT_RECORD_KEYS, persist, a re-import and a copy drop it', at >= 0 && persisted && reimported && uncopied, `${persisted} ${reimported} ${uncopied}`);
    } finally {
      keys.splice(at, 0, 'columnAccess');
    }
    await plant(DS);
    await as(() => datasets.updateSteps(P, DS, [{ type: 'filter', column: 'dept', op: 'not_empty' }]));
    ok('…and with it put back, persist keeps it again', stableStringify(rec.KEPT_RECORD_KEYS) === '["rowPolicy","columnAccess"]' && (await kept(DS)));
  } finally {
    H.cleanup();
  }
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
