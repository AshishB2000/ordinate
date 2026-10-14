// "DID YOU MEAN" for a refused answer — MAIN PROCESS, PURE: no fs, no model.
//
// When the model names a dataset or a column that does not exist, the spec is
// refused (./answerSpec) and the reply used to end there: the person rephrased
// blind. The validator now says WHAT it could not find (`SpecMiss`), and this
// file turns that into up to three things it may have meant. Each option is the
// complete spec with the candidate in the place of what was said — run through
// the same validator, so an option the app could not chart is never offered,
// and a click re-runs it with no model call at all (`answer:rerun`).
//
// The app picks the candidates, by NAME alone: no value of any column is read
// and nothing here goes to a model.

import { sanitizeAliases, squash } from '../app/columnNames';
import { withinOne } from '../analysis/valueMatch';
import { readMeasure, sanitizeStoredSpec, validateAnswerSpec } from './answerSpec';
import type { AnswerChip, AnswerSpec, SpecDataset, SpecMetric, SpecMiss } from './answerSpec';

/** What a refused turn stores: the part that missed, what was said for it, and the options offered. */
export interface AnswerSuggest { part: SpecMiss['part']; said: string; options: AnswerChip[] }

/**
 * A name an answer turn can offer to remember: what was said, and the column a
 * "Did you mean" option put in its place. Stored on the turn that option ran
 * (`answer:rerun`); whether it is still to offer is worked out when the card is
 * drawn, never stored.
 */
export interface AnswerLearn { said: string; column: string }

export const MAX_OPTIONS = 3;
/** `said` and a label are shown to a person, never used to resolve anything: one line, cut here. */
const MAX_TEXT = 80;
/** A name shorter than this is near too many others to say which was meant. */
const MIN_NAME = 3;
const PARTS: ReadonlySet<string> = new Set<SpecMiss['part']>(['dataset', 'category', 'measure', 'series', 'filter']);
/** A column name, as the catalog files one (app/catalog MAX_COLUMN_NAME). */
const MAX_COLUMN = 256;

const words = (s: string): string[] => s.split(/[^\p{L}\p{M}\p{N}]+/u).map(squash).filter((w) => w.length >= MIN_NAME);

/**
 * How near a said name is to one a candidate answers to, on squashed names:
 * 4 the same letters (two columns the name could not tell apart), 3 one holds
 * the other, 2 they share a word, 1 one edit apart, 0 not near.
 */
function nearness(said: string, name: string): number {
  const a = squash(said);
  const b = squash(name);
  if (!a || !b) return 0;
  if (a === b) return 4;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= MIN_NAME && long.includes(short)) return 3;
  const theirs = new Set(words(name));
  if (words(said).some((w) => theirs.has(w))) return 2;
  return short.length >= MIN_NAME && withinOne(a, b) ? 1 : 0;
}

/** Something the spec could name instead: what to write in, how to label it, the names it answers to, and how well its type fits. */
interface Candidate { put: string; label: string; names: string[]; fit: number }

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  (rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined);

function candidates(miss: SpecMiss, datasets: SpecDataset[]): Candidate[] {
  if (miss.part === 'dataset') return datasets.map((d) => ({ put: d.id, label: d.name, names: [d.name], fit: 0 }));
  const ds = datasets.find((d) => d.id === miss.datasetId);
  if (!ds) return [];
  // A measure is a number more often than not (and sum / avg / min / max need one — the validator
  // drops the rest); a category or a split prefers text or a date. A filter takes any column.
  const wantsNumber = miss.part === 'measure';
  const fit = (type: string): number => (miss.part === 'filter' || (type === 'number') !== wantsNumber ? 0 : 1);
  return ds.columns.map((c) => ({
    put: c.name, label: own(ds.shown, c.name) || c.name, names: [c.name, ...(own(ds.names, c.name) ?? [])], fit: fit(c.type),
  }));
}

/** The raw spec with `put` written where the name that missed was said. */
function substitute(raw: Record<string, unknown>, miss: SpecMiss, put: string): Record<string, unknown> {
  const at = miss.index ?? 0;
  if (miss.part === 'dataset') return { ...raw, dataset: put };
  if (miss.part === 'category') return { ...raw, category: put };
  if (miss.part === 'series') return { ...raw, series: put };
  if (miss.part === 'measure') {
    const measures = Array.isArray(raw.measures) ? raw.measures.slice() : [raw.measure];
    const agg = readMeasure(measures[at])?.agg;
    measures[at] = agg === undefined || agg === null || agg === '' ? { column: put } : { column: put, aggregation: agg };
    return { ...raw, measures };
  }
  const filters = Array.isArray(raw.filters) ? raw.filters.slice() : [];
  const said: unknown = filters[at];
  filters[at] = { ...(said && typeof said === 'object' ? said : {}), column: put };
  return { ...raw, filters };
}

/**
 * Up to three things a refused spec may have meant, nearest first.
 *
 * Ranked by how near the name is — containment and shared words (the names
 * people taught count), then one edit — then by type fit, ties in the
 * dataset's column order. Nothing near → nothing offered, and the reply reads
 * exactly as it did. `rawSpec` is what was validated: for a follow-up, the
 * MERGED spec (./answerRefine), so an option keeps the filters it carried.
 */
export function suggestFixes(
  rawSpec: unknown,
  miss: SpecMiss,
  datasets: SpecDataset[],
  metrics: SpecMetric[] = [],
  opts: { defaultDatasetId?: string; title?: string } = {},
): AnswerChip[] {
  if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) return [];
  const raw = rawSpec as Record<string, unknown>;
  const ranked = candidates(miss, datasets)
    .map((c) => ({ c, near: Math.max(...c.names.map((n) => nearness(miss.said, n))) }))
    .filter((x) => x.near > 0)
    .sort((a, b) => b.near - a.near || b.c.fit - a.c.fit); // stable: ties stay in column order
  const out: AnswerChip[] = [];
  for (const { c } of ranked) {
    if (out.length >= MAX_OPTIONS) break;
    const v = validateAnswerSpec(substitute(raw, miss, c.put), datasets, { ...opts, metrics });
    if (v.ok) out.push({ label: oneLine(c.label), spec: v.spec, ...(miss.part === 'dataset' ? {} : { column: c.put }) });
  }
  return out;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/**
 * A stored suggestion, re-read — a persisted turn is untrusted on load: a known
 * part, `said` and each label as one line of at most MAX_TEXT characters, at
 * most MAX_OPTIONS options, each spec through `sanitizeStoredSpec`. A malformed
 * option is dropped; with none left there is no suggestion.
 */
export function sanitizeSuggest(raw: unknown): AnswerSuggest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.part !== 'string' || !PARTS.has(o.part) || typeof o.said !== 'string') return undefined;
  const options: AnswerChip[] = [];
  for (const item of Array.isArray(o.options) ? (o.options as unknown[]) : []) {
    if (options.length >= MAX_OPTIONS || !item || typeof item !== 'object') continue;
    const { label, spec, column } = item as Record<string, unknown>;
    const clean = sanitizeStoredSpec(spec);
    if (!clean || typeof label !== 'string' || !oneLine(label)) continue;
    const named = o.part !== 'dataset' && typeof column === 'string' && column && column.length <= MAX_COLUMN;
    options.push({ label: oneLine(label), spec: clean, ...(named ? { column } : {}) });
  }
  return options.length ? { part: o.part as SpecMiss['part'], said: oneLine(o.said), options } : undefined;
}

/**
 * A name to remember, re-read — from a client (`answer:rerun`) or a stored turn:
 * kept only when `column` is one the answer uses and `said` is ONE name the
 * catalog would store exactly as said (app/columnNames `sanitizeAliases`: one
 * line, no comma, at most 60 characters, not the column's own name).
 */
export function sanitizeLearn(raw: unknown, spec: AnswerSpec): AnswerLearn | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { said, column } = raw as Record<string, unknown>;
  if (typeof said !== 'string' || typeof column !== 'string') return undefined;
  const uses = [spec.category, spec.series, ...spec.measures.map((m) => m.column), ...spec.filters.map((f) => f.column)];
  const one = sanitizeAliases(said, column);
  return uses.includes(column) && one.length === 1 && one[0] === said ? { said, column } : undefined;
}
