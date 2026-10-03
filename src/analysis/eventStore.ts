// Event PERSISTENCE — MAIN PROCESS ONLY.
//
// One `events.json` per project, beside `project.json`:
// `userData/projects/<id>/events.json` holding `{ events, calendars }`. One
// file, like alerts.json: every chart reply reads the whole list anyway, and
// events are counted in hundreds, not millions. Atomic write (unique temp
// sibling, then rename), UUID-checked ids, a corrupt file reads as empty and a
// corrupt entry is skipped — never fatal.
//
// The pure half (sanitizing, matching, attribution) is ./events.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { projectDir } from '../app/recordKinds';
import { MAX_EVENTS, sanitizeEvent } from './events';
import type { ProjectEvent } from './events';
import { holidayEvents, sanitizeCalendars } from './holidays';
import * as recordFs from '../app/recordFs';

export interface EventFile { events: ProjectEvent[]; calendars: string[] }

function fileOf(projectId: string): string | null {
  const dir = projectDir(projectId);
  return dir ? path.join(dir, 'events.json') : null;
}

/** One project's events and enabled calendars. Missing or corrupt → empty. */
export async function load(projectId: string): Promise<EventFile> {
  const file = fileOf(projectId);
  if (!file) return { events: [], calendars: [] };
  let raw: any; // any: parsed JSON, sanitized field by field below
  try {
    raw = JSON.parse(await recordFs.readFile(file, 'utf8'));
  } catch (_) {
    return { events: [], calendars: [] };
  }
  const events: ProjectEvent[] = [];
  for (const e of Array.isArray(raw?.events) ? raw.events : []) {
    const clean = sanitizeEvent(e);
    if (clean) events.push(clean);
    if (events.length >= MAX_EVENTS) break;
  }
  return { events, calendars: sanitizeCalendars(raw?.calendars) };
}

export async function save(projectId: string, f: EventFile): Promise<boolean> {
  const file = fileOf(projectId);
  if (!file) return false;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + randomUUID() + '.tmp';
    const body = { events: f.events.slice(0, MAX_EVENTS), calendars: sanitizeCalendars(f.calendars) };
    await recordFs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
    await recordFs.rename(tmp, file);
    return true;
  } catch (err: any) {
    console.error('[events] Could not write events.json:', err && err.message);
    return false;
  }
}

/** Every event a chart or a finding is matched against: the stored ones plus enabled calendars. */
export async function projectEvents(projectId: string): Promise<ProjectEvent[]> {
  const f = await load(projectId);
  return f.events.concat(holidayEvents(f.calendars));
}
