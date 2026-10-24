// What a project bundle may hold, and how big — MAIN PROCESS ONLY. A leaf shared
// by the export (./bundle.ts), the import (./bundleImport.ts) and the record
// writer (./recordFs.ts caps a record body at RECORD_MAX_BYTES, so nothing we
// store is a record our own import would refuse).
//
// WHAT TRAVELS is a WHITELIST (ENTRY_RULES): see ./bundle.ts. Import REFUSES a
// bundle holding any entry outside it, from the zip's central directory, before
// a byte is inflated (./zipReader.ts).

import { bundleNotImported, bundleNameCase } from './bundleMessages';
import type { ZipPolicy } from './zipReader';

export const BUNDLE_FORMAT = 'ordinate-project';
export const BUNDLE_VERSION = 1;

export interface BundleManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  project: { name: string };
  counts: Record<string, number>;
}

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_G = new RegExp(UUID, 'gi');
export const CONNECTION_FILE = new RegExp(`^connections/(${UUID})\\.json$`, 'i');
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

export function ruleFor(name: string): { re: RegExp; count?: string } | undefined {
  return ENTRY_RULES.find((r) => r.re.test(name));
}

export const MAX_ENTRIES = 50_000;
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024; // 1 GiB — far past a 1M-row Parquet
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024 - 1; // what a zip without zip64 can say
/**
 * The largest JSON body Ordinate stores or imports, 32 MiB: an input table's
 * VERSION (history/dataset/<id>/<key>.json) holds the whole base table, at most
 * 10,000 rows × 50 columns. Measured: 5.6 MiB with typical cells, 30.1 MiB
 * with a 60-character string in every cell. docs/pod-lifecycle/00-design.md §3.5.
 */
export const RECORD_MAX_BYTES = 32 * 1024 * 1024;
const MIB = 1024 * 1024;
/**
 * Every other record, 8 MiB: a record a person edits arrives in one RPC
 * (MAX_RPC_BODY_KB, 1 MiB) and is stored pretty-printed; the widest dataset
 * record (16,384 columns, source columns too) is 4.4 MiB.
 */
export const OTHER_RECORD_MAX_BYTES = 8 * MIB;
/**
 * The files the import PARSES whole, each capped by what its own sanitizer
 * lets it reach (refutation S1):
 *   manifest.json   counts and a name — 1 MiB is a thousand times the need;
 *   alerts.json     ≤ 100 rules (≤ 200 keys each, of unbounded length) and
 *                   ≤ 200 events of ≤ 400-character messages — 4 MiB;
 *   project.json    the colour map: ≤ 64 columns × 256 values × 200-character
 *                   keys is 3.6 MiB pretty-printed — 4 MiB;
 *   themes.json     ≤ 200 themes of names, palettes and fonts — 1 MiB;
 *   templates.json  user templates carry PNG thumbnails of up to 3 MiB each — 32 MiB.
 * Bytes are only half of it: every one is also refused past MAX_JSON_VALUES
 * before it is parsed (./jsonBudget.ts) — the heap a parse costs is its values.
 */
const PARSED_MAX_BYTES: Record<string, number> = {
  'manifest.json': MIB,
  'alerts.json': 4 * MIB,
  'project.json': 4 * MIB,
  'themes.json': MIB,
  'templates.json': RECORD_MAX_BYTES,
};
export const MANIFEST_MAX_BYTES = PARSED_MAX_BYTES['manifest.json'];
/** projectAssets.MAX_ASSET_BYTES: blobStore refuses a larger picture anyway. */
export const ASSET_MAX_BYTES = 5 * MIB;

/** What a JSON entry of a bundle — or a project's record at that path — may weigh. */
export function jsonCapOf(rel: string): number {
  if (/^history\/dataset\//i.test(rel)) return RECORD_MAX_BYTES;
  return PARSED_MAX_BYTES[rel] ?? OTHER_RECORD_MAX_BYTES;
}

/**
 * A stored record's limits (./recordFs.ts reads and writes): a PROJECT record
 * (`…/projects/<id>/<rel>`, what a bundle carries) gets its kind's byte cap and
 * the value budget, so nothing an import or an edit stores is past either, and
 * one planted before this check is refused when read instead of parsed. Any
 * other record keeps the plain 32 MiB cap. Null: not a JSON record.
 */
export function recordLimitOf(p: string): { bytes: number; values: boolean } | null {
  const norm = p.split('\\').join('/').replace(/(\.json)\.[^/]*$/, '$1'); // `x.json.<id>.tmp` is x.json
  if (!/\.json$/.test(norm) || norm.endsWith('.search.json')) return null;
  const m = /\/projects\/[0-9a-f-]{36}\/(.+)$/i.exec(norm);
  return m ? { bytes: jsonCapOf(m[1]), values: true } : { bytes: RECORD_MAX_BYTES, values: false };
}

/** The import's read: the kind each name is, and what it may weigh. */
export type EntryKind = 'json' | 'asset' | 'table';
export function kindOf(name: string): EntryKind {
  if (name.startsWith('assets/')) return 'asset';
  return name.toLowerCase().endsWith('.parquet') ? 'table' : 'json';
}

/**
 * The zip reader's policy for a bundle. A name must be on the whitelist AND in
 * canonical case — the exporter writes lower case only (bar the history key's
 * `T`/`Z`), and a case variant is how two entries would land on one file on a
 * case-insensitive volume, or `.JSON` slip past the record router.
 */
export const BUNDLE_POLICY: ZipPolicy = {
  refuseName(name: string): string | null {
    if (!ruleFor(name)) return bundleNotImported(name);
    if (/[A-Z]/.test(name.replace(new RegExp(KEY), ''))) return bundleNameCase(name);
    return null;
  },
  capOf(name: string): number {
    const kind = kindOf(name);
    return kind === 'table' ? MAX_ENTRY_BYTES : kind === 'asset' ? ASSET_MAX_BYTES : jsonCapOf(name);
  },
  maxEntries: MAX_ENTRIES,
  maxTotal: MAX_TOTAL_BYTES,
};
