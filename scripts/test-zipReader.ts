// Self-check for src/app/zipReader.ts — a zip read from a file, for input
// nobody vouches for (docs/pod-lifecycle/00-design.md §3.4). One crafted zip
// per rule; every refusal is checked by its sentence, and the CONTROL — the
// same zip untouched — opens and reads, so a refusal is the rule, not the build.
//
//   npm run build:ts && node scripts/test-zipReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');

const zr: typeof import('../src/app/zipReader') = require('../src/app/zipReader');
const rules: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');
const m: typeof import('../src/app/bundleMessages') = require('../src/app/bundleMessages');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-zipreader-'));
const U = '0f8fad5b-d9cb-469f-a165-70867728950e';
const JSON_NAME = `datasets/${U}.json`;
/** A backup-like policy: any `<name>.ordinate`, names as keys (the NFC/case duplicate rules). */
const KEYS: import('../src/app/zipReader').ZipPolicy = {
  refuseName: (n) => (/^[^/\\]+\.ordinate$/.test(n) ? null : 'not a key'), capOf: () => 1 << 20, maxEntries: 100, maxTotal: 1 << 24,
};

interface Spec {
  name: string | Buffer;
  data?: Buffer;
  method?: number;
  /** The compressed bytes as written (default: deflateRaw of data, or data when stored). */
  body?: Buffer;
  flags?: number;
  crc?: number;
  usize?: number;
  csize?: number;
  /** Fields where the LOCAL header says something else than the directory. */
  local?: { method?: number; flags?: number; crc?: number; usize?: number; csize?: number; name?: Buffer };
  /** The directory's local-header offset, overridden. */
  offset?: number;
  cdComment?: Buffer;
  cdExtra?: Buffer;
}

/** A zip, field by field, so each test can lie in exactly one place. */
function build(specs: Spec[], end: { count?: number; onDisk?: number; disk?: number; cdSize?: number; cdOffset?: number; comment?: Buffer; commentLen?: number; between?: Buffer } = {}): Buffer {
  const parts: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const data = s.data ?? Buffer.from('{"ok":true}');
    const method = s.method ?? 8;
    const body = s.body ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = Buffer.isBuffer(s.name) ? s.name : Buffer.from(s.name, 'utf8');
    const f = { method, flags: s.flags ?? 0x0800, crc: s.crc ?? (zlib.crc32(data) >>> 0), usize: s.usize ?? data.length, csize: s.csize ?? body.length };
    const l = { ...f, name, ...s.local };
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(l.flags, 6); lh.writeUInt16LE(l.method, 8);
    lh.writeUInt32LE(l.crc, 14); lh.writeUInt32LE(l.csize, 18); lh.writeUInt32LE(l.usize, 22); lh.writeUInt16LE(l.name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(f.flags, 8); cd.writeUInt16LE(f.method, 10);
    cd.writeUInt32LE(f.crc, 16); cd.writeUInt32LE(f.csize, 20); cd.writeUInt32LE(f.usize, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(s.cdExtra?.length ?? 0, 30); cd.writeUInt16LE(s.cdComment?.length ?? 0, 32); cd.writeUInt32LE(s.offset ?? offset, 42);
    parts.push(lh, l.name, body);
    cds.push(cd, name, s.cdExtra ?? Buffer.alloc(0), s.cdComment ?? Buffer.alloc(0));
    offset += 30 + l.name.length + body.length;
  }
  const cd = Buffer.concat(cds);
  const between = end.between ?? Buffer.alloc(0);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(end.disk ?? 0, 4);
  e.writeUInt16LE(end.onDisk ?? end.count ?? specs.length, 8); e.writeUInt16LE(end.count ?? specs.length, 10);
  e.writeUInt32LE(end.cdSize ?? cd.length, 12); e.writeUInt32LE(end.cdOffset ?? offset, 16);
  e.writeUInt16LE(end.commentLen ?? end.comment?.length ?? 0, 20);
  return Buffer.concat([...parts, cd, between, e, end.comment ?? Buffer.alloc(0)]);
}

let n = 0;
/** 'READ' when it opened and every entry read cleanly, else the refusal's message. */
async function outcome(bytes: Buffer, policy = rules.BUNDLE_POLICY): Promise<string> {
  const file = path.join(DIR, `z${n++}.zip`);
  fs.writeFileSync(file, bytes);
  try {
    const zip = await zr.openZip({ file }, policy);
    try {
      for (const e of zip.entries) await zip.read(e);
    } finally {
      await zip.close();
    }
    return 'READ';
  } catch (err) {
    return err instanceof zr.ZipRefused ? err.message : `THREW ${String(err)}`;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function refuses(label: string, bytes: Buffer, expected: string, policy = rules.BUNDLE_POLICY): Promise<void> {
  const got = await outcome(bytes, policy);
  ok(`refused: ${label}`, got === expected, `got ${got} — expected ${expected}`);
}

async function main(): Promise<void> {
  const manifest = { name: 'manifest.json', data: Buffer.from('{"format":"x"}') };
  const good = (extra: Partial<Spec> = {}): Spec[] => [manifest, { name: JSON_NAME, ...extra }];
  ok('CONTROL: the valid zip opens and every entry reads', (await outcome(build(good()))) === 'READ');
  ok('CONTROL: a stored entry reads too', (await outcome(build(good({ method: 0 })))) === 'READ');
  ok('CONTROL: an empty stored entry reads', (await outcome(build(good({ method: 0, data: Buffer.alloc(0) })))) === 'READ');
  ok('CONTROL: an EOCD-looking run inside a real comment is skipped, the real end record used',
    (await outcome(build(good(), { comment: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18, 0x41)]) }))) === 'READ');
  ok('CONTROL: an extra field in the directory is skipped, its contents never read', (await outcome(build(good({ cdExtra: Buffer.alloc(12, 0xff) })))) === 'READ');
  ok('CONTROL: a backup-like name with an accent reads under its policy', (await outcome(build([{ name: 'Café — 0f8fad5b.ordinate', method: 0 }]), KEYS)) === 'READ');

  // ── The end record and the directory ──────────────────────────────────────
  await refuses('not a zip at all', Buffer.from('hello, this is not a zip file at all'), m.notAZip());
  await refuses('an end record whose comment does not reach the end of the file', build(good(), { comment: Buffer.alloc(5), commentLen: 10 }), m.notAZip());
  await refuses('zip64: 0xFFFF entries', build(good(), { count: 0xffff }), m.unsupportedFeature());
  await refuses('zip64: a 0xFFFFFFFF directory offset', build(good(), { cdOffset: 0xffffffff }), m.unsupportedFeature());
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  await refuses('zip64: a zip64 locator before the end record', build(good(), { between: loc }), m.unsupportedFeature());
  await refuses('zip64: a 0xFFFFFFFF size in an entry', build(good({ usize: 0xffffffff })), m.unsupportedFeature());
  await refuses('a split archive (disk 1)', build(good(), { disk: 1 }), m.unsupportedFeature());
  await refuses('entries on this disk ≠ the total', build(good(), { onDisk: 1 }), m.unsupportedFeature());
  await refuses('a directory that does not end where the end record starts', build(good(), { between: Buffer.alloc(3) }), m.damagedDirectory());
  await refuses('a directory pointing outside the file', build(good(), { cdOffset: 10_000_000 }), m.damagedDirectory());
  {
    // The last directory record claims a 40-byte comment: the walk runs past the directory.
    const b = build([manifest, { name: JSON_NAME, cdComment: Buffer.from('xx') }]);
    let p = b.readUInt32LE(b.length - 22 + 16);
    p += 46 + b.readUInt16LE(p + 28) + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    b.writeUInt16LE(40, p + 32);
    await refuses('a directory the walk overruns (a comment length past its end)', b, m.damagedDirectory());
  }
  await refuses('a directory with bytes the walk never reads', build(good(), { cdSize: undefined, count: 1, onDisk: 1 }), m.damagedDirectory());
  await refuses('too many entries for the policy', build([{ name: 'a.ordinate' }, { name: 'b.ordinate' }]), m.tooManyFiles(), { ...KEYS, maxEntries: 1 });

  // ── Flags and methods ─────────────────────────────────────────────────────
  await refuses('an encrypted entry (flag bit 0)', build(good({ flags: 0x0801 })), m.encrypted());
  await refuses('a data descriptor (flag bit 3)', build(good({ flags: 0x0808 })), m.unsupportedFeature());
  {
    // An .xlsx policy takes data descriptors (src/data/xlsxGuard.ts): the local header's zeros are not compared,
    // the directory's sizes are, through the streamed counter — and a name that disagrees is still refused.
    const DD = { ...rules.BUNDLE_POLICY, dataDescriptors: true };
    const zeros = { flags: 0x0808, local: { crc: 0, csize: 0, usize: 0 } };
    ok('CONTROL: with dataDescriptors, a streaming writer\'s entry reads', (await outcome(build(good(zeros)), DD)) === 'READ');
    await refuses('with dataDescriptors, a directory size the data passes', build(good({ ...zeros, usize: 3 })), m.inflatesPast(JSON_NAME), DD);
    await refuses('with dataDescriptors, a local name that disagrees', build(good({ flags: 0x0808, local: { crc: 0, csize: 0, usize: 0, name: Buffer.from(JSON_NAME.replace('d', 'D')) } })), m.damagedEntry(JSON_NAME), DD);
  }
  await refuses('masked headers (flag bit 13)', build(good({ flags: 0x2800 })), m.unsupportedFeature());
  await refuses('method 12 (bzip2)', build(good({ method: 12, body: Buffer.from('x') })), m.unsupportedMethod());
  await refuses('method 99 (AES)', build(good({ method: 99, body: Buffer.from('x') })), m.unsupportedMethod());

  // ── Names ─────────────────────────────────────────────────────────────────
  await refuses('a name that is not valid UTF-8', build([manifest, { name: Buffer.from([0x64, 0xff, 0xfe, 0x2e, 0x6a]) }]), m.badName());
  await refuses('a non-ASCII name without the UTF-8 flag', build([manifest, { name: Buffer.from('dätä.json', 'latin1'), flags: 0 }]), m.badName());
  for (const bad of ['../x.json', `/datasets/${U}.json`, `datasets\\${U}.json`, `datasets/${U}.json/../../x`, 'privacy/salt.key', `dataſets/${U}.json`, `datasets/${U}.json\u0000`]) {
    await refuses(`a name off the whitelist: ${JSON.stringify(bad)}`, build([manifest, { name: bad }]), m.bundleNotImported(bad.replace(/[\p{Cc}\p{Cf}]/gu, '')));
  }
  ok('the JS /i rule never folds ſ (U+017F) or K (U+212A) to ASCII', !rules.ruleFor(`dataſets/${U}.json`) && !rules.ruleFor(`notebooks/${U}.json`.replace('k', '\u212a')) && !!rules.ruleFor(`notebooks/${U}.json`));
  await refuses('a name in the wrong case', build([manifest, { name: `DATASETS/${U}.JSON` }]), m.bundleNameCase(`DATASETS/${U}.JSON`));
  await refuses('an upper-case id', build([manifest, { name: `datasets/${U.toUpperCase()}.json` }]), m.bundleNameCase(`datasets/${U.toUpperCase()}.json`));
  ok('CONTROL: a history key keeps its T and Z', !rules.BUNDLE_POLICY.refuseName(`history/dataset/${U}/2026-01-02T03-04-05-006Z.json`));
  await refuses('the same name twice', build([manifest, { name: JSON_NAME }, { name: JSON_NAME }]), m.duplicateName(JSON_NAME));
  await refuses('two names that differ only in case', build([{ name: 'Sales.ordinate' }, { name: 'sales.ordinate' }]), m.duplicateName('sales.ordinate'), KEYS);
  await refuses('two names that differ only in Unicode normalisation (NFC vs NFD)',
    build([{ name: 'Café.ordinate' }, { name: 'Café.ordinate' }]), m.duplicateName('Café.ordinate'), KEYS);
  await refuses('a name over 1024 bytes', build([{ name: 'a'.repeat(1100) + '.ordinate' }]), m.damagedDirectory(), KEYS);

  // ── Declared sizes ────────────────────────────────────────────────────────
  await refuses('a JSON entry declaring more than its cap', build(good({ usize: rules.RECORD_MAX_BYTES + 1 })), m.entryTooLarge(JSON_NAME));
  await refuses('an image declaring more than 5 MiB', build([manifest, { name: `assets/${U}.png`, usize: 6 << 20 }]), m.entryTooLarge(`assets/${U}.png`));
  await refuses('entries declaring more than the total together', build([{ name: 'a.ordinate', usize: 900 }, { name: 'b.ordinate', usize: 900 }]), m.tooLarge(), { ...KEYS, maxTotal: 1000 });
  await refuses('a stored entry whose sizes differ', build(good({ method: 0, usize: 5 })), m.damagedEntry(JSON_NAME));
  const tiny = Buffer.from('{}');
  const padded = Buffer.concat([zlib.deflateRawSync(tiny), Buffer.alloc(200, 0)]);
  await refuses('a deflated entry far bigger than deflate can make (B2: a 2-byte entry dragging 200 bytes)', build(good({ data: tiny, body: padded })), m.damagedEntry(JSON_NAME));
  ok('…the bound is deflate\'s worst case: incompressible bytes still fit', zlib.deflateRawSync(require('crypto').randomBytes(1 << 20)).length <= zr.maxDeflated(1 << 20));

  // ── The local header against the directory ────────────────────────────────
  for (const [field, local] of [
    ['method', { method: 0 }], ['flags', { flags: 0x0802 }], ['CRC', { crc: 1 }], ['compressed size', { csize: 1 }],
    ['size', { usize: 99 }], ['name', { name: Buffer.from(`datasets/${U.replace('0f8f', '0f8e')}.json`) }],
  ] as Array<[string, Spec['local']]>) {
    await refuses(`a local header that disagrees on its ${field}`, build(good({ local })), m.damagedEntry(JSON_NAME));
  }
  await refuses('a local header at a wrong offset', build(good({ offset: 3 })), m.damagedEntry(JSON_NAME));
  await refuses('an entry reaching into the directory', build(good({ method: 0, usize: 200, csize: 200, local: { usize: 200, csize: 200 } })), m.damagedEntry(JSON_NAME));
  {
    // Overlapping entries: B's whole local record sits INSIDE A's stored bytes; both headers are honest.
    const inner = build([{ name: 'b.ordinate', method: 0, data: Buffer.from('BBBB') }]);
    const bRecord = inner.subarray(0, 30 + 'b.ordinate'.length + 4);
    const bytes = build([{ name: 'a.ordinate', method: 0, data: Buffer.concat([Buffer.from('AA'), bRecord]) }, { name: 'b.ordinate', method: 0, data: Buffer.from('BBBB'), offset: 30 + 'a.ordinate'.length + 2 }]);
    // build() appends B's own record too; the directory points B at the copy inside A.
    await refuses('two entries overlapping (B inside A\'s bytes: the non-recursive zip bomb)', bytes, m.damagedDirectory(), KEYS);
  }

  // ── What a read finds ─────────────────────────────────────────────────────
  const data = Buffer.from('{"hello":"world","n":12345}');
  await refuses('an entry that inflates PAST its declared size', build(good({ data, usize: 5, local: { usize: 5 } })), m.inflatesPast(JSON_NAME));
  await refuses('an entry that inflates SHORT of its declared size', build(good({ data, usize: data.length + 10, local: { usize: data.length + 10 } })), m.damagedEntry(JSON_NAME));
  await refuses('a CRC that does not match', build(good({ crc: 12345, local: { crc: 12345 } })), m.damagedEntry(JSON_NAME));
  const deflated = zlib.deflateRawSync(data);
  await refuses('a truncated deflate stream', build(good({ data, body: deflated.subarray(0, deflated.length - 3) })), m.damagedEntry(JSON_NAME));
  await refuses('a deflate stream that ends before its compressed bytes do (B2)', build(good({ data, body: Buffer.concat([deflated, Buffer.from('trail')]) })), m.damagedEntry(JSON_NAME));
  await refuses('a stored entry with a wrong CRC', build(good({ method: 0, crc: 7, local: { crc: 7 } })), m.damagedEntry(JSON_NAME));

  // ── A range of a handle the caller owns (a stored inner bundle) ──────────
  const innerZip = build(good());
  const outerFile = path.join(DIR, 'outer.bin');
  fs.writeFileSync(outerFile, Buffer.concat([Buffer.alloc(1000, 0x20), innerZip, Buffer.alloc(500, 0x20)]));
  const fh = await fs.promises.open(outerFile, 'r');
  const inRange = await zr.openZip({ fh, offset: 1000, length: innerZip.length }, rules.BUNDLE_POLICY);
  const body = (await inRange.read(inRange.get(JSON_NAME)!)).toString('utf8');
  await inRange.close();
  ok('a zip read in place as a range of a larger file', body === '{"ok":true}', body);
  ok('…and closing it leaves the caller\'s handle open', (await fh.stat()).size === innerZip.length + 1500);
  await fh.close();
}

main()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    finish();
  });
