// Home's "Starred": what this person pinned, as preview cards (a saved visual
// and a dashboard with their live picture, HomeThumbs, a lazy chunk; a dataset
// with its size), newest pin first, from every project. Recent below is what
// CHANGED; this is what they chose, so the two never repeat each other. The
// cards ride the same `recent:list` the table reads (the server keeps a
// caller's pins in it past its cap), so the row costs no call of its own.
// Room left in the first row holds the way to add one: the table's star.
// NO ROW with no work yet: the table's empty state is the page's, and a
// failed read is reported there too, once.

import { lazy, Suspense, useCallback, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useStarred, type RecentItem, type useRecent } from '../../api/home';
import { shortTime } from '../../app/when';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { accentFor } from '../visuals/model';
import { itemHref, TYPE_LABEL } from './homeText';
import { detailText, starKey, TYPE_ICON } from './recentItem';
import h from './HomePage.module.css';
import s from './StarredRow.module.css';

const HomeThumb = lazy(() => import('./HomeThumbs'));

/** Cards in a full first row (the hint fills what is left of it), and the most shown. */
const ROW = 4;
// shortcut: past MAX pins the oldest are not shown here (each still has its star in Recent); add "Show all" if people pin more.
const MAX = 8;

function Card({ it, here }: { it: RecentItem; here: string | undefined }) {
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []);
  const name = it.name || 'Untitled';
  const kind = TYPE_LABEL[it.type] ?? 'Record';
  const detail = detailText(it);
  const time = shortTime(it.updatedAt);
  // A pin from another project says which.
  const away = it.projectId !== here ? it.projectName : '';
  const live = it.type === 'visual' || it.type === 'analysis';
  // A dataset has no picture: its tile says its size, so the line under the name does not repeat it.
  const sized = it.type === 'dataset' && !!detail;
  return (
    <li>
      <Link className={s.card} to={itemHref(it)} aria-label={[name, kind, detail, it.projectName && `in ${it.projectName}`, time].filter(Boolean).join(', ')}>
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
        <span className={s.meta}>{[kind, sized ? '' : detail, away, time].filter(Boolean).join(' · ')}</span>
      </Link>
    </li>
  );
}

/** `projectId`: Home's project, so a pin from another one can say where it lives. */
export function StarredRow({ projectId, recent }: { projectId: string | undefined; recent: ReturnType<typeof useRecent> }) {
  const starred = useStarred();
  if (recent.isError || starred.isError) return null;
  const loading = recent.isPending || starred.isPending;
  const all = recent.data ?? [];
  if (!loading && !all.length) return null;
  const byKey = new Map(all.map((it) => [starKey(it), it]));
  // Pins are kept in the order they were made: the newest first here.
  const items = [...(starred.data ?? [])]
    .reverse()
    .flatMap((k) => byKey.get(k) ?? [])
    .slice(0, MAX);
  return (
    <section className={h.sec} aria-labelledby="home-starred" aria-busy={loading || undefined}>
      <h2 id="home-starred" className={h.secH}>
        Starred
      </h2>
      <ul className={s.grid}>
        {loading
          ? [0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className={s.sk} />
              </li>
            ))
          : items.map((it) => <Card key={starKey(it)} it={it} here={projectId} />)}
        {!loading && items.length < ROW && (
          <li className={s.hint} data-free={ROW - items.length}>
            <span className={s.hintMark} aria-hidden="true">
              <Icon name="star" size={16} />
            </span>
            <span>
              <strong className={s.hintTitle}>{items.length ? 'Star what you come back to' : 'Nothing starred yet'}</strong>
              Select the star on any row in Recent and it stays up here, from any project.
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
