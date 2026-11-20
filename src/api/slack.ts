import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Ordinate in Slack (docs/slack/00-design.md; src/server/slack/). The org admin sets the app up (Admin -> Slack); a
// project admin ties channels to agents; every member links or unlinks THEIR OWN Slack account. Replies carry names,
// ids and has-key flags only: never a key, a token or a figure.
const SlackId = z.string().regex(/^[A-Z0-9]{2,32}$/);

export const slack = {
  // The install, its has-key flags and the app manifest (this server's address filled in). Org admin.
  'slack:status': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  // Saves the app's keys (they go to the encrypted store, never back out), asks Slack who the bot is, and records the install.
  'slack:install': rpc({
    access: 'admin', org: true, audit: true,
    input: z.strictObject({
      botToken: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,300}$/),
      signingSecret: z.string().trim().max(200).optional(), // blank keeps the stored one
      clientId: z.string().trim().max(60).optional(),
      clientSecret: z.string().trim().max(200).optional(),
      appToken: z.string().trim().regex(/^xapp-[A-Za-z0-9-]{10,300}$/).optional(),
      mode: z.enum(['events', 'socket']),
    }),
  }),
  'slack:uninstall': rpc({ access: 'admin', org: true, audit: true, input: z.undefined() }),
  'slack:settings': rpc({
    access: 'admin', org: true, audit: true,
    input: z.strictObject({ mode: z.enum(['events', 'socket']).optional(), allowGuests: z.boolean().optional(), allowShareOverride: z.boolean().optional(), enabled: z.boolean().optional() }),
  }),
  // Who has linked a Slack account: Slack ids and the Ordinate email. Org admin.
  'slack:links': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  // The caller's own link (any member).
  'slack:myLink': rpc({ access: 'read', org: true, input: z.undefined() }),
  'slack:unlink': rpc({ access: 'read', org: true, audit: true, input: z.undefined() }),
  // "Open in Ordinate" from a Slack answer: where the question lives, for its asker; anyone else gets the question text to ask again as themselves.
  'slack:openQuestion': rpc({ access: 'read', org: true, input: z.strictObject({ id: Uuid }) }),
  // The channels the bot is in (the picker), and which agent holds each. A project admin.
  'slack:channels': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // An agent's Slack channels: read, or replace with `channels` (each must be one the bot is in; one agent per channel).
  'agent:slackChannels': rpc({
    access: 'admin', input: z.strictObject({ projectId: Uuid, agentId: Uuid, channels: z.array(z.strictObject({ id: SlackId })).max(50).optional() }), project: byProjectId,
  }),
} as const;
