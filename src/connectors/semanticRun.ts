// One semantic-layer question, run on its connector — MAIN PROCESS ONLY (semantic layer part 7, b1;
// docs/semantic-layer/07-portability.md D18). The twin of ./liveRun's `runLiveBound`, sharing its seams
// (`boundCall`): the per-call context, the SSRF guard and host pin (`guardHost`), costTag 'live', the row cap
// (LIVE_ROW_LIMIT), LIVE_QUERY_TIMEOUT_MS + the caller's signal, and `safeError` with the secrets on every way out.
//
// Called from src/engine/live/liveWarehouse.ts `warehouse()` and nowhere else (test-liveUsage), and it is the
// only caller of a connector's `semantic.run`: so a layer's question is slotted, counted and timed out exactly
// as a statement is.

import type { ConnectorDef, ConnectorError, ConnectorRows } from './types';
import type { LiveRunOpts } from './liveRun';
import { boundCall } from './liveRun';

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
