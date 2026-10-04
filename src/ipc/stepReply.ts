// What a step-mutating channel hands a BROWSER (T2.6). On the desktop the reply
// is the whole record — the prepared rows, the immutable source and the origin
// — because the renderer once painted `preview.rows` straight into its table.
// On the server that is a 1M-row structure through JSON, and the origin can
// hold a file path, a URL with a key in it or a SQL statement (the reason
// `dataset:meta` has no contract). The web grid pages the stored table
// itself, so the server replies with the pipeline's shape only.
//
// One function, applied where a commitSteps reply leaves a handler, so the
// in-process callers (the composer's scan, the plan runner) keep the full one.

import { serverDataDir } from '../server/context';

type Reply = { ok?: boolean; dataset?: Record<string, unknown>; preview?: Record<string, unknown> } & Record<string, unknown>;

/** The reply as the caller may see it: unchanged on the desktop, rows- and origin-free on the server. */
export function forClient<T>(res: T): T {
  if (serverDataDir() === null || !res || typeof res !== 'object') return res;
  const r = res as unknown as Reply;
  if (!r.dataset && !r.preview) return res;
  const out: Record<string, unknown> = { ...r };
  if (r.dataset) {
    const d = r.dataset;
    out.dataset = { id: d.id, name: d.name, columns: d.columns, rowCount: d.rowCount, steps: d.steps, stepCounts: d.stepCounts, updatedAt: d.updatedAt };
  }
  if (r.preview) {
    const p = r.preview;
    out.preview = { columns: p.columns, rowCount: p.rowCount, warnings: p.warnings, stepCounts: p.stepCounts };
  }
  return out as T;
}
