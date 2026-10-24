// Writing a zip — the header bytes, and a writer that appends entry by entry
// to a FILE — MAIN PROCESS ONLY. The org backup (src/ipc/settingsServer.ts)
// holds one project's bundle at a time this way, never the org; ./bundle.ts's
// in-memory writeZip builds its headers here too, so both write the same bytes.
//
// No zip64 and no data descriptors: ≤ 0xFFFF entries, < 4 GiB, sizes and CRC in
// every local header — what ./zipReader.ts accepts.

import * as fs from 'fs';
import * as zlib from 'zlib';
import { MAX_TOTAL_BYTES } from './bundleRules';
import { backupTooLarge } from './bundleMessages';

export function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface Packed { body: Buffer; store: boolean; crc: number }

/** Deflated when that is smaller, stored otherwise; `store` forces stored (an inner bundle is deflated already). */
export function pack(data: Buffer, deflated: Buffer | null): Packed {
  const store = !deflated || deflated.length >= data.length;
  return { body: store ? data : (deflated as Buffer), store, crc: zlib.crc32(data) >>> 0 };
}

export function localHeader(name: Buffer, p: Packed, usize: number, when: { time: number; date: number }): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // names are UTF-8
  local.writeUInt16LE(p.store ? 0 : 8, 8);
  local.writeUInt16LE(when.time, 10);
  local.writeUInt16LE(when.date, 12);
  local.writeUInt32LE(p.crc, 14);
  local.writeUInt32LE(p.body.length, 18);
  local.writeUInt32LE(usize, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

export function centralHeader(name: Buffer, p: Packed, usize: number, when: { time: number; date: number }, offset: number): Buffer {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(p.store ? 0 : 8, 10);
  central.writeUInt16LE(when.time, 12);
  central.writeUInt16LE(when.date, 14);
  central.writeUInt32LE(p.crc, 16);
  central.writeUInt32LE(p.body.length, 20);
  central.writeUInt32LE(usize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  return central;
}

export function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return end;
}

const deflateRawAsync = (b: Buffer): Promise<Buffer> =>
  new Promise((res, rej) => zlib.deflateRaw(b, (err, out) => (err ? rej(err) : res(out))));

/** A zip appended to `file` entry by entry: only the central records (46 bytes + name each) stay in memory. */
export class ZipFileWriter {
  private offset = 0;
  private readonly centrals: Buffer[] = [];
  private readonly when: { time: number; date: number };

  private constructor(private readonly fh: fs.promises.FileHandle, private readonly file: string, when: Date) {
    this.when = dosTime(when);
  }

  /** A new file (never an existing one), readable by the server only. */
  static async create(file: string, when = new Date()): Promise<ZipFileWriter> {
    return new ZipFileWriter(await fs.promises.open(file, 'wx', 0o600), file, when);
  }

  /** One entry: deflated on libuv's pool when that is smaller, or `store`d as is. */
  async add(name: string, data: Buffer, opts: { store?: boolean } = {}): Promise<void> {
    const p = pack(data, opts.store ? null : await deflateRawAsync(data));
    const nameBuf = Buffer.from(name, 'utf8');
    const local = localHeader(nameBuf, p, data.length, this.when);
    if (this.centrals.length / 2 >= 0xffff || this.offset + local.length + nameBuf.length + p.body.length > MAX_TOTAL_BYTES) {
      throw new Error(backupTooLarge());
    }
    this.centrals.push(centralHeader(nameBuf, p, data.length, this.when, this.offset), nameBuf);
    for (const b of [local, nameBuf, p.body]) await this.write(b);
  }

  /** The central directory and the end record, then the file is closed. */
  async close(): Promise<void> {
    const cd = Buffer.concat(this.centrals);
    const cdOffset = this.offset;
    await this.write(cd);
    await this.write(endRecord(this.centrals.length / 2, cd.length, cdOffset));
    await this.fh.close();
  }

  /** A failed write: the file is closed and deleted. */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
    await fs.promises.rm(this.file, { force: true });
  }

  private async write(b: Buffer): Promise<void> {
    let done = 0;
    while (done < b.length) done += (await this.fh.write(b, done, b.length - done, this.offset + done)).bytesWritten;
    this.offset += b.length;
  }
}
