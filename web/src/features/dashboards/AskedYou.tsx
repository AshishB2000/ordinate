// The bell's "Asked for data" (docs/assistant/00-design.md, phase G): what viewers of a project the
// signed-in person edits asked the editors for — the question as they typed it, the reason as the
// server words it, their note and their name — unseen first. A click marks it seen and opens where
// an editor fixes it: Connections for data that is missing or must be copied, the Data model's
// Relationships for a link. The route is built here from the ids and the reason; neither a row nor
// a push hands the browser a URL to follow. `useAskNotice` is the toast in the editor's open tabs.

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useServerEvent } from '../../api/events';
import { rpc } from '../../api/client';
import { ago } from '../../app/when';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ME_KEY } from '../auth/api';
import { useOverview } from '../projects/api';
import { MENTIONS_KEY, useMentionSeen, type AskRow } from './mentionsApi';
import a from './Alerts.module.css';
import s from './Mentions.module.css';

type Reason = AskRow['reason'];
const REASONS: ReadonlySet<string> = new Set<Reason>(['missing', 'link', 'copy']);

/** Where an editor fixes it, and what that place is called (src/server/mentions/asks.ts `askPath`). */
export function askPlace(projectId: string, reason: Reason): { href: string; name: string } {
  return reason === 'link' ? { href: `/model/${projectId}?tab=relationships`, name: 'Relationships' } : { href: `/connections/${projectId}`, name: 'Connections' };
}

export function AskedYou({ items, onOpened }: { items: readonly AskRow[]; onOpened: () => void }) {
  const seen = useMentionSeen();
  // Names from the switcher's list, which the shell has already loaded: no call of its own.
  const projects = useOverview();
  const navigate = useNavigate();
  const open = (q: AskRow) => {
    if (!q.seen) seen.mutate({ projectId: q.projectId, id: q.id });
    onOpened();
    void navigate(askPlace(q.projectId, q.reason).href);
  };
  return (
    <section aria-labelledby="bell-asks">
      <h3 id="bell-asks" className={a.inboxSec}>
        Asked for data <span className={a.inboxScope}>· projects you edit</span>
      </h3>
      <ul className={s.rows}>
        {items.map((q) => {
          const where = projects.data?.find((p) => p.id === q.projectId)?.name;
          const place = askPlace(q.projectId, q.reason);
          return (
            <li key={`${q.projectId}:${q.id}`}>
              <button
                type="button"
                className={q.seen ? s.row : `${s.row} ${s.rowNew}`}
                aria-label={`${q.by} asked for data${q.seen ? '' : ', new'}: ${q.question.slice(0, 120)}. Opens ${place.name}`}
                onClick={() => open(q)}
                data-testid="bell-ask"
              >
                <span className={s.rowTop}>
                  {!q.seen && <span className={s.dot} aria-hidden="true" />}
                  <span>
                    <span className={s.rowBy}>{q.by}</span> asked for data
                  </span>
                  <span className={s.rowWhen}>{ago(q.at)}</span>
                </span>
                <span className={s.snippet}>“{q.question}”</span>
                {q.note && <span className={s.askNote}>{q.note}</span>}
                <span className={s.on}>
                  <Icon name={q.reason === 'link' ? 'link' : 'database'} size={12} />
                  <span className={s.onName}>
                    {q.why}
                    {where ? ` · ${where}` : ''}
                  </span>
                  <span className={s.askGo}>
                    {place.name}
                    <Icon name="arrow-right" size={12} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "Priya Shah asked the editors of Sales for data", with Open: the one app-wide listener for `asks:new`, mounted by the bell. */
export function useAskNotice(): void {
  const navigate = useNavigate();
  const client = useQueryClient();
  useServerEvent('asks:new', (p) => {
    const n = (p ?? {}) as Record<string, unknown>;
    const projectId = str(n.projectId);
    const reason = str(n.reason);
    if (!projectId || !REASONS.has(reason)) return;
    // The list, and the bell's badge (its count rides on /api/auth/me).
    void client.invalidateQueries({ queryKey: MENTIONS_KEY });
    void client.invalidateQueries({ queryKey: ME_KEY });
    toast(`${str(n.by) || 'A viewer'} asked the editors of ${str(n.on) || 'a project'} for data`, {
      action: {
        label: 'Open',
        onClick: () => {
          void rpc('mentions:seen', { projectId, id: str(n.id) }).then(() => {
            void client.invalidateQueries({ queryKey: MENTIONS_KEY });
            void client.invalidateQueries({ queryKey: ME_KEY });
          });
          void navigate(askPlace(projectId, reason as Reason).href);
        },
      },
    });
  });
}
