// Event annotations IPC — the Events page's CRUD and CSV import, and the hook
// that puts a project's events on every date axis (`withEvents`, called on
// `visual:data`'s finished reply like ./visualsAnalytics). MAIN.
//
//   events:list           { events, calendars, available }  — the page's state
//   events:save           create or update one event
//   events:delete         remove one event
//   events:importCsv      CSV text → events, appended (parsed by data/parse)
//   events:setCalendars   which bundled holiday calendars this project uses
//
// NO MODEL. Placing an event is date arithmetic in ../analysis/events.

import { ipcMain } from './bus';
import { randomUUID } from 'crypto';
import { parseCsv } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import { axisOf } from '../analysis/analytics';
import { eventDays, eventsFromTable, eventsOnAxis, eventWhen, inScope, sanitizeEvent, MAX_EVENTS } from '../analysis/events';
import * as store from '../analysis/eventStore';
import { CALENDARS, loadCalendar, sanitizeCalendars } from '../analysis/holidays';
import type { VizDataReply } from './visuals';

/** Largest CSV accepted, in characters — an events list, not a dataset. */
const MAX_CSV = 2_000_000;

/** `reply` with `data.events` attached when its axis is a date axis and an event lands on it. Never throws. */
export async function withEvents(
  reply: VizDataReply, projectId: string, datasetId: string, filters: FilterStep[],
): Promise<VizDataReply> {
  try {
    if (!reply.ok || reply.data.pivot || reply.data.geo) return reply;
    const axis = axisOf(reply.data, { category: reply.category || null });
    if (axis.kind !== 'date' || !axis.grain) return reply;
    const events = (await store.projectEvents(projectId)).filter((e) => inScope(e, datasetId, filters));
    const marks = events.length ? eventsOnAxis(events, reply.data.labels, axis.grain) : [];
    return marks.length ? { ...reply, data: { ...reply.data, events: marks } } : reply;
  } catch (_) {
    return reply;
  }
}

async function listState(projectId: string): Promise<unknown> {
  const f = await store.load(projectId);
  const available = CALENDARS.map((c) => {
    const file = loadCalendar(c.code);
    return { code: c.code, name: c.name, note: file ? file.note : '', perYear: file ? Math.round(file.days.length / (file.to - file.from + 1)) : 0 };
  });
  // Each event's "when" line and its inclusive day count ride with it, so no
  // screen does date arithmetic (T2.11) — eventWhen is what Insights write too.
  const events = f.events.map((e) => ({ ...e, when: eventWhen(e), days: eventDays(e) }));
  return { ok: true, events, calendars: f.calendars, available };
}

// ponytail: IPC payloads are untrusted JSON envelopes, sanitized field by field below
type Payload = Record<string, any>;

export function register(): void {
  ipcMain.handle('events:list', async (_e, p: Payload = {}) => {
    try { return await listState(String(p.projectId || '')); } catch (err: any) { return { ok: false, error: err?.message || 'Could not read events' }; }
  });

  ipcMain.handle('events:save', async (_e, p: Payload = {}) => {
    const projectId = String(p.projectId || '');
    const ev = sanitizeEvent({ ...(p.event || {}), id: p.event && p.event.id ? p.event.id : randomUUID() });
    if (!ev) return { ok: false, error: 'An event needs a valid date and a title.' };
    const f = await store.load(projectId);
    const i = f.events.findIndex((x) => x.id === ev.id);
    if (i >= 0) f.events[i] = ev;
    else if (f.events.length >= MAX_EVENTS) return { ok: false, error: `A project keeps at most ${MAX_EVENTS} events.` };
    else f.events.push(ev);
    return (await store.save(projectId, f)) ? { ok: true, event: ev } : { ok: false, error: 'Could not save the event.' };
  });

  ipcMain.handle('events:delete', async (_e, p: Payload = {}) => {
    const projectId = String(p.projectId || '');
    const f = await store.load(projectId);
    const n = f.events.length;
    f.events = f.events.filter((x) => x.id !== p.id);
    if (f.events.length === n) return { ok: false, error: 'That event no longer exists.' };
    return { ok: await store.save(projectId, f) };
  });

  ipcMain.handle('events:importCsv', async (_e, p: Payload = {}) => {
    const projectId = String(p.projectId || '');
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) return { ok: false, error: 'The file is empty.' };
    if (text.length > MAX_CSV) return { ok: false, error: 'That file is too large for an events list.' };
    const parsed = parseCsv(text);
    const got = eventsFromTable(parsed.columns, parsed.rows, () => randomUUID());
    if (got.error) return { ok: false, error: got.error };
    const f = await store.load(projectId);
    const room = Math.max(0, MAX_EVENTS - f.events.length);
    const added = got.events.slice(0, room);
    f.events = f.events.concat(added);
    if (!(await store.save(projectId, f))) return { ok: false, error: 'Could not save the events.' };
    return { ok: true, added: added.length, skipped: got.skipped + (got.events.length - added.length) };
  });

  ipcMain.handle('events:setCalendars', async (_e, p: Payload = {}) => {
    const projectId = String(p.projectId || '');
    const f = await store.load(projectId);
    f.calendars = sanitizeCalendars(p.calendars);
    return (await store.save(projectId, f)) ? { ok: true, calendars: f.calendars } : { ok: false, error: 'Could not save the calendars.' };
  });
}
