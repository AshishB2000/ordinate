// An item's status as the MCP tools say it (semantic layer part 4, D9): `status`, who certified it and when, and the
// name of what replaces it. An item with no status gets no key, so a project without status replies as it always did.

import type { StatusView } from '../analysis/statusStore';

export function statusFields(s: StatusView | null | undefined): { status?: string; certifiedBy?: string; certifiedAt?: string; replacedBy?: string } {
  if (!s) return {};
  return {
    status: s.state,
    ...(s.state !== 'retired' && { certifiedBy: s.by, certifiedAt: s.at }), // needs_review: who certified it before it changed
    ...(s.replacedBy && { replacedBy: s.replacedBy.name }),
  };
}
