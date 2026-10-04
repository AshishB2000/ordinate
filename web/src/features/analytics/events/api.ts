// Event annotations' calls (src/api/analyticsB.ts → src/ipc/events.ts) and the
// reply shapes. Nothing here matches a date: the server places events on axes
// (src/analysis/events.ts) and sends each event's "when" line and its day
// count with the list.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';

export type EventKind = 'launch' | 'campaign' | 'incident' | 'holiday' | 'other';
export const KINDS: ReadonlyArray<[EventKind, string]> = [
  ['launch', 'Launch'],
  ['campaign', 'Campaign'],
  ['incident', 'Incident'],
  ['holiday', 'Holiday'],
  ['other', 'Other'],
];
export const kindName = (k: string): string => KINDS.find((x) => x[0] === k)?.[1] ?? 'Other';

export interface EventScope {
  datasetIds?: string[];
  filters?: Array<{ type: 'filter'; column: string; op: string; values: string[] }>;
}
export interface ProjectEvent {
  id: string;
  title: string;
  kind: EventKind;
  date: string;
  end?: string;
  scope?: EventScope;
  /** "Nov 28, 2024" / "Nov 24 – Dec 31, 2023" — the server's eventWhen. */
  when: string;
  /** Days covered, both ends included — the server's count. */
  days: number;
}
export interface Calendar {
  code: string;
  name: string;
  note: string;
  perYear: number;
}
export interface EventsState {
  events: ProjectEvent[];
  calendars: string[];
  available: Calendar[];
}
type Fail = { ok: false; error: string };

async function ask<T>(p: Promise<unknown>, fallback: string): Promise<T> {
  const r = (await p) as (T & { ok: true }) | Fail | null;
  if (!r || r.ok === false) throw new Error((r && r.error) || fallback);
  return r as T;
}

export const eventsKey = (projectId: string) => ['events:list', projectId] as const;

export function useEvents(projectId: string) {
  return useQuery({ queryKey: eventsKey(projectId), queryFn: () => ask<EventsState>(rpc('events:list', { projectId }), 'Could not read events.') });
}

/** Every write refreshes the list and every chart (their axes carry the marks). */
export function useEventsRefresh(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: eventsKey(projectId) });
    for (const k of ['visual:data', 'visual:preview', 'visual:thumbs']) void qc.invalidateQueries({ queryKey: [k] });
  };
}

export interface EventDraft {
  id?: string;
  title: string;
  kind: string;
  date: string;
  end: string | null;
  scope?: EventScope;
}

export const saveEvent = (projectId: string, event: EventDraft) => ask<{ event: ProjectEvent }>(rpc('events:save', { projectId, event }), 'Could not save the event.');
export const deleteEvent = (projectId: string, id: string) => ask<object>(rpc('events:delete', { projectId, id }), 'That event no longer exists.');
export const importCsv = (projectId: string, text: string) => ask<{ added: number; skipped: number }>(rpc('events:importCsv', { projectId, text }), 'Could not import that file.');
export const setCalendars = (projectId: string, calendars: string[]) => ask<{ calendars: string[] }>(rpc('events:setCalendars', { projectId, calendars }), 'Could not change the calendars.');

/** Under the RPC body cap (src/api/analyticsB.ts `events:importCsv`). */
export const MAX_CSV = 900_000;
