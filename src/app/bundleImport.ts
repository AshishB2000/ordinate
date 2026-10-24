// Importing a project bundle — MAIN PROCESS ONLY (docs/pod-lifecycle/00-design.md
// §3.4). ./bundle.ts re-exports `importBundle`, so callers keep `bundle.importBundle`.
//
// A bundle is an upload: read from its FILE through ./zipReader.ts, so memory
// holds at most one JSON entry (≤ 32 MiB, and one at a time across every import
// in this process) — never the bundle.
//
//   1. the zip's structure, names (the whitelist) and declared sizes — nothing
//      inflated yet; an unknown name stops it here;
//   2. the manifest, and its counts against the entries' NAMES;
//   3. pass 1: every JSON and image entry inflated and checked (size, CRC), the
//      record ids in it that are already used here noted — then dropped;
//   4. every table (Parquet) streamed into a staging dir, checked the same way;
//   5. only now the project is created; pass 2 inflates each JSON entry again,
//      swaps the colliding ids IN PLACE and writes the record; images are
//      written; staged tables are moved into place.
// Nothing is created until every entry has been inflated and checked.
//
// Import always makes a NEW project. Record ids are UUIDs; any that collide
// with a record already on this machine are remapped to fresh ones — in file
// names and in every JSON body, by exact UUID string, so every reference
// follows its record. A connection always gets a fresh id (T6.3).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { setImmediate as yieldToLoop } from 'timers/promises';
import * as appPaths from './paths';
import * as projects from './projects';
import { projectDir, projectsBase, isValidId } from './recordKinds';
import { importBundleThemes } from './themeStore';
import * as recordFs from './recordFs';
import { listBlobs, writeBlob } from './blobStore';
import { importBundleTemplates } from './userTemplateStore';
import { BUNDLE_FORMAT, BUNDLE_POLICY, BUNDLE_VERSION, CONNECTION_FILE, kindOf, ruleFor, UUID_G } from './bundleRules';
import type { BundleManifest } from './bundleRules';
import * as msg from './bundleMessages';
import { countJsonValuesAsync, JsonTooComplex, MAX_JSON_VALUES, parseBounded } from './jsonBudget';
import { logger } from './logger';
import { openZip, ZipRefused, type ZipEntryInfo, type ZipReader, type ZipSource } from './zipReader';

/** Progress (0–1) and a cancel check a job hands in; both optional. */
export interface BundleProgress {
  onProgress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
}

export interface ImportOptions extends BundleProgress {
  /** Replaces the manifest's project name (a restore names its copy). */
  name?: string;
  /** The job's own signal: a stream in flight stops with it. */
  signal?: AbortSignal;
  /** One byte budget for several imports (a backup's projects): each takes its declared size from it. */
  budget?: { left: number };
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  project?: projects.Project;
  counts?: Record<string, number>;
  remapped?: number;
}

/** Every file under `dir` (records and files alike), '/'-joined. */
export async function walk(dir: string, rel = ''): Promise<string[]> {
  let dirents: recordFs.Dirent[] = [];
  try {
    dirents = await recordFs.readdir(path.join(dir, rel), { withFileTypes: true });
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

/** Every record id already on this machine: file names under every project. */
async function idsInUse(): Promise<Set<string>> {
  const used = new Set<string>();
  let pids: string[] = [];
  try { pids = (await recordFs.readdir(projectsBase())).filter((n) => isValidId(n)); } catch (_) { pids = []; }
  for (const pid of pids) {
    used.add(pid.toLowerCase());
    for (const rel of [...(await walk(path.join(projectsBase(), pid))), ...(await listBlobs(path.join(projectsBase(), pid, 'assets')))]) {
      for (const m of rel.match(UUID_G) || []) used.add(m.toLowerCase());
    }
    try {
      const a = JSON.parse(await recordFs.readFile(path.join(projectsBase(), pid, 'alerts.json'), 'utf8'));
      for (const r of a.rules || []) if (typeof r.id === 'string') used.add(r.id.toLowerCase());
    } catch (_) { /* no alerts */ }
  }
  return used;
}

// One in-memory JSON entry at a time in this process, whichever import it
// belongs to: three concurrent imports cost one entry's memory, not three.
let gate: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.catch(() => undefined);
  return run;
}

const HEX = new Uint8Array(256);
for (const c of '0123456789abcdefABCDEF') HEX[c.charCodeAt(0)] = 1;

/** A UUID (8-4-4-4-12 hex, either case) at byte `i` of `buf`. */
function uuidAt(buf: Buffer, i: number): boolean {
  if (i < 0 || i + 36 > buf.length) return false;
  for (let k = 0; k < 36; k++) {
    const b = buf[i + k];
    if (k === 8 || k === 13 || k === 18 || k === 23 ? b !== 0x2d : !HEX[b]) return false;
  }
  return true;
}

/**
 * Every UUID in `buf`, leftmost first and never overlapping (what a global
 * regex finds), handed to `seen` with its byte offset. Anchored on each `-`
 * through `buf.indexOf` (native) and checked in place: no string, no regex
 * backtracking over a run of hex digits. Yields to the event loop whenever
 * ~10 ms have passed: one regex over 32 MiB with no id held it 735 ms (S2).
 */
export async function eachId(buf: Buffer, seen: (id: string, at: number) => void): Promise<void> {
  let from = 0; // the next id may start here (the end of the last one)
  let t = Date.now();
  let steps = 0;
  for (let dash = buf.indexOf(0x2d, from + 8); dash >= 0; dash = buf.indexOf(0x2d, Math.max(dash + 1, from + 8))) {
    const at = dash - 8;
    if (uuidAt(buf, at)) {
      seen(buf.toString('latin1', at, at + 36), at);
      from = at + 36;
    }
    if (++steps % 4096 === 0 && Date.now() - t >= 10) {
      await yieldToLoop();
      t = Date.now();
    }
  }
}

/** Imports one bundle as a NEW project. A Buffer (the tests) is written to a temp file first. */
export async function importBundle(source: Buffer | ZipSource, opts: ImportOptions = {}): Promise<ImportResult> {
  if (Buffer.isBuffer(source)) {
    const tmp = path.join(os.tmpdir(), `ordinate-bundle-${randomUUID()}.ordinate`);
    await fs.promises.writeFile(tmp, source, { mode: 0o600 });
    try {
      return await importBundle({ file: tmp }, opts);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }
  let zip: ZipReader;
  try {
    zip = await openZip(source, BUNDLE_POLICY);
  } catch (err) {
    if (err instanceof ZipRefused) return { ok: false, error: err.message };
    return { ok: false, error: msg.notThisFormat() };
  }
  try {
    return await importFrom(zip, opts);
  } catch (err) {
    if (err && (err as Error).name === 'JobCancelled') throw err; // a cancel is not a bad bundle
    if (err instanceof ZipRefused) return { ok: false, error: err.message };
    throw err;
  } finally {
    await zip.close();
  }
}

async function importFrom(zip: ZipReader, opts: ImportOptions): Promise<ImportResult> {
  const { entries } = zip;
  const tick = (f: number, note?: string): void => {
    if (opts.checkCancelled) opts.checkCancelled();
    if (opts.onProgress) opts.onProgress(f, note);
  };
  if (opts.budget) {
    const declared = entries.reduce((n, e) => n + e.usize, 0);
    if (declared > opts.budget.left) return { ok: false, error: msg.tooLarge() };
    opts.budget.left -= declared;
  }

  // 2. The manifest, and its counts against the names.
  // Every file parsed whole is parsed only within the value budget (./jsonBudget.ts):
  // a parse's heap is its values, and a 33 KB bundle can hold 11 M empty objects.
  let manifest: BundleManifest;
  const manifestEntry = zip.get('manifest.json');
  try {
    if (!manifestEntry) throw new SyntaxError('no manifest');
    manifest = (await parseBounded(await zip.read(manifestEntry, opts.signal))) as BundleManifest;
  } catch (err) {
    if (err instanceof ZipRefused) throw err;
    if (err instanceof JsonTooComplex) return { ok: false, error: msg.tooManyValues('manifest.json') };
    return { ok: false, error: msg.noManifest() };
  }
  if (!manifest || manifest.format !== BUNDLE_FORMAT || manifest.formatVersion !== BUNDLE_VERSION) {
    return { ok: false, error: msg.notThisFormat() };
  }
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const c = ruleFor(e.name)?.count;
    if (c) counts[c] = (counts[c] || 0) + 1;
  }
  const alertsEntry = zip.get('alerts.json');
  if (alertsEntry) {
    try { counts.alerts = (((await parseBounded(await zip.read(alertsEntry, opts.signal))) as { rules?: unknown[] }).rules || []).length; } catch (err) {
      if (err instanceof ZipRefused) throw err;
      if (err instanceof JsonTooComplex) return { ok: false, error: msg.tooManyValues('alerts.json') };
      return { ok: false, error: msg.alertsUnreadable() };
    }
  }
  const declared = manifest.counts && typeof manifest.counts === 'object' ? manifest.counts : {};
  for (const k of new Set([...Object.keys(declared), ...Object.keys(counts)])) {
    if ((declared[k] || 0) !== (counts[k] || 0)) return { ok: false, error: msg.manifestMismatch(k, String(declared[k] || 0), String(counts[k] || 0)) };
  }

  // 3. Pass 1: every in-memory entry checked; the ids already used here noted.
  const used = await idsInUse();
  const remap = new Map<string, string>();
  const note = (id: string): void => {
    const k = id.toLowerCase();
    if (used.has(k) && !remap.has(k)) remap.set(k, randomUUID());
  };
  for (const e of entries) for (const id of e.name.match(UUID_G) || []) note(id);
  const inMemory = entries.filter((e) => kindOf(e.name) !== 'table');
  for (let i = 0; i < inMemory.length; i++) {
    const e = inMemory[i];
    await oneAtATime(async () => {
      const buf = await zip.read(e, opts.signal);
      if (kindOf(e.name) === 'json') await eachId(buf, note);
    });
    tick(0.3 * ((i + 1) / inMemory.length), `Checking ${i + 1} of ${inMemory.length} files`);
  }
  for (const e of entries) {
    const id = CONNECTION_FILE.exec(e.name)?.[1].toLowerCase();
    if (id && !remap.has(id)) remap.set(id, randomUUID());
  }
  const swap = (s: string): string => s.replace(UUID_G, (m) => remap.get(m.toLowerCase()) || m);

  // 4. Every table streamed into staging, checked.
  const staging = path.join(appPaths.temp(), `bundle-${randomUUID()}`);
  const staged = new Map<ZipEntryInfo, string>();
  try {
    await fs.promises.mkdir(staging, { recursive: true });
    const tables = entries.filter((e) => kindOf(e.name) === 'table');
    for (let i = 0; i < tables.length; i++) {
      const file = path.join(staging, String(i));
      await zip.extract(tables[i], file, opts.signal);
      staged.set(tables[i], file);
      tick(0.3 + 0.3 * ((i + 1) / tables.length), `Reading ${i + 1} of ${tables.length} tables`);
    }
    return await write(zip, opts, manifest, counts, remap, swap, staged);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

/** 5. The new project: records swapped and written, images written, tables moved into place. */
async function write(
  zip: ZipReader, opts: ImportOptions, manifest: BundleManifest, counts: Record<string, number>,
  remap: Map<string, string>, swap: (s: string) => string, staged: Map<ZipEntryInfo, string>,
): Promise<ImportResult> {
  const name = String(opts.name || (manifest.project && manifest.project.name) || 'Imported project').trim() || 'Imported project';
  const taken = new Set((await projects.listProjects()).map((p) => p.name));
  const created = await projects.createProject(taken.has(name) ? `${name} (imported)` : name);
  const dir = projectDir(created.id);
  // The files read for their contents (the project's extras, themes, templates): an
  // optional extra past the value budget is skipped — it costs a look, never the import.
  const small = async (n: string): Promise<{ name: string; data: Buffer }[]> => {
    const e = zip.get(n);
    if (!e) return [];
    const data = await zip.read(e, opts.signal);
    if ((await countJsonValuesAsync(data)) > MAX_JSON_VALUES) {
      logger.warn(`[bundle] ${n} holds more than ${MAX_JSON_VALUES} values: not read`);
      return [];
    }
    return [{ name: n, data }];
  };
  try {
    const { entries } = zip;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.name === 'manifest.json' || e.name === 'project.json' || e.name === 'themes.json' || e.name === 'templates.json') continue; // the new project has its own; themes are workspace records
      const rel = swap(e.name);
      if (!ruleFor(rel)) throw new Error(msg.notWritten()); // a remapped name left the whitelist: cannot happen; guard anyway
      const target = path.join(dir, ...rel.split('/'));
      const kind = kindOf(e.name);
      if (kind === 'asset') {
        await writeBlob(target, await zip.read(e, opts.signal)); // a row, on a server with DATABASE_URL
      } else if (kind === 'table') {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await moveInto(staged.get(e) as string, target);
      } else {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await oneAtATime(async () => {
          const buf = await zip.read(e, opts.signal);
          if (remap.size) {
            await eachId(buf, (id, at) => {
              const to = remap.get(id.toLowerCase());
              if (to) buf.write(to, at, 36, 'latin1'); // a UUID is 36 bytes either way
            });
          }
          const tmp = target + '.' + randomUUID() + '.tmp';
          await recordFs.writeFile(tmp, buf);
          await recordFs.rename(tmp, target);
        });
      }
      if (opts.onProgress) opts.onProgress(0.6 + 0.4 * ((i + 1) / entries.length), `Writing ${i + 1} of ${entries.length} files`);
    }
    // Carry the source project's dismissed insights and colours; everything else about the
    // project record (id, dates, archive state) belongs to the new one.
    const [pj] = await small('project.json');
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
    await importBundleThemes(await small('themes.json'), swap).catch(() => 0); // a theme costs the look, never the import
    await importBundleTemplates(await small('templates.json'), swap); // r7:templates — merged by id, never clobbering
  } catch (err) {
    await projects.deleteProject(created.id);
    // A cancel is not a bad bundle: a JobCancelled, or the job's signal aborting a read (AbortError).
    const name = err && (err as Error).name;
    if (name === 'JobCancelled' || name === 'AbortError') throw err;
    return { ok: false, error: err instanceof ZipRefused ? err.message : (err as Error)?.message || msg.notWritten() };
  }
  return { ok: true, project: (await projects.getProject(created.id)) || created, counts, remapped: remap.size };
}

/** A rename; across volumes (a test's temp dir), a copy then an unlink. */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.copyFile(from, to);
    await fs.promises.rm(from, { force: true });
  }
}
