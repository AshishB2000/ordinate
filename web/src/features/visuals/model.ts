// The Visuals screen's pure helpers — what the legacy files decided inline:
// a card's accent (vizGallery.vizAccentFor), the suggested name
// (vizBuilder.suggestVisualName), related-column keys (encodingRelated), the
// form's defaults (encodingForm.setColumns) and the timestamp format
// (hub formatSidebarTime). Nothing here computes a figure.

import { VIZ_LABELS } from '../../charts/vizLabels';
import type { Agg, Encoding, Measure, RelatedCol } from './api';

export interface Column {
  name: string;
  type: 'text' | 'number' | 'date';
}

export const AGGS: readonly Agg[] = ['sum', 'avg', 'count', 'min', 'max', 'none'];
export const AGG_LABELS: Record<Agg, string> = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max', none: 'Raw (no aggregation)' };
export const GRAINS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
] as const;

export const typeLabel = (type: string): string => (VIZ_LABELS as Record<string, string>)[type] || type || 'Chart';

const ACCENTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

/** A stable colour per chart type: same type, same colour, every render and session. */
export function accentFor(chartType: string): string {
  let h = 0;
  for (let i = 0; i < chartType.length; i += 1) h = (h * 31 + chartType.charCodeAt(i)) >>> 0;
  return `var(${ACCENTS[h % ACCENTS.length]})`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "2:14 PM" today, "Mar 4 · 2:14 PM" otherwise; '' for no date. */
export function shortTime(iso: string | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const time = timeFmt.format(d);
  return d.toDateString() === now.toDateString() ? time : `${dayFmt.format(d)} · ${time}`;
}

/** "revenue by region", or the type's name when the encoding is not complete. */
export function suggestName(enc: Encoding, chartType: string): string {
  const pivot = enc.pivot as { rows?: { column: string }[]; values?: { column: string }[] } | undefined;
  if (pivot) {
    const value = pivot.values?.[0]?.column ?? '';
    const dim = pivot.rows?.[0]?.column ?? '';
    if (value && dim) return `${value} by ${dim}`;
  }
  const measure = enc.values[0]?.column ?? '';
  if (measure && enc.category) return `${measure} by ${enc.category}`;
  return typeLabel(chartType);
}

/** Numbers first for a measure; every column when the dataset has none (`count` over text is legitimate). */
export function measureColumns(cols: readonly Column[]): Column[] {
  const nums = cols.filter((c) => c.type === 'number');
  return nums.length ? nums : cols.slice();
}

/**
 * A new visual's starting encoding: the first text/date column as the
 * category (numbers only when there is nothing else), the first measure
 * column summed. `encodingForm.setColumns` with no preset.
 */
export function defaultEncoding(cols: readonly Column[]): Encoding {
  const dims = cols.filter((c) => c.type !== 'number');
  const category = (dims[0] ?? cols[0])?.name ?? '';
  const m = measureColumns(cols)[0];
  return { category, values: m ? [{ column: m.name, aggregation: 'sum' }] : [] };
}

/**
 * A saved (or suggested) encoding made to fit THIS dataset's columns — what
 * the desktop's selects did silently: a category or measure the dataset no
 * longer has falls back to the first real option; unknown shelves ride through.
 */
export function fitEncoding(preset: Encoding | undefined, cols: readonly Column[], related: readonly RelatedCol[]): Encoding {
  const base = defaultEncoding(cols);
  if (!preset) return base;
  const has = (name: string, dsId?: string) =>
    dsId ? related.some((r) => r.datasetId === dsId && r.column === name) : cols.some((c) => c.name === name);
  const out: Encoding = { ...preset };
  if (!preset.category || !has(preset.category, preset.categoryDatasetId)) {
    out.category = base.category;
    delete out.categoryDatasetId;
  }
  if (preset.series && !has(preset.series, preset.seriesDatasetId)) {
    delete out.series;
    delete out.seriesDatasetId;
  }
  const keep = (preset.values ?? []).filter((v) => v.column && has(v.column, v.datasetId));
  out.values = keep.length ? keep : base.values;
  return out;
}

// ── Related columns: one select value, `@<datasetId>/<column>` ──────────────

const REL = /^@([0-9a-f-]{36})\/([\s\S]*)$/i;

export function fieldKey(column: string, datasetId?: string): string {
  return datasetId ? `@${datasetId}/${column}` : column;
}

export function parseKey(value: string): { column: string; datasetId?: string } {
  const m = REL.exec(value);
  return m ? { datasetId: m[1], column: m[2] } : { column: value };
}

/** A measure picked from a select value. */
export function measureFrom(value: string, aggregation: Agg, prev?: Measure): Measure {
  const { column, datasetId } = parseKey(value);
  const m: Measure = { column, aggregation };
  if (datasetId) m.datasetId = datasetId;
  if (prev?.calc) m.calc = prev.calc;
  return m;
}

/** Is the category a date (the grain and the period overlay belong to dates only)? */
export function categoryType(enc: Encoding, cols: readonly Column[], related: readonly RelatedCol[]): string {
  if (enc.categoryDatasetId) return related.find((r) => r.datasetId === enc.categoryDatasetId && r.column === enc.category)?.type ?? '';
  return cols.find((c) => c.name === enc.category)?.type ?? '';
}
