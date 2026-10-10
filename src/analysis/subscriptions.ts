// The Subscription record — a dashboard (or chosen cards of it) posted to
// Slack / Teams channels on a schedule — its sanitizers and its store. MAIN.
//
// Built like reportSpec.ts: a per-project directory, UUID ids checked before
// they touch a path, atomic temp-then-rename writes, corrupt files skipped. A
// subscription stores DECISIONS only — which dashboard, which cards, when,
// where — never a figure: every number in a send is recomputed at send time
// through the figure doors (src/ipc/subscriptionFigures.ts).
//
// Two halves with two writers, kept apart so neither clobbers the other:
//   the definition   what a project writer set (subscription:save)
//   `run`            what the server did about it: the last slot handled, the
//                    failure count, why it paused, the last 20 runs. Never
//                    taken from a client.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import { isValidId } from '../app/ids';
import * as recordFs from '../app/recordFs';
import { sanitizeSubSchedule, sanitizeTimeZone, type SubSchedule } from './subscriptionSchedule';
import { untitledSubscription, type RunCode, type RunDetail } from './subscriptionText';

export const MAX_HISTORY = 20;
export const MAX_CHANNELS = 10;
export const MAX_CARDS = 50;
/** Consecutive failed runs before a subscription switches itself off. */
export const PAUSE_AFTER = 5;

export type RunOutcome = 'sent' | 'skipped' | 'failed' | 'missed';

export interface RunEntry {
  at: string;
  /** The scheduled instant this run was for; absent on a manual send. */
  slot?: string;
  trigger: 'schedule' | 'manual';
  outcome: RunOutcome;
  code: RunCode;
  detail?: RunDetail;
}

export interface RunState {
  /** The newest scheduled slot handled (sent, skipped, failed or missed) — the due check's fence. */
  lastSlot?: string;
  lastSentAt?: string;
  /** A hash of the figures last sent ("skip when nothing changed"). */
  lastHash?: string;
  /** The newest data time among the figures last sent ("only when refreshed"). */
  lastDataAt?: string;
  /** Failed runs in a row. */
  failures: number;
  /** Set when it paused itself: the failure that tipped it, and when. */
  paused?: { code: RunCode; detail?: RunDetail; at: string };
  history: RunEntry[];
}

export interface Subscription {
  id: string;
  /** Re-supplied by the loader, never trusted from the file. */
  projectId: string;
  name: string;
  /** The dashboard it sends. */
  analysisId: string;
  /** The whole dashboard, or chosen cards of it (in the dashboard's own order). */
  content: { mode: 'all' | 'cards'; cardIds: string[] };
  /** A saved view of the dashboard: the send carries its filters. */
  viewId?: string;
  schedule: SubSchedule;
  timezone: string;
  channelIds: string[];
  message: { title: string; note: string; includeLink: boolean };
  conditions: { skipUnchanged: boolean; onlyWhenRefreshed: boolean };
  enabled: boolean;
  /** The member whose access a run computes with. */
  owner: string;
  /** When the schedule was last set or switched on: no slot before it is ever due. */
  since: string;
  run: RunState;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const ids = (v: unknown, max: number): string[] => [...new Set((Array.isArray(v) ? v : []).filter(isValidId).map((x) => x.toLowerCase()))].slice(0, max);
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined);

const CODES: ReadonlySet<string> = new Set([
  'sent', 'partial', 'unchanged', 'not_refreshed', 'missed', 'owner_removed', 'owner_no_access', 'dashboard_gone',
  'no_channels', 'no_content', 'compute_failed', 'post_failed', 'unreachable', 'refused', 'no_secret',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['sent', 'skipped', 'failed', 'missed']);

function sanitizeDetail(raw: unknown): RunDetail | undefined {
  const o = obj(raw);
  const d: RunDetail = {};
  for (const k of ['sent', 'total', 'status'] as const) if (Number.isInteger(o[k])) d[k] = o[k] as number;
  for (const k of ['channel', 'owner'] as const) if (str(o[k], 200)) d[k] = str(o[k], 200);
  return Object.keys(d).length ? d : undefined;
}

function sanitizeEntry(raw: unknown): RunEntry | null {
  const o = obj(raw);
  const at = iso(o.at);
  if (!at || !OUTCOMES.has(o.outcome as string) || !CODES.has(o.code as string)) return null;
  const e: RunEntry = { at, trigger: o.trigger === 'manual' ? 'manual' : 'schedule', outcome: o.outcome as RunOutcome, code: o.code as RunCode };
  const slot = iso(o.slot);
  if (slot) e.slot = slot;
  const detail = sanitizeDetail(o.detail);
  if (detail) e.detail = detail;
  return e;
}

export function sanitizeRun(raw: unknown): RunState {
  const o = obj(raw);
  const run: RunState = {
    failures: Number.isInteger(o.failures) && (o.failures as number) > 0 ? (o.failures as number) : 0,
    history: (Array.isArray(o.history) ? o.history : []).map(sanitizeEntry).filter((e): e is RunEntry => e !== null).slice(0, MAX_HISTORY),
  };
  for (const k of ['lastSlot', 'lastSentAt', 'lastDataAt'] as const) {
    const v = iso(o[k]);
    if (v) run[k] = v;
  }
  if (typeof o.lastHash === 'string' && /^[0-9a-f]{64}$/.test(o.lastHash)) run.lastHash = o.lastHash;
  const p = obj(o.paused);
  const pausedAt = iso(p.at);
  if (pausedAt && CODES.has(p.code as string)) run.paused = { code: p.code as RunCode, at: pausedAt, ...(sanitizeDetail(p.detail) ? { detail: sanitizeDetail(p.detail) } : {}) };
  return run;
}

/** The fields a project writer may set, each clamped. */
export interface SubscriptionInput {
  name?: unknown;
  analysisId?: unknown;
  content?: unknown;
  viewId?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  channelIds?: unknown;
  message?: unknown;
  conditions?: unknown;
  enabled?: unknown;
}

/** The writer's half of a record, every field clamped — from a stored record or an unsaved draft. */
export function definitionOf(data: Record<string, unknown>): Pick<Subscription, 'name' | 'analysisId' | 'content' | 'viewId' | 'schedule' | 'timezone' | 'channelIds' | 'message' | 'conditions' | 'enabled'> {
  const content = obj(data.content);
  const message = obj(data.message);
  const conditions = obj(data.conditions);
  const cardIds = ids(content.cardIds, MAX_CARDS);
  return {
    name: str(data.name, 120) || untitledSubscription(),
    analysisId: isValidId(data.analysisId) ? data.analysisId.toLowerCase() : '',
    content: content.mode === 'cards' && cardIds.length ? { mode: 'cards', cardIds } : { mode: 'all', cardIds: [] },
    ...(isValidId(data.viewId) ? { viewId: data.viewId.toLowerCase() } : {}),
    schedule: sanitizeSubSchedule(data.schedule),
    timezone: sanitizeTimeZone(data.timezone),
    channelIds: ids(data.channelIds, MAX_CHANNELS),
    message: { title: str(message.title, 150), note: str(message.note, 1000), includeLink: message.includeLink !== false },
    conditions: { skipUnchanged: conditions.skipUnchanged === true, onlyWhenRefreshed: conditions.onlyWhenRefreshed === true },
    enabled: data.enabled !== false,
  };
}

/** A parsed record → a well-formed Subscription. `projectId` is the CALLER's, so a record cannot re-home itself. */
function normalize(data: Record<string, unknown>, projectId: string): Subscription {
  const createdAt = iso(data.createdAt) ?? new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    ...definitionOf(data),
    owner: str(data.owner, 320).toLowerCase(),
    since: iso(data.since) ?? createdAt,
    run: sanitizeRun(data.run),
    createdAt,
    updatedAt: iso(data.updatedAt) ?? createdAt,
    schemaVersion: 1,
  };
}

function dir(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'subscriptions');
}

const file = (projectId: string, id: string): string => path.join(dir(projectId), id + '.json');

// Atomic JSON write: temp sibling then rename (the per-write UUID keeps two overlapping writes apart).
async function write(s: Subscription): Promise<void> {
  await fs.promises.mkdir(dir(s.projectId), { recursive: true });
  const target = file(s.projectId, s.id);
  const tmp = target + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await recordFs.rename(tmp, target);
}

export async function getSubscription(projectId: string, id: string): Promise<Subscription | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await recordFs.readFile(file(projectId, id), 'utf8'));
    return data && typeof data.id === 'string' && data.id ? normalize(data, projectId) : null;
  } catch {
    return null; // missing or corrupt: skipped, never fatal
  }
}

/** A project's subscriptions, newest first. */
export async function listSubscriptions(projectId: string): Promise<Subscription[]> {
  if (!isValidId(projectId)) return [];
  let names: recordFs.Dirent[];
  try {
    names = await recordFs.readdir(dir(projectId), { withFileTypes: true });
  } catch {
    return []; // no subscriptions yet
  }
  const out: Subscription[] = [];
  for (const d of names) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const s = await getSubscription(projectId, d.name.slice(0, -5));
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createSubscription(projectId: string, input: SubscriptionInput, owner: string, now = new Date()): Promise<Subscription | null> {
  if (!isValidId(projectId)) return null;
  const at = now.toISOString();
  const s = normalize({ ...input, id: randomUUID(), owner, since: at, createdAt: at, updatedAt: at }, projectId);
  await write(s);
  return s;
}

/**
 * Replace a subscription's definition. `run` and the owner are kept; `since`
 * moves to now when the schedule changed or it was switched on, so an edit
 * never fires for a slot that passed under the old schedule. `owner` is given
 * only when the stored owner can no longer run it (the caller takes it over).
 */
export async function updateSubscription(projectId: string, id: string, input: SubscriptionInput, opts: { owner?: string; now?: Date } = {}): Promise<Subscription | null> {
  const cur = await getSubscription(projectId, id);
  if (!cur) return null;
  const at = (opts.now ?? new Date()).toISOString();
  const { viewId: _was, ...kept } = cur; // a cleared view must not survive the merge
  const next: Subscription = { ...kept, ...definitionOf({ ...cur, ...input }), updatedAt: at };
  if (opts.owner) next.owner = opts.owner.toLowerCase();
  const rescheduled = JSON.stringify([next.schedule, next.timezone]) !== JSON.stringify([cur.schedule, cur.timezone]);
  if (rescheduled || (next.enabled && !cur.enabled)) next.since = at;
  // Switching it back on is the owner's answer to a pause: the count starts over.
  if (next.enabled && (!cur.enabled || cur.run.paused)) next.run = { ...cur.run, failures: 0, paused: undefined };
  await write(next);
  return next;
}

/** The server's half: replace `run` (history capped), and switch off when a run says so. */
export async function stampRun(projectId: string, id: string, change: (run: RunState) => RunState, disable = false): Promise<Subscription | null> {
  const cur = await getSubscription(projectId, id);
  if (!cur) return null;
  const run = change(cur.run);
  const next: Subscription = { ...cur, run: { ...run, history: run.history.slice(0, MAX_HISTORY) }, ...(disable ? { enabled: false } : {}) };
  await write(next);
  return next;
}

export async function deleteSubscription(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(file(projectId, id), { force: true });
    return true;
  } catch {
    return false;
  }
}
