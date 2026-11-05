// Fixtures shared by the Source tables tab's tests: two connections, a used table with no doc, the server's strip.
import { serveRpc, type RpcReply } from '../../../test-utils';
import type { SourceList } from './api';

export const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const W = 'c1000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const S = 'c2000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const ORD = 'd1000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const CUS = 'd2000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const PUB = 'd3000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const X = 'e1000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
export const Y = 'e2000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
/** The Data model is a lazy chunk: its first render waits on a transform (long under load). */
export const LAZY = { timeout: 15_000 };
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export const LIST: SourceList = {
  ok: true,
  connections: [
    {
      connId: W, name: 'Warehouse', connectorId: 'snowflake', label: 'Snowflake', readsFacts: true,
      rows: [
        { docId: ORD, table: 'ANALYTICS.ORDERS', owner: 'Data platform', hasGuide: true, readAt: daysAgo(3), datasetIds: [X, Y] },
        { docId: CUS, table: 'ANALYTICS.CUSTOMERS', owner: '', hasGuide: false, datasetIds: [X] },
        { table: 'RETURNS', owner: '', hasGuide: false, datasetIds: [Y] },
      ],
    },
    { connId: S, name: 'Shop DB', connectorId: 'postgres', label: 'PostgreSQL', readsFacts: true, rows: [{ docId: PUB, table: 'public.orders', owner: 'Shop team', hasGuide: true, datasetIds: [] }] },
  ],
  todo: [
    { connId: W, table: 'RETURNS', kind: 'used_no_doc' },
    { connId: W, docId: CUS, table: 'ANALYTICS.CUSTOMERS', kind: 'no_owner' },
    { connId: S, docId: PUB, table: 'public.orders', kind: 'never_read' },
    { connId: W, docId: CUS, table: 'ANALYTICS.CUSTOMERS', kind: 'no_guide' },
  ],
  more: 2,
};

export const body = (b: unknown) => ({ body: b });
export function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'dataset:list': body([]),
    'model:overview': body({ ok: true, tables: [], todo: [], more: 0 }),
    'connectors:logos': body({}),
    'sourceTable:list': body(LIST),
    'sourceTable:get': (p) => body({ ok: false, error: `no fixture for ${JSON.stringify(p)}` }),
    ...routes,
  });
}
