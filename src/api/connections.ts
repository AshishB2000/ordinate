// Connections (T2.5): the connector catalog, a project's saved connections, and
// the workbench over one of them. Handlers: src/ipc/connections.ts.
//
// Access. Seeing the catalog and the project's connection cards is `read`.
// Everything that USES a connection's stored credential against the source —
// test, tables, describe, sample, run, explain, refresh, import — is `write`:
// it reads the external system directly, beyond the project's datasets, so it
// is authoring, not viewing. Creating, editing, deleting and replacing a
// secret are `write` too.
//
// Bounds. Every statement is still bounded SERVER side (connectionRun's
// buildContext clamps rows to 1,000,000 and the timeout to 30 s whatever a
// caller asks); the limits here only refuse an absurd request at the door.
// Secret values are capped at the store's own 64 KiB; a 400 never echoes one
// (src/server/rpc.ts reports paths and codes only).

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const Key = z.string().min(1).max(64);
const Sql = z.string().max(20_000);
const Table = z.string().max(1_000);
/** At most `n` keys — a form has a dozen fields, not thousands. */
const fewKeys = (n: number) => (o: Record<string, unknown>) => Object.keys(o).length <= n;

const Conn = { projectId: Uuid, connId: Uuid };

export const connections = {
  // preload: invoke('connectors:catalog') — form SHAPE of every source this
  // process offers (no local-file sources on the server). Same for every org.
  'connectors:catalog': rpc({ access: 'read', org: true, input: z.undefined() }),
  // The picker's brand marks — server form of the preload's sync `connector:logos`.
  'connectors:logos': rpc({ access: 'read', org: true, input: z.undefined() }),
  // preload: invoke('connections:list', { projectId }) — public view + `secretSet` booleans.
  'connections:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('connection:testAndSave', …) — the registry vocabulary only
  // ({connectorId, values, secrets}); the desktop's legacy {kind, config, secret} stays desktop.
  'connection:testAndSave': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      connectorId: Key,
      name: z.string().max(200).optional(),
      values: z
        .record(Key, z.union([z.string().max(20_000), z.number(), z.boolean()]))
        .refine(fewKeys(50))
        .optional(),
      secrets: z.record(Key, z.string().max(64 * 1024)).refine(fewKeys(10)).optional(),
      table: Table.optional(),
      query: Sql.optional(),
    }),
    project: byProjectId,
  }),
  'connection:listTables': rpc({ access: 'write', input: z.strictObject(Conn), project: byProjectId }),
  'connection:describe': rpc({ access: 'write', input: z.strictObject({ ...Conn, table: Table }), project: byProjectId }),
  'connection:sample': rpc({
    access: 'write',
    input: z.strictObject({ ...Conn, table: Table, limit: z.number().int().min(1).max(5_000).optional() }),
    project: byProjectId,
  }),
  // A preview (Run) or the import's re-run size. `limit` may only LOWER the server's cap.
  'connection:run': rpc({
    access: 'write',
    input: z.strictObject({
      ...Conn,
      tableOrQuery: z.strictObject({ table: Table.optional(), query: Sql.optional() }).optional(),
      limit: z.number().int().min(1).max(1_000_000).optional(),
    }),
    project: byProjectId,
  }),
  'connection:explain': rpc({ access: 'write', input: z.strictObject({ ...Conn, sql: Sql }), project: byProjectId }),
  'connection:refresh': rpc({ access: 'write', input: z.strictObject({ ...Conn, datasetId: Uuid }), project: byProjectId }),
  // Create (no id), edit or rename (no sql) a saved query; replies with the whole list.
  'connection:saveQuery': rpc({
    access: 'write',
    input: z.strictObject({ ...Conn, id: Uuid.optional(), name: z.string().max(200).optional(), sql: Sql.optional() }),
    project: byProjectId,
  }),
  'connection:deleteQuery': rpc({ access: 'write', input: z.strictObject({ ...Conn, queryId: Uuid }), project: byProjectId }),
  'connection:delete': rpc({ access: 'write', input: z.strictObject(Conn), project: byProjectId }),
  // Server only: replace ONE stored secret — tested first, stored on success, never echoed.
  'connection:replaceSecret': rpc({
    access: 'write',
    input: z.strictObject({ ...Conn, key: Key, value: z.string().min(1).max(64 * 1024) }),
    project: byProjectId,
  }),
  // Server only: "Save as dataset" — re-run the table or statement at `limit` and save it.
  'connection:import': rpc({
    access: 'write',
    input: z.strictObject({
      ...Conn,
      name: z.string().max(255).optional(),
      table: Table.optional(),
      sql: Sql.optional(),
      queryId: Uuid.optional(),
      limit: z.number().int().min(1).max(1_000_000),
      // "Copy the data" (absent) or "Live" (docs/live-data/00-plan.md L2.1): Live stores the schema only.
      mode: z.enum(['extract', 'live']).optional(),
      maxCacheAgeSec: z.number().int().min(0).max(30 * 24 * 60 * 60).optional(),
    }),
    project: byProjectId,
  }),
} as const;
