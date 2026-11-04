// Governance readers (semantic layer part 4, release A): a pod of this release KEEPS what a newer one
// writes and refuses what it cannot apply. Nothing here writes `status` or `columnAccess`.
//
//   § status   the catalog's `status` section survives every catalog write, sanitized not opaque:
//              a bad ref, a kind status does not cover, a certified entry with no pin, a bad
//              replacement are dropped; a bad pin or versionKey drops that one field
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
const { parseStatusRef } = require('../src/app/statusDocs') as typeof import('../src/app/statusDocs');

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [U1, U2, U3, U4, U5, U6, U7, U8] = [1, 2, 3, 4, 5, 6, 7, 8].map(uuid);
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
  ok('a kind status does not cover, and a certified entry with no pin, are dropped', !(`visual:${U5}` in out.status!) && !(`metric:${U6}` in out.status!));

  const P = (await projects.createProject('Governance'))!.id;
  const file = path.join(tmpUserData, 'projects', P, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(RAW));
  await catalog.setDoc(P, `dataset:${U3}`, { description: 'x' }); // the write every old pod makes
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('an unrelated catalog write keeps the section', stableStringify(back.status[M]) === stableStringify(RAW.status[M]) && back.status[T].replacedBy === `term:${U4}`);
  ok('NEGATIVE CONTROL: no section in, none out (byte-identical catalog)', !('status' in catalog.sanitizeCatalog({ ...RAW, status: undefined })) && !('status' in catalog.emptyCatalog()));

  // A corrupt field is skipped, never fatal.
  const bad = catalog.sanitizeCatalog({ status: {
    [`metric:${U1}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: 'short', versionKey: 'not-a-key' },
    [`metric:${U2}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: 42 },
    [`term:${U3}`]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `term:${U3}` },
    [`term:${U4}`]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: 7, pin: PIN },
    [`dataset:${U5}`]: { status: 'paused', by: 'a', at: 'b', note: '' },
    [`dataset:${U6}`]: 'junk',
    [`dataset:${U7}`]: { status: 'certified', by: 'x'.repeat(200), at: 'y'.repeat(200), note: 'z'.repeat(900), pin: PIN },
    'metric:not-an-id': { status: 'retired', by: 'a', at: 'b', note: '' },
    '__proto__': { status: 'retired', by: 'a', at: 'b', note: '' },
  } }).status!;
  ok('a bad pin and a bad versionKey drop that field, not the entry', bad[`metric:${U1}`].status === 'certified' && !('pin' in bad[`metric:${U1}`]) && !('versionKey' in bad[`metric:${U1}`]));
  ok('a pin that is not a string drops the entry', !(`metric:${U2}` in bad));
  ok('a replacement by itself or a non-ref is dropped, a pin on a retired entry is not kept', !('replacedBy' in bad[`term:${U3}`]) && !('replacedBy' in bad[`term:${U4}`]) && !('pin' in bad[`term:${U4}`]));
  ok('an unknown status, a non-object doc, a bad id and __proto__ are dropped', !(`dataset:${U5}` in bad) && !(`dataset:${U6}` in bad) && !('metric:not-an-id' in bad) && Object.keys(bad).length === 4);
  ok('by, at and note are clipped to 80, 40 and 500', bad[`dataset:${U7}`].by.length === 80 && bad[`dataset:${U7}`].at.length === 40 && bad[`dataset:${U7}`].note.length === 500);
  ok('a status that is not an object reads as no section', !('status' in catalog.sanitizeCatalog({ status: [1] })) && !('status' in catalog.sanitizeCatalog({ status: 'x' })));
  ok('parseStatusRef: a covered kind and a uuid, nothing else', parseStatusRef(`term:${U8}`)?.kind === 'term' && parseStatusRef(`term:${U8}`)?.id === U8
    && parseStatusRef(`visual:${U8}`) === null && parseStatusRef(`:${U8}`) === null && parseStatusRef(U8) === null && parseStatusRef(7) === null);
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
