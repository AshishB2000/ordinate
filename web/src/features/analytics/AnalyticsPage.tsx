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

function Hub({ projectId }: { projectId: string }) {
  const list = useDatasets(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const datasets = list.data ?? [];
  const id = picked && datasets.some((d) => d.id === picked) ? picked : (datasets[0]?.id ?? null);
  const chosen = datasets.find((d) => d.id === id);
  return (
    <Page title="Analytics" sub="Every statistic, driver, scenario and segment is computed by Ordinate from your data — the Assistant only puts them into words.">
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
            {chosen && <p className={s.hubNote}>{`${formatNumber(chosen.rowCount)} rows · ${chosen.columnCount} columns`}</p>}
          </div>
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
