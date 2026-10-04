// Home's "Recent comments" (legacy commentDoors.ts cmtPaintHome / cmtGoTo):
// the project's open threads, newest activity first, up to four — each opens
// the record it is on with its thread showing (`?comment=<kind>:<id>`, which
// the record's door or the dashboard reads on arrival). Hidden when nothing is
// open. The list rides on `home:overview`, so Home makes no extra call.

import { useNavigate } from 'react-router';
import type { RecentComment } from '../../api/home';
import { ago } from '../../app/when';
import { toast } from '../../ui/Toast';
import { Icon, type IconName } from '../../ui/icons/Icon';
import s from './Comments.module.css';

const ICON: Record<RecentComment['target']['kind'], IconName> = { dataset: 'database', story: 'file-text', visual: 'chart-bar', analysis: 'layout-dashboard', card: 'layout-dashboard' };

/** Where a thread lives, as a route that opens it. */
export function threadHref(projectId: string, c: RecentComment): string | null {
  const q = `comment=${c.target.kind}:${c.target.id}`;
  const t = c.target;
  if (t.kind === 'dataset') return `/data/${projectId}/${t.id}?${q}`;
  if (t.kind === 'visual') return `/visuals/${projectId}/${t.id}?${q}`;
  if (t.kind === 'story') return `/stories/${projectId}/${t.id}?${q}`;
  const aid = t.kind === 'analysis' ? t.id : c.on?.analysisId;
  return aid ? `/analyses/${projectId}/${aid}?${q}` : null;
}

export function RecentComments({ projectId, comments }: { projectId: string; comments: { open: number; recent: RecentComment[] } }) {
  const navigate = useNavigate();
  if (!comments.open) return null;
  return (
    <section className={s.home} aria-label="Recent comments">
      <h2 className={s.homeH}>
        Recent comments <span className={s.homeCount}>{comments.open} open</span>
      </h2>
      <div className={s.homeRow}>
        {comments.recent.map((c) => {
          const name = c.on?.name ?? 'a deleted record';
          return (
            <button
              key={c.id}
              type="button"
              className={s.homeCard}
              aria-label={`${c.author} on ${name}: ${c.snippet.slice(0, 120)}`}
              onClick={() => {
                const href = threadHref(projectId, c);
                if (href) void navigate(href);
                else toast('That card is no longer on a dashboard');
              }}
            >
              <span className={s.homeTop}>
                <span className={s.author}>{c.author}</span>
                <span className={s.when}>{ago(c.at)}</span>
              </span>
              <span className={s.homeSnippet}>{c.snippet}</span>
              <span className={s.homeOn}>
                <Icon name={ICON[c.target.kind]} size={12} />
                <span>{name}</span>
                {c.replies > 0 && <span className={s.homeReplies}>{c.replies === 1 ? '1 reply' : `${c.replies} replies`}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
