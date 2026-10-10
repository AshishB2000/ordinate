// Home's "Jump back in": the project's most recently touched records as
// preview cards — a saved visual and a dashboard with their live picture
// (HomeThumbs, a lazy chunk), a dataset with its size. They are the head of
// the same `recent:list` the table below reads, so the row costs no call of
// its own. NO EMPTY STATE: with no work yet the row is absent and the table's
// empty state is the page's; a failed read is reported there too, once.

import { lazy, Suspense, useCallback, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { RecentItem, useRecent } from '../../api/home';
import { shortTime } from '../../app/when';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { accentFor } from '../visuals/model';
import { itemHref, TYPE_LABEL } from './homeText';
import { detailText, TYPE_ICON } from './recentItem';
import h from './HomePage.module.css';
import s from './JumpBackIn.module.css';

const HomeThumb = lazy(() => import('./HomeThumbs'));

/** How many cards the row holds. */
const MAX = 4;

function Card({ it }: { it: RecentItem }) {
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []);
  const name = it.name || 'Untitled';
  const kind = TYPE_LABEL[it.type] ?? 'Record';
  const detail = detailText(it);
  const time = shortTime(it.updatedAt);
  const live = it.type === 'visual' || it.type === 'analysis';
  // A dataset has no picture: its tile says its size, so the line under the name does not repeat it.
  const sized = it.type === 'dataset' && !!detail;
  return (
    <li>
      <Link className={s.card} to={itemHref(it)} aria-label={[name, kind, detail, time].filter(Boolean).join(', ')}>
        <span
          className={drawn ? `${s.tile} ${s.drawn}` : s.tile}
          style={it.type === 'visual' ? ({ '--tile-accent': accentFor(it.meta?.chartType ?? '') } as CSSProperties) : undefined}
          aria-hidden="true"
        >
          <span className={s.glyph}>
            <Icon name={TYPE_ICON[it.type] ?? 'database'} size={24} />
          </span>
          {sized && <span className={s.size}>{detail}</span>}
          {live && (
            <Suspense fallback={null}>
              <HomeThumb it={it} onDrawn={onDrawn} />
            </Suspense>
          )}
        </span>
        <span className={s.name}>{name}</span>
        <span className={s.meta}>{[kind, sized ? '' : detail, time].filter(Boolean).join(' · ')}</span>
      </Link>
    </li>
  );
}

export function JumpBackIn({ projectId, recent }: { projectId: string | undefined; recent: ReturnType<typeof useRecent> }) {
  if (!projectId || recent.isError) return null;
  const items = (recent.data ?? []).filter((it) => it.projectId === projectId).slice(0, MAX);
  if (!recent.isPending && !items.length) return null;
  return (
    <section className={h.sec} aria-labelledby="home-jump" aria-busy={recent.isPending || undefined}>
      <h2 id="home-jump" className={h.secH}>
        Jump back in
      </h2>
      <ul className={s.grid}>
        {recent.isPending
          ? [0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className={s.sk} />
              </li>
            ))
          : items.map((it) => <Card key={`${it.type}:${it.id}`} it={it} />)}
      </ul>
    </section>
  );
}
