// The embed asker (docs/embedded-assistant/00-design.md): what a verified Assistant token and the agent's marking make.
// PURE. The ONLY place an `Identity.embed` is built. A token that does not lock every embeddable dataset's required
// column is refused as a whole, and so is one whose `params` names a column that no embeddable dataset requires.

import { createHash } from 'crypto';
import type { Identity } from '../context';
import type { AskClaims } from './askToken';
import type { EmbedAgent } from './assistants';

export type AskerRefusal = 'lock_missing' | 'lock_extra';

/** Lock values are strings: the required column is a declared text column, and `007` stays `007`. */
const asText = (v: string | number): string => String(v);

export function buildAsker(org: string, claims: AskClaims, marking: EmbedAgent): { ok: true; identity: Identity } | { ok: false; reason: AskerRefusal } {
  if (claims.agent.toLowerCase() !== marking.agentId.toLowerCase()) return { ok: false, reason: 'lock_missing' };
  const required = new Set(marking.datasets.map((d) => d.column));
  if (Object.keys(claims.params).some((c) => !required.has(c))) return { ok: false, reason: 'lock_extra' };
  const datasets: Record<string, { column: string; values: string[] }> = Object.create(null) as Record<string, { column: string; values: string[] }>;
  for (const d of marking.datasets) {
    const values = Object.prototype.hasOwnProperty.call(claims.params, d.column) ? claims.params[d.column].map(asText) : [];
    if (!values.length) return { ok: false, reason: 'lock_missing' };
    datasets[d.id.toLowerCase()] = { column: d.column, values };
  }
  return {
    ok: true,
    identity: {
      // A hash, never the customer's id (the email reaches logs); never an address: nothing looks a user up by it (callerOn answers for an embed asker without a query).
      user: { email: 'embed:' + createHash('sha256').update(claims.sub).digest('hex').slice(0, 16), role: 'viewer' },
      org: { id: org },
      embed: { agentId: marking.agentId.toLowerCase(), projectId: marking.projectId.toLowerCase(), customer: claims.sub, datasets },
    },
  };
}
