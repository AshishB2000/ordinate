import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// The data issues board (docs/issues-board/00-design.md; src/server/issues/). Editors and admins read and work the board (`write`); the
// project's admin switches the weekly check; the ORG admin connects Linear or Jira. Replies carry counts, the title and fix, and example
// question words with a reason: never an answer, a figure, a row or who asked, and never a token (a has-token flag only).
const Provider = z.enum(['linear', 'jira']);
const Token = z.string().trim().min(8).max(500);

export const issues = {
  'issues:list': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'issues:settings': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'issues:setEnabled': rpc({ access: 'admin', audit: true, input: z.strictObject({ projectId: Uuid, enabled: z.boolean() }), project: byProjectId }),
  'issues:checkNow': rpc({ access: 'admin', audit: true, input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'issues:setStatus': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, status: z.enum(['open', 'resolved', 'ignored']) }), project: byProjectId }),
  // #7's proposal from this issue's open questions, as the editor who pressed it.
  'issues:propose': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // One ticket: the title, a summary and a link back. No question text leaves Ordinate.
  'issues:send': rpc({ access: 'write', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid, provider: Provider }), project: byProjectId }),

  // Admin -> Integrations. Settings and a has-token flag per tracker; the token is never sent back.
  'tracker:status': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  'tracker:connect': rpc({
    access: 'admin', org: true, audit: true,
    input: z.discriminatedUnion('provider', [
      z.strictObject({ provider: z.literal('linear'), apiToken: Token, teamKey: z.string().trim().min(1).max(20) }),
      z.strictObject({ provider: z.literal('jira'), apiToken: Token, site: z.string().trim().min(1).max(100), email: z.string().trim().email().max(200), projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/) }),
    ]),
  }),
  'tracker:disconnect': rpc({ access: 'admin', org: true, audit: true, input: z.strictObject({ provider: Provider }) }),
} as const;
