// Phase 2 gate: an existing (v2, rows-inline) project must open correctly after
// migration, and a v3 record must round-trip through Parquet byte-for-byte.
//
// Style follows test-datasets.ts: stub 'electron' so userData points at a temp
// dir, then exercise the REAL modules against real disk. Planting a legacy file
// on disk and asserting the upgrade is the house pattern (test-visuals.ts:167).

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-migrate-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

const datasets: typeof import('../src/datasets') = require('../src/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');
const parquetStore: typeof import('../src/parquetStore') = require('../src/parquetStore');
const duck: typeof import('../src/duckdb') = require('../src/duckdb');

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const UUID = '11111111-2222-4333-8444-555555555555';

function dsDir(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'datasets');
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Migration');
  if (!proj) throw new Error('project fixture failed');

  ok('DuckDB bridge is available for this run', parquetStore.isSupported());

  // ── 1. A v2 record planted on disk, exactly as a pre-Phase-2 build wrote it ──
  const legacy = {
    id: UUID,
    projectId: proj.id,
    name: 'Legacy sales',
    sourceKind: 'csv',
    columns: [
      { name: 'city', type: 'text' },
      { name: 'sku', type: 'text' },
      { name: 'amount', type: 'number' },
      { name: 'note', type: 'text' },
    ],
    rows: [
      ['Paris', '007', 10, 'a'],
      ['Berlin', '012', 20, ''],
      ['Paris', '007', 5, '   '],
      ['Tokyo', '900', -3, null],
    ],
    rowCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 2,
    steps: [],
  };
  await fs.promises.mkdir(dsDir(proj.id), { recursive: true });
  await fs.promises.writeFile(
    path.join(dsDir(proj.id), UUID + '.json'),
    JSON.stringify(legacy, null, 2),
    'utf8',
  );

  // ── 1b. A METADATA READ MUST NOT MIGRATE ──
  // getDatasetMeta's stated contract is "migration is a write, and a metadata
  // read must stay a read". Every lazy-migration design in the app rests on it,
  // including the implicit-analysis wrap for legacy dashboards. Nothing asserted
  // it: getDatasetMeta appeared exactly once in scripts/, and only to read
  // `meta.resident`. So run it FIRST, before anything hydrates, and prove the
  // bytes on disk are untouched — with the bridge available, so a migration
  // genuinely COULD have happened here.
  const v2BytesBefore = await fs.promises.readFile(path.join(dsDir(proj.id), UUID + '.json'), 'utf8');
  const metaOfV2 = await datasets.getDatasetMeta(proj.id, UUID);
  ok('getDatasetMeta reads a v2 record', metaOfV2 !== null && metaOfV2.name === 'Legacy sales');
  ok('getDatasetMeta reports a v2 record as NOT resident', metaOfV2 !== null && metaOfV2.resident === false);
  ok('getDatasetMeta carries rowCount without the table', metaOfV2 !== null && metaOfV2.rowCount === 4);
  ok('getDatasetMeta does NOT hydrate (no rows on the meta object)',
    metaOfV2 !== null && (metaOfV2 as unknown as Record<string, unknown>).rows === undefined);
  const v2BytesAfterMeta = await fs.promises.readFile(path.join(dsDir(proj.id), UUID + '.json'), 'utf8');
  ok('getDatasetMeta left the v2 file byte-identical (a read stays a read)',
    v2BytesAfterMeta === v2BytesBefore);
  ok('getDatasetMeta wrote no .parquet sibling',
    !fs.existsSync(path.join(dsDir(proj.id), UUID + '.parquet')));
  {
    const after = JSON.parse(v2BytesAfterMeta);
    ok('the record on disk is still schemaVersion 2 after a metadata read', after.schemaVersion === 2);
    ok('the record on disk still carries its rows after a metadata read',
      Array.isArray(after.rows) && after.rows.length === 4);
  }
  ok('a metadata read leaves no .tmp litter',
    fs.readdirSync(dsDir(proj.id)).every((f) => !f.includes('.tmp')));

  // ── 2. Opening it must work, and must migrate ──
  const loaded = await datasets.getDataset(proj.id, UUID);
  ok('v2 record loads', loaded !== null);
  if (!loaded) throw new Error('load failed — nothing else can be checked');

  ok('name preserved', loaded.name === 'Legacy sales');
  ok('rowCount preserved', loaded.rowCount === 4);
  ok(
    'every cell survives migration verbatim',
    JSON.stringify(loaded.rows) === JSON.stringify(legacy.rows),
  );
  ok('leading zeros stay text', loaded.rows[0][1] === '007' && typeof loaded.rows[0][1] === 'string');
  ok('numbers stay numbers', loaded.rows[0][2] === 10 && typeof loaded.rows[0][2] === 'number');
  ok('negative numbers survive', loaded.rows[3][2] === -3);
  ok('empty string is NOT null', loaded.rows[1][3] === '');
  ok('whitespace-only cell preserved', loaded.rows[2][3] === '   ');
  ok('null stays null', loaded.rows[3][3] === null);

  const parquetFile = path.join(dsDir(proj.id), UUID + '.parquet');
  ok('a .parquet sibling was written', fs.existsSync(parquetFile));

  const rewritten = JSON.parse(
    await fs.promises.readFile(path.join(dsDir(proj.id), UUID + '.json'), 'utf8'),
  );
  ok('JSON was rewritten to schemaVersion 3', rewritten.schemaVersion === 3);
  ok('JSON no longer carries rows', rewritten.rows === undefined);
  ok('JSON keeps columns (needed with the bridge down)', Array.isArray(rewritten.columns));
  ok('JSON keeps rowCount (needed with the bridge down)', rewritten.rowCount === 4);
  const jsonBytes = Buffer.byteLength(JSON.stringify(rewritten));
  ok(`metadata JSON is small (${jsonBytes} bytes)`, jsonBytes < 1500);

  // ── 3. Re-reading the migrated record must give the same answer ──
  const reread = await datasets.getDataset(proj.id, UUID);
  ok('v3 record re-reads', reread !== null);
  ok(
    'v3 read is identical to the v2 read',
    JSON.stringify(reread?.rows) === JSON.stringify(loaded.rows),
  );
  const rereadJson = JSON.parse(
    fs.readFileSync(path.join(dsDir(proj.id), UUID + '.json'), 'utf8'),
  );
  ok('migration is idempotent — file stays v3 with no rows',
    rereadJson.schemaVersion === 3 && rereadJson.rows === undefined);

  // ── 4. Row order across a bigger table ──
  {
    const big = await datasets.saveDataset(proj.id, {
      name: 'Ordered',
      sourceKind: 'csv',
      columns: [
        { name: 'i', type: 'number' },
        { name: 'tag', type: 'text' },
      ],
      rows: Array.from({ length: 60_000 }, (_, i) => [i, 't' + (i % 7)]),
    });
    ok('60k-row dataset saves', big !== null);
    const back = big ? await datasets.getDataset(proj.id, big.id) : null;
    ok('60k-row dataset reloads', back !== null && back.rows.length === 60_000);
    let ordered = true;
    if (back) for (let i = 0; i < 60_000; i++) if (back.rows[i][0] !== i) { ordered = false; break; }
    ok('60k rows come back in source order', ordered);
  }

  // ── 5. source survives with steps CLEARED (the audit's data-loss case) ──
  {
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Stepped',
      sourceKind: 'csv',
      columns: [
        { name: 'city', type: 'text' },
        { name: 'amount', type: 'number' },
      ],
      rows: [
        ['Paris', 10],
        ['Berlin', 20],
        ['Paris', 5],
      ],
    });
    if (!ds) throw new Error('stepped fixture failed');
    await datasets.updateSteps(proj.id, ds.id, [
      { type: 'filter', column: 'city', op: '=', value: 'Paris' },
    ]);
    const filtered = await datasets.getDataset(proj.id, ds.id);
    ok('a step applies', filtered?.rowCount === 2);
    ok('source was snapshotted', Array.isArray(filtered?.source?.rows));
    ok('source parquet written', fs.existsSync(path.join(dsDir(proj.id), ds.id + '.source.parquet')));

    // Clearing every step must NOT discard the source — keying the source
    // parquet on steps.length would silently lose it here.
    await datasets.updateSteps(proj.id, ds.id, []);
    const cleared = await datasets.getDataset(proj.id, ds.id);
    ok('clearing steps restores all rows', cleared?.rowCount === 3);
    ok('source survives an empty step list', Array.isArray(cleared?.source?.rows));
    ok(
      'source rows are byte-identical to the original',
      JSON.stringify(cleared?.source?.rows) ===
        JSON.stringify([
          ['Paris', 10],
          ['Berlin', 20],
          ['Paris', 5],
        ]),
    );

    // ── 6. delete removes ALL THREE files, never orphaning table data ──
    const gone = await datasets.deleteDataset(proj.id, ds.id);
    ok('deleteDataset returns true', gone === true);
    ok('json removed', !fs.existsSync(path.join(dsDir(proj.id), ds.id + '.json')));
    ok('parquet removed', !fs.existsSync(path.join(dsDir(proj.id), ds.id + '.parquet')));
    ok(
      'source parquet removed',
      !fs.existsSync(path.join(dsDir(proj.id), ds.id + '.source.parquet')),
    );
  }

  // ── 7. listDatasets works off metadata alone (no table read at all) ──
  {
    const list = await datasets.listDatasets(proj.id);
    ok('listDatasets still enumerates', list.length >= 2);
    const legacyRow = list.find((d) => d.id === UUID);
    ok('summary rowCount comes from JSON', legacyRow?.rowCount === 4);
    ok('summary columnCount comes from JSON', legacyRow?.columnCount === 4);
  }

  // ── 8. No temp files left behind anywhere ──
  {
    const stray = (await fs.promises.readdir(dsDir(proj.id))).filter((f) => f.includes('.tmp'));
    ok(`no temp files left behind (found ${stray.length})`, stray.length === 0);
  }

  // ── 9. A v3 record whose parquet is missing must fail VISIBLY, not empty ──
  {
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Truncated',
      sourceKind: 'csv',
      columns: [{ name: 'a', type: 'text' }],
      rows: [['x'], ['y']],
    });
    if (!ds) throw new Error('fixture failed');
    await fs.promises.rm(path.join(dsDir(proj.id), ds.id + '.parquet'), { force: true });
    const orphan = await datasets.getDataset(proj.id, ds.id);
    ok('missing parquet yields null, NOT an empty table', orphan === null);
    const stillListed = (await datasets.listDatasets(proj.id)).some((d) => d.id === ds.id);
    ok('the dataset is still LISTED so the loss is visible to the user', stillListed);
  }

  // ── 10. Traversal guard covers the new paths ──
  {
    const sentinel = path.join(dsDir(proj.id), 'SECRET.parquet');
    await fs.promises.writeFile(sentinel, 'not a parquet', 'utf8');
    ok('deleteDataset rejects a traversal id', (await datasets.deleteDataset(proj.id, '../SECRET')) === false);
    ok('sentinel .parquet untouched', fs.existsSync(sentinel));
    ok('getDataset rejects a traversal id', (await datasets.getDataset(proj.id, '../SECRET')) === null);
    await fs.promises.rm(sentinel, { force: true });
  }

  duck.shutdown();
  fs.rmSync(tmpUserData, { recursive: true, force: true });

  console.log('');
  if (failures) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All dataset migration checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
