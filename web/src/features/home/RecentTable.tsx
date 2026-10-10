// Home's table of work — homePage.ts's Recent, as ONE list: All / Dashboards /
// Visuals / Datasets pills, Starred as a pill beside them, and a This project /
// All projects scope. A pin is a pin: Starred is never scoped (the caller's
// own pins — `starred:*` on the server is per user — across every project).
// Filtering, scoping and "Show all" are view state only — no re-fetch.

import { useState } from 'react';
import { Link } from 'react-router';
import { useSetStarred, useStarred, useRecent, type RecentItem } from '../../api/home';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { shortTime } from '../../app/when';
import { importPath, itemHref, qualityLabel, TYPE_LABEL } from './homeText';
import { detailText, starKey, TYPE_ICON } from './recentItem';
import s from './HomePage.module.css';

const COLLAPSED = 8;
const SCOPE_KEY = 'ordinate.recentAllProjects';
type Filter = 'all' | 'analysis' | 'visual' | 'dataset' | 'starred';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'analysis', label: 'Dashboards' },
  { value: 'visual', label: 'Visuals' },
  { value: 'dataset', label: 'Datasets' },
  { value: 'starred', label: 'Starred' },
];

function readScope(): boolean {
  try {
    return localStorage.getItem(SCOPE_KEY) === '1';
  } catch {
    return false;
  }
}

function Row({ it, starred, onStar }: { it: RecentItem; starred: boolean; onStar: () => void }) {
  const kind = TYPE_LABEL[it.type] ?? 'Record';
  const detail = detailText(it);
  const time = shortTime(it.updatedAt);
  const dq = it.type === 'dataset' ? qualityLabel(it.meta?.qualityFailing) : '';
  // One sentence for the link — the cells would otherwise run together ("Dataset3 rows…").
  const label = [it.name || 'Untitled', kind, detail, it.projectName && `in ${it.projectName}`, time].filter(Boolean).join(', ');
  return (
    <li className={s.row} data-type={it.type}>
      <Link className={`${s.rowLink} ${s.grid}`} to={itemHref(it)} aria-label={label}>
        <span className={s.rowIcon} aria-hidden="true">
          <Icon name={TYPE_ICON[it.type] ?? 'database'} size={16} />
        </span>
        <span className={s.rowName}>
          {dq && <span className={s.dq} role="img" aria-label={dq} title={dq} />}
          {it.name || 'Untitled'}
        </span>
        <span className={s.cell}>{kind}</span>
        <span className={`${s.cell} ${s.cDetail} ${s.tnum}`}>{detail}</span>
        <span className={`${s.cell} ${s.cProject}`}>{it.projectName}</span>
        <span className={`${s.cell} ${s.tnum}`}>{time}</span>
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

export function RecentTable({ projectId, recent, canEdit }: { projectId: string | undefined; recent: ReturnType<typeof useRecent>; canEdit: boolean }) {
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

  const onlyStarred = filter === 'starred';
  const rows = (recent.data ?? []).filter((it) =>
    onlyStarred ? pinned.has(starKey(it)) : (filter === 'all' || it.type === filter) && (allProjects || !projectId || it.projectId === projectId),
  );
  const shown = expanded ? rows : rows.slice(0, COLLAPSED);
  const loading = recent.isPending || starredQ.isPending;

  return (
    <section className={s.sec} aria-labelledby="home-recent">
      <div className={s.filter}>
        <h2 id="home-recent" className={s.secH}>
          Recent
        </h2>
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
              {f.value === 'starred' && <Icon name="star" size={12} />}
              {f.label}
            </button>
          ))}
        </div>
        {!onlyStarred && (
          <button type="button" className={s.scope} aria-pressed={allProjects} title="Show recent work from every project" onClick={flipScope}>
            <Icon name="layers" size={12} />
            All projects
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonRows rows={6} label="Loading recent work" />
      ) : recent.isError ? (
        <ErrorState compact heading={3} title="Recent work could not be loaded" message={recent.error.message} onRetry={() => void recent.refetch()} />
      ) : onlyStarred && starredQ.isError ? (
        <ErrorState compact heading={3} title="Your pins could not be loaded" message={starredQ.error.message} onRetry={() => void starredQ.refetch()} />
      ) : shown.length ? (
        <div className={s.table}>
          {/* Column names for the eye; each row's link already says the whole row as one sentence. */}
          <div className={`${s.thead} ${s.grid}`} aria-hidden="true">
            <span />
            <span>Name</span>
            <span>Type</span>
            <span className={s.cDetail}>Details</span>
            <span className={s.cProject}>Project</span>
            <span>Updated</span>
          </div>
          <ul className={s.rows}>
            {shown.map((it) => (
              <Row key={starKey(it)} it={it} starred={pinned.has(starKey(it))} onStar={() => toggle(it)} />
            ))}
          </ul>
          {rows.length > COLLAPSED && (
            <button type="button" className={s.showAll} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show all ${rows.length}`}
              {!expanded && <Icon name="arrow-right" size={12} />}
            </button>
          )}
        </div>
      ) : onlyStarred ? (
        <div className={s.emptyBox}>
          <EmptyState compact heading={3} icon="star" title="Nothing starred yet">
            Star a dataset, visual or dashboard and it stays here, across every project.
          </EmptyState>
        </div>
      ) : (
        <div className={s.emptyBox}>
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
              ? 'Every dataset, visual and dashboard you open shows up in this list — newest first, across all projects.'
              : 'Every dataset, visual and dashboard in this project shows up here, newest first. “All projects” shows the rest.'}
          </EmptyState>
        </div>
      )}
    </section>
  );
}
