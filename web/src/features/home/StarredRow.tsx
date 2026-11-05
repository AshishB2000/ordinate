// Home's "Starred": what this person pinned, as preview cards (a saved visual
// and a dashboard with their live picture, HomeThumbs, a lazy chunk; a dataset
// with its size), newest pin first, from every project. Recent below is what
// CHANGED; this is what they chose, so the two never repeat each other. The
// cards ride the same `recent:list` the table reads (the server keeps a
// caller's pins in it past its cap), so the row costs no call of its own.
// Room left in the first row holds suggestions: the newest work in Home's
// project not yet pinned, each with its own Star (nothing records what a
// person opens, so newest is the signal we have), then the way to add one.
// NO ROW with no work yet: the table's empty state is the page's, and a
// failed read is reported there too, once.

import { lazy, Suspense, useCallback, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useSetStarred, useStarred, type RecentItem, type useRecent } from '../../api/home';
import { shortTime } from '../../app/when';
import { Icon } from '../../ui/icons/Icon';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
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

/** `onStar`: a suggestion, drawn dashed with its own Star (outside the link: a button cannot sit in one). */
function Card({ it, here, onStar }: { it: RecentItem; here: string | undefined; onStar?: () => void }) {
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
    <li className={onStar ? s.sug : undefined}>
      <Link className={s.card} to={itemHref(it)} aria-label={[name, kind, detail, it.projectName && `in ${it.projectName}`, time, onStar && 'suggested'].filter(Boolean).join(', ')}>
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
        <span className={s.meta}>{[kind, sized ? '' : detail, away, onStar ? '' : time].filter(Boolean).join(' · ')}</span>
      </Link>
      {onStar && (
        <Button size="sm" variant="ghost" icon="star" className={s.star} aria-label={`Star ${name}`} onClick={onStar}>
          Star
        </Button>
      )}
    </li>
  );
}

/** `projectId`: Home's project, so a pin from another one can say where it lives. */
export function StarredRow({ projectId, recent }: { projectId: string | undefined; recent: ReturnType<typeof useRecent> }) {
  const starred = useStarred();
  const setStarred = useSetStarred();
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
  const pins = starred.data ?? [];
  const pinned = new Set(pins);
  // The rest of the first row: this project's newest work not yet pinned (recent:list is newest first).
  const suggested = items.length < ROW ? all.filter((it) => it.projectId === projectId && !pinned.has(starKey(it))).slice(0, ROW - items.length) : [];
  const star = (it: RecentItem) => setStarred.mutate([...pins, starKey(it)], { onError: () => toast('Your pins could not be saved. Try again.', { kind: 'error' }) });
  const free = ROW - items.length - suggested.length;
  return (
    <section className={h.sec} aria-labelledby="home-starred" aria-busy={loading || undefined}>
      <div className={s.head}>
        <h2 id="home-starred" className={h.secH}>
          Starred
        </h2>
        {!loading && suggested.length > 0 && (
          <span className={s.headHint}>
            {items.length ? 'More from this project, newest first. Star one and it stays up here.' : 'Nothing starred yet. Here is this project’s newest work: star one and it stays up here.'}
          </span>
        )}
      </div>
      <ul className={s.grid}>
        {loading
          ? [0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className={s.sk} />
              </li>
            ))
          : items.map((it) => <Card key={starKey(it)} it={it} here={projectId} />)}
        {!loading && suggested.map((it) => <Card key={`suggest:${starKey(it)}`} it={it} here={projectId} onStar={() => star(it)} />)}
        {!loading && free > 0 && (
          <li className={s.hint} data-free={free}>
            <span className={s.hintMark} aria-hidden="true">
              <Icon name="star" size={16} />
            </span>
            <span>
              <strong className={s.hintTitle}>{items.length || suggested.length ? 'Star what you come back to' : 'Nothing starred yet'}</strong>
              Select the star on any row in Recent and it stays up here, from any project.
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
