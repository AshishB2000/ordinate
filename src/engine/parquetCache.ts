// The local disk cache of S3 Parquet — SERVER ONLY (T5.2).
//
// A cached file is `DATA_DIR/orgs/<org>/cache/parquet/<project>.<id>.<version>[.source].parquet`:
// inside the org's root, so the org's locked DuckDB worker may read it and no
// other org's may. Versions are immutable, so a cached file is never stale —
// there is no invalidation, only eviction.
//
// One LRU per pod over every org, capped in BYTES (STORAGE_CACHE_MB). A miss is
// answered from S3 directly (httpfs) while the exact object bytes are fetched
// in the background (single-flight per file), so a cold read never waits for a
// download. A hit re-checks the file exists (another pod sharing the volume, or
// an operator, may have removed it). Evicting a file a query is still reading
// is harmless on POSIX (the open handle keeps it); a query that resolved the
// path but had not opened it yet fails, and its caller falls back to JS.
//
// On start the cache directories are scanned (oldest mtime first), so the cap
// holds across restarts; leftover temp files are removed.

import * as fs from 'fs';
import * as path from 'path';

let capBytes = 0;
let total = 0;
// Map order is recency order: a hit moves the entry to the end.
const entries = new Map<string, number>();
const filling = new Map<string, Promise<void>>();
const counts = { hits: 0, misses: 0, fills: 0, evictions: 0, fillErrors: 0 };

export function dirFor(dataDir: string, org: string): string {
  return path.join(dataDir, 'orgs', org, 'cache', 'parquet');
}

/** Set the cap and adopt what is already on disk under `dataDir`. 0 turns the cache off (and leaves the disk alone). */
export function configure(dataDir: string, bytes: number): void {
  capBytes = bytes;
  entries.clear();
  total = 0;
  if (bytes <= 0) return;
  const found: Array<{ file: string; size: number; at: number }> = [];
  let orgs: string[] = [];
  try { orgs = fs.readdirSync(path.join(dataDir, 'orgs')); } catch { /* no orgs yet */ }
  for (const org of orgs) {
    const dir = dirFor(dataDir, org);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      if (n.endsWith('.tmp')) { fs.rmSync(file, { force: true }); continue; }
      if (!n.endsWith('.parquet')) continue;
      try {
        const st = fs.statSync(file);
        found.push({ file, size: st.size, at: st.mtimeMs });
      } catch { /* raced away */ }
    }
  }
  for (const f of found.sort((a, b) => a.at - b.at)) add(f.file, f.size);
}

/** True (and most recently used) when `file` is cached. Counts a hit or a miss. */
export function has(file: string): boolean {
  const size = entries.get(file);
  if (size !== undefined && fs.existsSync(file)) {
    entries.delete(file);
    entries.set(file, size);
    counts.hits++;
    return true;
  }
  if (size !== undefined) forget(file);
  counts.misses++;
  return false;
}

/**
 * Fetch `file` in the background with `download(file)` (which writes it
 * atomically and returns its size), once however many readers miss at once.
 * A failure is counted and dropped — the next miss tries again.
 */
export function fill(file: string, download: (file: string) => Promise<number>): Promise<void> {
  if (capBytes <= 0) return Promise.resolve();
  const running = filling.get(file);
  if (running) return running;
  const p = (async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      add(file, await download(file));
      counts.fills++;
    } catch {
      counts.fillErrors++;
    } finally {
      filling.delete(file);
    }
  })();
  filling.set(file, p);
  return p;
}

/** Remove `file` from the cache and the disk (GC deleted its object). */
export function drop(file: string): void {
  forget(file);
  rmQuiet(file);
}

export function stats(): typeof counts & { files: number; bytes: number; capBytes: number } {
  return { ...counts, files: entries.size, bytes: total, capBytes };
}

/** Resolves once every background fill running now has finished (tests, benches). */
export async function settle(): Promise<void> {
  await Promise.all(filling.values());
}

/** Zero the hit/miss counters (benches, tests). */
export function resetCounts(): void {
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0;
}

function add(file: string, size: number): void {
  forget(file);
  entries.set(file, size);
  total += size;
  for (const [old, s] of entries) {
    if (total <= capBytes) break;
    entries.delete(old);
    total -= s;
    counts.evictions++;
    rmQuiet(old);
  }
}

function forget(file: string): void {
  const size = entries.get(file);
  if (size === undefined) return;
  entries.delete(file);
  total -= size;
}

function rmQuiet(file: string): void {
  fs.rmSync(file, { force: true });
  // dataSearchResident keeps its value index beside the table it indexes.
  fs.rmSync(file.replace(/\.parquet$/, '') + '.search.json', { force: true });
}
