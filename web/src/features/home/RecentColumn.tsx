// Home's left column — homePage.ts, ported: All / Datasets / Dashboards pills
// and a This project / All projects scope over Recent; Starred above it (a pin
// is a pin: never filtered, never scoped). Pins are the CALLER's own
// (`starred:*` on the server is per user). Filtering, scoping and "Show all"
// are view state only — no re-fetch.

import { useState } from 'react';
import { Link } from 'react-router';
import { useSetStarred, useStarred, useRecent, type RecentItem, type RecentType } from '../../api/home';
import { buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { shortTime } from '../../app/when';
import { importPath, itemHref, metaText, qualityLabel, TYPE_LABEL } from './homeText';
import s from './HomePage.module.css';

const COLLAPSED = 8;
const SCOPE_KEY = 'ordinate.recentAllProjects';
type Filter = 'all' | 'dataset' | 'dashboard';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dataset', label: 'Datasets' },
  { value: 'dashboard', label: 'Dashboards' },
];

const TYPE_ICON: Record<RecentType, IconName> = {
  dataset: 'database',
  analysis: 'layout-dashboard',
  capture: 'camera',
  report: 'file-text',
};

const starKey = (it: RecentItem) => `${it.type}:${it.id}`;

function readScope(): boolean {
  try {
    return localStorage.getItem(SCOPE_KEY) === '1';
  } catch {
    return false;
  }
}

function Row({ it, starred, onStar }: { it: RecentItem; starred: boolean; onStar: () => void }) {
  const kind = TYPE_LABEL[it.type] ?? 'Record';
  const size = metaText(it);
  const time = shortTime(it.updatedAt);
  const dq = it.type === 'dataset' ? qualityLabel(it.meta?.qualityFailing) : '';
  // One sentence for the link — the spans would otherwise run together ("Dataset3 rows…").
  const label = [it.name || 'Untitled', kind, size, it.projectName && `in ${it.projectName}`, time].filter(Boolean).join(', ');
  return (
    <li className={s.row} data-type={it.type}>
      <Link className={s.rowLink} to={itemHref(it)} aria-label={label}>
        <span className={s.rowIcon} aria-hidden="true">
          <Icon name={TYPE_ICON[it.type] ?? 'database'} size={16} />
        </span>
        <span className={s.rowBody}>
          <span className={s.rowName}>
            {dq && <span className={s.dq} role="img" aria-label={dq} title={dq} />}
            {it.name || 'Untitled'}
          </span>
          <span className={s.rowMeta}>
            <span>{kind}</span>
            {size && <span className={s.tnum}>{size}</span>}
            {it.projectName && <span className={s.rowProj}>{it.projectName}</span>}
          </span>
        </span>
        <span className={s.rowTime}>{time}</span>
      </Link>
      <button
        type="button"
        className={starred ? `${s.star} ${s.starOn}` : s.star}
        aria-label={starred ? `Unstar ${it.name}` : `Star ${it.name}`}
        aria-pressed={starred}
        onClick={onStar}
      >
        <Icon name={starred ? 'star-filled' : 'star'} size={16} />
      </button>
    </li>
  );
}

export function RecentColumn({ projectId, recent, canEdit }: { projectId: string | undefined; recent: ReturnType<typeof useRecent>; canEdit: boolean }) {
  const starredQ = useStarred();
  const setStarred = useSetStarred();
  const [filter, setFilter] = useState<Filter>('all');
  const [allProjects, setAllProjects] = useState(readScope);
  const [expanded, setExpanded] = useState(false);

  const pins = starredQ.data ?? [];
  const pinned = new Set(pins);
  const toggle = (it: RecentItem) => {
    const k = starKey(it);
    const next = pinned.has(k) ? pins.filter((p) => p !== k) : [...pins, k];
    setStarred.mutate(next, { onError: () => toast('Your pins could not be saved. Try again.', { kind: 'error' }) });
  };
  const flipScope = () => {
    const next = !allProjects;
    setAllProjects(next);
    setExpanded(false);
    try {
      localStorage.setItem(SCOPE_KEY, next ? '1' : '0');
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  };

  const items = recent.data ?? [];
  const starred = items.filter((it) => pinned.has(starKey(it)));
  const rest = items.filter(
    (it) =>
      !pinned.has(starKey(it)) &&
      (filter === 'all' || (filter === 'dataset' ? it.type === 'dataset' : it.type === 'analysis')) &&
      (allProjects || !projectId || it.projectId === projectId),
  );
  const shown = expanded ? rest : rest.slice(0, COLLAPSED);
  const loading = recent.isPending || starredQ.isPending;

  return (
    <div className={s.colMain}>
      <div className={s.filter}>
        <div className={s.pills} role="group" aria-label="Filter recent">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={filter === f.value ? `${s.pill} ${s.pillOn}` : s.pill}
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                setExpanded(false); // a narrower list starts collapsed, so "Show all" stays honest
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={s.scope}
          aria-pressed={allProjects}
          title="Show recent work from every project"
          onClick={flipScope}
        >
          <Icon name="layers" size={12} />
          All projects
        </button>
      </div>

      <section className={s.sec} aria-labelledby="home-starred">
        <h2 id="home-starred" className={s.secH}>
          Starred
        </h2>
        {loading ? (
          <SkeletonRows rows={2} label="Loading starred" />
        ) : starredQ.isError ? (
          <ErrorState compact heading={3} title="Your pins could not be loaded" message={starredQ.error.message} onRetry={() => void starredQ.refetch()} />
        ) : starred.length ? (
          <ul className={s.rows}>
            {starred.map((it) => (
              <Row key={starKey(it)} it={it} starred onStar={() => toggle(it)} />
            ))}
          </ul>
        ) : (
          <div className={s.emptyBox}>
            <EmptyState compact heading={3} icon="star" title="Nothing pinned yet">
              Star a dataset or dashboard and it stays here, across every project.
            </EmptyState>
          </div>
        )}
      </section>

      <section className={`${s.sec} ${s.grow}`} aria-labelledby="home-recent">
        <div className={s.secHead}>
          <h2 id="home-recent" className={s.secH}>
            Recent
            {rest.length > 0 && <span className={s.secCount}>{rest.length}</span>}
          </h2>
          {rest.length > COLLAPSED && (
            <button type="button" className={s.showAll} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show all ${rest.length}`}
              {!expanded && <Icon name="arrow-right" size={12} />}
            </button>
          )}
        </div>
        {loading ? (
          <SkeletonRows rows={6} label="Loading recent work" />
        ) : recent.isError ? (
          <ErrorState compact heading={3} title="Recent work could not be loaded" message={recent.error.message} onRetry={() => void recent.refetch()} />
        ) : shown.length ? (
          <ul className={s.rows}>
            {shown.map((it) => (
              <Row key={starKey(it)} it={it} starred={false} onStar={() => toggle(it)} />
            ))}
          </ul>
        ) : (
          <div className={`${s.emptyBox} ${s.emptyGrow}`}>
            <EmptyState
              heading={3}
              icon="list"
              title="Your work will collect here"
              actions={
                canEdit && (
                  <>
                    <Link className={buttonClass('primary')} to={importPath(projectId)}>
                      Bring in some data
                    </Link>
                    <Link className={buttonClass('ghost')} to={projectId ? `/connections/${projectId}` : '/connections'}>
                      Browse sources
                    </Link>
                  </>
                )
              }
            >
              {allProjects
                ? 'Every dataset and dashboard you open shows up in this list — newest first, across all projects.'
                : 'Every dataset and dashboard in this project shows up here, newest first. “All projects” shows the rest.'}
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}
