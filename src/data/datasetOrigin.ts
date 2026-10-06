// WHERE a dataset's rows came from, and the whitelist that decides whether to
// believe it. MAIN PROCESS, pure — no fs.
//
// Split out of datasets.ts when the composer's `composed` chain pushed that file
// past the 800-line cap (.claude/rules/file-size.md). It was already a separate
// job with its own self-check (scripts/test-dataset-origin.ts): datasets.ts
// stores records, this decides what a re-fetchable source is allowed to be.

import * as path from 'path';
import { isValidId } from '../app/ids';
import type { CombineMode } from './combine';
import { normalizeCombineMode } from './combine';
import { sanitizeSqlParams } from '../analysis/params';
import { serverDataDir } from '../server/context';
import type { SqlParam } from '../analysis/params';

/**
 * WHERE a dataset's rows came from, so they can be fetched again.
 *
 * Distinct from `sourceKind`, which is a display/format label and is a closed
 * union of eight values that 35 connectors already collapse onto. This says how
 * to RE-RUN the import, and it is the only thing that makes a dataset
 * refreshable — a record without one is a snapshot, exactly as every dataset was
 * before this existed.
 *
 * `paste` deliberately has no origin: pasted text has no re-fetchable source.
 *
 * `capture` is the ONE member that is not re-fetchable — a screenshot cannot be
 * taken again from a record, and recapture is a separate, user-driven flow. It
 * is here because it is still WHERE the rows came from, and the capture page
 * and the Captures grid both need to get from a dataset back to its screenshot.
 * `datasets.listDatasets` deliberately withholds it from `originKind`, which is
 * the summary field the refresh affordances read — see the note there.
 */
export type DatasetOrigin =
  | { kind: 'file'; path: string; sheetName?: string }
  | { kind: 'capture'; captureId: string }
  | { kind: 'url'; url: string }
  /**
   * A connection import. `connId` alone was enough while a connection had ONE
   * saved table/query: a refresh re-ran the connection's own selection. The
   * workbench lets one connection produce many datasets, so WHAT this dataset
   * was built from has to travel with the dataset rather than with the
   * connection — otherwise importing a second table silently re-points the
   * first dataset's refresh at it.
   *
   * `sql` is the statement that actually produced these rows and is what a
   * refresh re-runs, so a dataset keeps refreshing correctly after its saved
   * query is edited, renamed or deleted. `queryId` is a LABEL — it says which
   * saved query this came from so the UI can name it — and `table` likewise.
   * Neither is consulted to decide what to run.
   */
  | { kind: 'connection'; connId: string; table?: string; queryId?: string; sql?: string }
  | {
      kind: 'combined';
      leftId: string;
      rightId: string;
      mode: 'append' | 'join';
      on?: { left: string; right: string };
    }
  /**
   * A composer chain: a base table plus N joins folded left to right
   * (combine.composeTables). Supersedes `combined`, which is the two-table
   * special case and is READ FOREVER — every dataset saved before the composer
   * carries one, and rewriting them on load would be a migration nobody asked
   * for. Only new saves write `composed`.
   */
  | {
      kind: 'composed';
      baseId: string;
      joins: Array<{
        datasetId: string;
        mode: CombineMode;
        on?: { left: string; right: string };
      }>;
    }
  /**
   * A query over this project's OWN datasets (the Data page's Query tab,
   * src/engine/sqlDatasets.ts). `sql` is the text as written, `[[params]]` and
   * all; `params` are the values it was saved with; `deps` are the datasets it
   * read, which is what a change to one of them re-runs this for
   * (datasetDependents.ts) and what the lineage line names.
   */
  | { kind: 'sql'; sql: string; params?: SqlParam[]; deps: string[] }
  /**
   * One cell of a notebook (src/analysis/notebook): a refresh re-runs that
   * cell and everything above it that it reads, from the notebook AS SAVED,
   * with its parameter cells' stored values. `deps` are the datasets the run
   * read — what a change to one of them re-runs this for (datasetDependents.ts),
   * exactly like a `sql` origin's.
   */
  | { kind: 'notebook'; notebookId: string; cellId: string; deps: string[] };

/**
 * Whitelist an untrusted `origin` — from a stored file OR a save IPC payload —
 * into a well-formed DatasetOrigin, or `undefined`. Never throws.
 *
 * This is a SECURITY control, not tidying. `normalize()` runs it on every load,
 * so a hand-edited or corrupted record degrades to "not refreshable" instead of
 * turning into a file read or a fetch at an attacker's chosen target:
 *   • a relative path could escape wherever the refresh happens to resolve it
 *   • `file:`/`javascript:`/`data:` URLs are not fetchable sources
 *   • a non-UUID id would reach a path join in connections/datasets
 * Same whitelist discipline as sanitizeCapture and visuals.sanitizeEncoding:
 * keep only what is recognised, drop the rest, never repair.
 */
/** Same ceiling as connections.MAX_QUERY_SQL. A dataset record is read on
 *  every list; an unbounded statement pasted into it is a slow Data page. */
export const MAX_ORIGIN_SQL = 20_000;
/** Datasets one query may read. A query naming more is not a query, it is a join plan. */
const MAX_SQL_DEPS = 64;

export function sanitizeOrigin(raw: unknown): DatasetOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  switch (o.kind) {
    case 'file': {
      // Never on the server (T6.3): a server keeps no user's path, and a stored
      // one — planted through an imported bundle or a restored backup — would let
      // a refresh read any file the pod can (another org's DATA_DIR, a mounted
      // credential). Dropped here, where every dataset load passes, so the record
      // becomes an ordinary non-refreshable snapshot.
      if (serverDataDir() !== null) return undefined;
      const p = typeof o.path === 'string' ? o.path : '';
      // Absolute only. A relative path has no meaning outside the cwd it was
      // captured in, and main's cwd is not the user's.
      if (!p || !path.isAbsolute(p)) return undefined;
      const sheetName = str(o.sheetName);
      return sheetName ? { kind: 'file', path: p, sheetName } : { kind: 'file', path: p };
    }
    case 'url': {
      const u = str(o.url);
      if (!u) return undefined;
      try {
        const parsed = new URL(u);
        // http/https ONLY. (The URL connector itself is https-only and will
        // refuse an http one at fetch time — this is the outer guard that keeps
        // every other scheme from ever reaching a fetcher.)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
        return { kind: 'url', url: u };
      } catch (_) {
        return undefined;
      }
    }
    case 'connection': {
      const connId = str(o.connId);
      if (!isValidId(connId)) return undefined;
      const out: DatasetOrigin = { kind: 'connection', connId };
      // A bad table/queryId/sql degrades that FIELD, never the whole origin: the
      // connId is what makes this refreshable and it is already valid. Dropping
      // the origin here would turn a cosmetic problem into a dead Refresh.
      const table = str(o.table);
      if (table) out.table = table;
      const queryId = str(o.queryId);
      if (isValidId(queryId)) out.queryId = queryId;
      const sql = typeof o.sql === 'string' ? o.sql.slice(0, MAX_ORIGIN_SQL) : '';
      if (sql.trim()) out.sql = sql;
      return out;
    }
    case 'capture': {
      // History ids are main-generated (Date.now()-ish) and reach a path in
      // history.ts, so the shape guard is history's own: no `.`, `/` or `\`.
      const captureId = str(o.captureId);
      return /^[0-9a-zA-Z_-]+$/.test(captureId) ? { kind: 'capture', captureId } : undefined;
    }
    case 'combined': {
      const leftId = str(o.leftId);
      const rightId = str(o.rightId);
      if (!isValidId(leftId) || !isValidId(rightId)) return undefined;
      if (o.mode !== 'append' && o.mode !== 'join') return undefined;
      const out: DatasetOrigin = { kind: 'combined', leftId, rightId, mode: o.mode };
      const on = o.on as Record<string, unknown> | undefined;
      if (on && typeof on === 'object' && typeof on.left === 'string' && typeof on.right === 'string') {
        out.on = { left: on.left, right: on.right };
      }
      return out;
    }
    case 'composed': {
      const baseId = str(o.baseId);
      if (!isValidId(baseId)) return undefined;
      if (!Array.isArray(o.joins) || o.joins.length === 0) return undefined;
      const joins: Extract<DatasetOrigin, { kind: 'composed' }>['joins'] = [];
      for (const raw of o.joins) {
        if (!raw || typeof raw !== 'object') return undefined;
        const j = raw as Record<string, unknown>;
        const datasetId = str(j.datasetId);
        const mode = normalizeCombineMode(j.mode);
        // ONE bad entry drops the WHOLE origin, exactly as a bad leftId does
        // above. A chain missing a link is not a shorter chain — it is a
        // different dataset, and silently refreshing into it would be worse
        // than refusing to refresh at all.
        if (!isValidId(datasetId) || mode === null) return undefined;
        const entry: (typeof joins)[number] = { datasetId, mode };
        const on = j.on as Record<string, unknown> | undefined;
        if (on && typeof on === 'object' && typeof on.left === 'string' && typeof on.right === 'string') {
          entry.on = { left: on.left, right: on.right };
        }
        joins.push(entry);
      }
      return { kind: 'composed', baseId, joins };
    }
    case 'sql': {
      // NOT sliced like a connection's: a truncated statement is a different
      // query, and refreshing into it would be worse than not refreshing.
      const sql = typeof o.sql === 'string' ? o.sql : '';
      if (!sql.trim() || sql.length > MAX_ORIGIN_SQL) return undefined;
      const deps = Array.isArray(o.deps) ? o.deps : [];
      if (deps.length > MAX_SQL_DEPS || !deps.every((d) => isValidId(d))) return undefined;
      const params = sanitizeSqlParams(o.params);
      if (params === null) return undefined; // one bad value drops the origin, as a bad join does
      const out: DatasetOrigin = { kind: 'sql', sql, deps: [...new Set(deps as string[])] };
      if (params.length) out.params = params;
      return out;
    }
    case 'notebook': {
      const notebookId = str(o.notebookId);
      const cellId = str(o.cellId);
      if (!isValidId(notebookId) || !isValidId(cellId)) return undefined;
      const deps = Array.isArray(o.deps) ? o.deps : [];
      if (deps.length > MAX_SQL_DEPS || !deps.every((d) => isValidId(d))) return undefined;
      return { kind: 'notebook', notebookId, cellId, deps: [...new Set(deps as string[])] };
    }
    default:
      return undefined;
  }
}

// ── What a browser may be told about an origin ───────────────────────────────
//
// On the server an origin is not the viewer's own: a URL can carry an API key
// in its query, a file origin is a path inside the server's DATA_DIR, and a
// statement was written by someone else. These are the ONLY two ways an origin
// reaches a browser — a kind with a display label, and error text with every
// URL cut to its origin and the file path cut to its name.

/** Every http(s) URL in `text` cut to scheme + host (no path, query or fragment), and the origin's file path to its name. */
export function redactOriginText(text: string, origin?: DatasetOrigin): string {
  // A URL ends before trailing punctuation: "…?key=abc: 401" keeps its colon.
  let out = text.replace(/\bhttps?:\/\/[^\s"'<>`]*[^\s"'<>`.,:;!?)\]]/gi, (u) => {
    try {
      return new URL(u).origin;
    } catch {
      return '[address]';
    }
  });
  if (origin && origin.kind === 'file' && origin.path) out = out.split(origin.path).join(path.basename(origin.path));
  return out;
}

export interface SourceView {
  /** The origin's kind, or the dataset's `sourceKind` when it has none (pasted, an input table). */
  kind: string;
  /** "Web address · api.example.com", "Connection · Warehouse · orders", "SQL query over 2 datasets". */
  label: string;
  /** Has an origin a refresh can re-run (a screenshot is the one that cannot). */
  refreshable: boolean;
}

const SOURCE_WORD: Record<string, string> = {
  csv: 'CSV file', xlsx: 'Excel file', json: 'JSON file', parquet: 'Parquet file', paste: 'Pasted data',
  capture: 'Screenshot', postgres: 'Database', url: 'Web address', combined: 'Combined datasets',
  input: 'Input table', sql: 'SQL query', notebook: 'Notebook',
};

/** The redacted view of where a dataset's rows came from. `connName` names a connection by id. */
export function sourceView(sourceKind: string, origin: DatasetOrigin | undefined, connName: (id: string) => string | undefined): SourceView {
  const word = SOURCE_WORD[sourceKind] || 'Import';
  if (!origin) return { kind: sourceKind, label: word, refreshable: false };
  const view = (label: string): SourceView => ({ kind: origin.kind, label, refreshable: origin.kind !== 'capture' });
  const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
  switch (origin.kind) {
    case 'file':
      return view(origin.sheetName ? `${word} · sheet ${origin.sheetName}` : word);
    case 'url': {
      let host = '';
      try {
        host = new URL(origin.url).hostname;
      } catch {
        host = '';
      }
      return view(host ? `Web address · ${host}` : 'Web address');
    }
    case 'connection': {
      const parts = ['Connection', connName(origin.connId) || 'a deleted connection'];
      if (origin.table) parts.push(origin.table);
      else if (origin.sql) parts.push('a query');
      return view(parts.join(' · '));
    }
    case 'capture':
      return view('Screenshot');
    case 'combined':
      return view('Combined from 2 datasets');
    case 'composed':
      return view(`Combined from ${n(origin.joins.length + 1, 'dataset')}`);
    case 'sql':
      return view(`SQL query over ${n(origin.deps.length, 'dataset')}`);
    case 'notebook':
      return view('Notebook cell');
  }
}
