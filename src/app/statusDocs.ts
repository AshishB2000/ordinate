// What an admin has said about a metric, glossary term or dataset: certified (with the pin the badge
// is checked against) or retired. Kept in catalog.json under `status["<kind>:<id>"]` (catalog.ts).
// A release that cannot write a status still keeps one through every catalog write, and the sanitizer
// is what drops a hand-edited or corrupt entry instead of showing it later as a badge. Never throws.

import { isValidId } from './ids';
import { clip } from './clip';
import { KEY_RE } from './versions';

export const STATUS_KINDS = ['metric', 'term', 'dataset'] as const;
export type StatusKind = typeof STATUS_KINDS[number];

export interface StatusDoc {
  status: 'certified' | 'retired';
  by: string;
  at: string;
  note: string;
  /** Certified only: the pin of everything the figure depends on, sha256 as 43-char base64url. Absent = unreadable. */
  pin?: string;
  /** Certified only: the version the certify event wrote (versions.ts KEY_RE shape). */
  versionKey?: string;
  /** Retired only: a ref of the same kind, never the entry's own. */
  replacedBy?: string;
}

const MAX_BY = 80;
const MAX_AT = 40;
const MAX_NOTE = 500;
const PIN_RE = /^[A-Za-z0-9_-]{43}$/;

/** `${kind}:${uuid}` for a kind a status covers; anything else is null. */
export function parseStatusRef(ref: unknown): { kind: StatusKind; id: string } | null {
  if (typeof ref !== 'string') return null;
  const at = ref.indexOf(':');
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  return at > 0 && (STATUS_KINDS as readonly string[]).includes(kind) && isValidId(id) ? { kind: kind as StatusKind, id } : null;
}

function sanitizeStatusDoc(raw: unknown, ref: { kind: StatusKind; id: string }): StatusDoc | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const doc = { by: clip(r.by, MAX_BY), at: clip(r.at, MAX_AT), note: clip(r.note, MAX_NOTE) };
  if (r.status === 'certified') {
    // An unreadable pin or versionKey (missing, not a string, malformed) drops that one field and keeps the entry,
    // so sanitizing twice gives the same entry. Release B reads a certified entry with no pin as "changed since certified".
    const pin = typeof r.pin === 'string' && PIN_RE.test(r.pin) ? r.pin : undefined;
    const versionKey = typeof r.versionKey === 'string' && KEY_RE.test(r.versionKey) ? r.versionKey : undefined;
    return { status: 'certified', ...doc, ...(pin && { pin }), ...(versionKey && { versionKey }) };
  }
  if (r.status !== 'retired') return null;
  const to = parseStatusRef(r.replacedBy);
  return { status: 'retired', ...doc, ...(to && to.kind === ref.kind && to.id !== ref.id && { replacedBy: r.replacedBy as string }) };
}

/** ref -> doc, for a valid ref and an object doc only. Null-prototype: refs are stored text. */
export function sanitizeStatus(raw: unknown): Record<string, StatusDoc> {
  const out = Object.create(null) as Record<string, StatusDoc>;
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const key of Object.keys(o)) {
    const ref = parseStatusRef(key);
    const doc = ref && sanitizeStatusDoc(o[key], ref);
    if (doc) out[key] = doc;
  }
  return out;
}
