// The Assistant's value index, kept current (docs/assistant/00-design.md, step 3 "Values, as built") — MAIN PROCESS,
// server mode with a database (the job needs its jobs table). src/ipc/askValues.ts reads it; nothing here runs on an ask.
//
// A SIDECAR, never Postgres: `<id>.values.parquet` beside the table (DATA_DIR), or on S3 an object of the table's own
// version named with its tag (`<id>.<version>.values-<build version>-<marks hash>.parquet`, ../engine/storage
// writeValuesObject: registered pending first, then under that table version once written, so GC drops it with the
// table). Rows never go into Postgres: on S3 the registry holds its NAME, as for every table object. Its shape and the
// lookup: ../engine/valueIndexResident. WHICH sidecars exist is known before any is read (`sidecarsOf`): in DATA_DIR
// the files, on S3 ONE indexed query of the registry for the exact names the datasets' current versions and marks call
// for, so a sidecar not built yet, or built under other marks, is simply not read.
//
// BUILT AFTER EACH WRITE, OFF ITS PATH. Every write of a dataset's rows (import, refresh, an incremental append,
// Prepare, a column edit, an input table's edit, a snapshot restore, Live → extract) goes through datasets.persist,
// which chains `buildValueIndex` onto that dataset's write chain once the record is saved: the caller does not wait for
// it, the dataset's next write does, so a build never races one. A build never fails a write. A sidecar built from
// another write (its stamp) is never read, so nothing depends on when it lands.
// A build: the record (its stamp), the catalog's marks, two DuckDB statements over the table (the text columns not
// marked personal or financial, nor carrying a marked value, at or under MAX_DISTINCT distinct values), each value's
// word keys in JS (../engine/valueSearchResident valueKeys), then the sidecar written as the table is. Nothing is kept
// in this pod's memory.
//
// THE JOB (`values:index`, a row per org in the jobs table, every VALUES_JOB_EVERY_MS on whichever pod claims it): per
// project, the datasets whose sidecar is missing (made before this release, a pod killed mid-build) or stale, built
// again. Stale in DATA_DIR: another stamp, build version or catalog marks in its set; there it also removes sidecars
// whose dataset is gone or Live. On S3: its name (table version, build version, marks hash) is not registered as
// written, which the same one query says; the build deletes the version's sidecars of other marks. So a column marked
// personal leaves the index on the job's next run, in both. Never at startup. Datasets in the Trash keep theirs beside
// them in DATA_DIR (../app/trashStore parquetNames), and on S3 GC keeps a trashed table's objects: restored, fresh.

import * as fs from 'fs';
import * as path from 'path';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { datasetsDir, onDataWritten, tablePath, valuesPath } from '../data/datasetRecord';
import * as catalog from '../app/catalog';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import * as appPaths from '../app/paths';
import { isValidId } from '../app/ids';
import { withheldColumns } from '../app/sharePolicy';
import { logger } from '../app/logger';
import * as parquetStore from '../engine/parquetStore';
import * as storage from '../engine/storage';
import * as trace from '../engine/residentTrace';
import { MAX_DISTINCT, SIDECAR_COLUMNS, VALUE_INDEX_VERSION, distinctValuesResident, setsResident, sidecarRows, stampOf, valuesTag, type ValueRow, type ValueSet } from '../engine/valueIndexResident';
import { valueKeys } from '../engine/valueSearchResident';
import { defineJob } from '../server/jobs/runner';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** The catalog's personal and financial marks on one dataset's columns, sorted. */
const marksOf = (docs: Record<string, catalog.ColumnDoc>): string[] =>
  Object.keys(docs).filter((k) => docs[k].sensitivity === 'personal' || docs[k].sensitivity === 'financial').sort();

let warned = false;
let wired = false;
/** Whether this process builds the index (src/server/app.ts, with a database): the ask reads it only then. */
export const valueIndexWired = (): boolean => wired;

/** Builds one dataset's sidecar. True when written. Never throws. */
export async function buildValueIndex(projectId: string, datasetId: string): Promise<boolean> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    // A Live dataset has no table (its sidecar went with it: ../data/liveRecord), a v2 record's is inline: nothing to index.
    if (!meta || isLive(meta) || !meta.resident || !(await parquetStore.isSupportedAsync())) return false;
    const set: ValueSet = { version: VALUE_INDEX_VERSION, stamp: stampOf(meta), indexed: [], marked: marksOf(await catalog.getColumns(projectId, datasetId, true)) };
    const withheld = await withheldColumns(projectId, datasetId);
    const cols = meta.columns.flatMap((c, i) => (c.type === 'text' && !withheld.has(c.name) ? [i] : []));
    const found = await distinctValuesResident(tablePath(projectId, datasetId, meta.storageVersion), meta.columns, cols, MAX_DISTINCT);
    trace.record('valueIndex', found ? 'resident' : 'failed', found ? undefined : 'the dataset stays unindexed: its asks scan it');
    if (!found) return false;
    const rows: ValueRow[] = [];
    for (const { col, values } of found) {
      if (!values) continue;
      set.indexed.push(col);
      for (const [value, ord] of values) for (const word of valueKeys(value)) rows.push({ col, word, value, ord });
    }
    const table = sidecarRows(set, rows);
    const version = s3Version(meta.storageVersion);
    if (version) await storage.writeValuesObject(projectId, datasetId, version, valuesTag(set.marked), (url) => parquetStore.writeTableAsync(url, SIDECAR_COLUMNS, table, { stageDir: appPaths.temp() }));
    else await parquetStore.writeTableAsync(valuesPath(projectId, datasetId), SIDECAR_COLUMNS, table);
    return true;
  } catch (err: unknown) {
    if (!warned) logger.warn(`[valueIndex] a dataset's values were not indexed, so its asks scan it (${String((err as { code?: unknown })?.code ?? 'error')}); further failures are not logged.`);
    warned = true;
    return false;
  }
}

/** The table version an S3 sidecar belongs to, or null: the table (and so its sidecar) is in DATA_DIR. */
const s3Version = (v: unknown): string | null => (storage.isS3() && typeof v === 'string' && isValidId(v) ? v : null);

/**
 * Where to read each of `items`' sidecars, of those WRITTEN for its current table: in DATA_DIR the files that exist; on
 * S3 the objects the registry has as written under the name its version and its catalog marks call for (`marks`, or
 * read from the catalog), ONE indexed query, names only. Never throws: what it cannot tell is left out (scanned).
 */
export async function sidecarsOf(projectId: string, items: ReadonlyArray<{ id: string; version: unknown; marks?: string[] }>): Promise<Map<string, string>> {
  try {
    const local = items.filter((x) => !s3Version(x.version)); // DATA_DIR, or a table from before S3 was turned on
    const here = await Promise.all(local.map((x) => fs.promises.access(valuesPath(projectId, x.id)).then(() => true, () => false)));
    const out = new Map(local.filter((_, i) => here[i]).map((x) => [x.id, valuesPath(projectId, x.id)]));
    const want = await Promise.all(items.flatMap((x) => {
      const version = s3Version(x.version);
      return version ? [(async () => ({ id: x.id, version, tag: valuesTag(x.marks ?? marksOf(await catalog.getColumns(projectId, x.id, true))) }))()] : [];
    }));
    const written = await storage.valuesWritten(projectId, want);
    for (const x of want) if (written.has(x.id)) out.set(x.id, storage.valuesUrl(projectId, x.id, x.version, x.tag));
    return out;
  } catch (err: unknown) {
    trace.record('askValueIndex', 'failed', `which sidecars exist is unknown (${String((err as { code?: unknown })?.code ?? 'error')}): their datasets are scanned`);
    return new Map();
  }
}

export const VALUES_JOB = 'values:index';
export const VALUES_JOB_EVERY_MS = 10 * 60_000;

/** A project's datasets as their records say, Live ones left out: what a sidecar is checked against. */
async function extractsOf(projectId: string): Promise<Array<{ id: string; stamp: string; version: unknown }>> {
  const out: Array<{ id: string; stamp: string; version: unknown }> = [];
  let records;
  try {
    records = await recordFs.listRecords(datasetsDir(projectId));
  } catch {
    return out; // no datasets yet
  }
  for await (const r of records) {
    const id = r.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const text = r.text();
      const s = datasets.summaryOf(projectId, text);
      if (s && s.mode !== 'live') out.push({ id, stamp: stampOf(s), version: (JSON.parse(text) as { storageVersion?: unknown }).storageVersion });
    } catch {
      /* a record no reader can open has nothing to index */
    }
  }
  return out;
}

/** One run of the job for the context's org. True: it stopped at `stopAt` with datasets left to build. */
export async function indexOrgValues(stopAt = Infinity): Promise<boolean> {
  for (const p of await projects.listProjects()) {
    const [kept, cat] = await Promise.all([extractsOf(p.id), catalog.load(p.id)]);
    const marksFor = (id: string): string[] => marksOf(own(cat.columns, id) ? cat.columns[id] : {});
    let fresh: (d: (typeof kept)[number]) => boolean;
    if (storage.isS3()) {
      // The name says it all (table version, build version, marks): one query for the project.
      const written = await sidecarsOf(p.id, kept.map((d) => ({ id: d.id, version: d.version, marks: marksFor(d.id) })));
      fresh = (d) => written.has(d.id);
    } else {
      // Every local set is read (one statement); a sidecar that cannot be read is built again, over it.
      const dir = datasetsDir(p.id);
      const files = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.values.parquet')).map((n) => path.join(dir, n));
      const sets = (await setsResident(files)) ?? new Map<string, ValueSet | null>();
      const live = new Set(kept.map((d) => valuesPath(p.id, d.id)));
      for (const f of files) if (!live.has(f)) await recordFs.rm(f, { force: true }); // its dataset is gone, in the Trash or Live
      fresh = (d) => {
        const s = sets.get(valuesPath(p.id, d.id));
        return !!s && s.version === VALUE_INDEX_VERSION && s.stamp === d.stamp && s.marked.join('\0') === marksFor(d.id).join('\0');
      };
    }
    for (const d of kept) {
      if (fresh(d)) continue;
      if (Date.now() >= stopAt) return true;
      await buildValueIndex(p.id, d.id);
    }
  }
  return false;
}

let defined = false;
/** Builds after every data write, and declares the job (src/server/app.ts, with a database). Once per process. */
export function wireValueIndex(): void {
  wired = true;
  if (defined) return;
  defined = true;
  onDataWritten(async (projectId, id) => { await buildValueIndex(projectId, id); });
  defineJob(VALUES_JOB, { everyMs: VALUES_JOB_EVERY_MS, run: (_target, stopAt) => indexOrgValues(stopAt) });
}
