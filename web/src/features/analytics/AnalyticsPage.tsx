// /analytics — the doors into the workbenches for the CURRENT project. On the
// desktop each had its own door (the palette's "Statistics…", a dataset's ⋯
// "Find segments", a KPI's "Why?", the Scenarios tab of Dashboards); the web
// gathers them here, with one dataset picker for the three that read a
// dataset. A deep link carries the dataset itself: /analytics/:p/:d/<kind>.

import { useState } from 'react';
import { Link } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { useDatasets } from '../../api/datasets';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ProjectGate } from '../import/ProjectGate';
import { LiveBanner } from '../live/LiveOff';
import s from './Analytics.module.css';

const WORKBENCHES: Array<{ kind: string; icon: IconName; name: string; blurb: string }> = [
  {
    kind: 'stats',
    icon: 'activity',
    name: 'Statistics',
    blurb: 'Correlation, regression, compare groups and distributions — with p-values, intervals and the tests behind them.',
  },
  {
    kind: 'drivers',
    icon: 'trending-up',
    name: 'Why did this change?',
    blurb: 'Break a metric’s change between its latest two periods down by every dimension, ranked by how much each explains.',
  },
  {
    kind: 'segments',
    icon: 'layers',
    name: 'Find segments',
    blurb: 'Group rows that are alike with k-means, or score customers by recency, frequency and spend (RFM).',
  },
];

/**
 * T2.11's doors on the chosen dataset: the three grid chart types open the
 * Visuals builder on that type (its own shelves filled), Insights and
 * Snapshots open the dataset page's tab.
 */
const DATASET_DOORS: Array<{ key: string; icon: IconName; name: string; blurb: string; open: string; to: (p: string, d: string) => string; state?: { chartType: string } }> = [
  { key: 'pivot', icon: 'table', name: 'Pivot table', blurb: 'Rows, columns and values with subtotals, Top N, “show as” and conditional formatting — every total computed from the data, never folded from the cells.', open: 'New pivot table', to: (p, d) => `/visuals/${p}/new?dataset=${d}`, state: { chartType: 'pivot' } },
  { key: 'cohort', icon: 'grid', name: 'Cohorts', blurb: 'Group members by the period of their first event and see who came back — retention or cumulative value, as a grid or a curve.', open: 'New cohort grid', to: (p, d) => `/visuals/${p}/new?dataset=${d}`, state: { chartType: 'cohort' } },
  { key: 'event_funnel', icon: 'filter', name: 'Event funnel', blurb: 'Pick the steps from an event column; entities move through them in strict order inside a conversion window, with a breakdown.', open: 'New event funnel', to: (p, d) => `/visuals/${p}/new?dataset=${d}`, state: { chartType: 'event_funnel' } },
  { key: 'insights', icon: 'zap', name: 'Insights', blurb: 'What the app found on its own: movers, trends, concentration, period changes, outliers — each with the figures behind it.', open: 'Open insights', to: (p, d) => `/data/${p}/${d}?tab=insights` },
  { key: 'snapshots', icon: 'history', name: 'Snapshots', blurb: 'The table as it was before each refresh: compare any version with now, restore one, or view a chart as of that time.', open: 'Open snapshots', to: (p, d) => `/data/${p}/${d}?tab=snapshots` },
];

function Hub({ projectId }: { projectId: string }) {
  const list = useDatasets(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const datasets = list.data ?? [];
  const id = picked && datasets.some((d) => d.id === picked) ? picked : (datasets[0]?.id ?? null);
  const chosen = datasets.find((d) => d.id === id);
  return (
    <Page title="Analytics" sub="Every statistic, driver, scenario, segment, pivot and insight is computed by Ordinate from your data — the Assistant only puts them into words.">
      {list.isPending ? (
        <SkeletonRows rows={3} label="Loading datasets" />
      ) : list.isError ? (
        <ErrorState title="Datasets could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />
      ) : datasets.length === 0 ? (
        <EmptyState
          icon="database"
          title="No data to analyse"
          actions={
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import a dataset
            </Link>
          }
        >
          Import a dataset first, then come back to find what drives it.
        </EmptyState>
      ) : (
        <>
          <div className={s.hubBar}>
            <Select
              label="Dataset"
              value={id}
              options={datasets.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
              onValueChange={setPicked}
            />
            {chosen && <p className={s.hubNote}>{`${chosen.mode === 'live' ? 'Live' : `${formatNumber(chosen.rowCount)} rows`} · ${chosen.columnCount} columns`}</p>}
          </div>
          {/* A Live dataset keeps its rows in the warehouse (L2.6): every door below needs a copy, and says so when opened. */}
          {chosen?.mode === 'live' && <LiveBanner projectId={projectId} datasetId={chosen.id} name={chosen.name || 'This dataset'} />}
          <ul className={s.hubGrid} aria-label="Workbenches">
            {WORKBENCHES.map((w) => (
              <li key={w.kind} className={s.hubCard}>
                <span className={s.hubIcon} aria-hidden="true">
                  <Icon name={w.icon} size={20} />
                </span>
                <h2 className={s.hubName}>{w.name}</h2>
                <p className={s.hubBlurb}>{w.blurb}</p>
                <Link className={buttonClass('primary', 'sm')} to={`/analytics/${projectId}/${id}/${w.kind}`}>
                  Open {w.name === 'Why did this change?' ? 'drivers' : w.name.toLowerCase()}
                </Link>
              </li>
            ))}
            {id &&
              DATASET_DOORS.map((w) => (
                <li key={w.key} className={s.hubCard}>
                  <span className={s.hubIcon} aria-hidden="true">
                    <Icon name={w.icon} size={20} />
                  </span>
                  <h2 className={s.hubName}>{w.name}</h2>
                  <p className={s.hubBlurb}>{w.blurb}</p>
                  <Link className={buttonClass('secondary', 'sm')} to={w.to(projectId, id)} state={w.state}>
                    {w.open}
                  </Link>
                </li>
              ))}
          </ul>
        </>
      )}
      <ul className={s.hubGrid} aria-label="Project workbenches">
        <li className={s.hubCard}>
          <span className={s.hubIcon} aria-hidden="true">
            <Icon name="sliders" size={20} />
          </span>
          <h2 className={s.hubName}>Scenarios</h2>
          <p className={s.hubBlurb}>What-if: move a price, a volume or a metric and see every figure that depends on it — side by side with the baseline.</p>
          <Link className={buttonClass('secondary', 'sm')} to={`/analytics/scenarios/${projectId}`}>
            Open scenarios
          </Link>
        </li>
        <li className={s.hubCard}>
          <span className={s.hubIcon} aria-hidden="true">
            <Icon name="code" size={20} />
          </span>
          <h2 className={s.hubName}>SQL query</h2>
          <p className={s.hubBlurb}>Every dataset in this project is a table: join, filter and aggregate them in SQL, with typed [[parameters]], and save the result as a dataset that stays up to date.</p>
          <Link className={buttonClass('secondary', 'sm')} to={`/analytics/${projectId}/sql`}>
            Open SQL
          </Link>
        </li>
        <li className={s.hubCard}>
          <span className={s.hubIcon} aria-hidden="true">
            <Icon name="calendar" size={20} />
          </span>
          <h2 className={s.hubName}>Events</h2>
          <p className={s.hubBlurb}>Launches, campaigns, incidents and holidays: every chart with a date axis marks them, and findings that change during one name it.</p>
          <Link className={buttonClass('secondary', 'sm')} to={`/analytics/${projectId}/events`}>
            Open events
          </Link>
        </li>
      </ul>
    </Page>
  );
}

export default function AnalyticsPage() {
  return (
    <ProjectGate title="Analytics" why="The workbenches analyse a project's data.">
      {(projectId) => <Hub projectId={projectId} />}
    </ProjectGate>
  );
}
