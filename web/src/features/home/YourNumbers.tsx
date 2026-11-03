// Home's "Your numbers": the metrics and scorecards this person follows in
// Home's project, as tiles (src/ipc/numbers.ts). Every figure, period and
// change in a tile is the server's; the sparkline only draws the server's
// series. Nothing followed yet: the project's first metrics, each with Follow.
// A project with no metrics and nothing followed shows no section at all.

import type { ReactElement, ReactNode } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useFollowNumber, useNumbers, type GoalsTile, type MetricTile, type NumberChoice } from '../../api/home';
import h from './HomePage.module.css';
import s from './YourNumbers.module.css';

type Toggle = (kind: NumberChoice['kind'], id: string, on: boolean) => void;

/** The server's series as a line; gaps (a period with no figure) are skipped. */
function Spark({ values }: { values: Array<number | null> }) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const span = Math.max(...nums) - lo || 1;
  const step = 100 / (values.length - 1);
  const points = values.flatMap((v, i) => (typeof v === 'number' && Number.isFinite(v) ? [`${(i * step).toFixed(2)},${(29 - ((v - lo) / span) * 26).toFixed(2)}`] : [])).join(' ');
  return (
    <svg className={s.spark} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function MetricCard({ t, onUnfollow }: { t: MetricTile; onUnfollow: () => void }) {
  const said = [t.display, t.period, t.change && `${t.change.text} vs ${t.change.vs}`].filter(Boolean).join(', ');
  return (
    <article className={s.tile} aria-label={`${t.name}: ${t.error || said || 'no figure'}`}>
      <div className={s.top}>
        <span className={s.name}>{t.name}</span>
        <IconButton icon="x" size="sm" className={s.unfollow} label={`Unfollow ${t.name}`} onClick={onUnfollow} />
      </div>
      <span className={s.src}>{[t.dataset, t.period].filter(Boolean).join(' · ')}</span>
      {t.error ? <span className={s.err}>{t.error}</span> : t.display ? <span className={s.value}>{t.display}</span> : <span className={s.err}>No figure for this period yet.</span>}
      {t.change && (
        <span className={s.change} data-tone={t.change.tone}>
          {t.change.text} <span className={s.vs}>vs {t.change.vs}</span>
        </span>
      )}
      {t.spark && <Spark values={t.spark} />}
    </article>
  );
}

function GoalsCard({ t, onUnfollow }: { t: GoalsTile; onUnfollow: () => void }) {
  return (
    <article className={s.tile} aria-label={`${t.name}: ${t.error || (t.scored ? `${t.off} of ${t.scored} goals off track, ${t.warn} at risk` : 'no targets set')}`}>
      <div className={s.top}>
        <span className={s.name}>{t.name}</span>
        <IconButton icon="x" size="sm" className={s.unfollow} label={`Unfollow ${t.name}`} onClick={onUnfollow} />
      </div>
      <span className={s.src}>{['Goals', t.period].filter(Boolean).join(' · ')}</span>
      {t.error ? (
        <span className={s.err}>{t.error}</span>
      ) : t.scored ? (
        <>
          <span className={s.value}>
            {t.off} <span className={s.of}>of {t.scored} off track</span>
          </span>
          <span className={s.bar} aria-hidden="true">
            <span className={s.good} style={{ flexGrow: t.good }} />
            <span className={s.warn} style={{ flexGrow: t.warn }} />
            <span className={s.off} style={{ flexGrow: t.off }} />
          </span>
          <span className={s.src}>{t.warn} at risk</span>
        </>
      ) : (
        <span className={s.src}>No targets set yet.</span>
      )}
    </article>
  );
}

function Suggestion({ t, onFollow }: { t: MetricTile; onFollow: () => void }) {
  return (
    <article className={`${s.tile} ${s.suggest}`} aria-label={`${t.name}: ${t.error || t.display || 'no figure'}, suggested`}>
      <span className={s.name}>{t.name}</span>
      <span className={s.src}>{[t.dataset, t.period].filter(Boolean).join(' · ')}</span>
      {t.error ? <span className={s.err}>{t.error}</span> : t.display ? <span className={s.value}>{t.display}</span> : <span className={s.err}>No figure for this period yet.</span>}
      <Button size="sm" variant="ghost" className={s.follow} onClick={onFollow}>
        <Icon name="plus" size={12} />
        Follow
      </Button>
    </article>
  );
}

/** Cards in a full first row; the "follow another" tile takes what is left of it. */
const ROW = 4;

function FollowMenu({ choices, onToggle, trigger, align = 'end' }: { choices: NumberChoice[]; onToggle: Toggle; trigger: ReactElement; align?: 'center' | 'end' }) {
  const group = (kind: NumberChoice['kind'], heading: string) => {
    const of = choices.filter((c) => c.kind === kind);
    return of.length
      ? [{ kind: 'heading' as const, label: heading }, ...of.map((c) => ({ label: c.name, icon: c.followed ? ('check' as const) : ('plus' as const), onSelect: () => onToggle(c.kind, c.id, !c.followed) }))]
      : [];
  };
  return (
    <Menu
      label="Follow a metric"
      align={align}
      trigger={trigger}
      items={[...group('metric', 'Metrics'), ...group('scorecard', 'Scorecards')]}
    />
  );
}

export function YourNumbers({ projectId }: { projectId: string | undefined }) {
  const q = useNumbers(projectId);
  const follow = useFollowNumber(projectId);
  if (!projectId) return null;
  const toggle: Toggle = (kind, id, on) => follow.mutate({ kind, id, on }, { onError: (err) => toast(err.message, { kind: 'error' }) });
  const head = (extra?: ReactNode) => (
    <div className={s.head}>
      <h2 id="home-numbers" className={h.secH}>
        Your numbers
      </h2>
      {extra}
    </div>
  );
  if (q.isPending) {
    return (
      <section className={h.sec} aria-labelledby="home-numbers" aria-busy="true">
        {head()}
        <ul className={s.grid}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Skeleton className={s.sk} />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (q.isError) {
    return (
      <section className={h.sec} aria-labelledby="home-numbers">
        {head()}
        <ErrorState compact heading={3} title="Your numbers could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      </section>
    );
  }
  const { tiles, suggestions, choices } = q.data;
  if (!tiles.length && !suggestions.length) return null;
  const suggesting = !tiles.length;
  const shown = suggesting ? suggestions.length : tiles.length;
  return (
    <section className={h.sec} aria-labelledby="home-numbers">
      {head(
        <>
          {suggesting && <span className={s.hint}>Follow the numbers you check most and they stay up here.</span>}
          <FollowMenu
            choices={choices}
            onToggle={toggle}
            trigger={
              <button type="button" className={s.menuBtn}>
                <Icon name="plus" size={12} />
                Follow a metric
              </button>
            }
          />
        </>,
      )}
      <ul className={s.grid}>
        {suggesting
          ? suggestions.map((t) => (
              <li key={t.id}>
                <Suggestion t={t} onFollow={() => toggle('metric', t.id, true)} />
              </li>
            ))
          : tiles.map((t) => (
              <li key={`${t.kind}:${t.id}`}>
                {t.kind === 'metric' ? <MetricCard t={t} onUnfollow={() => toggle('metric', t.id, false)} /> : <GoalsCard t={t} onUnfollow={() => toggle('scorecard', t.id, false)} />}
              </li>
            ))}
        {shown < ROW && (
          <li className={s.add} data-free={ROW - shown}>
            <FollowMenu
              choices={choices}
              onToggle={toggle}
              align="center"
              trigger={
                <button type="button" className={s.addTile}>
                  <span className={s.addMark} aria-hidden="true">
                    <Icon name="plus" size={16} />
                  </span>
                  {suggesting ? 'Follow any metric or scorecard' : 'Follow another metric or scorecard'}
                </button>
              }
            />
          </li>
        )}
      </ul>
    </section>
  );
}
