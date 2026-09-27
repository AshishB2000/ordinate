// The three MASK steps of the prepare pipeline — MAIN PROCESS, PURE.
//
//   mask_hash        every value → a short token, HMAC-SHA256 under the
//                    project's salt. Deterministic per project, so the same
//                    email is the same token in every row and every dataset of
//                    the project: joins, counts and group-bys still work.
//   mask_redact      keep the last N characters: 4111 1111 1111 1234 → •••1234.
//   mask_generalize  keep the shape, lose the detail: a number to the floor of
//                    its bucket, a date to its month, an email to its domain.
//
// They are ordinary steps (transforms.dispatch calls applyMaskStep), so they
// are reversible the ordinary way: the source keeps the raw values and removing
// the step recomputes from it. sqlGen refuses them (it has no HMAC and no salt),
// so the resident pipeline falls back to the fold and never stores a derived
// table UNmasked.
//
// THE SALT is passed in, never read here: this module stays pure and sync, and
// the salt stays in main (src/app/privacyStore.ts reads it from the project
// folder). A hash step with no salt is SKIPPED with a warning — hashing with a
// missing or empty key would produce tokens anyone could reproduce from a list
// of likely emails, which is not masking.
//
// Empty cells stay empty: "no value" reveals nothing, and keeping it means
// isEmptyCell, fill_empty and completeness read a masked column the way they
// read the original. (The output is retyped like any derived column, and that
// shared rule stores an empty text cell as null.)

import { createHmac } from 'crypto';
import type { Cell, TableData } from './transforms';
import { colIndex, isEmptyCell, retypeColumn } from './transforms';

export const MASK_STEP_TYPES: readonly string[] = ['mask_hash', 'mask_redact', 'mask_generalize'];

export interface MaskHashStep {
  type: 'mask_hash';
  column: string;
}
export interface MaskRedactStep {
  type: 'mask_redact';
  column: string;
  /** Trailing characters left visible. 0–8, default 4. */
  keep?: number;
}
export type GeneralizeMode = 'bucket' | 'month' | 'domain';
export interface MaskGeneralizeStep {
  type: 'mask_generalize';
  column: string;
  mode: GeneralizeMode;
  /** Bucket width for `bucket`. Positive, default 10. */
  size?: number;
}
export type MaskStep = MaskHashStep | MaskRedactStep | MaskGeneralizeStep;

/** What an applyPipeline caller may hand the pure fold beyond the steps. */
export interface PipelineCtx {
  /** The project's masking key (privacyStore.getSalt). Absent → hash steps skip. */
  salt?: string;
}

export const DEFAULT_KEEP = 4;
export const DEFAULT_BUCKET = 10;
const MODES: ReadonlySet<string> = new Set(['bucket', 'month', 'domain']);
export const REDACT_MARK = '•••';

export function isMaskStep(s: unknown): s is MaskStep {
  return !!s && typeof s === 'object' && MASK_STEP_TYPES.includes(String((s as { type?: unknown }).type));
}

/**
 * The token for one value: '#' + 12 hex characters of HMAC-SHA256(salt, value).
 * 48 bits — a million distinct values collide with probability ~0.2%, and the
 * '#' keeps a token that happens to be all digits from ever typing as a number.
 */
export function maskToken(salt: string, value: string): string {
  return '#' + createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 12);
}

export function redactValue(value: string, keep: number): string {
  // A value no longer than what would be kept is hidden whole — showing all of
  // a short value is not redacting it.
  return keep > 0 && value.length > keep ? REDACT_MARK + value.slice(-keep) : REDACT_MARK;
}

/**
 * Floor to the bucket. Both sides are rounded to 12 significant digits: 0.7 /
 * 0.1 is 6.999999999999999 in a double (so a plain floor puts 0.7 in the 0.6
 * bucket), and 3 * 0.1 prints as 0.30000000000000004.
 */
export function bucketFloor(v: number, size: number): number {
  return Number((Math.floor(Number((v / size).toPrecision(12))) * size).toPrecision(12));
}

/** 'YYYY-MM' for an ISO, US or otherwise Date-parseable value; null when it is not a date. */
export function monthOf(value: string): string | null {
  const s = value.trim();
  const pad = (m: number): string => String(m).padStart(2, '0');
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?(?:[T ].*)?$/.exec(s);
  if (iso) {
    const m = Number(iso[2]);
    return m >= 1 && m <= 12 ? `${iso[1]}-${pad(m)}` : null;
  }
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (us) {
    const m = Number(us[1]);
    return m >= 1 && m <= 12 ? `${us[3]}-${pad(m)}` : null;
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return null; // a bare number is not a date
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** '@example.com' for an email; null for anything else. */
export function emailDomain(value: string): string | null {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(value.trim());
  return m ? '@' + m[1].toLowerCase() : null;
}

interface MaskResult {
  table: TableData;
  warnings: string[];
}

const STEP_LABEL: Record<MaskStep['type'], string> = {
  mask_hash: 'Hash',
  mask_redact: 'Redact',
  mask_generalize: 'Generalise',
};

/** Apply one mask step. Pure: builds a new table, never mutates `t`. */
export function applyMaskStep(t: TableData, s: MaskStep, ctx: PipelineCtx = {}): MaskResult {
  const label = STEP_LABEL[s.type] || 'Mask';
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return { table: t, warnings: [`${label} skipped: unknown column "${s.column}"`] };

  let fn: (cell: Cell) => Cell;
  let cleared = 0;
  const warnings: string[] = [];

  if (s.type === 'mask_hash') {
    const salt = ctx.salt;
    if (typeof salt !== 'string' || salt.length < 16) {
      return { table: t, warnings: [`Hash skipped on "${s.column}": this project's masking key is not available`] };
    }
    fn = (cell) => maskToken(salt, String(cell));
  } else if (s.type === 'mask_redact') {
    const keep = sanitizeKeep(s.keep);
    fn = (cell) => redactValue(String(cell), keep);
  } else {
    const mode: GeneralizeMode = MODES.has(s.mode) ? s.mode : 'bucket';
    if (mode === 'bucket') {
      if (t.columns[ci].type !== 'number') {
        return { table: t, warnings: [`Generalise skipped: "${s.column}" is not a number column`] };
      }
      const size = sanitizeSize(s.size);
      fn = (cell) => {
        if (typeof cell === 'number' && Number.isFinite(cell)) return bucketFloor(cell, size);
        cleared += 1; // a non-number in a number column: clearing it is the only safe answer
        return null;
      };
    } else {
      const pick = mode === 'month' ? monthOf : emailDomain;
      fn = (cell) => {
        const out = pick(String(cell));
        if (out === null) cleared += 1;
        return out;
      };
    }
  }

  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => {
    const out = r.slice();
    if (!isEmptyCell(out[ci])) out[ci] = fn(out[ci]);
    return out;
  });
  retypeColumn(columns, rows, ci);
  if (cleared > 0 && s.type === 'mask_generalize') {
    const what = s.mode === 'month' ? 'a date' : s.mode === 'domain' ? 'an email address' : 'a number';
    warnings.push(`Generalise cleared ${cleared} value${cleared === 1 ? '' : 's'} in "${s.column}" that ${cleared === 1 ? 'was' : 'were'} not ${what}`);
  }
  return { table: { columns, rows }, warnings };
}

function sanitizeKeep(raw: unknown): number {
  const n = raw == null || raw === '' ? NaN : Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : DEFAULT_KEEP;
}

function sanitizeSize(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUCKET;
}

/** Whitelist a mask step from untrusted renderer input. null = drop it. */
export function sanitizeMaskStep(o: Record<string, unknown>): MaskStep | null {
  const column = typeof o.column === 'string' ? o.column : undefined;
  if (column === undefined) return null;
  switch (o.type) {
    case 'mask_hash':
      return { type: 'mask_hash', column };
    case 'mask_redact':
      return { type: 'mask_redact', column, keep: sanitizeKeep(o.keep) };
    case 'mask_generalize': {
      if (typeof o.mode !== 'string' || !MODES.has(o.mode)) return null;
      const step: MaskGeneralizeStep = { type: 'mask_generalize', column, mode: o.mode as GeneralizeMode };
      if (o.mode === 'bucket') step.size = sanitizeSize(o.size);
      return step;
    }
    default:
      return null;
  }
}

/**
 * The derived-table columns a pipeline has masked, following later renames and
 * drops. The share policy leaves these alone — they already are what leaves.
 */
export function maskedColumns(steps: unknown): Set<string> {
  const out = new Set<string>();
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (isMaskStep(o)) out.add(o.column);
    else if (o.type === 'rename_column' && typeof o.from === 'string' && out.delete(o.from) && typeof o.to === 'string') out.add(o.to.trim());
    else if (o.type === 'drop_column' && typeof o.column === 'string') out.delete(o.column);
  }
  return out;
}
