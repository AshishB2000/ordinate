// A semantic dataset's layer block (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D11, D13) —
// PURE.
//
// A semantic dataset is a Live dataset whose questions a company's semantic layer answers (Snowflake semantic views,
// Cube, dbt). Its record holds no table and no SQL (origin `{ kind: 'connection', connId }`); the block below names
// the layer's model and what the last sync read from it. It sits at the record's TOP LEVEL, beside `baseFilters`, so
// no writer that rebuilds `raw.live` can erase it, and `applyLive` reads it into `live.semantic` in memory only.
// A block this pod cannot read in full is `live.semanticUnreadable`: every door refuses (as 08a does for base filters).

import type { DateGrain } from '../analysis/categoryKey';
import { DATE_GRAINS } from '../analysis/categoryKey';
import type { SemanticBackendId } from '../connectors/types';

export interface SemanticSettings {
  backend: SemanticBackendId;
  /** The layer's model (a view, a cube, a saved query). Never in a reply. */
  model: string;
  /** The layer's metrics as last synced; `additive`: the layer says plain sum or count. */
  metrics: Array<{ name: string; additive: boolean; description?: string }>;
  /** The grains the layer lists per date dimension. */
  grains: Array<{ column: string; grains: DateGrain[] }>;
  syncedAt: string;
}

export const MAX_SEMANTIC_METRICS = 2000;
const MAX_NAME = 512;
const MAX_DESCRIPTION = 2000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BACKEND = /^[a-z][a-z0-9-]{0,31}$/; // externalMetric's LAYER_ID

/** A layer member's name as a block stores it: 1–512 characters, no control character. */
export const isLayerName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME && !CONTROL.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The block when every part of `raw` reads, else null (the caller marks it unreadable). Idempotent. */
export function sanitizeSemantic(raw: unknown): SemanticSettings | null {
  if (!isObj(raw) || typeof raw.backend !== 'string' || !BACKEND.test(raw.backend) || !isLayerName(raw.model)) return null;
  if (typeof raw.syncedAt !== 'string' || !Number.isFinite(Date.parse(raw.syncedAt))) return null;
  if (!Array.isArray(raw.metrics) || raw.metrics.length > MAX_SEMANTIC_METRICS || !Array.isArray(raw.grains) || raw.grains.length > MAX_SEMANTIC_METRICS) return null;
  const metrics: SemanticSettings['metrics'] = [];
  for (const m of raw.metrics) {
    if (!isObj(m) || !isLayerName(m.name) || typeof m.additive !== 'boolean') return null;
    if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > MAX_DESCRIPTION)) return null;
    metrics.push(m.description === undefined ? { name: m.name, additive: m.additive } : { name: m.name, additive: m.additive, description: m.description });
  }
  const grains: SemanticSettings['grains'] = [];
  for (const g of raw.grains) {
    if (!isObj(g) || !isLayerName(g.column) || !Array.isArray(g.grains) || !g.grains.every((x) => (DATE_GRAINS as readonly unknown[]).includes(x))) return null;
    grains.push({ column: g.column, grains: g.grains.slice() as DateGrain[] });
  }
  return { backend: raw.backend, model: raw.model, metrics, grains, syncedAt: raw.syncedAt };
}
