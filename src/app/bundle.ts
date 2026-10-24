// Project bundles — one `.ordinate` file per project. MAIN PROCESS ONLY.
//
// A bundle is a plain ZIP of the project directory, Parquet included, plus a
// manifest.json, written with Node's own zlib — no dependency, because a zip is
// a few fixed-size headers around deflate (./zipWriter.ts).
//
// WHAT TRAVELS is a WHITELIST (./bundleRules.ts ENTRY_RULES): project.json, the
// record directories (stories and boundaries included), alerts.json, version
// history, the data model (relationships.json), the catalog, image assets and
// the share policy. What does not: config.json (keys and connection secrets
// live there, never in a project), privacy/salt.key (a per-project secret), the
// Trash, the Assistant's conversations (copilot.json), a synced project's
// lock.json, and anything else. A backup IS a bundle, so what is left off here
// is left out of every backup too — a new per-project file needs a rule there.
//
// This file EXPORTS. The import (./bundleImport.ts, re-exported below) reads
// the uploaded FILE through ./zipReader.ts: every name checked against the same
// whitelist from the central directory before a byte is inflated, memory
// bounded by one JSON entry, never by the bundle (docs/pod-lifecycle).

import * as path from 'path';
import * as zlib from 'zlib';
import * as projects from './projects';
import { projectDir } from './recordKinds';
import { bundleThemesEntry } from './themeStore';
import * as recordFs from './recordFs';
import { listBlobs, readBlob } from './blobStore';
import { bundleTemplatesEntry } from './userTemplateStore'; // r7:templates
import { BUNDLE_FORMAT, BUNDLE_POLICY, BUNDLE_VERSION, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, RECORD_MAX_BYTES, ruleFor } from './bundleRules';
import type { BundleManifest } from './bundleRules';
import { recordTooLargeToExport } from './bundleMessages';
import { centralHeader, deflateRawAsync, dosTime, endRecord, localHeader, pack, type Packed } from './zipWriter';
import { openZip } from './zipReader';
import { parseBounded } from './jsonBudget';
import { walk, type BundleProgress } from './bundleImport';

export { BUNDLE_FORMAT, BUNDLE_VERSION } from './bundleRules';
export type { BundleManifest } from './bundleRules';
// The import reads a FILE through ./zipReader.ts (docs/pod-lifecycle): ./bundleImport.ts.
export { importBundle, type BundleProgress, type ImportOptions, type ImportResult } from './bundleImport';

// ── The zip itself ───────────────────────────────────────────────────────────
// In memory: what an export builds (one project) and what the tests read back.
// Untrusted input never comes through here — it is read from its file by
// ./zipReader.ts — so this reader stays as the reference the streamed one is
// compared with (scripts/test-bundleMemory.ts).

export interface ZipEntry { name: string; data: Buffer }

/** A zip of the given entries: deflated when that is smaller, stored otherwise. */
export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  return assemble(entries, entries.map((e) => pack(e.data, zlib.deflateRawSync(e.data))), when);
}

const inflateRawAsync = (b: Buffer, max: number): Promise<Buffer> =>
  new Promise((res, rej) => zlib.inflateRaw(b, { maxOutputLength: Math.max(1, max) }, (err, out) => (err ? rej(err) : res(out))));

/**
 * `writeZip` with the deflate on libuv's thread pool, so a bundle of a large
 * project never freezes the main process. `onEntry` reports progress (entries
 * done, total) and may throw to cancel between entries — that is how a job's
 * `checkCancelled` reaches in. Byte-identical output to `writeZip`.
 */
export async function writeZipAsync(
  entries: ZipEntry[],
  when = new Date(),
  onEntry?: (done: number, total: number) => void,
): Promise<Buffer> {
  const packed: Packed[] = [];
  for (let i = 0; i < entries.length; i++) {
    packed.push(pack(entries[i].data, await deflateRawAsync(entries[i].data)));
    if (onEntry) onEntry(i + 1, entries.length);
  }
  return assemble(entries, packed, when);
}

function assemble(entries: ZipEntry[], packed: Packed[], when: Date): Buffer {
  // The entry count is a 16-bit field without zip64; past it the file would lie.
  if (entries.length > 0xffff) throw new Error('This project has too many files to bundle.');
  const at = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  entries.forEach((e, i) => {
    const name = Buffer.from(e.name, 'utf8');
    const p = packed[i];
    locals.push(localHeader(name, p, e.data.length, at), name, p.body);
    centrals.push(centralHeader(name, p, e.data.length, at, offset), name);
    offset += 30 + name.length + p.body.length;
    if (offset > MAX_TOTAL_BYTES) throw new Error('This project is too large to bundle (over 4 GB).');
  });
  const cd = Buffer.concat(centrals);
  return Buffer.concat([...locals, cd, endRecord(entries.length, cd.length, offset)]);
}

interface RawEntry { name: string; method: number; crc: number; usize: number; raw: Buffer }

/** Walk a zip's directory: every entry's name and still-compressed bytes. */
function zipDirectory(buf: Buffer): RawEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a bundle: no zip directory found.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('The bundle holds too many files.');
  const out: RawEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The bundle is damaged (directory).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error('Encrypted bundles are not supported.');
    if (method !== 0 && method !== 8) throw new Error('The bundle uses an unsupported compression method.');
    if (usize > MAX_ENTRY_BYTES || (total += usize) > MAX_TOTAL_BYTES) throw new Error('The bundle is too large to import.');
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('The bundle is damaged (entry).');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (start + csize > buf.length) throw new Error('The bundle is damaged (truncated).');
    out.push({ name, method, crc, usize, raw: buf.subarray(start, start + csize) });
  }
  return out;
}

function checked(r: RawEntry, data: Buffer): ZipEntry {
  if (data.length !== r.usize || (zlib.crc32(data) >>> 0) !== r.crc) throw new Error(`The bundle is damaged (${r.name}).`);
  return { name: r.name, data };
}

/** Read a zip's entries. Throws on anything malformed, encrypted or oversized. */
export function readZip(buf: Buffer): ZipEntry[] {
  return zipDirectory(buf).map((r) =>
    checked(r, r.method === 0 ? Buffer.from(r.raw) : zlib.inflateRawSync(r.raw, { maxOutputLength: Math.max(1, r.usize) })));
}

/** `readZip` with the inflate off the main thread. Same guards, same errors. */
export async function readZipAsync(buf: Buffer, onEntry?: (done: number, total: number) => void): Promise<ZipEntry[]> {
  const dir = zipDirectory(buf);
  const out: ZipEntry[] = [];
  for (let i = 0; i < dir.length; i++) {
    const r = dir[i];
    out.push(checked(r, r.method === 0 ? Buffer.from(r.raw) : await inflateRawAsync(r.raw, r.usize)));
    if (onEntry) onEntry(i + 1, dir.length);
  }
  return out;
}


/**
 * A bundle's manifest WITHOUT reading the bundle: the strict reader
 * (./zipReader.ts) checks the directory and every header with positioned reads
 * and inflates only manifest.json — a backup list stays cheap however large the
 * projects are. Null for anything that is not a readable Ordinate bundle:
 * truncated, garbage, another format. The caller skips it; nothing here throws.
 */
export async function peekManifest(file: string): Promise<BundleManifest | null> {
  try {
    const zip = await openZip({ file }, BUNDLE_POLICY);
    try {
      const e = zip.get('manifest.json');
      if (!e) return null;
      const m = (await parseBounded(await zip.read(e))) as BundleManifest | null;
      return m && m.format === BUNDLE_FORMAT && m.formatVersion === BUNDLE_VERSION ? m : null;
    } finally {
      await zip.close();
    }
  } catch (_) {
    return null;
  }
}

// ── Export ───────────────────────────────────────────────────────────────────

/** The version stamped into a manifest: package.json's. */
function appVersion(): string {
  return (require('../../package.json') as { version: string }).version;
}

export async function exportProject(
  projectId: string,
  opts: BundleProgress = {},
): Promise<{ bytes: Buffer; manifest: BundleManifest } | null> {
  const project = await projects.getProject(projectId);
  const dir = projectDir(projectId);
  if (!project || !dir) return null;
  const counts: Record<string, number> = {};
  const entries: ZipEntry[] = [];
  // Image-card pictures are rows on a server with DATABASE_URL (./blobStore.ts), not files the walk sees.
  const files = [...new Set([...(await walk(dir)), ...(await listBlobs(path.join(dir, 'assets'))).map((n) => 'assets/' + n)])].sort();
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const rule = ruleFor(rel);
    if (!rule || rel === 'manifest.json') continue; // the trash, copilot.json, temp files…
    if (opts.checkCancelled) opts.checkCancelled();
    const data = rel.startsWith('assets/') ? await readBlob(path.join(dir, rel)) : await recordFs.readFile(path.join(dir, rel));
    if (!data) continue; // a picture over its cap is not served, so it does not travel either
    // A record past the cap (left by an older version): refused here, so no bundle we
    // write — a backup above all — is one our own import refuses (docs/pod-lifecycle §3.5).
    if (rel.endsWith('.json') && data.length > RECORD_MAX_BYTES) throw new Error(recordTooLargeToExport(rel));
    entries.push({ name: rel, data });
    if (opts.onProgress) opts.onProgress(0.3 * ((i + 1) / files.length), 'Reading files');
    if (rule.count) counts[rule.count] = (counts[rule.count] || 0) + 1;
  }
  const themes = await bundleThemesEntry(entries);
  if (themes) entries.push(themes);
  const templates = await bundleTemplatesEntry(entries); // r7:templates
  if (templates) entries.push(templates);
  const alerts = entries.find((e) => e.name === 'alerts.json');
  if (alerts) {
    try { counts.alerts = (JSON.parse(alerts.data.toString('utf8')).rules || []).length; } catch (_) { counts.alerts = 0; }
  }
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_VERSION,
    appVersion: appVersion(),
    exportedAt: new Date().toISOString(),
    project: { name: project.name },
    counts,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  const bytes = await writeZipAsync(entries, new Date(), (done, total) => {
    if (opts.checkCancelled) opts.checkCancelled();
    if (opts.onProgress) opts.onProgress(0.3 + 0.7 * (done / total), `Compressing ${done} of ${total} files`);
  });
  return { bytes, manifest };
}
