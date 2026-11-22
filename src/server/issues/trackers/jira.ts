// Jira Cloud (docs/issues-board/00-design.md): REST v3 at the admin's `<name>.atlassian.net`, Basic auth with the account's email and an
// API token. Version 1 uses the project's DEFAULT issue type: `Task` if the project has one, else the first that is not a sub-task. A project
// that needs other required fields refuses the ticket (a TrackerError 'rejected'), and the editor is told so. Description is Atlassian
// Document Format, which v3 requires.

import { call, TrackerError } from './transport';

const basic = (email: string, token: string) => ({ authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` });

/** The project's issue type for a ticket, from the project itself. Null: it has none a ticket can use. A wrong login or key is an error. */
export async function issueTypeOf(host: string, email: string, token: string, projectKey: string): Promise<{ id: string; name: string } | null> {
  const r = await call(host, `/rest/api/3/project/${encodeURIComponent(projectKey)}`, { method: 'GET', headers: basic(email, token) });
  if (r.status === 401 || r.status === 403) throw new TrackerError('auth');
  if (r.status === 404) throw new TrackerError('rejected');
  if (r.status >= 500) throw new TrackerError('unreachable');
  const types = ((r.json as { issueTypes?: Array<{ id?: unknown; name?: unknown; subtask?: unknown }> } | null)?.issueTypes ?? [])
    .filter((t): t is { id: string; name: string; subtask?: unknown } => typeof t.id === 'string' && typeof t.name === 'string' && t.subtask !== true);
  const pick = types.find((t) => t.name.toLowerCase() === 'task') ?? types[0];
  return pick ? { id: pick.id, name: pick.name } : null;
}

const adf = (text: string) => ({ type: 'doc', version: 1, content: text.split('\n').filter(Boolean).map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })) });

export async function createIssue(host: string, email: string, token: string, p: { projectKey: string; issueTypeId: string; title: string; description: string }): Promise<{ ref: string; url: string }> {
  const r = await call(host, '/rest/api/3/issue', {
    method: 'POST', headers: basic(email, token),
    json: { fields: { project: { key: p.projectKey }, issuetype: { id: p.issueTypeId }, summary: p.title, description: adf(p.description) } },
  });
  if (r.status === 401 || r.status === 403) throw new TrackerError('auth');
  if (r.status >= 500) throw new TrackerError('unreachable');
  const key = (r.json as { key?: unknown } | null)?.key;
  if (r.status !== 201 || typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new TrackerError('rejected');
  return { ref: key, url: `https://${host}/browse/${key}` };
}
