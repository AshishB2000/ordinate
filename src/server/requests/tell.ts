// Telling people about dashboard requests (./requests.ts), the mention path, as Ask an editor (../mentions/asks.ts):
// the bell rows are the gate and are written by the store; the push (`requests:changed`: ids, names and the state,
// never a title or note) and the email (users.request_email, off by default, under the mention email budget) never
// stand in the reply's way — they run in the background, and a failure is a log line.

import type { Channel } from '../../app/channels';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { personName } from '../../app/mentionToken';
import { getProject } from '../../app/projects';
import { logger } from '../../app/logger';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import { hold, mentionEmailBuckets } from '../mail/budget';
import { mailReady } from '../mail/emailChannel';
import { appLink } from '../publicUrl';
import * as say from '../requestMessages';
import { publish } from '../sse';
import { deliver } from '../subscriptions/deliver';
import type { DashboardRequest, RequestState } from './store';

/** The push a person's tabs get: ids, names and the state — never the title, a chart or the note. */
export interface RequestNotice {
  projectId: string;
  id: string;
  by: string;
  on: string;
  state: RequestState;
  /** Approved: the dashboard the requester's toast opens. */
  dashboardId?: string;
}

const inFlight = new Set<Promise<void>>();

/** Test hook: until every notice started so far has ended. */
export async function requestsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

export function background(p: Promise<void>): void {
  const q = p.catch((err: unknown) => logger.warn('[requests] notices failed:', err instanceof Error ? err.message : String(err)));
  inFlight.add(q);
  void q.finally(() => inFlight.delete(q));
}

export const reviewPath = (projectId: string, id: string): string => `/requests/${projectId}/${id}`;
const dashboardPath = (projectId: string, id: string): string => `/dashboards/${projectId}/${id}`;

function push(email: string, notice: RequestNotice): void {
  try {
    publish({ org: ctx().org.id, user: email }, 'requests:changed', notice);
  } catch (err) {
    logger.warn('[requests] push failed:', err instanceof Error ? err.message : String(err));
  }
}

const projectName = async (projectId: string): Promise<string> => (await getProject(projectId).catch(() => null))?.name ?? '';

export async function tellApprovers(r: Pick<DashboardRequest, 'id' | 'projectId' | 'requester' | 'title' | 'note' | 'charts'>, to: string[]): Promise<void> {
  const by = personName(r.requester);
  const on = await projectName(r.projectId);
  for (const email of to) push(email, { projectId: r.projectId, id: r.id, by, on, state: 'open' });
  if (!mailReady()) return;
  const title = r.charts.length === 1 ? say.askedForDashboardOne(by, r.title) : say.askedForDashboard(by, r.title, String(r.charts.length));
  for (const email of to) {
    await mailOne(r.requester, email, r.projectId, { title, subtitle: r.charts.map((c) => c.title), note: r.note, noteBy: by, path: reviewPath(r.projectId, r.id) })
      .catch((err: unknown) => logger.warn('[requests] email failed:', err instanceof Error ? err.message : String(err)));
  }
}

/** A withdrawn request: the approvers whose rows went get a push (their bell refreshes), and no email. */
export async function tellWithdrawn(r: DashboardRequest, to: string[]): Promise<void> {
  const on = await projectName(r.projectId);
  for (const email of to) push(email, { projectId: r.projectId, id: r.id, by: personName(r.requester), on, state: 'withdrawn' });
}

export async function tellRequester(r: DashboardRequest): Promise<void> {
  const by = ctx().user.email;
  const on = await projectName(r.projectId);
  push(r.requester, { projectId: r.projectId, id: r.id, by: personName(by), on, state: r.state, ...(r.state === 'approved' && r.dashboardId ? { dashboardId: r.dashboardId } : {}) });
  if (!mailReady()) return;
  const ready = r.state === 'approved' && r.dashboardId;
  await mailOne(by, r.requester, r.projectId, {
    title: ready ? say.dashboardReady(r.title) : say.requestDeclined(r.title), subtitle: [], note: ready ? '' : r.answer, noteBy: personName(by),
    path: ready ? dashboardPath(r.projectId, r.dashboardId as string) : null,
  }).catch((err: unknown) => logger.warn('[requests] email failed:', err instanceof Error ? err.message : String(err)));
}

/** One email to `email`, only when they turned on users.request_email, under the mention email budget (`author`'s hour and theirs). */
async function mailOne(author: string, email: string, projectId: string, m: { title: string; subtitle: string[]; note: string; noteBy: string; path: string | null }): Promise<void> {
  const r0 = await orgDb()!.query<{ id: string; request_email: boolean }>('SELECT id::text, request_email FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [ctx().org.id, email]);
  const who = r0.rows[0];
  if (!who || !who.request_email) return; // off unless they turned it on
  const message = composeMessage({ title: m.title, subtitle: m.subtitle, note: m.note, noteBy: m.noteBy, kpis: [], visuals: [], link: m.path ? appLink(m.path) : null, footer: '' });
  // A channel of one, made here and never saved, as a mention's: the send resolves it as it resolves any list.
  const one: Channel = { id: who.id, name: 'request', kind: 'email', to: { userIds: [who.id], teamIds: [] }, createdBy: author, createdAt: '', updatedAt: '' };
  const held = await hold(mentionEmailBuckets(ctx().org.id, author, email), 1);
  if (!held) return logger.warn('[requests] email not sent: its sender or recipient reached the hourly limit (the bell row stands)');
  const r = await deliver(one, { kind: 'mention', projectId, message, reason: say.requestEmailReason() });
  if (!r.ok) await held.refund(1);
}
