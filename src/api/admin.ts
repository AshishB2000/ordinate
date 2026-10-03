import { z } from 'zod';
import { rpc, Uuid } from './contract';

// Admin (T3.4): org admins only. Every channel is `org: true` + `admin`, so the
// route refuses anyone below org admin with a 403 before the handler runs.
// Every write is audited, and every refusal; the lists the screens load are
// not (`audit: 'denials'`), so browsing the audit log does not fill it. The
// handlers (src/server/admin/) act on the CALLER's org only: an id from
// another org is simply not found.

/** The AI providers an org can allow — the server's API-key providers (src/app/config.ts BYOK_PROVIDERS). */
export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'gateway'] as const;

const Role = z.enum(['admin', 'editor', 'viewer']);
const Name = z.string().trim().min(1).max(100);
const When = z.iso.datetime({ offset: true });

const admin = <I extends z.ZodType>(input: I) => rpc({ access: 'admin', org: true, input });
const adminList = <I extends z.ZodType>(input: I) => rpc({ access: 'admin', org: true, audit: 'denials', input });

export const adminContracts = {
  // People: list, invite (a pending user row, signed in later by SSO), role, disable.
  'admin:users': adminList(z.undefined()),
  'admin:invite': admin(z.strictObject({ email: z.email().max(320), role: Role })),
  'admin:setRole': admin(z.strictObject({ userId: Uuid, role: Role })),
  'admin:setDisabled': admin(z.strictObject({ userId: Uuid, disabled: z.boolean() })),
  // Teams: list with members, create, rename, add / remove a member.
  'admin:teams': adminList(z.undefined()),
  'admin:createTeam': admin(z.strictObject({ name: Name })),
  'admin:renameTeam': admin(z.strictObject({ teamId: Uuid, name: Name })),
  'admin:teamMember': admin(z.strictObject({ teamId: Uuid, userId: Uuid, member: z.boolean() })),
  // Projects with their owner team, and moving ownership to another team.
  'admin:projects': adminList(z.undefined()),
  'admin:transferOwner': admin(z.strictObject({ projectId: Uuid, teamId: Uuid })),
  // The audit trail, filtered and paged newest-first by id (keyset: `before` = the last id seen).
  'admin:audit': adminList(
    z.strictObject({
      actor: z.string().trim().max(320).optional(),
      action: z.enum(['rpc', 'login', 'logout', 'logout_everywhere']).optional(),
      channel: z.string().max(100).optional(),
      projectId: Uuid.optional(),
      from: When.optional(),
      to: When.optional(),
      outcome: z.enum(['ok', 'denied', 'error']).optional(),
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  ),
  // Org settings: public links, allowed AI providers, the per-org upload cap (≤ MAX_UPLOAD_MB).
  'admin:settings': adminList(z.undefined()),
  'admin:saveSettings': admin(
    z.strictObject({
      publicLinks: z.boolean(),
      aiProviders: z.array(z.enum(AI_PROVIDERS)).max(AI_PROVIDERS.length),
      uploadCapMb: z.number().int().min(1).max(999_999).nullable(),
    }),
  ),
} as const;
