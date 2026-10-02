// The `.ordinate-template` file, and the whitelist every user template passes
// through on its way in — from disk, from a bundle, from a file someone sent.
// MAIN PROCESS, PURE.
//
// A TRUST BOUNDARY, like dashboardExport.sanitizeBundle: a template is a file
// from somewhere else. What survives is plain data only — strings, finite
// numbers, booleans, null, arrays and plain objects, `{ $ref }` refs of the
// one shape capture writes, and a `data:image/png` thumbnail. No other `data:`
// URL, no prototype keys, bounded depth, size and count. Everything the body
// becomes is then sanitized AGAIN by the record it turns into (saveAnalysis,
// saveVisual, saveMetric, updateSteps), so this is the outer wall, not the only
// one.

import type { RoleKind, TemplateRole } from './templateRoles';
import { TEMPLATE_FORMAT, TEMPLATE_VERSION, type TemplateBody, type UserTemplate } from './userTemplate';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_ID = /^(ds|[rcmv]\d{1,4})$/;
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const KINDS: ReadonlySet<string> = new Set(['date', 'measure', 'dimension', 'id', 'geo']);
const BAD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_THUMB = 3 * 1024 * 1024;
const MAX_STR = 20_000;
const MAX_KEY = 100;
const MAX_DEPTH = 24;
const MAX_NODES = 100_000;
const MAX_ROLES = 100;
const MAX_HINTS = 20;

/** Plain JSON, clamped. Returns undefined for anything that is not allowed. */
function clean(v: unknown, depth: number, budget: { n: number }): unknown {
  if ((budget.n -= 1) < 0 || depth > MAX_DEPTH) return undefined;
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.length > MAX_STR || /^\s*data:/i.test(v) ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1, budget)).filter((x) => x !== undefined);
  if (typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return undefined;
  const o = v as Record<string, unknown>;
  if ('$ref' in o) {
    return typeof o.$ref === 'string' && REF_ID.test(o.$ref) && Object.keys(o).length === 1 ? { $ref: o.$ref } : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (BAD_KEYS.has(k) || k.length > MAX_KEY) continue;
    const x = clean(o[k], depth + 1, budget);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const objOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function cleanRole(raw: unknown): TemplateRole | null {
  const o = objOf(raw);
  if (typeof o.id !== 'string' || !/^r\d{1,4}$/.test(o.id)) return null;
  const kind = typeof o.kind === 'string' && KINDS.has(o.kind) ? (o.kind as RoleKind) : 'dimension';
  const hints = arr(o.hints).filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    .map((h) => h.trim().toLowerCase().slice(0, 40)).slice(0, MAX_HINTS);
  return { id: o.id, label: str(o.label, 80).trim() || o.id, kind, required: o.required !== false, hints };
}

function cleanBody(raw: unknown): TemplateBody {
  const budget = { n: MAX_NODES };
  const b = objOf(raw);
  const list = (v: unknown): unknown[] => (clean(arr(v), 0, budget) as unknown[]) || [];
  const refd = <T>(v: unknown, re: RegExp, make: (o: Record<string, unknown>, ref: string) => T | null): T[] =>
    arr(v).map((x) => {
      const o = objOf(x);
      return typeof o.ref === 'string' && re.test(o.ref) ? make(o, o.ref) : null;
    }).filter((x): x is T => x !== null);
  return {
    sheets: list(b.sheets),
    filters: list(b.filters),
    style: clean(objOf(b.style), 0, budget) || {},
    parameters: list(b.parameters),
    visuals: refd(b.visuals, /^v\d{1,4}$/, (o, ref) => ({ ref, spec: objOf(clean(objOf(o.spec), 0, budget)) })),
    calcFields: refd(b.calcFields, /^c\d{1,4}$/, (o, ref) => {
      const name = str(o.name, 200).trim();
      return name && typeof o.expression === 'string' ? { ref, name, expression: str(o.expression, 4000) } : null;
    }),
    metrics: refd(b.metrics, /^m\d{1,4}$/, (o, ref) => {
      const name = str(o.name, 200).trim();
      return name ? { ref, name, spec: objOf(clean(objOf(o.spec), 0, budget)) } : null;
    }),
  };
}

/**
 * Whitelist one template. `newId` replaces a missing or malformed id; a valid
 * one is kept, which is what lets imports merge BY ID.
 */
export function sanitizeUserTemplate(raw: unknown, newId: () => string): UserTemplate | null {
  const o = objOf(raw);
  const name = str(o.name, 120).trim();
  if (!name) return null;
  const roles = arr(o.roles).map(cleanRole).filter((r): r is TemplateRole => !!r).slice(0, MAX_ROLES);
  const thumb = typeof o.thumbnail === 'string' && o.thumbnail.length <= MAX_THUMB && PNG_RE.test(o.thumbnail) ? o.thumbnail : '';
  const t: UserTemplate = {
    id: typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id.toLowerCase() : newId(),
    name,
    description: str(o.description, 500),
    createdAt: typeof o.createdAt === 'string' && !Number.isNaN(Date.parse(o.createdAt)) ? o.createdAt : new Date().toISOString(),
    roles,
    body: cleanBody(o.body),
    thumbnail: thumb,
  };
  if (typeof o.sourceAnalysisId === 'string' && UUID_RE.test(o.sourceAnalysisId)) t.sourceAnalysisId = o.sourceAnalysisId;
  return t;
}

/** The `.ordinate-template` file for one template. */
export function toTemplateFile(t: UserTemplate): string {
  const { sourceAnalysisId: _local, ...shared } = t; // a dashboard id means nothing on another machine
  return JSON.stringify({ format: TEMPLATE_FORMAT, formatVersion: TEMPLATE_VERSION, exportedAt: new Date().toISOString(), template: shared }, null, 2);
}

/** Read a `.ordinate-template` file. Refuses anything that is not one, whole. */
export function fromTemplateFile(text: string, newId: () => string): { ok: true; template: UserTemplate } | { ok: false; error: string } {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) return { ok: false, error: 'That file is too large to be a template.' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (_) { return { ok: false, error: 'That file is not an Ordinate template.' }; }
  const o = objOf(raw);
  if (o.format !== TEMPLATE_FORMAT) return { ok: false, error: 'That file is not an Ordinate template.' };
  if (o.formatVersion !== TEMPLATE_VERSION) return { ok: false, error: 'That template is from a newer version of Ordinate.' };
  const t = sanitizeUserTemplate(o.template, newId);
  if (!t) return { ok: false, error: 'That template has no name — it was refused.' };
  return { ok: true, template: t };
}
