// The bell's "Dashboard requests" (docs/team-folders/00-design.md, "Dashboard requests"; src/server/requests): for an
// editor, a viewer's request they may approve — who, the name they gave it, how many charts, their note — which opens
// the review page; for the viewer who asked, the request while it waits (with Withdraw), then its outcome — ready (it
// opens the dashboard) or declined, with the editor's note. Unseen first. The routes are built here from the ids;
// neither a row nor a push hands the browser a URL. `useRequestNotice` is the toast in the open tabs of whoever a
// request concerns (a withdrawn one only refreshes the approvers' bell).

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useServerEvent } from '../../api/events';
import { rpc } from '../../api/client';
import { ago } from '../../app/when';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ME_KEY } from '../auth/api';
import { useOverview } from '../projects/api';
import { MENTIONS_KEY, useMentionSeen, type RequestRow } from './mentionsApi';
import a from './Alerts.module.css';
import s from './Mentions.module.css';

export const reviewPath = (projectId: string, id: string): string => `/requests/${projectId}/${id}`;
const dashboardPath = (projectId: string, id: string): string => `/dashboards/${projectId}/${id}`;
const charts = (n: number): string => (n === 1 ? '1 chart' : `${n} charts`);

/** What one row says, and where it goes (null: nowhere — a declined request's row only reads). */
function lineOf(r: RequestRow): { head: string; sub: string; go: { href: string; name: string } | null } {
  if (r.mine) {
    if (r.state === 'approved' && r.dashboardId) return { head: `Your dashboard ${r.title} is ready`, sub: r.decidedBy ? `Approved by ${r.decidedBy}` : 'Approved', go: { href: dashboardPath(r.projectId, r.dashboardId), name: 'Dashboard' } };
    if (r.state === 'open') return { head: `Your request for ${r.title} is waiting for review`, sub: charts(r.charts), go: null };
    if (r.state === 'drafted') return { head: `Your request for ${r.title} is being made`, sub: `Being edited by ${r.decidedBy}`, go: null };
    if (r.state === 'withdrawn') return { head: `You withdrew your request for ${r.title}`, sub: 'Withdrawn', go: null };
    return { head: `Your request for ${r.title} was declined`, sub: r.decidedBy ? `Declined by ${r.decidedBy}` : 'Declined', go: null };
  }
  const done = r.state === 'approved' ? `Approved by ${r.decidedBy}` : r.state === 'drafted' ? `Being edited by ${r.decidedBy}` : r.state === 'declined' ? `Declined by ${r.decidedBy}` : charts(r.charts);
  return { head: r.onto ? `${r.by} asked for charts on a dashboard` : `${r.by} asked for a dashboard`, sub: done, go: { href: reviewPath(r.projectId, r.id), name: r.state === 'open' ? 'Review' : 'Open' } };
}

/** The requester's Withdraw on their own waiting request: nothing is made, and the approvers' rows go. */
function Withdraw({ r }: { r: RequestRow }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function withdraw(): Promise<void> {
    setBusy(true);
    try {
      const d = (await rpc('request:withdraw', { projectId: r.projectId, id: r.id })) as { ok: boolean; error?: string };
      if (!d.ok) toast(d.error || 'Could not withdraw the request.');
      await client.invalidateQueries({ queryKey: MENTIONS_KEY });
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not withdraw the request.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.rowAct}>
      <Button size="sm" variant="ghost" icon="undo" loading={busy} aria-label={`Withdraw your request for ${r.title}`} onClick={() => void withdraw()}>
        Withdraw
      </Button>
    </div>
  );
}

export function RequestsForYou({ items, onOpened }: { items: readonly RequestRow[]; onOpened: () => void }) {
  const seen = useMentionSeen();
  const projects = useOverview(); // the switcher's list, already loaded by the shell: no call of its own
  const navigate = useNavigate();
  return (
    <section aria-labelledby="bell-requests">
      <h3 id="bell-requests" className={a.inboxSec}>
        Dashboard requests
      </h3>
      <ul className={s.rows}>
        {items.map((r) => {
          const where = projects.data?.find((p) => p.id === r.projectId)?.name;
          const line = lineOf(r);
          const open = () => {
            if (!r.seen) seen.mutate({ projectId: r.projectId, id: r.id });
            if (!line.go) return;
            onOpened();
            void navigate(line.go.href);
          };
          const note = r.mine ? r.answer : r.note;
          return (
            <li key={`${r.projectId}:${r.id}`}>
              <button
                type="button"
                className={r.seen ? s.row : `${s.row} ${s.rowNew}`}
                aria-label={`${line.head}${r.seen ? '' : ', new'}: ${r.title}. ${line.go ? `Opens ${line.go.name}` : 'Marks it seen'}`}
                onClick={open}
                data-testid="bell-request"
              >
                <span className={s.rowTop}>
                  {!r.seen && <span className={s.dot} aria-hidden="true" />}
                  <span className={s.rowBy}>{line.head}</span>
                  <span className={s.rowWhen}>{ago(r.at)}</span>
                </span>
                {!r.mine && <span className={s.snippet}>{r.title}</span>}
                {note && <span className={s.askNote}>{note}</span>}
                <span className={s.on}>
                  <Icon name="layout-dashboard" size={12} />
                  <span className={s.onName}>
                    {line.sub}
                    {where ? ` · ${where}` : ''}
                  </span>
                  {line.go && (
                    <span className={s.askGo}>
                      {line.go.name}
                      <Icon name="arrow-right" size={12} />
                    </span>
                  )}
                </span>
              </button>
              {r.mine && r.state === 'open' && <Withdraw r={r} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one app-wide listener for `requests:changed` (ids, names and the state; never a title or note), mounted by the bell. */
export function useRequestNotice(): void {
  const navigate = useNavigate();
  const client = useQueryClient();
  useServerEvent('requests:changed', (p) => {
    const n = (p ?? {}) as Record<string, unknown>;
    const projectId = str(n.projectId);
    const id = str(n.id);
    const state = str(n.state);
    if (!UUID.test(projectId) || !UUID.test(id)) return;
    void client.invalidateQueries({ queryKey: MENTIONS_KEY });
    void client.invalidateQueries({ queryKey: ME_KEY }); // the badge's count rides on /api/auth/me
    const by = str(n.by) || 'Someone';
    const on = str(n.on) || 'a project';
    const seenThen = (go: string) => () => {
      void rpc('mentions:seen', { projectId, id }).then(() => {
        void client.invalidateQueries({ queryKey: MENTIONS_KEY });
        void client.invalidateQueries({ queryKey: ME_KEY });
      });
      void navigate(go);
    };
    if (state === 'open') toast(`${by} asked for a dashboard in ${on}`, { action: { label: 'Review', onClick: seenThen(reviewPath(projectId, id)) } });
    else if (state === 'approved' && UUID.test(str(n.dashboardId))) toast(`${by} approved your dashboard request in ${on}`, { action: { label: 'Open', onClick: seenThen(dashboardPath(projectId, str(n.dashboardId))) } });
    else if (state === 'declined') toast(`${by} declined your dashboard request in ${on}. The bell has their note.`);
  });
}
