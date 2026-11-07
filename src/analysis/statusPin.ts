// The pin of a status (semantic layer part 4, D4): a hash of everything a metric's, term's or dataset's figure
// depends on. A certification stores it; a later pin that differs reads as "changed since certified". METADATA ONLY:
// records, the data model and dataset metadata, never a row, so a Live dataset never reaches `getDataset`.
//
// Every field of every record a figure reads is classified below, `pin` (moves the pin) or `out` (does not). The
// tables are `Record<keyof …>`, so a new field fails tsc until someone decides. What part 1 added, by name:
//   Metric    timeColumn (pin); definition.snapshot (pin, inside definition); additivity (derived from definition and
//             the column types, both pinned); filters' term steps (pin, and each names a term dep); filters' `via`, the
//             labelled join a column is read through (pin, and the data model becomes a dep); its own dataset and every
//             other dataset its figure reads, resolved as the door resolves them (each one's pin is a dep)
//   Term      the record (TERM_PIN); a metric that names one has it as a dep
//   Dataset   Live baseFilters and calculated fields (LIVE_PIN, pin); origin.readsTables (out: a label, p2-02); each
//             dataset it is built from (parentsOfRecord: a union, lookup, combine, compose or SQL origin), its pin a dep
//   Catalog   TableDoc (role, key, grain, guide, keyCheck, hierarchies) and ColumnDoc (value labels, display names,
//             aliases): all out, docs and labels that change no figure
//   Model     a relationship's ends and cardinality (pin), its label (out)
// Part 5 and part 7 (kept, not computed, on this release): a funnel, period or external definition and a snapshot's
// `per` (pin, inside definition; a funnel reads only its own dataset); a period metric's base (a metric dep); a
// metric's target and importedFrom (out: neither changes the metric's value, cross-part check item 7); a Live
// dataset that asks another tool's layer (`semantic`: its backend and model pin, not what a sync refreshes;
// `semanticUnreadable`, pin).

import { createHash } from 'crypto';
import * as metrics from './metrics';
import type { Metric } from './metrics';
import { getTerm, type Term } from './terms';
import { compileMetricFormula } from './metricFormula';
import { bindFormulaText } from './params';
import { listRelationships, type Relationship } from './relationships';
import { expandTerms } from './termExpand';
import { metricReads } from '../ipc/relationships';
import { getDatasetMeta, type DatasetMeta } from '../data/datasets';
import { parentsOfRecord } from '../data/upstream';
import type { LiveSettings } from '../data/liveDataset';
import type { DatasetOrigin } from '../data/datasetOrigin';
import { isTermNotExpandedError, isTermStep } from '../data/termStep';
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
  target: 'out', importedFrom: 'out', // neither changes the value (cross-part check item 7)
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
  baseFilters: 'pin', baseFiltersUnreadable: 'pin', calculated: 'pin', calculatedUnreadable: 'pin', semantic: 'pin', semanticUnreadable: 'pin', // semantic: its backend and model only (datasetOwn)
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
  // A semantic dataset pointed at another model is another dataset; a sync that only refreshes its metrics, grains or time is not (cross-part check 7).
  if (meta.live?.semantic) (own.live as Record<string, unknown>).semantic = { backend: meta.live.semantic.backend, model: meta.live.semantic.model };
  return own;
}

/** One pinOf call tree: ref -> its pin, computed once. Never shared across calls: a dep inside a loop reads 'cycle'. */
/** The other datasets the figure reads, resolved as its door resolves them: terms expanded, then its join plan. */
async function relatedDatasets(projectId: string, m: Metric, measures: readonly string[]): Promise<string[] | 'refused'> {
  try {
    const filters = (await expandTerms(projectId, m.datasetId, m.filters)).steps;
    const out = new Set<string>();
    for (const column of measures.length ? measures : ['']) for (const id of await metricReads(projectId, m.datasetId, column, filters)) out.add(id);
    return [...out].sort();
  } catch (err) {
    if (isTermNotExpandedError(err)) return 'refused'; // the door refuses this figure too; hashed as such, never as no read
    throw err;
  }
}

interface Walk { projectId: string; memo: Map<string, Promise<string | null>>; byName?: Promise<Map<string, Metric>> }

async function metricDeps(w: Walk, m: Metric, stack: readonly string[]): Promise<Record<string, string>> {
  const deps: Record<string, string> = {};
  const dep = async (ref: string): Promise<void> => {
    deps[ref] = stack.includes(ref) || stack.length > MAX_DEPTH ? 'cycle' : ((await pinIn(w, ref, stack)) ?? 'missing');
  };
  const meta = await getDatasetMeta(w.projectId, m.datasetId);
  await dep(`dataset:${m.datasetId}`); // the figure is computed over its Prepare output (D4 heading, D5)
  const own = new Set((meta?.columns ?? []).map((c) => c.name));
  const reads: string[] = []; // every column the figure names, filters included
  const measures: string[] = []; // the columns it aggregates
  let crosses = false;
  for (const s of m.filters) {
    const step: unknown = s; // a term step is stored in a filter list, typed as a FilterStep
    if (isTermStep(step)) {
      await dep(`term:${step.term}`);
      if ((await getTerm(w.projectId, step.term))?.datasetId !== m.datasetId) crosses = true;
    } else {
      if (s.via || s.datasetId) crosses = true;
      if (s.type === 'filter') reads.push(s.column);
    }
  }
  const def = m.definition;
  if (metrics.isPeriodDefinition(def)) await dep(`metric:${def.base}`); // its figure is its base metric's, over a window
  if (metrics.isSimpleDefinition(def)) {
    if (def.column) measures.push(def.column);
  } else if (metrics.isFormulaDefinition(def)) {
    const compiled = compileMetricFormula(bindFormulaText(def.formula, new Map()).text, own);
    if (!compiled.ok) deps.formula = 'uncompiled';
    else {
      measures.push(...compiled.program.aggregates.map((a) => a.column).filter((c) => c[0] !== '{')); // an LOD reads its own dataset
      for (const name of [...new Set(compiled.program.metricRefs.map((r) => r.toLowerCase()))].sort()) {
        const other = (await (w.byName ??= metrics.metricsByName(w.projectId))).get(name);
        if (other) await dep(`metric:${other.id}`);
        else deps[`name:${name}`] = 'missing'; // a metric later given this name changes the figure
      }
    }
  }
  reads.push(...measures);
  // A column read through the data model (its nearest owner, a `via`, a term on another table): the model is a dep,
  // and so is every other dataset the figure reads (its Prepare output, as its own dataset's).
  if (crosses || reads.some((c) => !own.has(c))) {
    deps.relationships = digest((await listRelationships(w.projectId)).map((r) => pinned(r, RELATIONSHIP_PIN)));
    const related = await relatedDatasets(w.projectId, m, measures);
    if (related === 'refused') deps.reads = 'refused';
    else for (const id of related) await dep(`dataset:${id}`);
  }
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
  const meta = await getDatasetMeta(w.projectId, r.id);
  if (!meta) return null;
  // Its figures are its upstream's Prepare output too (a union, lookup, combine, compose or SQL origin): each parent's pin, bounded as a metric's deps are.
  const deps: Record<string, string> = {};
  for (const p of parentsOfRecord(meta).sort()) {
    const ref = `dataset:${p}`;
    deps[ref] = here.includes(ref) || here.length > MAX_DEPTH ? 'cycle' : ((await pinIn(w, ref, here)) ?? 'missing');
  }
  return digest({ kind: r.kind, own: datasetOwn(meta), deps });
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
