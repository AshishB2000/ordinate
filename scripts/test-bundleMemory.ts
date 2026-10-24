// Self-check: a bundle, a backup and a restore hold bounded memory
// (docs/pod-lifecycle/00-design.md §3.4–§3.6). With and without DATABASE_URL
// (with it: a scratch database, records and pictures as rows).
//
//   bomb        a ~4 MB bundle that HONESTLY declares ~4 GiB of tables is
//               STREAMED to disk (the inflater ran, staging reached ~4 GiB)
//               with RSS growth under 256 MB
//   json bomb   ~40 × 32 MiB records of one in-use id (~4 MB zipped): pass 1
//               over all of them under 256 MB; three of them imported for
//               real (the in-place id swap) under 256 MB too
//   names       an unknown entry is refused before ONE byte is inflated (a spy
//               on zlib's inflaters; CONTROL: without it they run)
//   sizes       a table and a record that inflate past their declared size are
//               refused by the size check alone (their CRC is the full
//               output's); the staged table never passed its size; no project
//   round trip  a real large bundle imported into a fresh org: every file
//               byte-identical; the old in-memory reader and the streamed one
//               read the same entries (differential)
//   backup      16 projects (a backup bigger than the bound) backed up and
//               restored into a fresh org: RSS growth under 256 MB each way,
//               every file byte-identical, every inner bundle stored
//   writer      ZipFileWriter writes exactly writeZip's bytes (differential)
//   records     recordFs refuses a record over 32 MiB (a 22-character CJK
//               input table); CONTROL: one byte under is written
//
//   npm run build:ts && node scripts/test-bundleMemory.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');
const crypto: typeof import('crypto') = require('crypto');

const context: typeof import('../src/server/context') = require('../src/server/context');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const bundleImport: typeof import('../src/app/bundleImport') = require('../src/app/bundleImport');
const rules: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');
const m: typeof import('../src/app/bundleMessages') = require('../src/app/bundleMessages');
const zr: typeof import('../src/app/zipReader') = require('../src/app/zipReader');
const zw: typeof import('../src/app/zipWriter') = require('../src/app/zipWriter');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const blobs: typeof import('../src/app/blobStore') = require('../src/app/blobStore');
const recordKinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');
const settings: typeof import('../src/ipc/settingsServer') = require('../src/ipc/settingsServer');

require('v8').setFlagsFromString('--expose_gc');
const gc = require('vm').runInNewContext('gc') as () => void;

const MB = 1024 * 1024;
const BOUND = 256 * MB;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bundlemem-'));
const who = (org: string): import('../src/server/context').Identity => ({ user: { email: 't@test', role: 'admin' }, org: { id: org } });
const inOrg = <T>(org: string, fn: () => Promise<T>): Promise<T> => context.runInContext(who(org), 'test', fn);
const mb = (n: number): string => `${(n / MB).toFixed(0)} MB`;

/** `fn`'s peak RSS growth over the RSS just before it (sampled every 5 ms), after a full GC. */
async function rssGrowth<T>(fn: () => Promise<T>, sample?: () => void): Promise<{ value: T; growth: number }> {
  gc();
  const base = process.memoryUsage.rss();
  let peak = base;
  const t = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
    if (sample) sample();
  }, 5);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage.rss());
    return { value, growth: peak - base };
  } finally {
    clearInterval(t);
  }
}

interface Body { body: Buffer; crc: number; usize: number }

/** `total` bytes made of `chunk` repeated, deflated as a stream: neither side is ever whole in memory. */
async function deflatedOf(chunk: Buffer, total: number): Promise<Body> {
  const out: Buffer[] = [];
  const d = zlib.createDeflateRaw();
  d.on('data', (b: Buffer) => out.push(b));
  const done = new Promise((r) => d.on('end', r));
  let crc = 0;
  for (let left = total; left > 0; left -= chunk.length) {
    const c = left >= chunk.length ? chunk : chunk.subarray(0, left);
    crc = zlib.crc32(c, crc);
    if (!d.write(c)) await new Promise((r) => d.once('drain', r));
  }
  d.end();
  await done;
  return { body: Buffer.concat(out), crc: crc >>> 0, usize: total };
}

/** A zip of already-deflated bodies, written to `file` (method 8 unless `stored`). */
function zipOf(file: string, entries: Array<{ name: string; body: Body; stored?: boolean }>): void {
  const when = zw.dosTime(new Date());
  const fd = fs.openSync(file, 'w');
  const centrals: Buffer[] = [];
  let offset = 0;
  const put = (b: Buffer): void => { fs.writeSync(fd, b); offset += b.length; };
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const p = { body: e.body.body, store: !!e.stored, crc: e.body.crc };
    const at = offset;
    put(zw.localHeader(name, p, e.body.usize, when));
    put(name);
    put(p.body);
    centrals.push(zw.centralHeader(name, p, e.body.usize, when, at), name);
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  put(cd);
  put(zw.endRecord(entries.length, cd.length, cdOffset));
  fs.closeSync(fd);
}

const manifestOf = (counts: Record<string, number>): Body => {
  const data = Buffer.from(JSON.stringify({ format: rules.BUNDLE_FORMAT, formatVersion: rules.BUNDLE_VERSION, appVersion: 'test', exportedAt: new Date().toISOString(), project: { name: 'Bomb' }, counts }));
  return { body: zlib.deflateRawSync(data), crc: zlib.crc32(data) >>> 0, usize: data.length };
};

/** Every whitelisted file of a project, by its path in the bundle: records, tables and pictures. */
async function filesOf(org: string, projectId: string): Promise<Map<string, Buffer>> {
  return inOrg(org, async () => {
    const dir = recordKinds.projectDir(projectId);
    const out = new Map<string, Buffer>();
    for (const rel of await bundleImport.walk(dir)) {
      if (!rules.ruleFor(rel) || rel === 'project.json') continue;
      out.set(rel, await recordFs.readFile(path.join(dir, rel)));
    }
    for (const n of await blobs.listBlobs(path.join(dir, 'assets'))) {
      const b = await blobs.readBlob(path.join(dir, 'assets', n));
      if (b) out.set('assets/' + n, b);
    }
    return out;
  });
}

function sameFiles(a: Map<string, Buffer>, b: Map<string, Buffer>): string {
  if (a.size !== b.size) return `${a.size} files vs ${b.size}: ${[...a.keys()].filter((k) => !b.has(k)).join(',')} | ${[...b.keys()].filter((k) => !a.has(k)).join(',')}`;
  for (const [k, v] of a) if (!b.get(k)?.equals(v)) return `${k} differs`;
  return '';
}

/**
 * Counts every chunk handed to an inflater — stream or one-shot, both go
 * through InflateRaw's _transform. (zlib's exports are read-only in Node 24.)
 */
function spyInflaters(): { count(): number; restore(): void } {
  const proto = (require('zlib') as { InflateRaw: { prototype: { _transform: (...a: unknown[]) => unknown } } }).InflateRaw.prototype;
  const real = proto._transform;
  let n = 0;
  proto._transform = function (this: unknown, ...a: unknown[]) {
    n++;
    return real.apply(this, a);
  };
  return { count: () => n, restore: () => { proto._transform = real; } };
}

async function projectCount(org: string): Promise<number> {
  return inOrg(org, async () => (await projects.listProjects()).length);
}

async function main(adminUrl: string | undefined): Promise<void> {
  context.enterServerMode(DATA);
  if (adminUrl) await useScratchDb(adminUrl);
  const A = 'memsource';
  const B = 'memfresh';
  const C = 'membomb';
  const U = () => crypto.randomUUID();

  // ── A real project: a large table, records, a version, a picture ─────────
  const src = await inOrg(A, async () => {
    const p = await projects.createProject('Round trip');
    const rows = Array.from({ length: 200_000 }, (_, i) => [`r${i}`, i * 1.5, crypto.randomBytes(12).toString('base64')]);
    const ds = await datasets.saveDataset(p.id, { name: 'Big', sourceKind: 'csv', columns: [{ name: 'k', type: 'text' }, { name: 'v', type: 'number' }, { name: 'r', type: 'text' }], rows });
    await (require('../src/app/versions') as typeof import('../src/app/versions')).record(p.id, 'dataset', { id: ds!.id, steps: [] });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2000)]);
    await blobs.writeBlob(path.join(recordKinds.projectDir(p.id), 'assets', `${U()}.png`), png);
    return p;
  });
  const exported = (await inOrg(A, () => bundle.exportProject(src.id)))!;

  // ── Differential: the old in-memory reader and the streamed one ─────────
  const tmpZip = path.join(DATA, 'export.ordinate');
  fs.writeFileSync(tmpZip, exported.bytes);
  const old = bundle.readZip(exported.bytes);
  const streamed = await zr.openZip({ file: tmpZip }, rules.BUNDLE_POLICY);
  const sameEntries = old.length === streamed.entries.length && (await Promise.all(old.map(async (e) => {
    const s = streamed.get(e.name);
    return !!s && (await streamed.read(s)).equals(e.data);
  }))).every(Boolean);
  await streamed.close();
  ok(`differential: the streamed reader reads exactly what the in-memory reader reads (${old.length} entries, ${mb(exported.bytes.length)})`, sameEntries);

  // ── Round trip into a fresh org: byte-identical ─────────────────────────
  const back = await inOrg(B, () => bundle.importBundle({ file: tmpZip }));
  ok('round trip: the bundle imports into a fresh org', back.ok === true && back.remapped === 0, JSON.stringify(back.error));
  if (back.project) {
    const diff = sameFiles(await filesOf(A, src.id), await filesOf(B, back.project.id));
    ok('round trip: every record, table and picture is byte-identical', diff === '', diff);
  }

  // ── Names: refused before one byte is inflated ──────────────────────────
  const stray = bundle.writeZip([...old, { name: 'privacy/salt.key', data: Buffer.from('secret') }]);
  const spy = spyInflaters();
  const before = await projectCount(C);
  const refused = await inOrg(C, () => bundle.importBundle(stray));
  const inflatedForStray = spy.count();
  const control = await inOrg(C, () => bundle.importBundle(bundle.writeZip(old)));
  const inflatedForControl = spy.count() - inflatedForStray;
  spy.restore();
  ok('an unknown entry is refused, naming it', refused.ok === false && refused.error === m.bundleNotImported('privacy/salt.key'), refused.error);
  ok('…before ONE byte is inflated (the inflater spy saw nothing)', inflatedForStray === 0, inflatedForStray);
  ok('NEGATIVE CONTROL: the same bundle without it imports, and the spy saw the inflaters run', control.ok === true && inflatedForControl > 0, `${control.error} ${inflatedForControl}`);
  if (control.project) await inOrg(C, () => projects.deleteProject(control.project!.id));
  ok('…and the refused one created no project', (await projectCount(C)) === before);

  // ── Sizes: inflating past the declared size ─────────────────────────────
  {
    const id = U();
    const tableName = `datasets/${id}.parquet`;
    const real = await deflatedOf(Buffer.alloc(64 * 1024, 7), 8 * MB); // 8 MiB of output…
    const lying: Body = { ...real, usize: MB }; // …declared as 1 MiB, with the CRC of the full 8 MiB (only the size check can refuse)
    const file = path.join(DATA, 'past-table.ordinate');
    zipOf(file, [{ name: 'manifest.json', body: manifestOf({ parquet: 1 }) }, { name: tableName, body: lying }]);
    let written = 0;
    const realCreate = fs.createWriteStream;
    (fs as { createWriteStream: unknown }).createWriteStream = (...a: unknown[]) => {
      const w = (realCreate as (...x: unknown[]) => import('fs').WriteStream)(...a);
      const write = w.write.bind(w);
      (w as { write: unknown }).write = (chunk: Buffer, ...rest: unknown[]) => { written += chunk.length; return (write as (...x: unknown[]) => boolean)(chunk, ...rest); };
      return w;
    };
    const r = await inOrg(C, () => bundle.importBundle({ file }));
    (fs as { createWriteStream: unknown }).createWriteStream = realCreate;
    ok('a table inflating past its declared size is refused by the size check', r.ok === false && r.error === m.inflatesPast(tableName), r.error);
    ok(`…the staged table never passed its declared size plus one chunk (${written} bytes written of ${MB} declared)`, written <= MB + 64 * 1024, written);
    const json = Buffer.from(JSON.stringify({ id, pad: 'a'.repeat(5000) })); // deflates to a few bytes: inside the csize bound, so only the size check is left
    const jName = `datasets/${id}.json`;
    const jBody: Body = { body: zlib.deflateRawSync(json), crc: zlib.crc32(json) >>> 0, usize: 100 };
    const jFile = path.join(DATA, 'past-json.ordinate');
    zipOf(jFile, [{ name: 'manifest.json', body: manifestOf({ datasets: 1 }) }, { name: jName, body: jBody }]);
    const rj = await inOrg(C, () => bundle.importBundle({ file: jFile }));
    ok('a record inflating past its declared size is refused by the size check', rj.ok === false && rj.error === m.inflatesPast(jName), rj.error);
    ok('…and neither created a project or left staging behind', (await projectCount(C)) === before
      && !fs.readdirSync(path.join(DATA, 'orgs', C, 'temp')).some((n) => n.startsWith('bundle-')));
  }

  // ── The bomb: ~4 MB declaring ~4 GiB, streamed ──────────────────────────
  const free = fs.statfsSync(DATA);
  if (free.bavail * free.bsize < 6 * 1024 * MB) {
    console.log(`     SKIPPED the 4 GiB bomb: ${mb(free.bavail * free.bsize)} free under ${DATA}, 6 GiB needed`);
  } else {
    const zero = Buffer.alloc(MB);
    const gib = await deflatedOf(zero, 1024 * MB);
    const last = await deflatedOf(zero, 1024 * MB - 64 * 1024);
    const a = U();
    const b = U();
    const file = path.join(DATA, 'bomb.ordinate');
    zipOf(file, [
      { name: 'manifest.json', body: manifestOf({ parquet: 4 }) },
      { name: `datasets/${a}.parquet`, body: gib }, { name: `datasets/${a}.source.parquet`, body: gib },
      { name: `datasets/${b}.parquet`, body: gib }, { name: `datasets/${b}.source.parquet`, body: last },
    ]);
    const size = fs.statSync(file).size;
    const declared = 3 * 1024 * MB + 1024 * MB - 64 * 1024;
    const temp = path.join(DATA, 'orgs', C, 'temp');
    let staged = 0;
    const stagedNow = (): void => {
      let n = 0;
      for (const d of fs.readdirSync(temp).filter((x) => x.startsWith('bundle-'))) {
        for (const f of fs.readdirSync(path.join(temp, d))) n += fs.statSync(path.join(temp, d, f)).size;
      }
      staged = Math.max(staged, n);
    };
    const spy2 = spyInflaters();
    let ticks = 0;
    const r = await rssGrowth(() => inOrg(C, () => bundle.importBundle({ file })), () => { if (++ticks % 20 === 0) { try { stagedNow(); } catch { /* moved meanwhile */ } } });
    const inflaters = spy2.count();
    spy2.restore();
    console.log(`     measured: a ${mb(size)} bundle declaring ${mb(declared)} — staging peaked at ${mb(staged)}, RSS grew ${mb(r.growth)}`);
    ok(`the bomb is ~4 MB and honestly declares ~4 GiB (${mb(size)} → ${mb(declared)})`, size < 8 * MB && declared > 4000 * MB);
    ok('…it was STREAMED: the inflater ran and staging reached ~4 GiB', inflaters >= 4 && staged >= declared * 0.99, `${inflaters} ${staged}`);
    ok(`…with RSS growth under 256 MB (${mb(r.growth)})`, r.growth < BOUND, r.growth);
    if (r.value.ok && r.value.project) await inOrg(C, () => projects.deleteProject(r.value.project!.id));
    fs.rmSync(file, { force: true });
  }

  // ── The JSON bomb: records of one in-use id ─────────────────────────────
  {
    const id = src.id; // a project id: in use in org A
    const unit = Buffer.from(`"${id}",`);
    const chunk = Buffer.alloc(MB);
    for (let i = 0; i < MB; i += unit.length) unit.copy(chunk, i);
    const body = await deflatedOf(chunk, rules.RECORD_MAX_BYTES);
    const dsId = U();
    const names = Array.from({ length: 40 }, (_, i) => `history/dataset/${dsId}/2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z.json`);
    const bad: Body = { body: zlib.deflateRawSync(Buffer.from('x')), crc: 0, usize: 1 }; // a table whose CRC fails: refused AFTER pass 1
    const file = path.join(DATA, 'json-bomb.ordinate');
    zipOf(file, [{ name: 'manifest.json', body: manifestOf({ versions: 40, parquet: 1 }) }, ...names.map((name) => ({ name, body })), { name: `datasets/${dsId}.parquet`, body: bad }]);
    const r = await rssGrowth(() => inOrg(A, () => bundle.importBundle({ file })));
    console.log(`     measured: ${mb(fs.statSync(file).size)} zipped, 40 × 32 MiB records of an in-use id through pass 1 — RSS grew ${mb(r.growth)}`);
    ok(`json bomb: 40 × 32 MiB of an in-use id, pass 1 over all of them, RSS growth under 256 MB (${mb(r.growth)})`, r.value.ok === false && r.growth < BOUND, `${r.value.error} ${r.growth}`);
    const three = path.join(DATA, 'json-three.ordinate');
    zipOf(three, [{ name: 'manifest.json', body: manifestOf({ versions: 3 }) }, ...names.slice(0, 3).map((name) => ({ name, body }))]);
    const r3 = await rssGrowth(() => inOrg(A, () => bundle.importBundle({ file: three })));
    ok(`json swap: three 32 MiB records imported, every id swapped in place, RSS growth under 256 MB (${mb(r3.growth)})`, r3.value.ok === true && r3.growth < BOUND && (r3.value.remapped ?? 0) >= 1, `${r3.value.error} ${r3.growth}`);
    if (r3.value.project) {
      const swapped = await inOrg(A, () => recordFs.readFile(path.join(recordKinds.projectDir(r3.value.project!.id), 'history', 'dataset', dsId, '2026-01-01T00-00-00-000Z.json')));
      ok('…the record holds the NEW id everywhere, never the old one, and kept its length', swapped.length === rules.RECORD_MAX_BYTES && !swapped.includes(Buffer.from(id)), swapped.length);
      await inOrg(A, () => projects.deleteProject(r3.value.project!.id));
    }
  }

  // ── Backup and restore of several projects ──────────────────────────────
  {
    const ids: string[] = [];
    await inOrg('membackup', async () => {
      for (let i = 0; i < 16; i++) {
        const p = await projects.createProject(`Backed up ${i}`);
        const rows = Array.from({ length: 240_000 }, () => [crypto.randomBytes(75).toString('base64')]);
        await datasets.saveDataset(p.id, { name: `T${i}`, sourceKind: 'csv', columns: [{ name: 'x', type: 'text' }], rows });
        ids.push(p.id);
      }
    });
    const job = { progress() {}, checkCancelled() {} };
    const backup = await rssGrowth(() => inOrg('membackup', () => settings.writeBackup(job)));
    const size = fs.statSync(backup.value.file).size;
    const outer = await zr.openZip({ file: backup.value.file }, { refuseName: () => null, capOf: () => rules.MAX_TOTAL_BYTES, maxEntries: 100, maxTotal: rules.MAX_TOTAL_BYTES });
    const stored = outer.entries.filter((e) => e.name.endsWith('.ordinate')).every((e) => e.method === 0);
    await outer.close();
    console.log(`     measured: a ${mb(size)} backup of 16 projects — RSS grew ${mb(backup.growth)}`);
    ok(`backup: ${mb(size)} for 16 projects (more than the bound), every bundle STORED`, size > BOUND && stored, `${size} ${stored}`);
    ok(`backup: RSS growth under 256 MB (${mb(backup.growth)})`, backup.growth < BOUND, backup.growth);
    const ctl = new AbortController();
    const restore = await rssGrowth(() => inOrg('memrestore', () => settings.restoreBackupFile(backup.value.file, { signal: ctl.signal, progress() {}, checkCancelled() {} })));
    console.log(`     measured: restore of the ${mb(size)} backup — RSS grew ${mb(restore.growth)}`);
    ok(`restore: every project back, RSS growth under 256 MB (${mb(restore.growth)})`, restore.value.restored.length === 16 && restore.value.failed.length === 0 && restore.growth < BOUND,
      `${JSON.stringify(restore.value.failed)} ${restore.growth}`);
    let identical = 0;
    for (const id of ids) {
      const name = (await inOrg('membackup', () => projects.getProject(id)))!.name;
      const copy = restore.value.restored.find((p) => p.name.startsWith(name + ' (restored'));
      if (copy && sameFiles(await filesOf('membackup', id), await filesOf('memrestore', copy.id)) === '') identical++;
    }
    ok(`restore: every restored project byte-identical to its source (${identical} of 16)`, identical === 16);
    fs.rmSync(backup.value.file, { force: true });
  }

  // ── The writer: ZipFileWriter ≡ writeZip ────────────────────────────────
  {
    const when = new Date('2026-05-06T07:08:10Z');
    const entries = [{ name: 'a.json', data: Buffer.from('{"a":1}'.repeat(500)) }, { name: 'b.bin', data: crypto.randomBytes(5000) }, { name: 'é/c.txt', data: Buffer.alloc(0) }];
    const file = path.join(DATA, 'writer.zip');
    const w = await zw.ZipFileWriter.create(file, when);
    for (const e of entries) await w.add(e.name, e.data);
    await w.close();
    ok('writer: ZipFileWriter writes exactly writeZip\'s bytes (differential)', fs.readFileSync(file).equals(bundle.writeZip(entries, when)));
  }

  // ── Records: the cap on both sides ──────────────────────────────────────
  {
    const cell = '数据'.repeat(11); // 22 CJK characters, 66 bytes in UTF-8
    const table = JSON.stringify({ id: U(), steps: [], table: { rows: Array.from({ length: 10_000 }, () => Array.from({ length: 50 }, () => cell)) } });
    const bytes = Buffer.byteLength(table);
    console.log(`     measured: a full 10,000 × 50 input table of 22-character CJK cells is ${mb(bytes)} of JSON`);
    const dir = await inOrg(A, async () => path.join(recordKinds.projectDir(src.id), 'history', 'dataset', U()));
    let msg = '';
    try { await inOrg(A, () => recordFs.writeFile(path.join(dir, '2026-01-01T00-00-00-000Z.json'), table)); } catch (err) { msg = (err as Error).message; }
    ok(`records: a ${mb(bytes)} record is refused at the writer, so no bundle we write holds one our import refuses`, bytes > rules.RECORD_MAX_BYTES && msg === (require('../src/app/recordLockMessages') as typeof import('../src/app/recordLockMessages')).recordTooLarge(), msg);
    const under = 'x'.repeat(rules.RECORD_MAX_BYTES - 1);
    await inOrg(A, async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await recordFs.writeFile(path.join(dir, '2026-01-01T00-00-01-000Z.json'), under);
    });
    ok('NEGATIVE CONTROL: one byte under the cap is written', (await inOrg(A, () => recordFs.readFile(path.join(dir, '2026-01-01T00-00-01-000Z.json')))).length === rules.RECORD_MAX_BYTES - 1);
  }
}

let dropDb: (() => Promise<void>) | null = null;
async function useScratchDb(adminUrl: string): Promise<void> {
  const { Client, Pool }: typeof import('pg') = require('pg');
  const name = `ordinate_bundlemem_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const pool = new Pool({ connectionString: u.toString(), max: 4 });
  pool.on('error', () => undefined);
  await (require('../src/server/db/migrate') as typeof import('../src/server/db/migrate')).migrate(pool);
  recordFs.useRecordDb(pool);
  blobs.useBlobDb(pool);
  dropDb = async () => {
    recordFs.useRecordDb(null);
    blobs.useBlobDb(null);
    await pool.end();
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await a.end();
  };
}

const adminUrl = process.env.DATABASE_URL;
console.log(`     mode: ${adminUrl ? 'with DATABASE_URL (scratch database)' : 'without DATABASE_URL'}`);
void main(adminUrl)
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .then(async () => {
    if (dropDb) await dropDb().catch(() => undefined);
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
