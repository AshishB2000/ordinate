// Dashboards, sharing, alerts, comments (T2.9).
//
// Publish to a URL (src/ipc/publishServer.ts): a project's dashboards,
// stories and scorecards built into a site the server serves at /p/<id>/.
// Publishing writes and shares project data with the org, so every change is
// `write`; who may OPEN a site is decided at /p/ itself (src/server/published.ts).
//
// Comments: a VIEWER may discuss what they can read, so adding, replying,
// resolving and reopening are `read` — audited like an export (`audit: true`).
// The author is the signed-in user (ctx().user, src/app/comments.ts), never a
// name the browser sends; edit and delete refuse anyone but the author.
//
// Alerts (src/ipc/alerts.ts): reading the inbox is `read`; rules and their
// state are the project's records, so changing them is `write`.

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

const Ids = z.array(Uuid).max(50);
const Access = z.enum(['org', 'link']);
const Targets = {
  projectId: Uuid,
  dashboardIds: Ids.optional(),
  storyIds: Ids.optional(),
  scorecardIds: Ids.optional(),
  // sanitizePublishConfig re-clamps both (title ≤ 120, combos 1–2048).
  options: z
    .strictObject({ title: z.string().max(200).optional(), maxCombos: z.number().int().min(1).max(4096).optional(), afterRefresh: z.boolean().optional() })
    .optional(),
  // Per dashboard, the accent ramp the browser computed (sanitizeBrand clamps it).
  brands: z.record(Uuid, z.looseObject({})).optional(),
};
/** A comment's target: what it is attached to (commentModel.sanitizeTarget re-checks it). */
const Target = z.strictObject({
  kind: z.enum(['analysis', 'card', 'visual', 'dataset', 'story']),
  id: Uuid,
  point: z.looseObject({}).optional(),
});
const Body = z.string().min(1).max(10_000);
/** A rule (alerts.sanitizeRule whitelists every field). */
const Rule = z.looseObject({ datasetId: Uuid });
/** The sheets a summary is about (sanitizeCard per card) and the scope it reads under. */
const SummaryReq = {
  projectId: Uuid,
  analysisId: Uuid.optional(),
  name: z.string().max(200).optional(),
  pages: z.array(z.looseObject({})).max(100),
  filters: Steps.optional(),
  params: z.array(z.looseObject({ name: z.string().max(40), kind: z.string().max(16) })).max(50).optional(),
  asOf: z.string().max(40).nullable().optional(),
};

export const dashboards = {
  'publish:targets': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'publish:plan': rpc({ access: 'read', input: z.strictObject(Targets), project: byProjectId }),
  'publish:sites': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'publish:run': rpc({ access: 'write', input: z.strictObject({ ...Targets, id: Uuid.optional(), access: Access.optional() }), project: byProjectId }),
  'publish:access': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, access: Access }), project: byProjectId }),
  'publish:unpublish': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // One dashboard as a self-contained .html download — an export, so audited.
  'dashboard:exportHtml': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The "As of" picker: snapshot times of the datasets the sheet reads.
  'dashboard:asOfStamps': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetIds: Ids, metricIds: Ids }),
    project: byProjectId,
  }),
  // The Summary card: app-computed sentences; Rewrite narrates them (AI, audited against the facts).
  'summary:compute': rpc({ access: 'read', input: z.strictObject(SummaryReq), project: byProjectId }),
  'summary:rewrite': rpc({ access: 'read', input: z.strictObject(SummaryReq), project: byProjectId }),
  // The dashboard's own currency (fx settings `dashboards[id]`): the KPIs' and charts' money shows in it.
  'fx:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'fx:dashboard': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, dashboardId: Uuid, code: z.string().regex(/^[A-Z]{3}$/).nullable() }),
    project: byProjectId,
  }),

  'comment:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'comment:add': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, target: Target, body: Body }), project: byProjectId }),
  'comment:reply': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid, body: Body }), project: byProjectId }),
  'comment:edit': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid, body: Body }), project: byProjectId }),
  'comment:resolve': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'comment:reopen': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'comment:delete': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'comment:deleteReply': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid, replyId: Uuid }), project: byProjectId }),

  'alerts:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'alerts:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, rule: Rule }), project: byProjectId }),
  'alerts:patch': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      ruleId: Uuid,
      patch: z.strictObject({
        enabled: z.boolean().optional(),
        quietHours: z.strictObject({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).nullable().optional(),
        snoozedUntil: z.string().max(40).nullable().optional(),
      }),
    }),
    project: byProjectId,
  }),
  'alerts:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, ruleId: Uuid }), project: byProjectId }),
  // Whether a rule WOULD fire now — reads only.
  'alerts:test': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, rule: Rule }), project: byProjectId }),
  'alerts:markSeen': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, eventId: Uuid.optional() }), project: byProjectId }),
  'alerts:setDigest': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, on: z.boolean() }), project: byProjectId }),
  // An alert's "Why": the change the rule caught, broken down by what drove it (src/ipc/drivers.ts, T2.10's engine).
  'drivers:explainAlert': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, ruleId: Uuid }), project: byProjectId }),
} as const;
