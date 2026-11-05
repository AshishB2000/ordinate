// The pin of a status (semantic layer part 4, D4): a hash of everything a metric's, term's or dataset's figure
// depends on. A certification stores it; a later pin that differs reads as "changed since certified". METADATA ONLY:
// records, the data model and dataset metadata, never a row, so a Live dataset never reaches `getDataset`.
//
// Every field of every record a figure reads is classified below, `pin` (moves the pin) or `out` (does not). The
// tables are `Record<keyof …>`, so a new field fails tsc until someone decides. What part 1 added, by name:
//   Metric    timeColumn (pin); definition.snapshot (pin, inside definition); additivity (derived from definition and
//             the column types, both pinned); filters' term steps (pin, and each names a term dep); filters' `via`, the
//             labelled join a column is read through (pin, and the data model becomes a dep); its own dataset and every
//             dataset it reads through a `via` or another table's term (each one's pin is a dep: a Prepare edit moves it)
//   Term      the record (TERM_PIN); a metric that names one has it as a dep
//   Dataset   Live baseFilters and calculated fields (LIVE_PIN, pin); origin.readsTables (out: a label, p2-02)
//   Catalog   TableDoc (role, key, grain, guide, keyCheck, hierarchies) and ColumnDoc (value labels, display names,
//             aliases): all out, docs and labels that change no figure
//   Model     a relationship's ends and cardinality (pin), its label (out)

import { createHash } from 'crypto';
import * as metrics from './metrics';
import type { Metric } from './metrics';
import { getTerm, type Term } from './terms';
import { compileMetricFormula } from './metricFormula';
import { bindFormulaText } from './params';
import { listRelationships, type Relationship } from './relationships';
import { viaPath } from './joinPlan';
import { getDatasetMeta, type DatasetMeta } from '../data/datasets';
import type { LiveSettings } from '../data/liveDataset';
import type { DatasetOrigin } from '../data/datasetOrigin';
import { isTermStep } from '../data/termStep';
import { pipelineHash, stableStringify } from '../engine/queryCache';
import { parseStatusRef } from '../app/statusDocs';
import type { ColumnDoc } from '../app/catalog';
import type { TableDoc } from '../app/tableDocs';

type Pin = 'pin' | 'out';

export const METRIC_PIN: Record<keyof Metric, Pin> = {
  id: 'out', projectId: 'out', // the ref names it
  name: 'pin', // a formula names a metric by it
  datasetId: 'pin',
  definition: 'pin', // with its snapshot
  filters: 'pin',
  format: 'pin',
  timeColumn: 'pin',
  description: 'out', direction: 'out', tree: 'out',
  createdAt: 'out', updatedAt: 'out', schemaVersion: 'out',
};

export const TERM_PIN: Record<keyof Term, Pin> = {
  id: 'out', projectId: 'out', name: 'pin', aliases: 'out', description: 'out', datasetId: 'pin', filters: 'pin',
  createdAt: 'out', updatedAt: 'out', schemaVersion: 'out',
};

export const DATASET_PIN: Record<keyof DatasetMeta, Pin> = {
  id: 'out', projectId: 'out', name: 'out', sourceKind: 'out',
  columns: 'pin', // as [name, type]
  steps: 'pin', // as pipelineHash
  origin: 'pin', // whole, minus readsTables
  mode: 'pin',
  live: 'pin', // as LIVE_PIN
  // The data and its bookkeeping: a refresh keeps a certification.
  rowCount: 'out', createdAt: 'out', updatedAt: 'out', schemaVersion: 'out', capture: 'out', stepCounts: 'out',
  lastRefreshedAt: 'out', lastRefreshStatus: 'out', lastRefreshError: 'out', autoRefresh: 'out', quality: 'out',
  input: 'out', incremental: 'out', freshOnAsk: 'out', sourceColumns: 'out', resident: 'out', storageVersion: 'out',
};

export const LIVE_PIN: Record<keyof LiveSettings, Pin> = {
  baseFilters: 'pin', baseFiltersUnreadable: 'pin', calculated: 'pin', calculatedUnreadable: 'pin',
  maxCacheAgeSec: 'out', epoch: 'out', schemaSyncedAt: 'out', profile: 'out', missingColumns: 'out', syncAttemptAt: 'out',
};

export const RELATIONSHIP_PIN: Record<keyof Relationship, Pin> = {
  id: 'pin', // what a filter's `via` names
  from: 'pin', to: 'pin', cardinality: 'pin',
  label: 'out', warning: 'out', verified: 'out',
};

// `'out'` only: pinOf reads no catalog doc. A field that changes a figure widens its entry to Pin AND is read in `datasetOwn`.
export const TABLE_DOC_PIN: Record<keyof TableDoc, 'out'> = {
  role: 'out', key: 'out', grain: 'out', guide: 'out', keyCheck: 'out', hierarchies: 'out', updatedBy: 'out', updatedAt: 'out',
};
export const COLUMN_DOC_PIN: Record<keyof ColumnDoc, 'out'> = {
  description: 'out', displayName: 'out', aliases: 'out', example: 'out', sensitivity: 'out', values: 'out', updatedBy: 'out', updatedAt: 'out',
};

/** The keys a table does not classify. */
export function unclassified(table: Record<string, string>, keys: readonly string[]): string[] {
  return keys.filter((k) => !Object.prototype.hasOwnProperty.call(table, k));
}

/** Formula metrics nest at most this deep (metricMeasures' MAX_DEPTH): past it, as round a loop, a dep is 'cycle'. */
const MAX_DEPTH = 10;

function pinned<T extends object>(rec: T, table: Record<keyof T, Pin>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(table) as (keyof T)[]) if (table[k] === 'pin' && rec[k] !== undefined) out[k] = rec[k];
  return out;
}

const digest = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('base64url');

function datasetOwn(meta: DatasetMeta): Record<string, unknown> {
  const own: Record<string, unknown> = pinned(meta, DATASET_PIN);
  own.steps = pipelineHash(meta.steps);
  own.columns = meta.columns.map((c) => [c.name, c.type]);
  if (meta.origin) {
    const { readsTables: _label, ...origin } = meta.origin as DatasetOrigin & { readsTables?: unknown };
    own.origin = origin;
  }
  if (meta.live) own.live = pinned(meta.live, LIVE_PIN);
  return own;
}

/** One pinOf call tree: ref -> its pin, computed once. Never shared across calls: a dep inside a loop reads 'cycle'. */
interface Walk { projectId: string; memo: Map<string, Promise<string | null>>; byName?: Promise<Map<string, Metric>> }

async function metricDeps(w: Walk, m: Metric, stack: readonly string[]): Promise<Record<string, string>> {
  const deps: Record<string, string> = {};
  const dep = async (ref: string): Promise<void> => {
    deps[ref] = stack.includes(ref) || stack.length > MAX_DEPTH ? 'cycle' : ((await pinIn(w, ref, stack)) ?? 'missing');
  };
  const meta = await getDatasetMeta(w.projectId, m.datasetId);
  await dep(`dataset:${m.datasetId}`); // the figure is computed over its Prepare output (D4 heading, D5)
  const own = new Set((meta?.columns ?? []).map((c) => c.name));
  const reads: string[] = [];
  const vias: string[] = [];
  let crosses = false;
  for (const s of m.filters) {
    const step: unknown = s; // a term step is stored in a filter list, typed as a FilterStep
    if (isTermStep(step)) {
      await dep(`term:${step.term}`);
      const termDs = (await getTerm(w.projectId, step.term))?.datasetId;
      if (termDs !== m.datasetId) crosses = true;
      if (termDs && termDs !== m.datasetId) await dep(`dataset:${termDs}`);
    } else {
      if (s.via || s.datasetId) crosses = true;
      if (s.via) vias.push(s.via);
      if (s.type === 'filter') reads.push(s.column);
    }
  }
  const model = vias.length > 0 || crosses ? listRelationships(w.projectId) : null;
  for (const via of [...new Set(vias)].sort()) {
    const path = viaPath(m.datasetId, via, await model!); // a via that no longer walks: the model's digest below says so
    if (path.ok) for (const hop of path.value) await dep(`dataset:${hop.to.datasetId}`);
  }
  if (!metrics.isFormulaDefinition(m.definition)) {
    if (m.definition.column) reads.push(m.definition.column);
  } else {
    const compiled = compileMetricFormula(bindFormulaText(m.definition.formula, new Map()).text, own);
    if (!compiled.ok) deps.formula = 'uncompiled';
    else {
      reads.push(...compiled.program.aggregates.map((a) => a.column).filter((c) => c[0] !== '{')); // an LOD reads its own dataset
      for (const name of [...new Set(compiled.program.metricRefs.map((r) => r.toLowerCase()))].sort()) {
        const other = (await (w.byName ??= metrics.metricsByName(w.projectId))).get(name);
        if (other) await dep(`metric:${other.id}`);
        else deps[`name:${name}`] = 'missing'; // a metric later given this name changes the figure
      }
    }
  }
  // A column read through the data model (its nearest owner, a `via`, a term on another table): the model is a dep.
  if (crosses || reads.some((c) => !own.has(c))) deps.relationships = digest((await (model ?? listRelationships(w.projectId))).map((r) => pinned(r, RELATIONSHIP_PIN)));
  return deps;
}

async function compute(w: Walk, ref: string, stack: readonly string[]): Promise<string | null> {
  const r = parseStatusRef(ref);
  if (!r) return null;
  const here = [...stack, ref];
  if (r.kind === 'metric') {
    const m = await metrics.getMetric(w.projectId, r.id);
    return m && digest({ kind: r.kind, own: pinned(m, METRIC_PIN), deps: await metricDeps(w, m, here) });
  }
  if (r.kind === 'term') {
    const t = await getTerm(w.projectId, r.id);
    return t && digest({ kind: r.kind, own: pinned(t, TERM_PIN), deps: {} });
  }
  const meta = await getDatasetMeta(w.projectId, r.id); // its upstream is not its definition: no deps
  return meta && digest({ kind: r.kind, own: datasetOwn(meta), deps: {} });
}

function pinIn(w: Walk, ref: string, stack: readonly string[]): Promise<string | null> {
  let p = w.memo.get(ref);
  if (!p) w.memo.set(ref, (p = compute(w, ref, stack)));
  return p;
}

/** The pin of `metric:` / `term:` / `dataset:<id>`: 43-char base64url sha256, or null when the item is gone. */
export function pinOf(projectId: string, ref: string): Promise<string | null> {
  return pinIn({ projectId, memo: new Map() }, ref, []);
}
