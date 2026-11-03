// Home's "Data freshness": the project's datasets that keep themselves current
// (a refresh schedule, or Live) and any whose last refresh failed, failed ones
// first, each with when it last refreshed and, on a failure, the reason and
// Retry (an editor's). Every field is the dataset list's own, riding Home's
// `home:overview` reply, so the section costs no call of its own. NO SECTION
// while it loads, on a failed read (Recent reports that) or when nothing in
// the project refreshes: most projects are uploaded files, and a placeholder
// that then vanishes would make the page jump.

import { Link } from 'react-router';
import { useOverview, type OverviewDataset } from '../../api/home';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useWrite } from '../data/api';
import { ago, everyWord, sourceLabel } from '../data/format';
import { useCanEdit } from '../projects/api';
import h from './HomePage.module.css';
import s from './DataFreshness.module.css';

// shortcut: past SHOWN the rest are on the Data page ("Open Data"); add "Show all" if projects schedule many.
const SHOWN = 5;

type Tone = 'bad' | 'live' | 'ok';
const toneOf = (d: OverviewDataset): Tone => (d.lastRefreshStatus === 'error' ? 'bad' : d.mode === 'live' ? 'live' : 'ok');

function how(d: OverviewDataset, tone: Tone): string {
  if (tone === 'live') return 'Live, read at the source on each question';
  // A failed refresh leaves the last good data in place (only a success moves lastRefreshedAt): say how old it is.
  const age = tone === 'bad' && d.lastRefreshedAt ? `data from ${ago(d.lastRefreshedAt)}` : '';
  return [sourceLabel(d.sourceKind ?? ''), d.every ? `refreshes ${everyWord(d.every)}` : 'no schedule', age].filter(Boolean).join(' · ');
}

export function DataFreshness({ projectId }: { projectId: string | undefined }) {
  const ov = useOverview(projectId);
  const canEdit = useCanEdit(projectId);
  // Quiet: the refresh is a job, and the job's own toast says done or why not (api/jobs.ts); the row then reads again.
  const retry = useWrite('dataset:refresh', ['home:overview', 'dataset:list'], { quiet: true });
  if (!projectId || !ov.data) return null;
  const all = ov.data.datasets.filter((d) => d.every || d.mode === 'live' || d.lastRefreshStatus === 'error');
  if (!all.length) return null;
  const failed = all.filter((d) => toneOf(d) === 'bad');
  const rows = [...failed, ...all.filter((d) => toneOf(d) !== 'bad')].slice(0, SHOWN);
  return (
    <section className={h.sec} aria-labelledby="home-fresh">
      <div className={s.head}>
        <h2 id="home-fresh" className={h.secH}>
          Data freshness
        </h2>
        <span className={s.state} data-tone={failed.length ? 'bad' : 'ok'}>
          {failed.length ? `${failed.length} ${failed.length === 1 ? 'needs' : 'need'} attention` : 'All up to date'}
        </span>
        <Link className={s.more} to={`/data/${projectId}`}>
          Open Data
        </Link>
      </div>
      <ul className={s.list}>
        {rows.map((d) => {
          const tone = toneOf(d);
          const busy = retry.isPending && retry.variables?.id === d.id;
          return (
            <li key={d.id} className={s.row}>
              <span className={s.mark} aria-hidden="true">
                <Icon name={d.mode === 'live' ? 'zap' : 'database'} size={16} />
                <span className={s.dot} data-tone={tone} />
              </span>
              <span className={s.what}>
                <Link className={s.name} to={`/data/${projectId}/${d.id}`}>
                  {d.name}
                </Link>
                <span className={s.how}>{how(d, tone)}</span>
                {tone === 'bad' && (
                  <span className={s.why}>
                    The last refresh failed: {d.lastRefreshError || 'no reason was given.'}
                    {!canEdit && ' An editor can fix it.'}
                  </span>
                )}
              </span>
              {tone === 'live' ? (
                <span className={s.live}>Live</span>
              ) : tone === 'bad' && canEdit ? (
                <Button size="sm" icon="refresh" loading={busy} aria-label={`Retry the refresh of ${d.name}`} onClick={() => retry.mutate({ projectId, id: d.id })}>
                  Retry
                </Button>
              ) : (
                <span className={s.when}>
                  <strong>{tone === 'bad' ? 'Failed' : ago(d.lastRefreshedAt) || 'Not yet'}</strong>
                  {d.behindSchedule ? <span className={s.behind}>Behind schedule</span> : tone === 'ok' && d.lastRefreshedAt ? 'last refresh' : null}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
