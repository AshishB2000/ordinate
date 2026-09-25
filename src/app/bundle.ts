// Project bundles — one `.ordinate` file per project. MAIN PROCESS ONLY.
//
// A bundle is a plain ZIP of the project directory, Parquet included, plus a
// manifest.json. Written and read with Node's own zlib and a minimal zip
// writer/reader below — no dependency, because a zip is a few fixed-size
// headers around deflate, and the reader has to be strict anyway.
//
// WHAT TRAVELS is a WHITELIST (ENTRY_RULES): project.json, the six record
// directories, alerts.json and version history. What does not: config.json
// (keys and connection secrets live there, never in a project), the Trash,
// the Assistant's conversations (copilot.json), and anything else. Import
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
  { re: new RegExp(`^datasets/${UUID}\\.json$`, 'i'), count: 'datasets' },
  { re: new RegExp(`^datasets/${UUID}(?:\\.source)?\\.parquet$`, 'i'), count: 'parquet' },
  { re: new RegExp(`^visuals/${UUID}\\.json$`, 'i'), count: 'visuals' },
  { re: new RegExp(`^analyses/${UUID}\\.json$`, 'i'), count: 'dashboards' },
  { re: new RegExp(`^metrics/${UUID}\\.json$`, 'i'), count: 'metrics' },
  { re: new RegExp(`^reports/${UUID}\\.json$`, 'i'), count: 'reports' },
  { re: new RegExp(`^connections/${UUID}\\.json$`, 'i'), count: 'connections' },
  { re: new RegExp(`^history/(?:dataset|visual|dashboard|metric|report)/${UUID}/${KEY}\\.json$`, 'i'), count: 'versions' },
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

/** A zip of the given entries: deflated when that is smaller, stored otherwise. */
export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  // The entry count is a 16-bit field without zip64; past it the file would lie.
  if (entries.length > 0xffff) throw new Error('This project has too many files to bundle.');
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : deflated;
    const crc = zlib.crc32(e.data) >>> 0;
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
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Read a zip's entries. Throws on anything malformed, encrypted or oversized. */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a bundle: no zip directory found.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('The bundle holds too many files.');
  const out: ZipEntry[] = [];
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
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
    if (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`The bundle is damaged (${name}).`);
    out.push({ name, data });
  }
  return out;
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
export async function exportProject(projectId: string): Promise<{ bytes: Buffer; manifest: BundleManifest } | null> {
  const project = await projects.getProject(projectId);
  const dir = projectDir(projectId);
  if (!project || !dir) return null;
  const counts: Record<string, number> = {};
  const entries: ZipEntry[] = [];
  for (const rel of (await walk(dir)).sort()) {
    const rule = ruleFor(rel);
    if (!rule || rel === 'manifest.json') continue; // the trash, copilot.json, temp files…
    entries.push({ name: rel, data: await fs.promises.readFile(path.join(dir, rel)) });
    if (rule.count) counts[rule.count] = (counts[rule.count] || 0) + 1;
  }
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
  return { bytes: writeZip(entries), manifest };
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

export async function importBundle(bytes: Buffer): Promise<ImportResult> {
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch (err: any) {
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

  const name = String((manifest.project && manifest.project.name) || 'Imported project').trim() || 'Imported project';
  const taken = new Set((await projects.listProjects()).map((p) => p.name));
  const created = await projects.createProject(taken.has(name) ? `${name} (imported)` : name);
  const dir = projectDir(created.id);
  try {
    for (const e of entries) {
      if (e.name === 'manifest.json' || e.name === 'project.json') continue; // the new project has its own
      const rel = swap(e.name);
      if (!ruleFor(rel)) throw new Error('A remapped name left the whitelist.'); // cannot happen; guard anyway
      const target = path.join(dir, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const data = rel.endsWith('.json') ? Buffer.from(swap(e.data.toString('utf8')), 'utf8') : e.data;
      const tmp = target + '.' + randomUUID() + '.tmp';
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, target);
    }
    // Carry the source project's dismissed insights; everything else about the
    // project record (id, dates, archive state) belongs to the new one.
    const pj = entries.find((e) => e.name === 'project.json');
    if (pj) {
      try {
        const src = JSON.parse(swap(pj.data.toString('utf8')));
        if (Array.isArray(src.dismissedInsights)) {
          for (const d of src.dismissedInsights.slice(0, 500)) await projects.setInsightDismissed(created.id, String(d), true);
        }
      } catch (_) { /* optional */ }
    }
  } catch (err: any) {
    await projects.deleteProject(created.id);
    return { ok: false, error: err?.message || 'The bundle could not be written.' };
  }
  return { ok: true, project: (await projects.getProject(created.id)) || created, counts, remapped: remap.size };
}
