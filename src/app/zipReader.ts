// A zip read from a FILE, for input nobody vouches for — MAIN PROCESS, and the
// compute worker for an .xlsx (src/data/xlsxGuard.ts)
// (docs/pod-lifecycle/00-design.md §3.4). A bundle import or a backup restore
// is an upload: this module never holds it whole in memory and never inflates
// a byte before the whole structure has been checked.
//
// openZip() reads the central directory and every local header with positioned
// reads and refuses, before anything is inflated:
//   • an end record that does not end the file exactly (a forged one in a
//     comment), zip64 (any 0xFFFF/0xFFFFFFFF marker or a zip64 locator), a
//     split archive;
//   • a directory that does not end exactly where the end record starts, or
//     that the walk does not consume exactly;
//   • any flag but UTF-8 and the deflate-level hints — so encryption and DATA
//     DESCRIPTORS (the one case where a local header may disagree) are refused,
//     unless the policy takes data descriptors (an .xlsx from a streaming
//     writer); then the directory's sizes and CRC are the only ones, as every
//     other reader takes them, and the streamed check below holds them;
//   • a method other than stored (0) or deflate (8);
//   • a name that is not valid UTF-8 (or not ASCII without the UTF-8 flag), that
//     the caller's policy refuses, or that repeats another (NFC, case-folded);
//   • a declared size over the caller's cap or the total over its budget; a
//     stored entry whose sizes differ; a deflated one whose compressed size is
//     past deflate's worst case (zlib ignores trailing bytes: a 1 KB entry must
//     not drag 199 MB through a read);
//   • a local header that differs from the directory in any field or byte of
//     the name; an entry reaching into the directory; two entries overlapping
//     (the overlapping-data zip bomb).
// Then each read is a STREAM — positioned read → inflate → a counter that stops
// the moment the output passes the declared size, and checks size, CRC and
// that the deflate stream consumed exactly its compressed bytes at the end.
// Extra-field CONTENTS are never read: nothing a decision rests on comes from them.

import * as fs from 'fs';
import * as zlib from 'zlib';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import * as msg from './bundleMessages';

export class ZipRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipRefused';
  }
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly csize: number;
  readonly usize: number;
  /** Where the compressed bytes start, relative to the zip's own start. */
  readonly dataStart: number;
}

export interface ZipPolicy {
  /** The sentence refusing `name`, or null when it may be read. */
  refuseName(name: string): string | null;
  /** The most `name` may inflate to, in bytes. */
  capOf(name: string): number;
  maxEntries: number;
  /** Every entry's declared size together. */
  maxTotal: number;
  /** Accept data descriptors (flag 0x8): the local header's CRC and sizes are then not compared. */
  dataDescriptors?: boolean;
}

/** A file this module opens and closes, or a range of a handle the caller owns (a stored inner zip). */
export type ZipSource = { file: string } | { fh: fs.promises.FileHandle; offset: number; length: number };

export interface ZipReader {
  readonly entries: readonly ZipEntryInfo[];
  get(name: string): ZipEntryInfo | undefined;
  /** The entry inflated into memory (it is at most its cap), size and CRC checked. */
  read(e: ZipEntryInfo, signal?: AbortSignal): Promise<Buffer>;
  /** The entry streamed to `dest` (created, never overwritten), size and CRC checked; deleted on failure. */
  extract(e: ZipEntryInfo, dest: string, signal?: AbortSignal): Promise<void>;
  /** A stored entry's CRC, streamed. */
  verify(e: ZipEntryInfo, signal?: AbortSignal): Promise<void>;
  /** A stored entry as a source of its own: an inner zip read in place. */
  range(e: ZipEntryInfo): ZipSource;
  close(): Promise<void>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ALLOWED_FLAGS = 0x0800 | 0x0006; // UTF-8 names; deflate-level hints
const DATA_DESCRIPTOR = 0x0008;
const MAX_CD_BYTES = 16 * 1024 * 1024;
const MAX_NAME_BYTES = 1024;

/** A hostile name, shown in a sentence: no control or format characters, cut short. */
function shown(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Deflate's worst case for `usize` bytes, with room: stored blocks cost 5 bytes per ≤ 16 KiB. */
export function maxDeflated(usize: number): number {
  return usize + 5 * Math.ceil(usize / 16383) + 64;
}

export async function openZip(src: ZipSource, policy: ZipPolicy): Promise<ZipReader> {
  const own = 'file' in src;
  const fh = own ? await fs.promises.open(src.file, 'r') : src.fh;
  try {
    const base = own ? 0 : src.offset;
    const size = own ? (await fh.stat()).size : src.length;
    const entries = await directory(fh, base, size, policy);
    return reader(fh, own, base, entries);
  } catch (err) {
    if (own) await fh.close().catch(() => undefined);
    throw err;
  }
}

async function directory(fh: fs.promises.FileHandle, base: number, size: number, policy: ZipPolicy): Promise<ZipEntryInfo[]> {
  const pread = async (pos: number, len: number): Promise<Buffer> => {
    const b = Buffer.alloc(len);
    if (pos < 0 || pos + len > size || (await fh.read(b, 0, len, base + pos)).bytesRead !== len) throw new ZipRefused(msg.damagedDirectory());
    return b;
  };
  if (size < 22) throw new ZipRefused(msg.notAZip());
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await pread(size - tailLen, tailLen);
  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    // The real end record ends the file: its comment length reaches EOF exactly.
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLen) { at = i; break; }
  }
  if (at < 0) throw new ZipRefused(msg.notAZip());
  const eocdPos = size - tailLen + at;
  const disk = tail.readUInt16LE(at + 4);
  const cdDisk = tail.readUInt16LE(at + 6);
  const onDisk = tail.readUInt16LE(at + 8);
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRefused(msg.unsupportedFeature());
  if (eocdPos >= 20 && (await pread(eocdPos - 20, 4)).readUInt32LE(0) === ZIP64_LOCATOR) throw new ZipRefused(msg.unsupportedFeature());
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw new ZipRefused(msg.unsupportedFeature());
  if (count > policy.maxEntries) throw new ZipRefused(msg.tooManyFiles());
  if (cdOffset + cdSize !== eocdPos || cdSize > MAX_CD_BYTES) throw new ZipRefused(msg.damagedDirectory());

  const cd = await pread(cdOffset, cdSize);
  const out: Array<ZipEntryInfo & { localOffset: number; nameBytes: Buffer; flags: number }> = [];
  const seen = new Set<string>();
  let total = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdSize || cd.readUInt32LE(p) !== CENTRAL) throw new ZipRefused(msg.damagedDirectory());
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const diskStart = cd.readUInt16LE(p + 34);
    const localOffset = cd.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdSize || nameLen > MAX_NAME_BYTES) throw new ZipRefused(msg.damagedDirectory());
    if (flags & 0x1) throw new ZipRefused(msg.encrypted());
    if (flags & ~(ALLOWED_FLAGS | (policy.dataDescriptors ? DATA_DESCRIPTOR : 0))) throw new ZipRefused(msg.unsupportedFeature());
    if (method !== 0 && method !== 8) throw new ZipRefused(msg.unsupportedMethod());
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff || diskStart !== 0) throw new ZipRefused(msg.unsupportedFeature());
    const nameBytes = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    let name: string;
    if (flags & 0x0800) {
      try { name = utf8.decode(nameBytes); } catch { throw new ZipRefused(msg.badName()); }
    } else {
      if (nameBytes.some((b) => b > 0x7f)) throw new ZipRefused(msg.badName());
      name = nameBytes.toString('latin1');
    }
    const refused = policy.refuseName(name);
    if (refused) throw new ZipRefused(refused.replace(name, () => shown(name)));
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ZipRefused(msg.duplicateName(shown(name)));
    seen.add(key);
    if (usize > policy.capOf(name)) throw new ZipRefused(msg.entryTooLarge(shown(name)));
    if ((total += usize) > policy.maxTotal) throw new ZipRefused(msg.tooLarge());
    if (method === 0 ? csize !== usize : csize > maxDeflated(usize)) throw new ZipRefused(msg.damagedEntry(shown(name)));
    out.push({ name, method, crc, csize, usize, dataStart: 0, localOffset, nameBytes, flags });
    p = next;
  }
  if (p !== cdSize) throw new ZipRefused(msg.damagedDirectory());

  // Every local header must say what the directory says, and no two entries may share a byte.
  const spans: Array<[number, number]> = [];
  for (const e of out) {
    if (e.localOffset + 30 + e.nameBytes.length > cdOffset) throw new ZipRefused(msg.damagedEntry(shown(e.name)));
    const lh = await pread(e.localOffset, 30 + e.nameBytes.length);
    const sizes = (e.flags & DATA_DESCRIPTOR) !== 0 // only reachable when the policy takes them
      || (lh.readUInt32LE(14) === e.crc && lh.readUInt32LE(18) === e.csize && lh.readUInt32LE(22) === e.usize);
    const same = lh.readUInt32LE(0) === LOCAL && lh.readUInt16LE(6) === e.flags && lh.readUInt16LE(8) === e.method
      && sizes && lh.readUInt16LE(26) === e.nameBytes.length && lh.subarray(30).equals(e.nameBytes);
    if (!same) throw new ZipRefused(msg.damagedEntry(shown(e.name)));
    (e as { dataStart: number }).dataStart = e.localOffset + 30 + e.nameBytes.length + lh.readUInt16LE(28);
    if (e.dataStart + e.csize > cdOffset) throw new ZipRefused(msg.damagedEntry(shown(e.name)));
    spans.push([e.localOffset, e.dataStart + e.csize]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw new ZipRefused(msg.damagedDirectory());
  return out.map(({ name, method, crc, csize, usize, dataStart }) => ({ name, method: method as 0 | 8, crc, csize, usize, dataStart }));
}

/** Counts and CRCs the inflated bytes; refuses the moment they pass `usize`. */
class Counter extends Transform {
  n = 0;
  crc = 0;
  constructor(private readonly e: ZipEntryInfo) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.n += chunk.length;
    if (this.n > this.e.usize) return cb(new ZipRefused(msg.inflatesPast(shown(this.e.name))));
    this.crc = zlib.crc32(chunk, this.crc);
    cb(null, chunk);
  }
}

/**
 * `length` bytes of `fh` from `start`, as a stream of positioned reads. Not
 * FileHandle.createReadStream: each of those leaves a listener on the handle,
 * and a bundle reads thousands of entries through one.
 */
function rangeOf(fh: fs.promises.FileHandle, start: number, length: number): Readable {
  let pos = start;
  const end = start + length;
  return new Readable({
    highWaterMark: 64 * 1024,
    read(): void {
      const n = Math.min(64 * 1024, end - pos);
      if (n <= 0) {
        this.push(null);
        return;
      }
      const b = Buffer.allocUnsafe(n);
      fh.read(b, 0, n, pos).then(({ bytesRead }) => {
        if (!bytesRead) return void this.destroy(new Error('unexpected end of file'));
        pos += bytesRead;
        this.push(bytesRead === n ? b : b.subarray(0, bytesRead));
      }, (err: unknown) => this.destroy(err as Error));
    },
  });
}

function reader(fh: fs.promises.FileHandle, own: boolean, base: number, entries: ZipEntryInfo[]): ZipReader {
  const byName = new Map(entries.map((e) => [e.name, e]));

  /** source → inflate → counter → sink; then size, CRC and full consumption of the compressed bytes. */
  async function stream(e: ZipEntryInfo, sink: Writable, signal?: AbortSignal): Promise<void> {
    const counter = new Counter(e);
    const stages: Array<Readable | Transform | Writable> = [];
    stages.push(rangeOf(fh, base + e.dataStart, e.csize));
    const inflater = e.method === 8 ? zlib.createInflateRaw() : null;
    if (inflater) stages.push(inflater);
    stages.push(counter, sink);
    try {
      await (signal ? pipeline(stages as unknown as [Readable, Writable], { signal }) : pipeline(stages as unknown as [Readable, Writable]));
    } catch (err) {
      if (err instanceof ZipRefused || (err as { name?: string }).name === 'AbortError') throw err;
      throw new ZipRefused(msg.damagedEntry(shown(e.name))); // a truncated or corrupt deflate stream
    }
    // zlib stops at the end of the deflate stream and ignores what follows: a stream
    // that ends before its compressed bytes do is not this entry's.
    if (inflater && inflater.bytesWritten !== e.csize) throw new ZipRefused(msg.damagedEntry(shown(e.name)));
    if (counter.n !== e.usize || counter.crc >>> 0 !== e.crc) throw new ZipRefused(msg.damagedEntry(shown(e.name)));
  }

  return {
    entries,
    get: (name) => byName.get(name),
    async read(e, signal) {
      const out = Buffer.allocUnsafe(e.usize); // at most the entry's cap; the counter keeps it there
      let at = 0;
      await stream(e, new Writable({ write(chunk: Buffer, _enc, cb) { chunk.copy(out, at); at += chunk.length; cb(); } }), signal);
      return out;
    },
    async extract(e, dest, signal) {
      try {
        await stream(e, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }), signal);
      } catch (err) {
        await fs.promises.rm(dest, { force: true });
        throw err;
      }
    },
    async verify(e, signal) {
      await stream(e, new Writable({ write(_chunk, _enc, cb) { cb(); } }), signal);
    },
    range(e) {
      return { fh, offset: base + e.dataStart, length: e.csize };
    },
    async close() {
      if (own) await fh.close().catch(() => undefined);
    },
  };
}
