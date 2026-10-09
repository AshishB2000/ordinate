// A Live query's bind parameters, checked once before any dialect spells them
// (docs/live-data/00-plan.md D4) — MAIN PROCESS ONLY.
//
// The compiler (src/engine/live/, L2.2) never inlines a value into SQL text:
// every literal travels beside the statement as a LiveParam, and each
// connector's `runBound` hands it to the warehouse's own binding mechanism
// (Redshift `$n`, Databricks `parameters`, ClickHouse `param_<name>`). This is
// the one gate every connector runs first, so a malformed parameter — a NaN, a
// number typed as text, a timestamp in a local zone — is refused here with one
// message instead of meaning three different things on three warehouses.
//
// Names are the compiler's `p<i>`, in placeholder order, and nothing else: a
// name rides into a URL key on ClickHouse and a JSON key on Databricks, so it
// is whitelisted rather than escaped.

import type { ConnectorError, LiveParam } from './types';

/** More parameters than this is not a filter, it is a data upload. */
export const MAX_LIVE_PARAMS = 1_000;

/** Total characters of parameter text — ClickHouse carries them in the URL. */
export const MAX_LIVE_PARAM_CHARS = 64 * 1024;

const TYPES: ReadonlySet<string> = new Set(['text', 'number', 'boolean', 'date', 'timestamp']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** UTC only (the LiveParam contract): a local offset would mean a different instant per warehouse session. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function bad(i: number, why: string): ConnectorError {
  return { ok: false, error: `Live query parameter ${i + 1} ${why}.` };
}

/**
 * The parameters, validated and copied, or a refusal. `params[i]` must be named
 * `p<i>`, carry one of the five types, and a value of that type (or null).
 */
export function checkParams(params: unknown): LiveParam[] | ConnectorError {
  if (!Array.isArray(params)) return { ok: false, error: 'Live query parameters must be a list.' };
  if (params.length > MAX_LIVE_PARAMS) return { ok: false, error: `A live query takes at most ${MAX_LIVE_PARAMS} parameters.` };
  const out: LiveParam[] = [];
  let chars = 0;
  for (let i = 0; i < params.length; i++) {
    const raw: unknown = params[i];
    if (!raw || typeof raw !== 'object') return bad(i, 'is not a parameter');
    const p = raw as Record<string, unknown>;
    if (p.name !== `p${i}`) return bad(i, `must be named p${i}`);
    if (typeof p.type !== 'string' || !TYPES.has(p.type)) return bad(i, 'has an unknown type');
    const type = p.type as LiveParam['type'];
    const v = p.value;
    if (v === null) {
      out.push({ name: `p${i}`, type, value: null });
      continue;
    }
    if (type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return bad(i, 'is not a finite number');
    if (type === 'boolean' && typeof v !== 'boolean') return bad(i, 'is not true or false');
    if (type === 'text' && typeof v !== 'string') return bad(i, 'is not text');
    if (type === 'date' && !(typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')))) {
      return bad(i, 'is not a YYYY-MM-DD date');
    }
    if (type === 'timestamp' && !(typeof v === 'string' && TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v)))) {
      return bad(i, 'is not a UTC ISO-8601 timestamp');
    }
    chars += String(v).length;
    if (chars > MAX_LIVE_PARAM_CHARS) return { ok: false, error: 'The live query parameters are too long.' };
    out.push({ name: `p${i}`, type, value: v as string | number | boolean });
  }
  return out;
}

export function isParamError(v: LiveParam[] | ConnectorError): v is ConnectorError {
  return !Array.isArray(v);
}

/** `2024-01-02T03:04:05.678Z` → `2024-01-02 03:04:05.678`: the zone-free UTC spelling a warehouse column of a declared UTC type parses. */
export function utcWallClock(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, '');
}
