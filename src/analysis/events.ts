// Event annotations — PURE, MAIN PROCESS, NO MODEL.
//
// A project keeps a list of EVENTS — a launch, a campaign, an incident, a
// holiday — each a date or a date range with a title. This file decides, by
// date arithmetic alone, where an event falls on a chart's date axis and
// whether a change the app found (an insight, a key-drivers comparison)
// happened during one. "Revenue rose 18% in 2023-11, during 'Holiday campaign'"
// is the app matching two date ranges, never a model guessing at a cause.
//
// Matching reuses the app's ONE date grammar: an axis label becomes the dates
// it covers through `driverScope.bucketRange` (the inverse of
// `categoryKey.dateBucketLabel`), and an event's own dates parse through
// `categoryKey.parseDateCell`, the same shapes a date column accepts. Ranges
// are inclusive epoch-day spans; two spans meet when each starts before the
// other ends.
//
// SCOPE. An event may name the datasets it belongs to and filters it is about
// ("only where region is West"). A scoped filter EXCLUDES the event only when
// the chart is filtered to something else on that column — an unfiltered chart
// still includes West, so a West outage still marks it.
//
// Storage (events.json), holiday calendars and the IPC live elsewhere
// (./eventStore, ./holidays, ../ipc/events); this file is node-testable.

import type { FilterStep, Cell } from '../data/transforms';
import type { DateGrain } from './categoryKey';
import { daysFromCivil, parseDateCell } from './categoryKey';
import { bucketRange, rangeLabel } from './driverScope';
import { daysFromIso, isoFromDays } from './dateIntel';
import type { DateRange } from './dateIntel';
import type { Insight } from './insightsAgg';

export type EventKind = 'launch' | 'campaign' | 'incident' | 'holiday' | 'other';
export const EVENT_KINDS: readonly EventKind[] = ['launch', 'campaign', 'incident', 'holiday', 'other'];
const KINDS: ReadonlySet<string> = new Set(EVENT_KINDS);

export const MAX_EVENTS = 2000;
const MAX_TITLE = 200;
const MAX_SCOPE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scope filter: the event is about these values of one column. */
export interface EventScopeFilter { type: 'filter'; column: string; op: 'in'; values: string[] }
export interface EventScope { datasetIds?: string[]; filters?: EventScopeFilter[] }

export interface ProjectEvent {
  id: string;
  /** ISO date. A single-date event is a marker; with `end` it is a band. */
  date: string;
  /** ISO date, after `date`. */
  end?: string;
  title: string;
  kind: EventKind;
  scope?: EventScope;
  /** Set on a holiday contributed by a bundled calendar ('US', 'UK'…) — never stored. */
  calendar?: string;
}

/** An event placed on one chart's axis — what `data.events` carries to the renderer. */
export interface EventMark {
  id: string;
  kind: EventKind;
  title: string;
  /** "Nov 24 – Dec 31, 2023" — how the event's dates read. */
  when: string;
  /** First and last label index the event covers, in main's label order. */
  from: number;
  to: number;
  /** A range (band) rather than a single date (marker). */
  range: boolean;
}

// ── sanitizing ───────────────────────────────────────────────────────────────

/** Any date shape a date column accepts → ISO, or null. */
export function isoDate(cell: unknown): string | null {
  const c = parseDateCell(cell as Cell);
  return c ? isoFromDays(daysFromCivil(c.y, c.m, c.d)) : null;
}

function sanitizeScope(raw: unknown): EventScope | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return undefined;
  const out: EventScope = {};
  const ids = Array.isArray(o.datasetIds) ? o.datasetIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)) : [];
  if (ids.length) out.datasetIds = [...new Set(ids)].slice(0, MAX_SCOPE);
  const filters: EventScopeFilter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters : []) {
    const fo = f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
    const column = typeof fo.column === 'string' ? fo.column.trim().slice(0, MAX_TITLE) : '';
    const list = fo.op === '=' ? [fo.value] : Array.isArray(fo.values) ? fo.values : [];
    const values = list.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).slice(0, MAX_TITLE)).slice(0, MAX_SCOPE);
    if (column && values.length) filters.push({ type: 'filter', column, op: 'in', values });
    if (filters.length >= 8) break;
  }
  if (filters.length) out.filters = filters;
  return out.datasetIds || out.filters ? out : undefined;
}

/** A stored or incoming event, cleaned — or null when it is not one. Never throws. */
export function sanitizeEvent(raw: unknown): ProjectEvent | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.id !== 'string' || !UUID_RE.test(o.id)) return null;
  let date = isoDate(o.date);
  let end = o.end == null || o.end === '' ? null : isoDate(o.end);
  const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
  if (!date || !title) return null;
  if (end && end < date) [date, end] = [end, date];
  const ev: ProjectEvent = { id: o.id, date, title, kind: KINDS.has(o.kind as string) ? (o.kind as EventKind) : 'other' };
  if (end && end !== date) ev.end = end;
  const scope = sanitizeScope(o.scope);
  if (scope) ev.scope = scope;
  return ev;
}

// ── dates ────────────────────────────────────────────────────────────────────

interface Span { from: number; to: number }

function eventSpan(e: ProjectEvent): Span | null {
  const from = daysFromIso(e.date);
  const to = daysFromIso(e.end || e.date);
  return from === null || to === null ? null : { from, to };
}

function rangeSpan(r: DateRange | null): Span | null {
  const from = r ? daysFromIso(r.from) : null;
  const to = r ? daysFromIso(r.to) : null;
  return from === null || to === null ? null : { from, to };
}

/** "Nov 28, 2024" / "Nov 24 – Dec 31, 2023". */
export function eventWhen(e: ProjectEvent): string {
  return rangeLabel({ from: e.date, to: e.end || e.date });
}

/** How many days an event covers, both ends included — 1 for a one-day event. */
export function eventDays(e: ProjectEvent): number {
  const s = eventSpan(e);
  return s ? s.to - s.from + 1 : 1;
}

/**
 * A PERIOD KEY as the insights and alerts write it — a year, a quarter
 * ('2024-Q4'), a year-month ('2024-11') or one raw date cell — → its days.
 */
export function periodSpan(key: string): Span | null {
  const s = String(key || '').trim();
  if (/^\d{4}$/.test(s)) return rangeSpan(bucketRange(s, 'year'));
  if (/^\d{4}-Q[1-4]$/.test(s)) return rangeSpan(bucketRange(s, 'quarter'));
  if (/^\d{4}-\d{2}$/.test(s)) return rangeSpan(bucketRange(s, 'month'));
  const iso = isoDate(s);
  return iso ? rangeSpan({ from: iso, to: iso }) : null;
}

/** A date range with both ends (a drivers period) → its days. */
export function dateRangeSpan(r: DateRange | null | undefined): Span | null {
  return r && r.from && r.to ? rangeSpan(r) : null;
}

// ── scope ────────────────────────────────────────────────────────────────────

/**
 * Does the event belong on a view of `datasetId` under `filters`? A dataset
 * scope must name it; a scoped filter is contradicted only by an `=` / `in`
 * filter on the same column that keeps none of its values.
 */
export function inScope(e: ProjectEvent, datasetId: string | null | undefined, filters: FilterStep[] = []): boolean {
  const s = e.scope;
  if (!s) return true;
  if (s.datasetIds && s.datasetIds.length && !(datasetId && s.datasetIds.includes(datasetId))) return false;
  for (const f of s.filters || []) {
    const want = new Set(f.values);
    for (const c of filters || []) {
      if (!c || c.column !== f.column) continue;
      const have = c.op === '=' ? [c.value] : c.op === 'in' ? c.values || [] : null;
      if (have && !have.some((v) => want.has(String(v)))) return false;
    }
  }
  return true;
}

// ── a chart's axis ───────────────────────────────────────────────────────────

/**
 * Place events on a date axis at its grain. Every label must be a bucket label
 * of that grain, or nothing is placed (it is not a date axis). An event covers
 * every bucket its dates touch; one that touches none of them is left off.
 */
export function eventsOnAxis(events: ProjectEvent[], labels: unknown[], grain: DateGrain): EventMark[] {
  const spans: Span[] = [];
  for (const l of labels || []) {
    const sp = rangeSpan(bucketRange(String(l), grain));
    if (!sp) return [];
    spans.push(sp);
  }
  if (!spans.length) return [];
  const out: EventMark[] = [];
  for (const e of events || []) {
    const ev = eventSpan(e);
    if (!ev) continue;
    let from = -1;
    let to = -1;
    spans.forEach((sp, i) => {
      if (sp.from <= ev.to && sp.to >= ev.from) { if (from < 0) from = i; to = i; }
    });
    if (from < 0) continue;
    out.push({ id: e.id, kind: e.kind, title: e.title, when: eventWhen(e), from, to, range: !!e.end });
  }
  return out;
}

// ── attribution: "…, during 'Holiday campaign'" ──────────────────────────────

/** In-scope events whose dates meet `span`, earliest first. */
export function eventsDuring(events: ProjectEvent[], span: Span | null, datasetId: string | null, filters: FilterStep[] = []): ProjectEvent[] {
  if (!span) return [];
  return (events || [])
    .filter((e) => { const ev = eventSpan(e); return !!ev && ev.from <= span.to && ev.to >= span.from && inScope(e, datasetId, filters); })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
}

/** At most this many events are named in one sentence; the rest are counted. */
const NAMED = 2;

/** ", during 'A'" · ", during 'A' and 'B'" · ", during 'A', 'B' and 3 more". '' for none. */
export function duringClause(hits: ProjectEvent[]): string {
  if (!hits.length) return '';
  const names = hits.slice(0, NAMED).map((e) => `'${e.title}'`);
  const rest = hits.length - names.length;
  const list = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.length === 2 ? `${names[0]} and ${names[1]}` : names[0];
  return `, during ${list}`;
}

/** "It falls during 'Holiday campaign' (Nov 24 – Dec 31, 2023)." '' for none. */
export function duringSentence(hits: ProjectEvent[]): string {
  if (!hits.length) return '';
  const named = hits.slice(0, NAMED).map((e) => `'${e.title}' (${eventWhen(e)})`);
  const rest = hits.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(' and ');
  return `It falls during ${list}.`;
}

/** The finding kinds that name ONE period a change landed in — a change point. */
const CHANGE_KINDS: ReadonlySet<string> = new Set(['mover', 'period_change']);

/**
 * Insights whose change point falls inside an event, with the event named in
 * the title, the detail and the facts. Others come back untouched. Returns new
 * objects — the caller's list may be a cached one.
 */
export function attributeInsights(list: Insight[], events: ProjectEvent[]): Insight[] {
  if (!events || !events.length) return list;
  return list.map((i) => {
    if (!CHANGE_KINDS.has(i.kind) || !i.periodKey) return i;
    const hits = eventsDuring(events, periodSpan(i.periodKey), i.datasetId, (i.chart && i.chart.filters) || []);
    if (!hits.length) return i;
    return {
      ...i,
      title: i.title + duringClause(hits),
      detail: `${i.detail} ${duringSentence(hits)}`,
      facts: { ...i.facts, event: hits[0].title, eventKind: hits[0].kind, eventWhen: eventWhen(hits[0]) },
    };
  });
}

// ── CSV import ───────────────────────────────────────────────────────────────

const HEADS: Record<string, string[]> = {
  date: ['date', 'start', 'start date', 'from', 'day', 'when'],
  end: ['end', 'end date', 'to', 'until'],
  title: ['title', 'name', 'event', 'description', 'label'],
  kind: ['kind', 'type', 'category'],
};

/**
 * Rows of a parsed CSV (`parse.parseCsv`) → events. Columns are found by name
 * (date/start, end, title/name, kind/type); `newId` mints each id. A row
 * without a readable date or a title is counted as skipped, never guessed.
 */
export function eventsFromTable(
  columns: Array<{ name: string }>, rows: unknown[][], newId: () => string,
): { events: ProjectEvent[]; skipped: number; error?: string } {
  const find = (k: string): number => columns.findIndex((c) => HEADS[k].includes(String(c && c.name).trim().toLowerCase()));
  const di = find('date');
  const ti = find('title');
  if (di < 0 || ti < 0) return { events: [], skipped: 0, error: 'The file needs a "date" column and a "title" column.' };
  const ei = find('end');
  const ki = find('kind');
  const events: ProjectEvent[] = [];
  let skipped = 0;
  for (const r of rows || []) {
    const kind = ki >= 0 ? String(r[ki] ?? '').trim().toLowerCase() : 'other';
    const ev = sanitizeEvent({ id: newId(), date: r[di], end: ei >= 0 ? r[ei] : null, title: r[ti], kind });
    if (ev && events.length < MAX_EVENTS) events.push(ev); else skipped++;
  }
  return { events, skipped };
}
