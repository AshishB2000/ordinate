// Self-check for datasets.sanitizeOrigin and the refresh-provenance fields.
//
// sanitizeOrigin is a SECURITY control, not tidying: normalize() runs it on
// every load, so it is the thing standing between a hand-edited dataset.json and
// a file read or a fetch at a target the user never chose. Every rejection below
// is a case where the record is on disk and looks plausible.
//
// Like test-datasets.ts, the 'electron' module is stubbed (via Module._load) to
// point userData at a fresh temp dir, then the REAL modules run against real
// disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-origin-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');

let failures = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log('ok   ' + label + (detail ? '  ' + detail : ''));
  else {
    console.error('FAIL ' + label + (detail ? '  ' + detail : ''));
    failures++;
  }
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const ABS = path.join(os.tmpdir(), 'sales.csv');

async function main(): Promise<void> {
  const san = datasets.sanitizeOrigin;

  // ── Accepted shapes ────────────────────────────────────────────────────────
  ok('an absolute file path is accepted',
     JSON.stringify(san({ kind: 'file', path: ABS })) === JSON.stringify({ kind: 'file', path: ABS }));
  ok('…with a sheet name when one is given',
     JSON.stringify(san({ kind: 'file', path: ABS, sheetName: 'Q3' }))
       === JSON.stringify({ kind: 'file', path: ABS, sheetName: 'Q3' }));
  ok('…and an empty sheet name is dropped rather than stored as ""',
     san({ kind: 'file', path: ABS, sheetName: '   ' })?.kind === 'file'
       && (san({ kind: 'file', path: ABS, sheetName: '   ' }) as any).sheetName === undefined);
  ok('an https URL is accepted', san({ kind: 'url', url: 'https://api.example.com/d.json' })?.kind === 'url');
  ok('an http URL is accepted (the connector still refuses it at fetch time)',
     san({ kind: 'url', url: 'http://example.com/d.json' })?.kind === 'url');
  ok('a UUID connId is accepted', san({ kind: 'connection', connId: UUID_A })?.kind === 'connection');
  ok('a combined origin with two UUIDs and a mode is accepted',
     san({ kind: 'combined', leftId: UUID_A, rightId: UUID_B, mode: 'append' })?.kind === 'combined');
  const joined: any = san({
    kind: 'combined', leftId: UUID_A, rightId: UUID_B, mode: 'join', on: { left: 'id', right: 'ref' },
  });
  ok('…carrying the join keys', joined && joined.on.left === 'id' && joined.on.right === 'ref');

  // ── Rejections — each is a plausible-looking record on disk ────────────────
  ok('an unknown kind → undefined', san({ kind: 'ftp', path: ABS }) === undefined);
  ok('a missing kind → undefined', san({ path: ABS }) === undefined);
  ok('a RELATIVE path → undefined', san({ kind: 'file', path: 'sales.csv' }) === undefined);
  ok('a traversal-style relative path → undefined',
     san({ kind: 'file', path: '../../etc/passwd' }) === undefined);
  ok('an empty path → undefined', san({ kind: 'file', path: '' }) === undefined);
  ok('a non-string path → undefined', san({ kind: 'file', path: 42 }) === undefined);
  ok('a file: URL → undefined', san({ kind: 'url', url: 'file:///etc/passwd' }) === undefined);
  // oxlint-disable-next-line no-script-url -- the literal IS the thing under test
  ok('a javascript: URL → undefined', san({ kind: 'url', url: 'javascript:alert(1)' }) === undefined);
  ok('a data: URL → undefined', san({ kind: 'url', url: 'data:text/plain,hi' }) === undefined);
  ok('an unparseable URL → undefined', san({ kind: 'url', url: 'not a url' }) === undefined);
  ok('a non-UUID connId → undefined', san({ kind: 'connection', connId: '../SECRET' }) === undefined);
  ok('an empty connId → undefined', san({ kind: 'connection', connId: '' }) === undefined);
  // ── composed (the composer's N-table chain) ────────────────────────────────
  const UUID_C = '33333333-3333-4333-8333-333333333333';
  const comp = (joins: any): any => san({ kind: 'composed', baseId: UUID_A, joins });

  ok('a composed origin with a UUID base and one join is accepted',
     comp([{ datasetId: UUID_B, mode: 'inner', on: { left: 'id', right: 'ref' } }])?.kind === 'composed');
  ok('…and keeps every link, in order',
     JSON.stringify(comp([{ datasetId: UUID_B, mode: 'left' }, { datasetId: UUID_C, mode: 'append' }])?.joins)
       === JSON.stringify([{ datasetId: UUID_B, mode: 'left' }, { datasetId: UUID_C, mode: 'append' }]));
  ok("…and normalises the legacy 'join' spelling to 'inner' on the way in",
     comp([{ datasetId: UUID_B, mode: 'join' }])?.joins[0].mode === 'inner');
  ok('…and drops a half-specified key pair rather than storing it',
     comp([{ datasetId: UUID_B, mode: 'inner', on: { left: 'id' } }])?.joins[0].on === undefined);

  // ONE bad link drops the WHOLE origin. A chain missing a link is a different
  // dataset, and refreshing into it silently would be worse than not refreshing.
  ok('a composed origin with a non-UUID base → undefined',
     san({ kind: 'composed', baseId: '../x', joins: [{ datasetId: UUID_B, mode: 'inner' }] }) === undefined);
  ok('a composed origin with a non-UUID in ANY link → undefined',
     comp([{ datasetId: UUID_B, mode: 'inner' }, { datasetId: 'not-a-uuid', mode: 'inner' }]) === undefined);
  ok('a composed origin with an unknown mode in ANY link → undefined',
     comp([{ datasetId: UUID_B, mode: 'inner' }, { datasetId: UUID_C, mode: 'right' }]) === undefined);
  ok('a composed origin with no joins → undefined (that is not a chain)', comp([]) === undefined);
  ok('a composed origin with a non-array joins → undefined', comp('nope') === undefined);
  ok('a composed origin with a non-object link → undefined', comp([UUID_B]) === undefined);

  ok('a combined origin with a non-UUID parent → undefined',
     san({ kind: 'combined', leftId: '../x', rightId: UUID_B, mode: 'append' }) === undefined);
  ok('a combined origin with an unknown mode → undefined',
     san({ kind: 'combined', leftId: UUID_A, rightId: UUID_B, mode: 'cross' }) === undefined);
  ok('a partial `on` is dropped, not half-stored',
     (san({ kind: 'combined', leftId: UUID_A, rightId: UUID_B, mode: 'join', on: { left: 'id' } }) as any)?.on
       === undefined);
  ok('null → undefined', san(null) === undefined);
  ok('a bare string → undefined', san('/tmp/sales.csv' as unknown) === undefined);
  ok('an array → undefined', san([{ kind: 'file', path: ABS }] as unknown) === undefined);

  // ── On-disk behaviour ──────────────────────────────────────────────────────
  await projects.init();
  const proj = await projects.createProject('Origin project');
  const columns = [{ name: 'a', type: 'text' as const }];
  const rows = [['1'], ['2']];

  // A dataset saved WITHOUT an origin is a snapshot, exactly as before.
  const plain = await datasets.saveDataset(proj.id, { name: 'Pasted', sourceKind: 'paste', columns, rows });
  ok('a dataset saved with no origin has none', plain !== null && plain.origin === undefined);
  ok('…and carries no refresh stamp either',
     plain !== null && plain.lastRefreshedAt === undefined && plain.lastRefreshStatus === undefined);

  // An import IS a fetch, so saving with an origin stamps the data's age now.
  const withOrigin = await datasets.saveDataset(proj.id, {
    name: 'From file', sourceKind: 'csv', columns, rows, origin: { kind: 'file', path: ABS },
  });
  ok('saving with an origin stores it', withOrigin !== null && withOrigin.origin?.kind === 'file');
  ok('…and stamps lastRefreshedAt + ok status',
     withOrigin !== null && typeof withOrigin.lastRefreshedAt === 'string'
       && withOrigin.lastRefreshStatus === 'ok' && withOrigin.lastRefreshError === null);

  // A bogus origin in the SAVE payload is dropped, leaving a plain snapshot —
  // the renderer cannot talk main into storing an unreachable source.
  // oxlint-disable-next-line no-script-url -- the literal IS the thing under test
  const SCRIPT_URL = 'javascript:alert(1)';
  const bogus = await datasets.saveDataset(proj.id, {
    name: 'Bogus', sourceKind: 'csv', columns, rows, origin: { kind: 'url', url: SCRIPT_URL },
  });
  ok('a bogus origin in the save payload is dropped', bogus !== null && bogus.origin === undefined);
  ok('…and no refresh stamp is invented for it', bogus !== null && bogus.lastRefreshedAt === undefined);

  // The real defence: a record already on disk, hand-edited. It must LOAD, and
  // load as not-refreshable — never as a file read.
  const file = path.join(tmpUserData, 'projects', proj.id, 'datasets', withOrigin!.id + '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.origin = { kind: 'file', path: '../../../etc/passwd' };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const tampered = await datasets.getDataset(proj.id, withOrigin!.id);
  ok('a hand-edited traversal origin loads as NOT refreshable',
     tampered !== null && tampered.origin === undefined);
  ok('…and the dataset itself still loads with its rows intact',
     tampered !== null && tampered.rows.length === 2);

  // A v3 record with no origin key at all — i.e. every dataset that existed
  // before this feature — must be untouched by the new load path.
  const legacyFile = path.join(tmpUserData, 'projects', proj.id, 'datasets', plain!.id + '.json');
  const legacyRaw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  ok('the pre-existing record really has no origin key', !('origin' in legacyRaw));
  const legacy = await datasets.getDataset(proj.id, plain!.id);
  ok('a record with no origin key loads unchanged',
     legacy !== null && legacy.origin === undefined && legacy.rows.length === 2
       && legacy.name === 'Pasted');

  // The summary carries freshness so the saved list needs no full load.
  const list = await datasets.listDatasets(proj.id);
  const bogusSum = list.find((d) => d.id === bogus!.id);
  const tamperedSum = list.find((d) => d.id === withOrigin!.id);
  ok('a summary omits originKind for a dataset that never had an origin',
     bogusSum !== undefined && bogusSum.originKind === undefined && bogusSum.lastRefreshedAt === undefined);
  ok('…and the tampered record summarises as not refreshable too, via the same sanitizer',
     tamperedSum !== undefined && tamperedSum.originKind === undefined);

  const stillGood = await datasets.saveDataset(proj.id, {
    name: 'Refreshable', sourceKind: 'csv', columns, rows, origin: { kind: 'connection', connId: UUID_A },
  });
  const list2 = await datasets.listDatasets(proj.id);
  const good = list2.find((d) => d.id === stillGood!.id);
  ok('a live origin shows up in the summary as its kind + stamp',
     good !== undefined && good.originKind === 'connection'
       && typeof good.lastRefreshedAt === 'string' && good.lastRefreshStatus === 'ok');
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' origin check(s) FAILED'); process.exit(1); }
    console.log('\nAll dataset-origin checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
