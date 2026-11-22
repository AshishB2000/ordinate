// Linear and Jira Cloud, as the board uses them (docs/issues-board/00-design.md). An org admin CONNECTS one (Admin → Integrations): one read
// call proves the token and finds the team or the project; the token goes to the secrets store and the rest to `tracker_integrations`.
// An editor SENDS an issue: one ticket, the title, a summary and a link back, no question text (the owner's answer to Q2). Nothing here
// runs until those two things happen; the weekly job never calls it.

import { ctx } from '../../context';
import { serverOrigin } from '../../slack/manifest';
import * as say from '../../issueMessages';
import * as store from '../db';
import * as jira from './jira';
import * as linear from './linear';
import * as tokens from './tokens';
import { jiraHost, TrackerError } from './transport';

export const NAMES: Readonly<Record<store.Provider, string>> = { linear: 'Linear', jira: 'Jira' };
type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

/** A TrackerError as one of our sentences; the provider's own words are never used. */
function sentence(err: unknown, p: store.Provider, rejected: () => string): string {
  if (err instanceof TrackerError) return err.code === 'auth' ? say.badToken(NAMES[p]) : err.code === 'rejected' ? rejected() : say.trackerUnreachable(NAMES[p]);
  throw err;
}

export interface ProviderView { provider: store.Provider; connected: boolean; hasToken: boolean; settings: Record<string, string>; connectedBy: string; connectedAt: string }

/** What an admin sees: per provider, the settings that are not secret and whether a token is stored. Never the token. */
export async function status(): Promise<{ canSave: boolean; providers: ProviderView[] }> {
  const org = ctx().org.id;
  const rows = new Map((await store.integrations(org)).map((r) => [r.provider, r]));
  const providers: ProviderView[] = [];
  for (const p of ['linear', 'jira'] as const) {
    const r = rows.get(p);
    const hasToken = !!r && !!(await tokens.getToken(org, p));
    providers.push({ provider: p, connected: !!r && hasToken, hasToken, settings: r?.settings ?? {}, connectedBy: r?.connectedBy ?? '', connectedAt: r?.connectedAt ?? '' });
  }
  return { canSave: tokens.canStore(), providers };
}

/** Which are ready to send to: for the editors' board (flags only). */
export async function connected(): Promise<{ linear: boolean; jira: boolean }> {
  const s = await status();
  return { linear: s.providers[0].connected, jira: s.providers[1].connected };
}

export type Connect =
  | { provider: 'linear'; apiToken: string; teamKey: string }
  | { provider: 'jira'; apiToken: string; site: string; email: string; projectKey: string };

export async function connect(c: Connect): Promise<{ ok: true } | Fail> {
  if (!tokens.canStore()) return fail(say.needsMasterKey());
  const { org, user } = ctx();
  if (c.provider === 'linear') {
    try {
      const team = await linear.findTeam(c.apiToken, c.teamKey);
      if (!team) return fail(say.noTeam(c.teamKey));
      await tokens.putToken(org.id, 'linear', c.apiToken);
      await store.saveIntegration(org.id, 'linear', { teamId: team.id, teamKey: team.key }, user.email);
    } catch (err) {
      return fail(sentence(err, 'linear', () => say.noTeam(c.teamKey)));
    }
    return { ok: true };
  }
  const host = jiraHost(c.site);
  if (!host) return fail(say.badSite());
  try {
    const type = await jira.issueTypeOf(host, c.email, c.apiToken, c.projectKey);
    if (!type) return fail(say.noIssueType());
    await tokens.putToken(org.id, 'jira', c.apiToken);
    await store.saveIntegration(org.id, 'jira', { site: host, email: c.email, projectKey: c.projectKey, issueTypeId: type.id, issueType: type.name }, user.email);
  } catch (err) {
    return fail(sentence(err, 'jira', () => say.noJiraProject(c.projectKey)));
  }
  return { ok: true };
}

export async function disconnect(p: store.Provider): Promise<{ ok: true }> {
  const org = ctx().org.id;
  await store.dropIntegration(org, p);
  await tokens.dropToken(org, p);
  return { ok: true };
}

export interface Ticket { title: string; fix: string; questions: number; people: number; link: string }

/** One ticket for one issue: the title, a summary of counts and the fix, a link back. Returns the tracker's reference and URL. */
export async function createTicket(p: store.Provider, t: Ticket): Promise<{ ok: true; ref: string; url: string } | Fail> {
  const org = ctx().org.id;
  const row = (await store.integrations(org)).find((r) => r.provider === p);
  const token = row ? await tokens.getToken(org, p) : null;
  if (!row || !token) return fail(say.notConnected(NAMES[p]));
  const description = `${say.ticketSummary(t.questions, t.people, t.fix)}\n${say.ticketLink(t.link)}`;
  try {
    const made = p === 'linear'
      ? await linear.createIssue(token, row.settings.teamId, t.title, description)
      : await jira.createIssue(row.settings.site, row.settings.email, token, { projectKey: row.settings.projectKey, issueTypeId: row.settings.issueTypeId, title: t.title, description });
    return { ok: true, ...made };
  } catch (err) {
    return fail(sentence(err, p, () => say.ticketFailed(NAMES[p])));
  }
}

/** Where a ticket links back to: this issue's page in the Assistant tab; null when the server does not know its public address. */
export function linkBack(projectId: string, issueId: string): string | null {
  const origin = serverOrigin();
  return origin ? `${origin}/model/${projectId}?tab=assistant&issue=${issueId}` : null;
}
