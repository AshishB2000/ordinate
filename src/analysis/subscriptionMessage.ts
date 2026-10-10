// A scheduled send as a NEUTRAL MESSAGE — pure. The figures arrive resolved
// (src/ipc/subscriptionFigures.ts, through the figure doors); this file turns
// them into one model both platforms are rendered from
// (./subscriptionRender.ts): a title, a subtitle, KPIs, one section per visual,
// a link, a footer. There is no picture: a visual travels as text.
//
//   categorical   the top rows by the first measure, each with its share of the
//                 total (only when every value is ≥ 0 — a share of a total with
//                 negatives in it means nothing)
//   time series   the latest value, its change from the point before, and the
//                 range over the period
//   table         the first rows, as drawn (a table, a pivot's leaf rows, a
//                 cohort, an event funnel)
//
// Every figure is formatted here by src/app/format.ts — the formatter the
// screen's figures come from — and every string that came from DATA or from an
// author (a category, a card title, a note) passes `clean` first: one line, no
// control or direction-override characters, bounded. The platform escape is the
// renderer's.

import { formatValue } from '../app/format';
import { fmtPct } from './alerts';
import * as say from './subscriptionText';

export interface KpiFigure {
  label: string;
  /** The figure as the card shows it. */
  display: string;
  /** The card's Compare, when it has one and there is a period to compare with. */
  compare?: { pct: number | null; delta: number | null; deltaDisplay?: string; label: string; direction?: 'up_good' | 'down_good' };
  /** Why there is no figure: a Live refusal's sentence, a deleted metric. */
  error?: string;
}

export interface VisualFigure {
  title: string;
  chartType: string;
  /** `visual:data`'s chart; absent when the Share policy hid it or it failed. */
  data?: { labels: Array<string | number>; series: Array<{ name: string; values: Array<number | null>; role?: string }>; dataShape?: string };
  /** The app's own sentence about the chart (reports:caption). */
  caption?: string;
  /** Why there is no chart. */
  note?: string;
  /** The visual's value format (chartFormat NumberFormatId); absent = the app's default figure. */
  format?: string;
  /** `visual:data`'s `recommendedShape`: 'time_series' when the category is a date. */
  shape?: string;
}

export interface ComposeInput {
  title: string;
  /** The date, the view, the filter line — whatever applies, already worded. */
  subtitle: string[];
  note?: string;
  kpis: KpiFigure[];
  visuals: VisualFigure[];
  /** The dashboard in the app, or null when this server does not know its public address. */
  link?: string | null;
  footer: string;
}

export interface MessageKpi {
  label: string;
  value: string;
  change?: string;
  tone?: 'good' | 'bad';
}

export interface MessageSection {
  title: string;
  caption?: string;
  /** Column headings; [] for a section that is only a note. */
  columns: string[];
  rows: string[][];
  /** Rows not shown. */
  more: number;
  note?: string;
}

export interface MessageModel {
  title: string;
  subtitle: string[];
  note?: string;
  kpis: MessageKpi[];
  sections: MessageSection[];
  /** KPIs and sections left out to fit a platform. */
  more: number;
  link?: { url: string; label: string };
  footer: string;
}

/** Rows a section carries before a platform's own limit trims further. */
export const TOP_ROWS = 10;
/** Measure columns a table section carries. */
export const TABLE_COLS = 5;
const TABLE_TYPES: ReadonlySet<string> = new Set(['table', 'pivot', 'cohort', 'event_funnel']);

// C0/C1 controls, zero-width characters, and the bidi embedding / override / isolate marks (which can reorder what a reader sees).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Untrusted text → one bounded line: invisible characters out, whitespace collapsed, cut with an ellipsis. */
export function clean(raw: unknown, max = 120): string {
  const s = String(raw ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const figure = (n: number | null | undefined, format?: string): string => (typeof n === 'number' && Number.isFinite(n) ? formatValue(n, format) || '—' : '—');

function kpi(f: KpiFigure): MessageKpi {
  const out: MessageKpi = { label: clean(f.label, 80), value: f.error ? clean(f.error, 160) : clean(f.display, 40) || '—' };
  const c = f.compare;
  if (f.error || !c || c.delta === null || !Number.isFinite(c.delta)) return out;
  const dir = c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  // A percent metric's change is in points (metric:compare sends no pct, only the delta's own words).
  const size = c.pct !== null && Number.isFinite(c.pct) ? (dir === 'down' ? '−' : dir === 'up' ? '+' : '') + fmtPct(c.pct) : clean(c.deltaDisplay ?? '', 40);
  if (!size) return out;
  const good = dir === 'flat' || !c.direction ? null : (dir === 'up') === (c.direction === 'up_good');
  out.change = say.changeText(arrow, size, clean(c.label, 60), good);
  if (good !== null) out.tone = good ? 'good' : 'bad';
  return out;
}

function section(v: VisualFigure): MessageSection {
  const base = { title: clean(v.title, 100), ...(v.caption ? { caption: clean(v.caption, 400) } : {}) };
  const series = (v.data?.series ?? []).filter((s) => s && s.role !== 'overlay' && Array.isArray(s.values));
  const labels = (v.data?.labels ?? []).map((l) => clean(l, 80));
  if (!v.data || !series.length || !labels.length) return { ...base, columns: [], rows: [], more: 0, note: clean(v.note || say.noFigure(), 300) };
  const first = series[0];
  const at = (i: number): number | null => (typeof first.values[i] === 'number' && Number.isFinite(first.values[i]) ? (first.values[i] as number) : null);

  if (TABLE_TYPES.has(v.chartType)) {
    const shown = labels.slice(0, TOP_ROWS);
    const cols = series.slice(0, TABLE_COLS); // a chat message is not a 60-column grid: the first measures, the rest said
    return {
      ...base,
      columns: ['', ...cols.map((s) => clean(s.name, 60))],
      rows: shown.map((l, i) => [l, ...cols.map((s) => figure(s.values[i], v.format))]),
      more: labels.length - shown.length,
      ...(series.length > cols.length ? { note: say.moreColumns(series.length - cols.length) } : {}),
    };
  }

  if (v.shape === 'time_series' || v.data.dataShape === 'time_series') {
    const known = labels.map((_, i) => i).filter((i) => at(i) !== null);
    if (!known.length) return { ...base, columns: [], rows: [], more: 0, note: say.noFigure() };
    const last = known[known.length - 1];
    const latest = at(last) as number;
    const rows: string[][] = [[`${say.latestLabel()} (${labels[last]})`, figure(latest, v.format)]];
    if (known.length > 1) {
      const prev = at(known[known.length - 2]) as number;
      const delta = latest - prev;
      const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
      const pct = prev !== 0 ? ` (${sign}${fmtPct((delta / Math.abs(prev)) * 100)})` : '';
      rows.push([say.changeLabel(), sign + figure(Math.abs(delta), v.format) + pct]);
      const all = known.map((i) => at(i) as number);
      rows.push([say.rangeLabel(), `${figure(Math.min(...all), v.format)} – ${figure(Math.max(...all), v.format)}`]);
    }
    return { ...base, columns: ['', clean(first.name, 60)], rows, more: 0 };
  }

  // Categorical: the biggest first, nulls last, ties in the chart's own order.
  const order = labels.map((_, i) => i).sort((a, b) => (at(b) ?? -Infinity) - (at(a) ?? -Infinity) || a - b);
  const values = order.map(at).filter((x): x is number => x !== null);
  const total = values.reduce((sum, x) => sum + x, 0);
  const shares = values.length > 1 && total > 0 && values.every((x) => x >= 0);
  const shown = order.slice(0, TOP_ROWS);
  return {
    ...base,
    columns: ['', clean(first.name, 60), ...(shares ? [say.shareHeading()] : [])],
    rows: shown.map((i) => [labels[i], figure(at(i), v.format), ...(shares ? [at(i) === null ? '—' : fmtPct(((at(i) as number) / total) * 100)] : [])]),
    more: labels.length - shown.length,
  };
}

/** The figures as one message. Pure: the same input is the same model. */
export function composeMessage(input: ComposeInput): MessageModel {
  const model: MessageModel = {
    title: clean(input.title, 150) || say.untitledSubscription(),
    subtitle: input.subtitle.map((s) => clean(s, 200)).filter(Boolean),
    kpis: input.kpis.map(kpi),
    sections: input.visuals.map(section),
    more: 0,
    footer: clean(input.footer, 300),
  };
  const note = clean(input.note, 1000);
  if (note) model.note = note;
  if (input.link) model.link = { url: input.link, label: say.openInOrdinate() };
  return model;
}

/** What "nothing changed" compares: the figures, not the date line or the footer. */
export function figuresOf(model: MessageModel): string {
  return JSON.stringify([model.kpis, model.sections]);
}

/** `model` cut to at most these counts; what was cut is counted in `more`. */
export function trimModel(model: MessageModel, lim: { kpis: number; sections: number; rows: number }): MessageModel {
  const kpis = model.kpis.slice(0, lim.kpis);
  const sections = model.sections.slice(0, lim.sections).map((s) => (s.rows.length > lim.rows ? { ...s, rows: s.rows.slice(0, lim.rows), more: s.more + s.rows.length - lim.rows } : s));
  return { ...model, kpis, sections, more: model.more + (model.kpis.length - kpis.length) + (model.sections.length - sections.length) };
}
