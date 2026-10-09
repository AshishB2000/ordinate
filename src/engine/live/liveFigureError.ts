// A Live figure the warehouse could not give (docs/live-data/00-plan.md L2.4) —
// MAIN PROCESS ONLY. Its own file so the RPC route (src/server/app.ts) can type
// an uncaught one without importing the doors (src/ipc/liveRoute.ts).
//
// Thrown by the KPI door (`computeCardMetric` → liveRoute.liveCardMetric), not
// returned: every caller of `computeCardMetric` reads `ok: false` as "the
// dataset is gone" and shows a blank, where a Live failure must be said (D6).
// A handler's catch keeps its type with `liveCodeOf`; one that escapes is
// answered by the route as a typed 409, as `LiveDatasetError` is.

import type { LiveFailure } from './liveQuery';

export class LiveFigureError extends Error {
  readonly failure: LiveFailure;
  constructor(failure: LiveFailure) {
    super(failure.error);
    this.name = 'LiveFigureError';
    this.failure = failure;
  }
}

/** True for a LiveFigureError — by class, or by name and failure when it crossed a module copy. */
export function isLiveFigureError(err: unknown): err is LiveFigureError {
  if (err instanceof LiveFigureError) return true;
  const e = err as { name?: unknown; failure?: { ok?: unknown; code?: unknown } } | null;
  return !!e && typeof e === 'object' && e.name === 'LiveFigureError' && !!e.failure && e.failure.ok === false && typeof e.failure.code === 'string';
}

/** The typed half of a Live failure — `{code, reason}` — to spread onto a handler's `{ok:false, error}`. */
export function liveCodeOf(err: unknown): { code?: LiveFailure['code']; reason?: string } {
  if (!isLiveFigureError(err)) return {};
  const f = err.failure;
  return f.reason ? { code: f.code, reason: f.reason } : { code: f.code };
}
