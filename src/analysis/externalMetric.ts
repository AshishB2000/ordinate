// A metric defined in another tool's semantic layer (semantic layer part 7, b0: the READER release).
//
// A later release (b2's layer sync) writes `definition: { external, additive?, layer? }`, and f1's dbt import writes
// `importedFrom`. A pod of THIS release keeps both verbatim through every read and re-save, and refuses every figure
// that would need such a metric with a typed sentence: it holds a NAME, not math, and only the layer can answer it.
// This file is PURE (the type, its whitelist, the refusal); ./metrics imports from here, never the other way round.

import * as msg from './externalMetricMessages';
import { tagRefusals } from '../data/refusalTag';
import { knownLayerLabel, layerLabel } from '../engine/live/semantic/semanticRefusals';

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
/** The sentences this process raised lately, with their reason: a handler that caught one into `{ok:false, error}` is typed by it. */
const recent = new Map<string, ExternalReason>();
const RECENT_MAX = 256;

/** `pending`: this pod cannot ask the layer (b0). `layer`: a path that never asks one, of a layer this pod knows by name (b3). */
export type ExternalReason = 'pending' | 'layer';

/** A figure that needs an external metric: the route answers it 409 `external_metric`. Never caught into a null figure. */
export class ExternalMetricError extends Error {
  readonly code = EXTERNAL_CODE;
  readonly reason: ExternalReason;
  readonly metric: string;
  /** `layer`: the layer's product name, for reason `layer`. */
  constructor(reason: ExternalReason, metric: string, layer = '') {
    super(reason === 'layer' ? msg.externalOnLayer(metric, layer) : msg.externalPending(metric));
    this.name = 'ExternalMetricError';
    this.reason = reason;
    this.metric = metric;
    raised++;
    recent.delete(this.message);
    recent.set(this.message, reason);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  }
}

/**
 * The refusal on a path that never asks a layer (key drivers, a scenario, the rows behind a figure, a metric tree's
 * split, a pivot): naming the layer when this pod knows its backend, else b0's sentence (part 5 step 09's split).
 */
export function noRowsError(m: { name: string; definition: unknown }): ExternalMetricError {
  const id = isExternalDefinition(m.definition) ? m.definition.layer : undefined;
  const label = id ? knownLayerLabel(id) : null;
  return label ? new ExternalMetricError('layer', m.name, label) : new ExternalMetricError('pending', m.name);
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
  return tagRefusals(reply, recent, EXTERNAL_CODE, depth);
}

/** Throw the refusal when `m` is an external metric: the second line of defence at an engine that would read its column. */
export function refuseExternal(m: { name: string; definition: unknown }): void {
  if (isExternalDefinition(m.definition)) throw new ExternalMetricError('pending', m.name);
}

/** A Metrics-table row's words for a layer's metric (b3): the layer by name, and the door's sentence when it has no figure. */
export function layerRowWords(definition: unknown, value: Record<string, unknown> | null | undefined): { layer?: string; refused?: { code: string; reason?: string; error: string } } {
  if (!isExternalDefinition(definition)) return {};
  const refused = value && value.ok === false && typeof value.error === 'string' ? { code: String(value.code ?? ''), ...(typeof value.reason === 'string' ? { reason: value.reason } : {}), error: value.error } : null;
  return { layer: layerLabel(definition.layer ?? ''), ...(refused ? { refused } : {}) };
}
