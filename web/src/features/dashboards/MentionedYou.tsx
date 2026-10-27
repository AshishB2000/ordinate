// Home's "Mentioned you" (docs/notifications/00-design.md §5.10): the comments
// that name the signed-in person, across every project they can read now, unseen
// first. Each card says who, when, the words (the server's snippet — names, never
// addresses) and what it is on; a click marks it seen and opens the thread. Its
// own loading, empty and error states; nothing at all on a server without a user
// directory (no one can be mentioned there).

import { useNavigate } from 'react-router';
import { ago } from '../../app/when';
import { Button } from '../../ui/Button';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { threadPath } from '../../../../src/app/threadPath.ts';
import { useOverview } from '../projects/api';
import { useMentions, useMentionSeen, type HomeMention } from './mentionsApi';
import s from './Mentions.module.css';

const ICON: Record<HomeMention['target']['kind'], IconName> = { dataset: 'database', story: 'file-text', visual: 'chart-bar', analysis: 'layout-dashboard', card: 'layout-dashboard' };
const SHOWN = 8;

export function MentionedYou() {
  const q = useMentions();
  const seen = useMentionSeen();
  // Names from the switcher's list, which the shell has already loaded: no call of its own.
  const projects = useOverview();
  const navigate = useNavigate();
  if (q.isSuccess && !q.data.available) return null;
  const items = q.data?.items ?? [];
  // The database's count: Mark all seen stays offered while any unseen row is left, shown here or not.
  const fresh = q.data?.unseen ?? 0;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name;
  const open = (m: HomeMention) => {
    const href = threadPath(m.projectId, m.target, m.on.analysisId);
    if (!m.seen) seen.mutate({ projectId: m.projectId, id: m.id });
    if (href) void navigate(href);
    else toast('That card is no longer on a dashboard');
  };
  return (
    <section className={s.home} aria-label="Mentioned you">
      <div className={s.homeHead}>
        <h2 className={s.homeH}>Mentioned you</h2>
        {fresh > 0 && <span className={s.homeNew}>{fresh} new</span>}
        {fresh > 0 && (
          <span className={s.homeAll}>
            <Button size="sm" variant="ghost" icon="check" loading={seen.isPending} onClick={() => seen.mutate({ through: items.reduce((m, x) => (x.at > m ? x.at : m), items[0]?.at ?? '') })}>
              Mark all seen
            </Button>
          </span>
        )}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={2} label="Loading your mentions" />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="Could not read your mentions" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !items.length ? (
        <EmptyState compact heading={3} icon="at-sign" title="No mentions yet">
          When someone types @ and picks you in a comment, it shows up here.
        </EmptyState>
      ) : (
        <div className={s.homeRow}>
          {items.slice(0, SHOWN).map((m) => {
            const where = projectName(m.projectId);
            return (
              <button
                key={`${m.projectId}:${m.id}`}
                type="button"
                className={m.seen ? s.card : `${s.card} ${s.cardNew}`}
                aria-label={`${m.by} mentioned you on ${m.on.name}${m.seen ? '' : ', new'}: ${m.snippet.slice(0, 120)}`}
                onClick={() => open(m)}
              >
                <span className={s.cardTop}>
                  {!m.seen && <span className={s.dot} aria-hidden="true" />}
                  <span>
                    <span className={s.cardBy}>{m.by}</span> mentioned you
                  </span>
                  <span className={s.cardWhen}>{ago(m.at)}</span>
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
            );
          })}
        </div>
      )}
    </section>
  );
}
