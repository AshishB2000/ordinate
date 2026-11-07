// A semantic layer's models, and "Add as dataset" (semantic layer part 7, b2; docs/semantic-layer/07-portability.md
// D11, D14) — server, MAIN ONLY. Contracts in src/api/semantic.ts, both `write`.
//
//   connection:semanticModels      the layer's models (name, label, description), read through the connector's
//                                  catalog (connectors/semanticRun: the SSRF guard, `safeError`; not counted)
//   connection:addSemanticDataset  describes the model, saves a Live record whose origin names only the connection
//                                  (data/liveRecord `saveSemanticRecord`) and queues its first schema sync, which
//                                  writes the mirror metrics (engine/live/semantic/semanticSync)
//
// The layer's own words, the model name and the connection's values never reach a dataset reply: they go to the
// server log through `safeError` (R-L6). The listing names models on purpose: it answers only a caller who may add one.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { describeSemanticModel, listSemanticModels } from '../connectors/semanticRun';
import type { ConnectorDef } from '../connectors/types';
import { safeError } from '../connectors/types';
import { loadSecrets } from './connectionSecrets';
import { saveSemanticRecord } from '../data/liveRecord';
import { parseMaxCacheAge } from '../data/liveDataset';
import { isLayerName } from '../data/semanticDataset';
import * as msg from '../data/liveMessages';
import * as smsg from '../engine/semanticMessages';
import { readModel } from '../engine/live/semantic/semanticSync';
import { layerLabel } from '../engine/live/semantic/semanticRefusals';
import { timeoutMs } from '../engine/live/liveWarehouse';
import { ctx } from '../server/context';
import { logger } from '../app/logger';

type Fail = { ok: false; error: string };
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const MAX_MODELS = 2000;

/** The connection's layer: its connector, values and secrets — or the sentence saying it has none. */
async function layerOf(projectId: string, connId: string): Promise<{ ok: true; def: ConnectorDef; name: string; values: Record<string, unknown>; secrets: Record<string, string> } | Fail> {
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: msg.liveConnectionGoneMessage() };
  const def = getConnector(conn.connectorId);
  if (!def || !def.semantic) return { ok: false, error: smsg.noLayer() };
  return { ok: true, def, name: conn.name, values: conn.values, secrets: await loadSecrets(conn.id, def) };
}

const opts = () => ({ signal: ctx().signal ?? new AbortController().signal, timeoutMs: timeoutMs() });

/** `connection:semanticModels`. */
export async function semanticModels(p: Record<string, unknown>) {
  const projectId = str(p.projectId);
  const layer = await layerOf(projectId, str(p.connId));
  if (!layer.ok) return layer;
  const r = await listSemanticModels(layer.def, layer.values, layer.secrets, opts());
  if (!r.ok) {
    logger.warn(`[live] semantic models of connection ${str(p.connId)}: ${r.error}`);
    return { ok: false, error: smsg.layerReadFailed(layerLabel(layer.def.semantic!.backend)) };
  }
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, 2000) : undefined);
  const models = (Array.isArray(r.models) ? r.models : []).filter((m) => m && isLayerName(m.name)).slice(0, MAX_MODELS).map((m) => {
    const label = text(m.label);
    const description = text(m.description);
    return { name: m.name, ...(label ? { label } : {}), ...(description ? { description } : {}) };
  });
  return { ok: true, models };
}

/** Queue the new dataset's first sync (lazy, as ./liveDatasets queueSync: the job reads its target through modules that import this one). */
function queueSync(projectId: string, id: string): void {
  const job = require('../engine/live/schemaSyncJob') as typeof import('../engine/live/schemaSyncJob');
  void job.startSchemaSync(projectId, id).catch(() => undefined);
}

/** `connection:addSemanticDataset`. */
export async function addSemanticDataset(p: Record<string, unknown>) {
  const projectId = str(p.projectId);
  const connId = str(p.connId);
  const model = typeof p.model === 'string' ? p.model : '';
  if (!isLayerName(model)) return { ok: false, error: smsg.noLayer() };
  const maxCacheAgeSec = parseMaxCacheAge(p.maxCacheAgeSec);
  if (maxCacheAgeSec === null) return { ok: false, error: msg.liveCacheAgeRangeMessage() };
  const layer = await layerOf(projectId, connId);
  if (!layer.ok) return layer;
  const backend = layer.def.semantic!.backend;
  const d = await describeSemanticModel(layer.def, layer.values, layer.secrets, model, opts());
  if (!d.ok) {
    logger.warn(`[live] add a semantic dataset from connection ${connId}: describe failed: ${d.error}`);
    return { ok: false, error: smsg.layerReadFailed(layerLabel(backend)) };
  }
  const read = readModel(d, backend, model, new Date().toISOString());
  const ds = await saveSemanticRecord(projectId, { name: str(p.name) || layer.name, connId, semantic: read.semantic, columns: read.columns, maxCacheAgeSec });
  if (!ds) return { ok: false, error: smsg.addNoProject() };
  queueSync(projectId, ds.id);
  return { ok: true, dataset: { id: ds.id, name: ds.name, rowCount: 0, columns: ds.columns.map((c) => ({ name: c.name, type: c.type })), mode: 'live' as const } };
}

export function register(): void {
  ipcMain.handle('connection:semanticModels', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await semanticModels(payload);
    } catch (err: unknown) {
      logger.warn(`[live] semantic models failed: ${safeError(err)}`);
      return { ok: false, error: smsg.noLayer() };
    }
  });
  ipcMain.handle('connection:addSemanticDataset', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await addSemanticDataset(payload);
    } catch (err: unknown) {
      logger.warn(`[live] add a semantic dataset failed: ${safeError(err)}`);
      return { ok: false, error: smsg.addFailed() };
    }
  });
}
