// A metric defined in another tool's semantic layer (semantic layer part 7, b0: the READER release).
//
// A later release (b2's layer sync) writes `definition: { external, additive?, layer? }`, and f1's dbt import writes
// `importedFrom`. A pod of THIS release keeps both verbatim through every read and re-save, and refuses every figure
// that would need such a metric with a typed sentence: it holds a NAME, not math, and only the layer can answer it.
// This file is PURE (the type, its whitelist, the refusal); ./metrics imports from here, never the other way round.

import * as msg from './externalMetricMessages';
import { tagRefusals } from '../data/refusalTag';

/** The layer's own metric, by its name there. `additive` is the layer saying plain sum or count; `layer` its backend id. */
export interface MetricExternalDefinition {
  external: string;
  additive?: true;
  layer?: string;
}

/** Where an imported metric came from, so a re-import updates it (f1). */
export interface MetricImportedFrom {
  kind: 'dbt';
  name: string;
}

const MAX_NAME = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LAYER_ID = /^[a-z][a-z0-9-]{0,31}$/;

const isName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME && !CONTROL.test(v);

export function isExternalDefinition(d: unknown): d is MetricExternalDefinition {
  return !!d && typeof d === 'object' && typeof (d as { external?: unknown }).external === 'string';
}

/** The external definition when `raw` carries a well-formed one, else null (the caller reads the other kinds). Idempotent. */
export function sanitizeExternal(raw: unknown): MetricExternalDefinition | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || !isName(o.external)) return null;
  const out: MetricExternalDefinition = { external: o.external };
  if (o.additive === true) out.additive = true;
  if (typeof o.layer === 'string' && LAYER_ID.test(o.layer)) out.layer = o.layer;
  return out;
}

export function sanitizeImportedFrom(raw: unknown): MetricImportedFrom | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return o && o.kind === 'dbt' && isName(o.name) ? { kind: 'dbt', name: o.name } : undefined;
}

// ── The refusal ──────────────────────────────────────────────────────────────

export const EXTERNAL_CODE = 'external_metric';

let raised = 0;
/** The sentences this process raised lately: a handler that caught one into `{ok:false, error}` is typed by it. */
const recent = new Set<string>();
const RECENT_MAX = 256;

/** A figure that needs an external metric: the route answers it 409 `external_metric`. Never caught into a null figure. */
export class ExternalMetricError extends Error {
  readonly code = EXTERNAL_CODE;
  readonly reason: 'pending';
  readonly metric: string;
  constructor(reason: 'pending', metric: string) {
    super(msg.externalPending(metric));
    this.name = 'ExternalMetricError';
    this.reason = reason;
    this.metric = metric;
    raised++;
    recent.delete(this.message);
    recent.add(this.message);
    if (recent.size > RECENT_MAX) recent.delete(recent.values().next().value as string);
  }
}

/** True for an ExternalMetricError — by class, or by name and code when it crossed a module copy. */
export function isExternalMetricError(err: unknown): err is ExternalMetricError {
  if (err instanceof ExternalMetricError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'ExternalMetricError' && e.code === EXTERNAL_CODE;
}

/** The refusal as a reply, for a door whose contract answers `{ok:false, error}`. */
export function externalRefusal(err: ExternalMetricError): { ok: false; code: typeof EXTERNAL_CODE; reason: string; error: string } {
  return { ok: false, code: EXTERNAL_CODE, reason: err.reason, error: err.message };
}

/** How many refusals this process has raised — the route walks a reply for them only when this moved. */
export function externalRaised(): number {
  return raised;
}

/** Type the refusals a handler caught (../data/refusalTag): an `{ok:false}` carrying one's sentence gets the code. Mutates and returns. */
export function tagExternalRefusals<T>(reply: T, depth = 3): T {
  return tagRefusals(reply, new Map([...recent].map((s) => [s, 'pending'])), EXTERNAL_CODE, depth);
}

/** Throw the refusal when `m` is an external metric: the second line of defence at an engine that would read its column. */
export function refuseExternal(m: { name: string; definition: unknown }): void {
  if (isExternalDefinition(m.definition)) throw new ExternalMetricError('pending', m.name);
}
