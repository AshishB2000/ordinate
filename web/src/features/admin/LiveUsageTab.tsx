// Admin → Live usage (live data L2.7): what Live datasets asked their
// warehouses, per UTC day and connection, for the last 30 days — beside the
// org's daily limit and today's count — so the warehouse bill is never a
// surprise. Every figure is the server's (src/server/admin/liveUsage.ts): the
// counts are formatted here, the share and the byte sizes arrive as labels,
// and the meter is a <meter> given today's count and the limit.

import { Badge } from '../../ui/Badge';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useLiveUsage, type LiveUsage } from './api';
import s from './Admin.module.css';

const count = (n: number) => n.toLocaleString();
// A usage day is a UTC day: formatted in UTC, or a browser west of Greenwich would print the day before.
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const fmtDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

function Today({ u }: { u: LiveUsage }) {
  const reached = u.todayRefused > 0;
  return (
    <div className={s.group} aria-label="Today">
      <h3 className={s.groupTitle}>Today (UTC)</h3>
      <p className={s.usageFigure}>
        <span className={s.usageBig}>{count(u.todayQueries)}</span>
        {u.limit > 0 ? ` of ${count(u.limit)} live warehouse queries` : ' live warehouse queries'}
      </p>
      {u.limit > 0 && (
        <meter
          className={reached ? `${s.usageMeter} ${s.usageMeterFull}` : s.usageMeter}
          min={0}
          max={u.limit}
          value={u.todayQueries}
          aria-label={`Today's live warehouse queries against the daily limit of ${count(u.limit)}`}
        />
      )}
      <p className={s.meta}>
        {u.limit > 0
          ? `${u.usedLabel ?? ''} of the daily limit (LIVE_DAILY_QUERY_LIMIT). The count starts over at 00:00 UTC.`
          : 'No daily limit: LIVE_DAILY_QUERY_LIMIT is 0.'}
      </p>
    </div>
  );
}

function Rows({ u }: { u: LiveUsage }) {
  return (
    <div className={s.card}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col">Connection</th>
            <th scope="col">Project</th>
            <th scope="col" className={s.num}>
              Queries
            </th>
            <th scope="col" className={s.num}>
              Bytes billed
            </th>
            <th scope="col" className={s.num}>
              Refused
            </th>
          </tr>
        </thead>
        <tbody>
          {u.rows.map((r) => (
            <tr key={`${r.day}:${r.connectionId}`}>
              <td className={s.meta}>
                <span className={s.cellRow}>
                  {fmtDay(r.day)}
                  {r.day === u.today && <Badge tone="accent">Today</Badge>}
                </span>
              </td>
              <td>
                {r.connection === null ? (
                  <span className={s.meta}>Deleted connection</span>
                ) : (
                  <span className={s.stack}>
                    <span className={s.strong}>{r.connection}</span>
                    {r.connector && <span className={s.meta}>{r.connector}</span>}
                  </span>
                )}
              </td>
              <td>{r.project ?? <span className={s.meta}>Deleted project</span>}</td>
              <td className={s.num}>{count(r.queries)}</td>
              <td className={s.num}>{r.bytesLabel ?? <span className={s.meta}>Not reported</span>}</td>
              <td className={s.num}>{r.refused > 0 ? count(r.refused) : <span className={s.meta}>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiveUsageTab() {
  const usage = useLiveUsage();
  let body;
  if (usage.isPending) body = <SkeletonTable cols={6} rows={5} label="Loading live usage" />;
  else if (usage.isError) {
    body = <ErrorState heading={3} title="Live usage could not be loaded" message={usage.error.message} onRetry={() => void usage.refetch()} />;
  } else {
    const u = usage.data;
    body = (
      <>
        {u.todayRefused > 0 && (
          <div className={`${s.notice} ${s.noticeWarn}`} role="status">
            <Icon name="alert" />
            <div>
              <h3 className={s.noticeTitle}>Today’s limit was reached</h3>
              <p className={s.lead}>
                {count(u.todayRefused)} {u.todayRefused === 1 ? 'question was' : 'questions were'} answered from the cache, labelled stale, or refused.
                Live figures ask the warehouse again after 00:00 UTC, or once LIVE_DAILY_QUERY_LIMIT is raised.
              </p>
            </div>
          </div>
        )}
        <Today u={u} />
        {u.perPod && (
          <div className={s.notice} role="note">
            <Icon name="database" />
            <p className={s.lead}>
              Counted by this server since it started. Without Postgres (DATABASE_URL) each server keeps its own count and its own daily limit.
            </p>
          </div>
        )}
        {u.rows.length === 0 ? (
          <EmptyState heading={3} icon="gauge" title={`No live queries in the last ${u.days} days`}>
            When a Live dataset asks its warehouse, each query and the bytes it billed show here, per day and connection.
          </EmptyState>
        ) : (
          <Rows u={u} />
        )}
      </>
    );
  }
  return (
    <section className={s.section} aria-label="Live usage">
      <p className={s.lead}>
        What Live datasets asked their warehouses, per day and connection. Every query sent counts once; a figure served from the cache costs
        nothing. Bytes are what the warehouse reports billing — BigQuery reports them, Snowflake bills by warehouse time instead.
      </p>
      {body}
    </section>
  );
}
