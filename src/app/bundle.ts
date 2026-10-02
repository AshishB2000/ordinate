// Project bundles — one `.ordinate` file per project. MAIN PROCESS ONLY.
//
// A bundle is a plain ZIP of the project directory, Parquet included, plus a
// manifest.json. Written and read with Node's own zlib and a minimal zip
// writer/reader below — no dependency, because a zip is a few fixed-size
// headers around deflate, and the reader has to be strict anyway.
//
// WHAT TRAVELS is a WHITELIST (ENTRY_RULES): project.json, the record
// directories (stories and boundaries included), alerts.json, version history,
// the data model (relationships.json), the catalog, image assets and the share
// policy. What does not: config.json (keys and connection secrets live there,
// never in a project), privacy/salt.key (a per-project secret), the Trash, the
// Assistant's conversations (copilot.json), a synced project's lock.json, and
// anything else. A backup IS a bundle, so what is left off here is left out of
// every backup too — a new per-project file needs a rule here. Import
// REFUSES a bundle holding any entry outside the same whitelist — a bundle is a
// file from somewhere else, and "skip what we do not recognise" is how a crafted
// one would smuggle a path in.
//
// Import always makes a NEW project. Record ids are UUIDs; any that collide
// with a record already on this machine (importing a bundle exported from this
// same install, say) are remapped to fresh ones — in file names and in every
// JSON body, by exact UUID string, so every reference follows its record.
//
// Guards: entry names are whitelist-matched before anything touches a path;
// sizes are capped before inflating (a zip bomb stops at the cap); every
// entry's CRC is checked; the manifest's counts must match what is there.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from './projects';
import { projectDir, projectsBase, isValidId } from './recordKinds';
import { bundleThemesEntry, importBundleThemes } from './themeStore';
import { bundleTemplatesEntry, importBundleTemplates } from './userTemplateStore'; // r7:templates

export const BUNDLE_FORMAT = 'ordinate-project';
export const BUNDLE_VERSION = 1;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_G = new RegExp(UUID, 'gi');
const KEY = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z(?:-\\d{1,3})?';

/** Every entry a bundle may hold, and what it counts as in the manifest. */
const ENTRY_RULES: Array<{ re: RegExp; count?: string }> = [
  { re: /^manifest\.json$/ },
  { re: /^project\.json$/ },
  { re: /^alerts\.json$/ },
  { re: /^events\.json$/ }, // r8:events — the project's Events list
  { re: new RegExp(`^datasets/${UUID}\\.json$`, 'i'), count: 'datasets' },
  { re: new RegExp(`^datasets/${UUID}(?:\\.source)?\\.parquet$`, 'i'), count: 'parquet' },
  { re: new RegExp(`^visuals/${UUID}\\.json$`, 'i'), count: 'visuals' },
  { re: new RegExp(`^analyses/${UUID}\\.json$`, 'i'), count: 'dashboards' },
  { re: new RegExp(`^metrics/${UUID}\\.json$`, 'i'), count: 'metrics' },
  { re: new RegExp(`^reports/${UUID}\\.json$`, 'i'), count: 'reports' },
  { re: new RegExp(`^scorecards/${UUID}\\.json$`, 'i'), count: 'scorecards' },
  { re: new RegExp(`^scenarios/${UUID}\\.json$`, 'i'), count: 'scenarios' },
  { re: new RegExp(`^connections/${UUID}\\.json$`, 'i'), count: 'connections' },
  { re: new RegExp(`^history/(?:dataset|visual|dashboard|metric|report)/${UUID}/${KEY}\\.json$`, 'i'), count: 'versions' },
  { re: new RegExp(`^stories/${UUID}\\.json$`, 'i'), count: 'stories' },
  { re: new RegExp(`^notebooks/${UUID}\\.json$`, 'i'), count: 'notebooks' }, // r7:notebooks
  { re: new RegExp(`^boundaries/${UUID}\\.json$`, 'i'), count: 'boundaries' },
  // Binary (and SVG) images: not `.json`, so import never rewrites their bytes.
  { re: new RegExp(`^assets/${UUID}\\.(?:png|jpg|svg)$`, 'i'), count: 'assets' },
  { re: /^relationships\.json$/ },
  { re: /^catalog\.json$/ },
  // The share policy travels. Its sibling privacy/salt.key NEVER does: it is a
  // per-project secret, and "not on this list" is what keeps it home.
  { re: /^privacy\/policy\.json$/ },
  { re: /^comments\.json$/ }, // comment threads (src/app/comments.ts); target ids remap like any body
  // The workspace themes this project's dashboards name (themeStore.ts). Not a
  // project file: written at export, adopted into the workspace at import.
  { re: /^themes\.json$/ },
  { re: /^templates\.json$/ }, // r7:templates — user templates from these dashboards (userTemplateStore.ts)
];

const MAX_ENTRIES = 50_000;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024; // 1 GiB — far past a 1M-row Parquet
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024 - 1; // what a zip without zip64 can say

export interface BundleManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  project: { name: string };
  counts: Record<string, number>;
}

function ruleFor(name: string): { re: RegExp; count?: string } | undefined {
  return ENTRY_RULES.find((r) => r.re.test(name));
}

// ── The zip itself ───────────────────────────────────────────────────────────

export interface ZipEntry { name: string; data: Buffer }

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Packed { body: Buffer; store: boolean; crc: number }

function pack(e: ZipEntry, deflated: Buffer): Packed {
  const store = deflated.length >= e.data.length;
  return { body: store ? e.data : deflated, store, crc: zlib.crc32(e.data) >>> 0 };
}

/** A zip of the given entries: deflated when that is smaller, stored otherwise. */
export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  return assemble(entries, entries.map((e) => pack(e, zlib.deflateRawSync(e.data))), when);
}

const deflateRawAsync = (b: Buffer): Promise<Buffer> =>
  new Promise((res, rej) => zlib.deflateRaw(b, (err, out) => (err ? rej(err) : res(out))));
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
    packed.push(pack(entries[i], await deflateRawAsync(entries[i].data)));
    if (onEntry) onEntry(i + 1, entries.length);
  }
  return assemble(entries, packed, when);
}

function assemble(entries: ZipEntry[], packed: Packed[], when: Date): Buffer {
  // The entry count is a 16-bit field without zip64; past it the file would lie.
  if (entries.length > 0xffff) throw new Error('This project has too many files to bundle.');
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  entries.forEach((e, i) => {
    const name = Buffer.from(e.name, 'utf8');
    const { body, store, crc } = packed[i];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
    if (offset > MAX_TOTAL_BYTES) throw new Error('This project is too large to bundle (over 4 GB).');
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
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

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * A bundle's manifest WITHOUT reading the bundle: the zip directory sits at the
 * end of the file, so this reads the tail, finds manifest.json's entry there,
 * and reads just those bytes — a backup list stays cheap however large the
 * projects are. Same guards as readZip (CRC, size cap, format check). Null for
 * anything that is not a readable Ordinate bundle: truncated, garbage, another
 * format. The caller skips it; nothing here throws.
 */
export async function peekManifest(file: string): Promise<BundleManifest | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const size = (await fh.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 22 + 65535));
    await fh.read(tail, 0, tail.length, size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size || count > MAX_ENTRIES) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLen = cd.readUInt16LE(p + 28);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'manifest.json') {
        const method = cd.readUInt16LE(p + 10);
        const r = { name, method, crc: cd.readUInt32LE(p + 16), usize: cd.readUInt32LE(p + 24), raw: Buffer.alloc(0) };
        const csize = cd.readUInt32LE(p + 20);
        const localOff = cd.readUInt32LE(p + 42);
        if ((method !== 0 && method !== 8) || r.usize > MAX_MANIFEST_BYTES || csize > MAX_MANIFEST_BYTES) return null;
        const local = Buffer.alloc(30);
        await fh.read(local, 0, 30, localOff);
        if (local.readUInt32LE(0) !== 0x04034b50) return null;
        r.raw = Buffer.alloc(csize);
        const start = localOff + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if ((await fh.read(r.raw, 0, csize, start)).bytesRead !== csize) return null;
        const data = checked(r, method === 0 ? r.raw : await inflateRawAsync(r.raw, r.usize)).data;
        const m = JSON.parse(data.toString('utf8'));
        return m && m.format === BUNDLE_FORMAT && m.formatVersion === BUNDLE_VERSION ? m : null;
      }
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => { /* already closed */ });
  }
}

// ── Export ───────────────────────────────────────────────────────────────────

async function walk(dir: string, rel = ''): Promise<string[]> {
  let dirents: fs.Dirent[] = [];
  try {
    dirents = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...(await walk(dir, r)));
    else if (d.isFile()) out.push(r);
  }
  return out;
}

/** The bundle for one project, as bytes. Only whitelisted files go in. */
/** Progress (0–1) and a cancel check a job hands in; both optional. */
export interface BundleProgress {
  onProgress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
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
  const files = (await walk(dir)).sort();
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const rule = ruleFor(rel);
    if (!rule || rel === 'manifest.json') continue; // the trash, copilot.json, temp files…
    if (opts.checkCancelled) opts.checkCancelled();
    entries.push({ name: rel, data: await fs.promises.readFile(path.join(dir, rel)) });
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
    appVersion: app.getVersion ? app.getVersion() : '',
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

// ── Import ───────────────────────────────────────────────────────────────────

/** Every record id already on this machine: file names under every project. */
async function idsInUse(): Promise<Set<string>> {
  const used = new Set<string>();
  let pids: string[] = [];
  try { pids = (await fs.promises.readdir(projectsBase())).filter((n) => isValidId(n)); } catch (_) { pids = []; }
  for (const pid of pids) {
    used.add(pid.toLowerCase());
    for (const rel of await walk(path.join(projectsBase(), pid))) {
      for (const m of rel.match(UUID_G) || []) used.add(m.toLowerCase());
    }
    try {
      const a = JSON.parse(await fs.promises.readFile(path.join(projectsBase(), pid, 'alerts.json'), 'utf8'));
      for (const r of a.rules || []) if (typeof r.id === 'string') used.add(r.id.toLowerCase());
    } catch (_) { /* no alerts */ }
  }
  return used;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  project?: projects.Project;
  counts?: Record<string, number>;
  remapped?: number;
}

/** `name` replaces the manifest's project name (a restore names its copy). */
export async function importBundle(bytes: Buffer, opts: BundleProgress & { name?: string } = {}): Promise<ImportResult> {
  let entries: ZipEntry[];
  try {
    entries = await readZipAsync(bytes, (done, total) => {
      if (opts.checkCancelled) opts.checkCancelled();
      if (opts.onProgress) opts.onProgress(0.6 * (done / total), `Reading ${done} of ${total} files`);
    });
  } catch (err: any) {
    if (err && err.name === 'JobCancelled') throw err; // a cancel is not a bad bundle
    return { ok: false, error: err?.message || 'That file is not an Ordinate project bundle.' };
  }
  const outside = entries.filter((e) => !ruleFor(e.name));
  if (outside.length) {
    return { ok: false, error: `The bundle holds files Ordinate does not import (${outside[0].name}) — it was refused as a whole.` };
  }
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(manifestEntry ? manifestEntry.data.toString('utf8') : '');
  } catch (_) {
    return { ok: false, error: 'The bundle has no readable manifest.' };
  }
  if (!manifest || manifest.format !== BUNDLE_FORMAT || manifest.formatVersion !== BUNDLE_VERSION) {
    return { ok: false, error: 'This is not an Ordinate project bundle, or it is from a newer version.' };
  }
  // The manifest's counts must be what is actually there — a mismatch means a
  // truncated or edited bundle, and importing half a project is worse than none.
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const c = ruleFor(e.name)!.count;
    if (c) counts[c] = (counts[c] || 0) + 1;
  }
  const alertsEntry = entries.find((e) => e.name === 'alerts.json');
  if (alertsEntry) {
    try { counts.alerts = (JSON.parse(alertsEntry.data.toString('utf8')).rules || []).length; } catch (_) {
      return { ok: false, error: 'The bundle\'s alerts.json is not readable.' };
    }
  }
  const declared = manifest.counts && typeof manifest.counts === 'object' ? manifest.counts : {};
  const keys = new Set([...Object.keys(declared), ...Object.keys(counts)]);
  for (const k of keys) {
    if ((declared[k] || 0) !== (counts[k] || 0)) {
      return { ok: false, error: `The bundle does not match its manifest (${k}: ${declared[k] || 0} listed, ${counts[k] || 0} present).` };
    }
  }

  // Remap every id that is already in use here, file names and bodies alike.
  const used = await idsInUse();
  const remap = new Map<string, string>();
  for (const e of entries) {
    const names = e.name.match(UUID_G) || [];
    const body = e.name.endsWith('.json') ? e.data.toString('utf8').match(UUID_G) || [] : [];
    for (const id of [...names, ...body]) {
      const k = id.toLowerCase();
      if (used.has(k) && !remap.has(k)) remap.set(k, randomUUID());
    }
  }
  const swap = (s: string): string => s.replace(UUID_G, (m) => remap.get(m.toLowerCase()) || m);

  const name = String(opts.name || (manifest.project && manifest.project.name) || 'Imported project').trim() || 'Imported project';
  const taken = new Set((await projects.listProjects()).map((p) => p.name));
  const created = await projects.createProject(taken.has(name) ? `${name} (imported)` : name);
  const dir = projectDir(created.id);
  try {
    for (const e of entries) {
      if (e.name === 'manifest.json' || e.name === 'project.json' || e.name === 'themes.json' || e.name === 'templates.json') continue; // the new project has its own; themes are workspace records
      const rel = swap(e.name);
      if (!ruleFor(rel)) throw new Error('A remapped name left the whitelist.'); // cannot happen; guard anyway
      const target = path.join(dir, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const data = rel.endsWith('.json') ? Buffer.from(swap(e.data.toString('utf8')), 'utf8') : e.data;
      const tmp = target + '.' + randomUUID() + '.tmp';
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, target);
    }
    // Carry the source project's dismissed insights and colours; everything else about the
    // project record (id, dates, archive state) belongs to the new one.
    const pj = entries.find((e) => e.name === 'project.json');
    if (pj) {
      try {
        const src = JSON.parse(swap(pj.data.toString('utf8')));
        if (Array.isArray(src.dismissedInsights)) {
          for (const d of src.dismissedInsights.slice(0, 500)) await projects.setInsightDismissed(created.id, String(d), true);
        }
        // …and its category colours (sanitized on the way in, like any read).
        if (src.colorMap) await projects.setColorMap(created.id, src.colorMap);
      } catch (_) { /* optional */ }
    }
    await importBundleThemes(entries, swap).catch(() => 0); // a theme costs the look, never the import
    await importBundleTemplates(entries, swap); // r7:templates — merged by id, never clobbering
  } catch (err: any) {
    await projects.deleteProject(created.id);
    return { ok: false, error: err?.message || 'The bundle could not be written.' };
  }
  return { ok: true, project: (await projects.getProject(created.id)) || created, counts, remapped: remap.size };
}
