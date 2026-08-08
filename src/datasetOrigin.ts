// WHERE a dataset's rows came from, and the whitelist that decides whether to
// believe it. MAIN PROCESS, pure — no fs, no Electron.
//
// Split out of datasets.ts when the composer's `composed` chain pushed that file
// past the 800-line cap (.claude/rules/file-size.md). It was already a separate
// job with its own self-check (scripts/test-dataset-origin.ts): datasets.ts
// stores records, this decides what a re-fetchable source is allowed to be.

import * as path from 'path';
import { isValidId } from './ids';
import type { CombineMode } from './combine';
import { normalizeCombineMode } from './combine';

/**
 * WHERE a dataset's rows came from, so they can be fetched again.
 *
 * Distinct from `sourceKind`, which is a display/format label and is a closed
 * union of eight values that 35 connectors already collapse onto. This says how
 * to RE-RUN the import, and it is the only thing that makes a dataset
 * refreshable — a record without one is a snapshot, exactly as every dataset was
 * before this existed.
 *
 * `paste` and `capture` deliberately have no origin: pasted text has no
 * re-fetchable source, and a capture already has its own recapture flow.
 */
export type DatasetOrigin =
  | { kind: 'file'; path: string; sheetName?: string }
  | { kind: 'url'; url: string }
  | { kind: 'connection'; connId: string }
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
    };

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
export function sanitizeOrigin(raw: unknown): DatasetOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  switch (o.kind) {
    case 'file': {
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
      return isValidId(connId) ? { kind: 'connection', connId } : undefined;
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
    default:
      return undefined;
  }
}
