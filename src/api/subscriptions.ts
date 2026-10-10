// Subscriptions: a dashboard posted to Slack / Teams on a schedule
// (src/server/subscriptions/), and the channels it is posted to.
//
// CHANNELS are the org's, and a channel is a path for data to leave the server:
// making, changing, testing and removing one is an ORG ADMIN's
// (`org: true` + `admin` — refused with a 403 before the handler runs). Any
// member may LIST them to pick one, and the list never carries the webhook URL:
// `{id, name, kind, secretSet}`. `webhookUrl` is write-only — it goes in on
// save and nothing returns it.
//
// SUBSCRIPTIONS are a project's records: reading them is `read`, everything
// that changes one or sends one is `write`. Every record body is re-sanitized
// field by field by its store (src/analysis/subscriptions.ts); the zod shapes
// bound size and type. Run state (`run`, the owner, `since`) is the server's and
// is not in any input.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const Name = z.string().trim().min(1).max(80);
/** https only is the handler's rule (so the refusal can say so); here it is bounded. */
const WebhookUrl = z.string().max(2048);
const Kind = z.enum(['slack', 'teams']);

const Schedule = z.strictObject({
  cadence: z.enum(['hourly', 'daily', 'weekdays', 'weekly', 'monthly']),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
});

/** What a project writer sets. No owner, no run state. */
const Definition = z.strictObject({
  name: z.string().max(120),
  analysisId: Uuid,
  content: z.strictObject({ mode: z.enum(['all', 'cards']), cardIds: z.array(Uuid).max(50) }),
  viewId: Uuid.nullable().optional(),
  schedule: Schedule,
  timezone: z.string().min(1).max(64),
  channelIds: z.array(Uuid).max(10),
  message: z.strictObject({ title: z.string().max(150), note: z.string().max(1000), includeLink: z.boolean() }),
  conditions: z.strictObject({ skipUnchanged: z.boolean(), onlyWhenRefreshed: z.boolean() }),
  enabled: z.boolean().optional(),
});

const ById = z.strictObject({ projectId: Uuid, id: Uuid });
const admin = <I extends z.ZodType>(input: I) => rpc({ access: 'admin', org: true, input });

export const subscriptions = {
  // ── Channels (org) ──────────────────────────────────────────────────────
  // { canStore, channels: [{ id, name, kind, secretSet }] } — for every member, to pick from.
  'channel:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  // Create (no id) or change. `webhookUrl` may be left out on a change: the stored one stays.
  'channel:save': admin(z.strictObject({ id: Uuid.optional(), name: Name, kind: Kind, webhookUrl: WebhookUrl.optional() })),
  // The subscriptions and alert rules that post to it — what Delete warns about. Names from every project: admins only.
  'channel:usage': rpc({ access: 'admin', org: true, audit: 'denials', input: z.strictObject({ id: Uuid }) }),
  'channel:delete': admin(z.strictObject({ id: Uuid })),
  // Posts one fixed test message to the stored URL.
  'channel:test': admin(z.strictObject({ id: Uuid })),

  // ── Subscriptions (project) ─────────────────────────────────────────────
  'subscription:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'subscription:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  'subscription:history': rpc({ access: 'read', input: ById, project: byProjectId }),
  // The message a (possibly unsaved) definition would send now, as the CALLER may see it: the model, how each
  // platform would cut it, the next run times, and the dashboard's cards and views for the dialog to list.
  'subscription:preview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, draft: Definition }), project: byProjectId }),
  'subscription:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), subscription: Definition }), project: byProjectId }),
  'subscription:setEnabled': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, enabled: z.boolean() }), project: byProjectId }),
  'subscription:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
  // Sends now, as its owner, whatever the conditions say.
  'subscription:sendNow': rpc({ access: 'write', input: ById, project: byProjectId }),
} as const;
