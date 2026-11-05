// One semantic-layer question, run on its connector — MAIN PROCESS ONLY (semantic layer part 7, b1;
// docs/semantic-layer/07-portability.md D18). The twin of ./liveRun's `runLiveBound`, sharing its seams
// (`boundCall`): the per-call context, the SSRF guard and host pin (`guardHost`), costTag 'live', the row cap
// (LIVE_ROW_LIMIT), LIVE_QUERY_TIMEOUT_MS + the caller's signal, and `safeError` with the secrets on every way out.
//
// Called from src/engine/live/liveWarehouse.ts `warehouse()` and nowhere else (test-liveUsage), and it is the
// only caller of a connector's `semantic.run`: so a layer's question is slotted, counted and timed out exactly
// as a statement is.

import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSemantic } from './types';
import { safeError } from './types';
import type { LiveRunOpts } from './liveRun';
import { boundCall, liveContext } from './liveRun';
import { guardHost } from './connectionRun';

/**
 * One encoded question for a layer. `body` is what the backend sends (its encoder's output); `columns` are the
 * layer member names the rows must come back with, in the order the caller reads them.
 */
export interface SemanticRequest {
  kind: 'semantic';
  body: unknown;
  columns: readonly string[];
}

export function isSemanticRequest(q: unknown): q is SemanticRequest {
  return !!q && typeof q === 'object' && (q as { kind?: unknown }).kind === 'semantic';
}

/** Ask the layer behind `def` one question. Every error is redacted. */
export async function runSemanticBound(
  def: ConnectorDef,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  req: SemanticRequest,
  opts: LiveRunOpts,
): Promise<ConnectorRows | ConnectorError> {
  const semantic = def.semantic;
  if (!semantic || typeof semantic.run !== 'function') return { ok: false, error: 'This source cannot answer semantic-layer questions.' };
  return boundCall(def, values, secrets, opts, (ctx) => semantic.run(ctx, req.body));
}

// ── The layer's catalog (part 7 b2) ──────────────────────────────────────────
//
// Listing models and describing one are catalog reads, as `readLiveSchema` is for a warehouse: the same context, the
// SSRF guard and host pin, and `safeError` with the secrets — but no slot and no daily count (no question is asked).

type Listed = Awaited<ReturnType<ConnectorSemantic['listModels']>>;
type Described = Awaited<ReturnType<ConnectorSemantic['describeModel']>>;

async function catalogCall<T extends { ok: true }>(def: ConnectorDef, values: Record<string, unknown>, secrets: Record<string, string>, opts: LiveRunOpts, call: (s: ConnectorSemantic, ctx: ConnectorContext) => Promise<T | ConnectorError>): Promise<T | ConnectorError> {
  const semantic = def.semantic;
  if (!semantic) return { ok: false, error: 'This source cannot answer semantic-layer questions.' };
  const ctx = liveContext(values, secrets, opts);
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const r = await call(semantic, ctx);
    return r.ok ? r : { ok: false, error: safeError(r.error, ctx.secrets) };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/** The layer's models. Every error is redacted. */
export function listSemanticModels(def: ConnectorDef, values: Record<string, unknown>, secrets: Record<string, string>, opts: LiveRunOpts): Promise<Listed> {
  return catalogCall(def, values, secrets, opts, (s, ctx) => s.listModels(ctx));
}

/** One model's dimensions and metrics. Every error is redacted. */
export function describeSemanticModel(def: ConnectorDef, values: Record<string, unknown>, secrets: Record<string, string>, model: string, opts: LiveRunOpts): Promise<Described> {
  return catalogCall(def, values, secrets, opts, (s, ctx) => s.describeModel(ctx, model));
}
