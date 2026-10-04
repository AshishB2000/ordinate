// Analytics workbenches B (T2.11): insights, event annotations, data snapshots
// and SQL over the project's own datasets. Handlers: src/ipc/insights.ts,
// events.ts, snapshots.ts, sqlQuery.ts — every figure is computed there.
// (The pivot / cohort / funnel shelves need no channel of their own: they ride
// `visual:preview` / `visual:data`, src/api/visuals.ts.)
//
// Every dataset id is read inside the named project's own directory, so naming
// another project's dataset finds nothing. SQL: the text is only bounded here;
// the read-only gate (src/engine/sqlGate.ts) and the org worker's engine lock
// (src/engine/duckdbPool.ts) decide what may run, and every `[[param]]` is
// bound, never spliced (src/analysis/params.ts).
//
// Access: reading, scanning, comparing and running a SELECT are `read`;
// anything that changes a record — a dismissal, an event, the calendars, a
// snapshot's retention or a restore — is `write`. `sql:prepareSave` is `write`:
// it reads the whole result only to stage it for the composer's save.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** src/data/datasetOrigin.ts MAX_ORIGIN_SQL — longer text is refused by the handler too. */
const Sql = z.string().max(20_000);
/** src/analysis/params.ts — sanitizeSqlParams owns each value; at most MAX_SQL_PARAMS (32). */
const SqlParams = z
  .array(z.looseObject({ name: z.string().max(40), kind: z.enum(['text', 'number', 'date', 'list']) }))
  .max(32)
  .optional();
const SqlIn = z.strictObject({ projectId: Uuid, sql: Sql, params: SqlParams });

/** src/data/snapshotNames.ts STAMP_RE — a snapshot's file stamp. */
const Stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
const DatasetIn = { projectId: Uuid, datasetId: Uuid };

/** An ISO date (YYYY-MM-DD); sanitizeEvent re-checks it. */
const IsoDate = z.string().max(32);
/** src/analysis/events.ts sanitizeEvent / sanitizeScope own every field. */
const Event = z.strictObject({
  id: Uuid.optional(),
  title: z.string().max(200),
  kind: z.string().max(20),
  date: IsoDate,
  end: IsoDate.nullable().optional(),
  scope: z
    .strictObject({
      datasetIds: z.array(Uuid).max(20).optional(),
      filters: z.array(z.looseObject({ type: z.string().max(64), column: z.string().max(512) })).max(10).optional(),
    })
    .optional(),
});

export const analyticsB = {
  // ── Insights (insights.ts) ──────────────────────────────────────────────────
  // preload: invoke('insights:list', { projectId, datasetId }) — what the app
  // found, ranked; one dataset, or the project's newest eight (Home).
  'insights:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional() }), project: byProjectId }),
  // preload: invoke('insights:dismiss', { projectId, id, dismissed }) — hide a card for the project.
  'insights:dismiss': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: z.string().min(1).max(2_000), dismissed: z.boolean().optional() }),
    project: byProjectId,
  }),

  // ── Event annotations (eventsPage.ts / eventsEditor.ts) ─────────────────────
  'events:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'events:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, event: Event }), project: byProjectId }),
  'events:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The file is read in the browser and sent as text, under the RPC body cap
  // (MAX_RPC_BODY_KB, 1 MB) — an events list, not a dataset.
  'events:importCsv': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, text: z.string().max(900_000) }), project: byProjectId }),
  'events:setCalendars': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, calendars: z.array(z.string().max(16)).max(50) }),
    project: byProjectId,
  }),

  // ── Data snapshots (snapshots.ts, snapshotDiffView.ts, snapshotAsOf.ts) ─────
  'snapshots:list': rpc({ access: 'read', input: z.strictObject(DatasetIn), project: byProjectId }),
  'snapshots:setKeep': rpc({
    access: 'write',
    input: z.strictObject({ ...DatasetIn, keep: z.number().int().min(0).max(100) }),
    project: byProjectId,
  }),
  // A snapshot against the current table, matched on the whole row (key null) or one column.
  'snapshots:diff': rpc({
    access: 'read',
    input: z.strictObject({ ...DatasetIn, stamp: Stamp, key: z.string().max(512).nullable().optional(), limit: z.number().int().min(1).max(500).optional() }),
    project: byProjectId,
  }),
  'snapshots:restore': rpc({ access: 'write', input: z.strictObject({ ...DatasetIn, stamp: Stamp }), project: byProjectId }),
  // The "As of" picker's times for the datasets (and metrics) on a page.
  'snapshots:stamps': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetIds: z.array(Uuid).max(50), metricIds: z.array(Uuid).max(50) }),
    project: byProjectId,
  }),

  // ── SQL over the project's datasets (queryTab.ts / queryEditor.ts / queryParams.ts) ──
  'sql:schema': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'sql:run': rpc({ access: 'read', input: SqlIn, project: byProjectId }),
  'sql:explain': rpc({ access: 'read', input: SqlIn, project: byProjectId }),
  'sql:prepareSave': rpc({ access: 'write', input: SqlIn, project: byProjectId }),
  // Server only: a SQL dataset's own statement and parameters ("View query") —
  // only for an origin of kind `sql`, which names nothing outside the project.
  'sql:datasetQuery': rpc({ access: 'read', input: z.strictObject(DatasetIn), project: byProjectId }),
} as const;
