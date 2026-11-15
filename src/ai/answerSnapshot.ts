// An answer turn's SNAPSHOT (docs/assistant/00-design.md, "Answers keep the figures they had") — PURE.
//
// The card as the server computed it when the answer was made, or last refreshed: bars or table, caption,
// bullets, filter labels, the days a relative period resolved to, the time, and a fingerprint of the access it
// was computed under. Kept on the turn (../ai/copilot.ts), so reopening a conversation runs no query.
//
// SERVER ONLY. A turn reaches the browser through ../ipc/answerSnapshots `turnsForBrowser`, which drops this
// field and hands back the stored card only while the fingerprint still matches the caller's access now.
//
// The card is kept wire-encoded (../server/wire `toWire`): a NaN or a -0 in a figure survives the JSON the turn
// is stored as. At most SNAPSHOT_MAX_BYTES of it; a bigger card keeps none and is computed on every open.

import { fromWire, toWire } from '../server/wire';
import { answerPeriod, type AnswerSpec } from './answerSpec';
import { describePeriod, getCalendar } from '../analysis/dateIntel';

export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** A relative period as it resolved when the card was computed: "Yesterday", from and to the same ISO day. */
export interface KeptPeriod {
  name: string;
  from: string;
  to: string;
}

export interface AnswerSnapshot {
  /** The card exactly as the server returned it (../ipc/answers AnswerCard), wire-encoded. */
  card: unknown;
  /** ISO: when it was computed. */
  asOf: string;
  /** ISO: when the answer was first given (the turn's createdAt). A refresh keeps it. */
  firstAsked: string;
  /** sha256 hex of what decided the figures this person may see on the dataset (../ipc/answerSnapshots `accessPrint`). */
  access: string;
  periods: KeptPeriod[];
}

/** What the browser is told about a card's snapshot: never the stored card itself, which only `turnsForBrowser` attaches. */
export interface KeptView {
  /** When the figures were computed; null when the card is too big to keep, so it is computed each time ("Live"). */
  asOf: string | null;
  /** When the answer was first given, only when that was before `asOf` (refreshed, or kept on a later open). */
  firstAsked?: string;
  periods: KeptPeriod[];
  /** The stored figures were not shown: the caller's access changed since, so these are today's. */
  accessChanged?: true;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/** Each relative period of `spec`, resolved now as the card's filters were (`answerPeriod`), with its name. */
export function periodsOf(spec: Pick<AnswerSpec, 'filters'>): KeptPeriod[] {
  const cal = getCalendar();
  const out: KeptPeriod[] = [];
  for (const f of spec.filters) {
    if (!('period' in f)) continue;
    const p = answerPeriod(f, undefined, cal);
    const back = f.yearsBack ? `, ${f.yearsBack === 1 ? 'a year' : `${f.yearsBack} years`} earlier` : '';
    out.push({ name: describePeriod({ preset: f.period, n: f.n }, cal) + back, from: p.from, to: p.to });
  }
  return out;
}

/** The card as it decodes, when it reads as one: an object with `ok: true` and chart data, or an SQL answer's table (./answerSql). */
function decoded(wire: unknown): ({ ok: true; spec?: unknown } & Record<string, unknown>) | null {
  try {
    const c = fromWire(wire) as { ok?: unknown; kind?: unknown; data?: { labels?: unknown; series?: unknown }; columns?: unknown; rows?: unknown } | null;
    const shaped = c && (c.kind === 'sql' ? Array.isArray(c.columns) && Array.isArray(c.rows) : Array.isArray(c.data?.labels) && Array.isArray(c.data?.series));
    return c && typeof c === 'object' && c.ok === true && shaped
      ? (c as { ok: true } & Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sizeOf = (wire: unknown): number => Buffer.byteLength(JSON.stringify(wire));

/** A snapshot of `card`, or null when its JSON is past SNAPSHOT_MAX_BYTES (or it does not encode): that card stays live. */
export function makeSnapshot(card: object, at: { asOf: string; firstAsked: string }, access: string, periods: KeptPeriod[]): AnswerSnapshot | null {
  let wire: unknown;
  try {
    wire = toWire(card);
  } catch {
    return null;
  }
  return sizeOf(wire) <= SNAPSHOT_MAX_BYTES ? { card: wire, asOf: at.asOf, firstAsked: at.firstAsked, access, periods } : null;
}

/** A stored snapshot, re-sanitized on every read and write; anything corrupt or past the cap is dropped (undefined), never fatal. */
export function sanitizeSnapshot(raw: unknown): AnswerSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (!isTime(s.asOf) || !isTime(s.firstAsked) || typeof s.access !== 'string' || !HEX64.test(s.access)) return undefined;
  if (!Array.isArray(s.periods) || s.periods.length > 8) return undefined;
  const periods: KeptPeriod[] = [];
  for (const p of s.periods as Array<Record<string, unknown> | null>) {
    if (!p || typeof p.name !== 'string' || p.name.length > 120 || typeof p.from !== 'string' || !ISO_DAY.test(p.from) || typeof p.to !== 'string' || !ISO_DAY.test(p.to)) return undefined;
    periods.push({ name: p.name, from: p.from, to: p.to });
  }
  let size: number;
  try {
    size = sizeOf(s.card);
  } catch {
    return undefined;
  }
  if (size > SNAPSHOT_MAX_BYTES || !decoded(s.card)) return undefined;
  return { card: s.card, asOf: s.asOf, firstAsked: s.firstAsked, access: s.access, periods };
}

/** The stored card, decoded, or null when it does not read as one. */
export function cardOf(snap: AnswerSnapshot): ({ ok: true } & Record<string, unknown>) | null {
  return decoded(snap.card);
}

/** A minute: an answer kept as it was first given (the ask's own compute and its append) carries no "first asked". */
const SAME_ANSWER_MS = 60_000;

/** What the card says about its snapshot. `snap` null: not kept ("Live"). */
export function keptView(snap: AnswerSnapshot | null, firstAsked: string, periods: KeptPeriod[], accessChanged = false): KeptView {
  const asOf = snap ? snap.asOf : null;
  const later = asOf !== null && Date.parse(asOf) - Date.parse(firstAsked) > SAME_ANSWER_MS;
  return { asOf, ...(later ? { firstAsked } : {}), periods, ...(accessChanged ? { accessChanged: true as const } : {}) };
}
