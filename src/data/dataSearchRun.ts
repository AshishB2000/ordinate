'use strict';

// Search inside the data — ONE SEARCH across a project (or every project):
// which datasets, which columns may be read, cancellation, and the merged,
// ranked hits ⌘K paints. MAIN PROCESS ONLY. dependency-free apart from what
// datasets.ts already pulls in, so it is callable from a test or the CLI.
//
// CANCELLATION is by generation: every search takes the next number, and a
// search whose number is no longer the latest stops before its next query and
// answers `cancelled`. ⌘K issues one per debounced keystroke, so typing
// "Calif" never leaves four older searches queued on the DuckDB worker.
//
// SENSITIVE COLUMNS (marked personal/financial in the catalog, PR #179) are not
// searched unless the project's share policy lets their values out as they
// are — `include` on the export path, the path a user copying values out of a
// dataset takes. Under mask or drop, a value the export would hide is not
// shown here either. Decided per search, so a policy change applies at once;
// the index on disk holds those values regardless, which is no new exposure —
// it sits next to the Parquet that holds the same cells.

import * as datasets from './datasets';
import { tablePath } from './datasetRecord';
import * as projects from '../app/projects';
import * as privacyStore from '../app/privacyStore';
import { withheldColumns } from '../app/sharePolicy';
import { isSupportedAsync } from '../engine/parquetStore';
import { readIndex, scheduleIndex, searchDataset } from '../engine/dataSearchResident';
import { compareMatches, excludedColumns, needleOf, searchRowsJs } from './dataSearch';
import type { MatchRank } from './dataSearch';
import { isLive } from './liveDataset';

/** Hits returned to ⌘K — a group, not a page. */
export const MAX_HITS = 10;
/** Shorter terms match nearly everything and teach nothing. */
export const MIN_TERM = 2;
const MAX_TERM = 200;
/** A missing or stale index is rebuilt this long after the search that found it so. */
const LAZY_BUILD_MS = 500;

export interface DataHit {
  projectId: string;
  projectName: string;
  datasetId: string;
  datasetName: string;
  column: string;
  columnIndex: number;
  value: string;
  rows: number;
  rank: MatchRank;
  /** The dataset is one the open dashboard reads, so the value can filter it. */
  onDashboard: boolean;
}

export interface DataSearchReply {
  ok: boolean;
  cancelled?: boolean;
  hits: DataHit[];
  /** Datasets that ran out of time budget before every column was searched. */
  partial: string[];
  searched: number;
  error?: string;
}

let generation = 0;

export interface RunOpts {
  /** '' = every non-archived project (⌘K on Home). */
  projectId: string;
  term: string;
  /** Dataset ids the open dashboard reads. */
  dashboardDatasets?: ReadonlySet<string>;
}

async function scope(projectId: string): Promise<Array<{ id: string; name: string }>> {
  if (projectId) {
    const p = await projects.getProject(projectId);
    return p ? [{ id: projectId, name: p.name }] : [];
  }
  return (await projects.listProjects()).filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name }));
}

export async function runSearch(opts: RunOpts): Promise<DataSearchReply> {
  const my = ++generation;
  const cancelled = (): boolean => my !== generation;
  const term = typeof opts.term === 'string' ? opts.term.trim().slice(0, MAX_TERM) : '';
  const out: DataSearchReply = { ok: true, hits: [], partial: [], searched: 0 };
  if (needleOf(term).length < MIN_TERM) return out;
  const resident = await isSupportedAsync();
  const hits: DataHit[] = [];

  for (const project of await scope(opts.projectId)) {
    const exportAction = (await privacyStore.getPolicy(project.id)).export;
    for (const summary of await datasets.listDatasets(project.id).catch(() => [])) {
      if (cancelled()) return { ...out, ok: false, cancelled: true };
      const meta = await datasets.getDatasetMeta(project.id, summary.id);
      if (!meta || isLive(meta)) continue; // a Live dataset holds no values here to search
      const exclude = excludedColumns(exportAction, await withheldColumns(project.id, meta.id).catch(() => new Set<string>()));
      let found;
      if (meta.resident && resident) {
        const src = { parquetPath: tablePath(project.id, meta.id, meta.storageVersion), columns: meta.columns };
        const index = await readIndex(src.parquetPath);
        if (!index) scheduleIndex(src, LAZY_BUILD_MS);
        const r = await searchDataset(src, { term, exclude, index, cancelled });
        if (!r) return { ...out, ok: false, cancelled: true };
        if (r.skipped) out.partial.push(meta.name);
        found = r.columns;
      } else if (!meta.resident) {
        // A v2 record holds its rows inline: the reference IS the fast path.
        const ds = await datasets.getDataset(project.id, meta.id);
        found = ds ? searchRowsJs(ds.columns, ds.rows, term, exclude) : [];
      } else {
        continue; // resident but the bridge is down: hydrating would need it too
      }
      out.searched++;
      for (const c of found) {
        for (const m of c.matches) {
          hits.push({
            projectId: project.id, projectName: project.name, datasetId: meta.id, datasetName: meta.name,
            column: c.column, columnIndex: c.index, value: m.value, rows: m.rows, rank: m.rank,
            onDashboard: !!opts.dashboardDatasets && opts.dashboardDatasets.has(meta.id),
          });
        }
      }
    }
  }
  out.hits = hits
    .sort((a, b) => compareMatches(a, b) || (a.datasetName < b.datasetName ? -1 : a.datasetName > b.datasetName ? 1 : 0) || a.columnIndex - b.columnIndex)
    .slice(0, MAX_HITS);
  return out;
}
