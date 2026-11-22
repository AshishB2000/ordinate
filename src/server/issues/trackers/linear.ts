// Linear (docs/issues-board/00-design.md): GraphQL at api.linear.app, a personal API key in `Authorization`. Connect lists the teams once
// to turn the admin's team KEY (DATA) into the team id a ticket needs; Send makes one `issueCreate`.

import { call, LINEAR_HOST, TrackerError } from './transport';

const GQL = '/graphql';
const headers = (token: string) => ({ authorization: token });

interface Gql { data?: Record<string, unknown>; errors?: unknown[] }
async function gql(token: string, query: string, variables?: Record<string, unknown>): Promise<Gql> {
  const r = await call(LINEAR_HOST, GQL, { method: 'POST', headers: headers(token), json: { query, ...(variables ? { variables } : {}) } });
  if (r.status === 401 || r.status === 403) throw new TrackerError('auth');
  const body = r.json as Gql | null;
  if (r.status >= 500) throw new TrackerError('unreachable');
  if (!body || typeof body !== 'object') throw new TrackerError('bad_reply');
  // Linear answers an invalid key with 400 and an "authentication" error.
  if (body.errors?.length) throw new TrackerError(r.status === 400 && JSON.stringify(body.errors).toLowerCase().includes('authentication') ? 'auth' : 'rejected');
  return body;
}

/** The team whose key is `teamKey`, or null. A bad key is a TrackerError('auth'). */
export async function findTeam(token: string, teamKey: string): Promise<{ id: string; key: string } | null> {
  const body = await gql(token, 'query { teams(first: 100) { nodes { id key } } }');
  const nodes = ((body.data?.teams as { nodes?: Array<{ id?: unknown; key?: unknown }> } | undefined)?.nodes ?? []);
  const t = nodes.find((n) => typeof n.key === 'string' && n.key.toLowerCase() === teamKey.toLowerCase() && typeof n.id === 'string');
  return t ? { id: String(t.id), key: String(t.key) } : null;
}

export async function createIssue(token: string, teamId: string, title: string, description: string): Promise<{ ref: string; url: string }> {
  const body = await gql(
    token,
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }',
    { input: { teamId, title, description } },
  );
  const out = body.data?.issueCreate as { success?: boolean; issue?: { identifier?: unknown; url?: unknown } } | undefined;
  if (!out?.success || typeof out.issue?.identifier !== 'string' || typeof out.issue.url !== 'string') throw new TrackerError('rejected');
  return { ref: out.issue.identifier, url: out.issue.url };
}
