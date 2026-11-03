// The bell's "Mentioned you" (docs/notifications/00-design.md §5.10): the comments
// that name the signed-in person, across every project they can read now, unseen
// first. Each row says who, when, the words (the server's snippet — names, never
// addresses) and what it is on; a click marks it seen and opens the thread. The
// bell owns the list's loading, error and empty states, since it weighs them
// against its alerts.

import { useNavigate } from 'react-router';
import { ago } from '../../app/when';
import { toast } from '../../ui/Toast';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { threadPath } from '../../../../src/app/threadPath.ts';
import { useOverview } from '../projects/api';
import { useMentionSeen, type HomeMention } from './mentionsApi';
import a from './Alerts.module.css';
import s from './Mentions.module.css';

const ICON: Record<HomeMention['target']['kind'], IconName> = { dataset: 'database', story: 'file-text', visual: 'chart-bar', analysis: 'layout-dashboard', card: 'layout-dashboard' };

export function MentionedYou({ items, onOpened }: { items: readonly HomeMention[]; onOpened: () => void }) {
  const seen = useMentionSeen();
  // Names from the switcher's list, which the shell has already loaded: no call of its own.
  const projects = useOverview();
  const navigate = useNavigate();
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name;
  const open = (m: HomeMention) => {
    const href = threadPath(m.projectId, m.target, m.on.analysisId);
    if (!m.seen) seen.mutate({ projectId: m.projectId, id: m.id });
    onOpened();
    if (href) void navigate(href);
    else toast('That card is no longer on a dashboard');
  };
  return (
    <section aria-labelledby="bell-mentions">
      <h3 id="bell-mentions" className={a.inboxSec}>
        Mentioned you <span className={a.inboxScope}>· all projects</span>
      </h3>
      <ul className={s.rows}>
        {items.map((m) => {
          const where = projectName(m.projectId);
          return (
            <li key={`${m.projectId}:${m.id}`}>
              <button
                type="button"
                className={m.seen ? s.row : `${s.row} ${s.rowNew}`}
                aria-label={`${m.by} mentioned you on ${m.on.name}${m.seen ? '' : ', new'}: ${m.snippet.slice(0, 120)}`}
                onClick={() => open(m)}
              >
                <span className={s.rowTop}>
                  {!m.seen && <span className={s.dot} aria-hidden="true" />}
                  <span>
                    <span className={s.rowBy}>{m.by}</span> mentioned you
                  </span>
                  <span className={s.rowWhen}>{ago(m.at)}</span>
                </span>
                <span className={s.snippet}>{m.snippet}</span>
                <span className={s.on}>
                  <Icon name={ICON[m.target.kind]} size={12} />
                  <span className={s.onName}>
                    {m.on.name}
                    {where ? ` · ${where}` : ''}
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
