// What a stored column value is CALLED ("EU" -> "Europe"). PURE: no fs, no node imports, because
// the web imports this file too (so it imports only the shared, import-free clip: the chart's data
// shape is typed structurally below, and the "Other" name is copied). A column doc without labels reads as [].

import { clip } from '../app/clip';

export interface ValueLabel { value: string; label: string }

export const MAX_VALUE_LABELS = 500;
export const MAX_VALUE_LEN = 256;
export const MAX_LABEL_LEN = 120;

/**
 * Whitelist a stored list. A value is matched against cells exactly, so it is kept verbatim
 * (never trimmed or clipped: one over MAX_VALUE_LEN is dropped) and a blank one is dropped. The
 * label is trimmed and clipped. The first of a repeated value, and the first of a repeated label,
 * wins, so a label names one value and a value has one label.
 */
export function sanitizeValueLabels(raw: unknown): ValueLabel[] {
  const out: ValueLabel[] = [];
  if (!Array.isArray(raw)) return out;
  const values = new Set<string>();
  const labels = new Set<string>();
  for (const r of raw) {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    const value = o.value;
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_VALUE_LEN) continue;
    const label = clip(o.label, MAX_LABEL_LEN);
    if (!label || values.has(value) || labels.has(label)) continue;
    values.add(value);
    labels.add(label);
    out.push({ value, label });
    if (out.length >= MAX_VALUE_LABELS) break;
  }
  return out;
}

// ── what a chart reply carries ──────────────────────────────────────────────

/**
 * The "Other" bucket's name, mirrored from categoryKey.OTHER_LABEL (a leaf cannot import it);
 * scripts/test-valueLabels.ts pins the two, so a change there fails a test, not a picture.
 */
export const VL_OTHER_LABEL = 'Other';

/** The two axes of a grouped chart, as pairs `[stored value, label]`: pairs, not a map, because a value may be `__proto__`. */
export interface ValueLabelPairs { category?: [string, string][]; series?: [string, string][] }

/** The part of a chart reply (vizData's ChartData) these rules read: typed structurally, so this file imports nothing. */
export interface LabelledAxes {
  labels: readonly (string | number)[];
  series: readonly { name: string }[];
}

/** One axis: a pair for each listed value that is present, minus any whose label is another value present. */
function axisPairs(list: ValueLabel[] | undefined, present: ReadonlySet<string>, dropped: string[], noPair?: string): [string, string][] {
  const out: [string, string][] = [];
  for (const { value, label } of list ?? []) {
    if (!present.has(value) || value === noPair) continue;
    if (label !== value && present.has(label)) dropped.push(label); // two bars would both read `label`
    else out.push([value, label]);
  }
  return out;
}

/**
 * Decide which labels a reply carries: a pair for each stored value that is on the axis (EXACT text,
 * `'EU '` is not `'EU'`), never for the app's own "Other" bucket (`otherBucket`), and never when the
 * label is itself another stored value on that axis (`dropped` names it, for a warning). A reply
 * with no pair is returned as it came, without the `valueLabels` key.
 */
export function applyValueLabels<D extends LabelledAxes>(
  data: D,
  lists: { category?: ValueLabel[]; series?: ValueLabel[] },
  opts: { otherBucket?: boolean } = {},
): { data: D & { valueLabels?: ValueLabelPairs }; dropped: string[] } {
  const dropped: string[] = [];
  const text = (xs: readonly unknown[]): Set<string> => new Set(xs.filter((x): x is string => typeof x === 'string'));
  const category = axisPairs(lists.category, text(data.labels), dropped, opts.otherBucket ? VL_OTHER_LABEL : undefined);
  const series = axisPairs(lists.series, text(data.series.map((s) => s.name)), dropped);
  if (!category.length && !series.length) return { data, dropped };
  const valueLabels: ValueLabelPairs = {};
  if (category.length) valueLabels.category = category;
  if (series.length) valueLabels.series = series;
  return { data: { ...data, valueLabels }, dropped };
}

/** Each text as shown: its label when it has one (a number is never a labelled value). */
export function shownText<T>(values: readonly T[], pairs: [string, string][] = []): (T | string)[] {
  const shown = new Map(pairs);
  return values.map((v) => (typeof v === 'string' ? shown.get(v) ?? v : v));
}

/** The stored value a shown text stands for; a text that is no label passes through. */
export function rawOf<T>(shown: T, pairs: [string, string][] = []): T | string {
  return typeof shown === 'string' ? pairs.find(([, label]) => label === shown)?.[0] ?? shown : shown;
}

/** A reply as drawn: category labels and series names shown, `valueLabels` gone. */
export function shownChart<D extends LabelledAxes & { valueLabels?: ValueLabelPairs }>(data: D): D {
  if (!data.valueLabels) return data;
  const { valueLabels, ...rest } = data;
  const series = valueLabels.series ? data.series.map((s) => ({ ...s, name: shownText([s.name], valueLabels.series)[0] })) : data.series;
  return { ...rest, labels: shownText(data.labels, valueLabels.category), series } as unknown as D;
}

// ── what a list may not contain ─────────────────────────────────────────────

export type ValueLabelProblem =
  | { kind: 'repeatValue'; value: string }
  | { kind: 'sharedLabel'; label: string; values: [string, string] }
  | { kind: 'tooMany' }
  | { kind: 'blankValue' }
  | { kind: 'valueTooLong'; value: string }
  | { kind: 'emptyLabel'; value: string };

/**
 * The first reason this list cannot be saved, or null. Stricter than sanitizeValueLabels, which
 * quietly drops what a stored list should never hold: the editor is told instead of losing a row.
 * Labels are compared as they would be stored (trimmed, clipped).
 */
export function valueLabelProblem(list: ValueLabel[]): ValueLabelProblem | null {
  if (list.length > MAX_VALUE_LABELS) return { kind: 'tooMany' };
  const byLabel = new Map<string, string>();
  const values = new Set<string>();
  for (const { value, label } of list) {
    if (value.trim() === '') return { kind: 'blankValue' };
    if (value.length > MAX_VALUE_LEN) return { kind: 'valueTooLong', value };
    const stored = clip(label, MAX_LABEL_LEN);
    if (!stored) return { kind: 'emptyLabel', value };
    if (values.has(value)) return { kind: 'repeatValue', value };
    const other = byLabel.get(stored);
    if (other !== undefined) return { kind: 'sharedLabel', label: stored, values: [other, value] };
    values.add(value);
    byLabel.set(stored, value);
  }
  return null;
}
