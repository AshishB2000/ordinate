import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Refresh URLs (live data L0.5, src/server/hooks/): a URL a dbt run or an
// Airflow DAG calls to refresh ONE dataset. Managing them is a project
// writer's job — the same access the ↻ button (`dataset:refresh`) needs, which
// is all a URL can ever do. The list is audited only when refused, like an
// admin screen's list, so opening the panel does not write to the trail;
// creating and revoking a credential are always rows.
export const refreshHooks = {
  // { available, minIntervalSec, hooks: [{ id, prefix, createdBy, createdAt, lastUsedAt, revokedAt }] } — never a hash or a token.
  'refreshHook:list': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // The reply carries the token ONCE; nothing returns it again.
  'refreshHook:create': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  'refreshHook:revoke': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
} as const;
