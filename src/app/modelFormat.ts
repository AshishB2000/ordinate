// The model files' format (semantic layer part 7, D1–D3; docs/semantic-layer/07-portability.md): the
// shapes, the JSON writer, slugs, `base` hashes and the zip whitelist an import reads with. PURE: no
// store is read here (./modelExport.ts collects), nothing is written.
//
//   model.json              format, formatVersion, appVersion, project name, the calendar (read-only)
//   datasets/<slug>.json    id, name, table doc, field docs, value labels, a Live dataset's base filters
//   datasets/<slug>.md      the dataset's guide
//   metrics/<slug>.json     terms/<slug>.json     relationships.json
//
// No object in a model file is keyed by user text: fields, value labels and relationships are arrays
// sorted by a fixed key, because a JS object orders integer-like keys first (a column named `2024`).
// A key is written only when it holds something, so a later field never churns an old file.

import { createHash } from 'crypto';
import { stableStringify } from '../engine/queryCache';
import { OTHER_RECORD_MAX_BYTES } from './bundleRules';
import { modelEntryRefused } from './modelFileMessages';
import type { ZipPolicy } from './zipReader';
import type { ValueLabel } from '../analysis/valueLabels';
import type { FilterStep } from '../data/transforms';
import type { MetricDefinition, MetricFormat } from '../analysis/metrics';
import type { MetricTargetSpec } from '../analysis/metricTarget';
import type { Cardinality } from '../analysis/relationships';
import type { CalendarPrefs } from '../analysis/dateIntel';
import type { MetricImportedFrom } from '../analysis/externalMetric';

export const MODEL_FORMAT = 'ordinate-model';
export const MODEL_VERSION = 1;
/** The DOS time floor: every entry carries it, so the zip itself is byte-identical, not only its files. */
export const MODEL_ZIP_TIME = new Date(1980, 0, 1);

export interface ModelField {
  name: string;
  description?: string;
  displayName?: string;
  aliases?: string[];
  example?: string;
  sensitivity?: 'personal' | 'financial';
  values?: ValueLabel[];
}

/** The guide is the dataset's `.md`, not a key here. */
export interface ModelDataset {
  id: string;
  name: string;
  base: string;
  description?: string;
  role?: 'fact' | 'dimension';
  key?: string;
  grain?: string;
  fields?: ModelField[];
  baseFilters?: FilterStep[];
}

export interface ModelMetric {
  id: string;
  name: string;
  dataset: string;
  base: string;
  definition: MetricDefinition;
  filters?: FilterStep[];
  format: MetricFormat;
  description?: string;
  direction?: 'up_good' | 'down_good';
  timeColumn?: string;
  target?: MetricTargetSpec;
  /** A dbt import's tag (f1, ./dbtImport.ts): never in a model file, and read from the store only when the files carry it. */
  importedFrom?: MetricImportedFrom;
}

export interface ModelTerm {
  id: string;
  name: string;
  dataset: string;
  base: string;
  aliases?: string[];
  description?: string;
  filters: FilterStep[];
}

export interface ModelRelationship {
  id: string;
  base: string;
  from: { dataset: string; column: string };
  to: { dataset: string; column: string };
  cardinality: Cardinality;
  label?: string;
}

export interface ModelManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  project: { name: string };
  calendar: CalendarPrefs;
}

/** Path → text, the files of one export. */
export type ModelFiles = Map<string, string>;

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
  return out;
}

/** Keys sorted at every depth, 2-space indent, a trailing newline: git diffs it line by line. */
export function modelJson(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}

/** sha256 (base64url) of the object as exported, its own `base` left out. It includes `id`, so it matches only inside one project. */
export function objectBase(o: object): string {
  const { base: _own, ...rest } = o as Record<string, unknown>;
  return createHash('sha256').update(stableStringify(rest)).digest('base64url');
}

const SLUG_MAX = 60;

function slugOf(name: string): string {
  const runs = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g);
  return runs ? cut(runs.join('-'), SLUG_MAX) : 'untitled';
}

const cut = (s: string, n: number): string => s.slice(0, n).replace(/-+$/, '');

/** id → slug: lower-case runs of [a-z0-9] joined by `-`, at most 60 characters; a clash takes -2, -3… in id order. */
export function slugsFor(items: readonly { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const base = slugOf(it.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${cut(base, SLUG_MAX - String(n).length - 1)}-${n}`;
    taken.add(slug);
    out.set(it.id, slug);
  }
  return out;
}

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NAMES = new RegExp(`^(?:model\\.json|relationships\\.json|datasets/(${SLUG})\\.(?:json|md)|(?:metrics|terms)/(${SLUG})\\.json)$`);
const KIB = 1024;

/** The zip reader's policy for model files (D2, D5): only the layout's names, in lower case, each slug at most 60 characters. */
export const MODEL_POLICY: ZipPolicy = {
  refuseName(name: string): string | null {
    const m = NAMES.exec(name);
    const slug = m?.[1] ?? m?.[2];
    return m && (slug === undefined || slug.length <= SLUG_MAX) ? null : modelEntryRefused(name);
  },
  capOf(name: string): number {
    return name.endsWith('.md') ? 32 * KIB : OTHER_RECORD_MAX_BYTES; // a guide is 8,000 characters, at most 4 bytes each
  },
  maxEntries: 20_000,
  maxTotal: 256 * KIB * KIB,
};
