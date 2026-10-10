// /data/:projectId/:datasetId — one dataset (dsExplorer.ts, dsLineage.ts,
// dataSection.ts's tabs): its identity header — source, tags, freshness,
// schedule, what it is built from and what uses it — then the tabs: the
// rows (Data), the checks (Quality), the column docs (Columns), what the app
// found (Insights) and the versions kept on refresh (Snapshots, T2.11). Tab,
// profiled column and grid filter live in the URL, so a link reopens them.

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useDatasetColumns, useDatasets, type DatasetSummary } from '../../api/datasets';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { EmptyState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { useLineage, useSource, useTags } from './api';
import { ColumnsTab } from './ColumnsTab';
import { DataTab } from './DataTab';
import { QualityDot, SchedulePicker, useDeleteDataset, useRefresh, WatchToggle } from './DatasetList';
import { BehindBadge } from './cadence';
import { FreshOnAskPicker } from './FreshOnAsk';
import { IncrementalButton } from './Incremental';
import { useCanEdit } from '../projects/api';
import { useAdoptProject } from '../projects/current';
import { RecordDetails } from './Details';
import { formatNumber, freshness, NOT_REFRESHABLE, rowsText } from './format';
import { LineageDrawer, usedInText } from './LineageDrawer';
import { QualityTab } from './QualityTab';
import { TagChips, tagsOf } from './tags';
import { InsightsTab } from '../analytics/insights/InsightsTab';
import { SnapshotsTab } from '../analytics/snapshots/SnapshotsTab';
import s from './Data.module.css';
import { CommentDoor } from '../dashboards/CommentsPanel';
import { LiveBadge, SwitchToLiveDialog } from './LiveMode';
import { LiveTabs } from './LiveDataset';
import { CacheAgePicker, LiveSwitch, RefreshNow } from './LiveSettings';
import { RefreshUrlDialog } from './RefreshUrl';

const TABS = ['data', 'quality', 'columns', 'insights', 'snapshots'] as const;
type TabId = (typeof TABS)[number];

/** Reads from / Used by — the datasets this one is built from, and the SQL datasets built on it. */
function LineageLine({ projectId, id, list }: { projectId: string; id: string; list: DatasetSummary[] }) {
  const me = list.find((d) => d.id === id);
  const up = me?.originDeps ?? [];
  const down = list.filter((d) => (d.originKind === 'sql' || d.originKind === 'notebook') && d.originDeps?.includes(id));
  if (!up.length && !down.length) return null;
  const chip = (dsId: string, label: string | undefined, kind = '') =>
    label ? (
      <Link key={dsId} className={s.lineChip} to={`/data/${projectId}/${dsId}`} title={`Open ${label}`}>
        <Icon name={kind === 'sql' ? 'code' : kind === 'notebook' ? 'file-text' : 'database'} size={16} />
        {label}
      </Link>
    ) : (
      <span key={dsId} className={`${s.lineChip} ${s.lineGone}`} title="This dataset has been deleted">
        <Icon name="database" size={16} />
        Deleted dataset
      </span>
    );
  return (
    <div className={s.lineage}>
      {up.length > 0 && (
        <span className={s.lineGroup}>
          <span className={s.lineLabel}>Reads from</span>
          {up.map((u) => {
            const d = list.find((x) => x.id === u);
            return chip(u, d?.name, d?.sourceKind);
          })}
        </span>
      )}
      {down.length > 0 && (
        <span className={s.lineGroup}>
          <span className={s.lineLabel}>Used by</span>
          {down.map((d) => chip(d.id, d.name, d.originKind))}
        </span>
      )}
    </div>
  );
}

function Header({ projectId, id, name, rowCount, columnCount, live }: { projectId: string; id: string; name: string; rowCount: number; columnCount: number; live: boolean }) {
  const navigate = useNavigate();
  const list = useDatasets(projectId);
  const source = useSource(projectId, id);
  const tags = useTags(projectId);
  const lineage = useLineage(projectId, id);
  const refresh = useRefresh(projectId);
  const remove = useDeleteDataset(projectId, () => void navigate(`/data/${projectId}`));
  const [graph, setGraph] = useState(false);
  const [goLive, setGoLive] = useState(false);
  const [hooks, setHooks] = useState(false);
  // Everything here that changes the dataset — its schedule, mode, steps, a refresh, the Trash — is an editor's.
  const canEdit = useCanEdit(projectId);
  const d = list.data?.find((x) => x.id === id);
  const outcome = refresh.state[id];
  return (
    <header className={s.dsHead}>
      <Link className={buttonClass('ghost', 'sm', s.back)} to={`/data/${projectId}`}>
        <Icon name="arrow-left" />
        <span>Datasets</span>
      </Link>
      <div className={s.dsTop}>
        <div className={s.dsIdent}>
          <div className={s.dsTitleRow}>
            <h1 className={s.title}>{name}</h1>
            {source.data && (
              <span className={s.badge} title={source.data.refreshable ? 'Where the rows come from' : NOT_REFRESHABLE}>
                {source.data.label}
              </span>
            )}
            {live && <LiveBadge maxCacheAgeSec={source.data?.maxCacheAgeSec} />}
            <TagChips tags={tagsOf(tags.data, `dataset:${id}`)} max={4} />
          </div>
          <div className={s.dsMeta}>
            <span>
              {/* A Live dataset keeps no rows here: the badge and the freshness line say Live. */}
              {live ? '' : `${rowsText(rowCount)} · `}
              {formatNumber(columnCount)} {columnCount === 1 ? 'column' : 'columns'}
            </span>
            {d && (
              <span className={s.freshLine} title={d.lastRefreshStatus === 'error' ? d.lastRefreshError || 'The last refresh failed.' : undefined}>
                <QualityDot n={d.qualityFailing} />
                {d.lastRefreshStatus === 'error' && <span className={s.failDot} role="img" aria-label="Last refresh failed" />}
                {freshness(d)}
                <BehindBadge behind={d.behindSchedule} />
              </span>
            )}
            {canEdit && d && <SchedulePicker projectId={projectId} d={d} />}
            {/* A Live dataset's settings (L2.6): its cache age is its schedule; Refresh now resets the cache. */}
            {live && <CacheAgePicker projectId={projectId} datasetId={id} name={name} maxCacheAgeSec={source.data?.maxCacheAgeSec ?? d?.maxCacheAgeSec} />}
            <LiveSwitch projectId={projectId} datasetId={id} name={name} live={live} canGoLive={!!source.data?.canGoLive} rowCount={rowCount} />
            {canEdit && d && <IncrementalButton projectId={projectId} d={d} />}
            {canEdit && d && <FreshOnAskPicker projectId={projectId} d={d} />}
            {canEdit && d && <WatchToggle projectId={projectId} d={d} />}
            {lineage.data && (
              <button type="button" className={s.usedIn} onClick={() => setGraph(true)}>
                <Icon name="lineage" size={16} />
                {usedInText(lineage.data.usedIn) || 'Not used yet'}
              </button>
            )}
            {live ? (
              <RefreshNow projectId={projectId} datasetId={id} />
            ) : (
              canEdit &&
              d?.originKind && (
                <Button size="sm" icon="refresh" loading={outcome?.busy} onClick={() => void refresh.run(id)}>
                  Refresh
                </Button>
              )
            )}
          </div>
          {outcome?.message && (
            <p className={outcome.error ? s.rowError : s.rowNote} role="status">
              {outcome.message}
            </p>
          )}
          {list.data && <LineageLine projectId={projectId} id={id} list={list.data} />}
        </div>
        <div className={s.dsActions}>
          {/* The reversible step pipeline (T2.6): its own page, the rows beside the steps. Off for Live (L2.1). */}
          {canEdit && !live && (
            <Link className={buttonClass('secondary', 'sm')} to={`/data/${projectId}/${id}/prepare`}>
              <Icon name="sliders" />
              <span>Prepare</span>
            </Link>
          )}
          {/* A SQL dataset's own statement, in the SQL workbench (queryTab.ts qtOpenWithSql, T2.11). */}
          {d?.originKind === 'sql' && (
            <Link className={buttonClass('secondary', 'sm')} to={`/analytics/${projectId}/sql?dataset=${id}`}>
              <Icon name="code" />
              <span>View query</span>
            </Link>
          )}
          {canEdit && (
            <>
              <Link className={buttonClass('primary', 'sm')} to={`/visuals?project=${projectId}&datasetId=${id}`}>
                New visual
              </Link>
              {/* The dashboard wizard on this dataset, at "Start from" (T2.8; dsExplorer's "New dashboard"). */}
              <Link className={buttonClass('secondary', 'sm')} to={`/analyses?project=${projectId}&new=1&dataset=${id}`}>
                New dashboard
              </Link>
            </>
          )}
          <CommentDoor projectId={projectId} kind="dataset" id={id} />
          <RecordDetails projectId={projectId} kind="dataset" id={id} name={name} trigger={<Button size="sm" icon="info">Details</Button>} />
          <Menu
            align="end"
            label="More dataset actions"
            trigger={<IconButton icon="more-horizontal" size="sm" label="More dataset actions" />}
            items={[
              { label: 'Lineage', icon: 'lineage', onSelect: () => setGraph(true) },
              // A URL dbt or Airflow calls to refresh it (live data L0.5): only where there is a source to refresh from.
              ...(canEdit && (d?.originKind || live) ? [{ label: 'Refresh URL…', icon: 'link' as const, onSelect: () => setHooks(true) }] : []),
              ...(canEdit && source.data?.canGoLive ? [{ label: 'Switch to Live…', icon: 'zap' as const, onSelect: () => setGoLive(true) }] : []),
              { label: 'Pipeline history', icon: 'history', onSelect: () => void navigate(`/versions/${projectId}/dataset/${id}`) },
              ...(canEdit ? [{ kind: 'separator' as const }, { label: 'Move to Trash', icon: 'trash' as const, danger: true, disabled: !d, onSelect: () => d && remove(d) }] : []),
            ]}
          />
        </div>
      </div>
      {graph && <LineageDrawer projectId={projectId} id={id} name={name} onClose={() => setGraph(false)} />}
      {goLive && <SwitchToLiveDialog projectId={projectId} datasetId={id} name={name} rowCount={rowCount} onClose={() => setGoLive(false)} />}
      {hooks && <RefreshUrlDialog projectId={projectId} datasetId={id} name={name} live={live} onClose={() => setHooks(false)} />}
    </header>
  );
}

export default function DatasetPage() {
  const { projectId = '', datasetId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useDatasetColumns(projectId, datasetId);
  // The URL names the project: the shell's switcher shows it (T2.2).
  useAdoptProject(projectId);
  const list = useDatasets(projectId);
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'data';
  const setTab = (v: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v === 'data') n.delete('tab');
      else n.set('tab', v);
      return n;
    }, { replace: true });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Dataset">
        <ErrorState title="This dataset could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data) {
    return (
      <Page title="Dataset">
        <EmptyState
          icon="database"
          title="Dataset not found"
          actions={
            <Link className={buttonClass('primary')} to={`/data/${projectId}`}>
              Back to datasets
            </Link>
          }
        >
          It may have been deleted, or moved to the Trash with its project.
        </EmptyState>
      </Page>
    );
  }
  const header = q.data;
  const failing = list.data?.find((x) => x.id === datasetId)?.qualityFailing;
  // A Live dataset keeps no rows here: its Data tab says so, and the tabs that read rows are off (L2.1).
  const live = header.mode === 'live';
  const maxCacheAgeSec = list.data?.find((x) => x.id === datasetId)?.maxCacheAgeSec;
  if (live) {
    return (
      <div className={s.page}>
        <Header projectId={projectId} id={datasetId} name={header.name} rowCount={header.rowCount} columnCount={header.columns.length} live />
        <LiveTabs projectId={projectId} datasetId={datasetId} header={header} tab={asked ?? 'data'} onTab={setTab} maxCacheAgeSec={maxCacheAgeSec} />
      </div>
    );
  }
  return (
    <div className={s.page}>
      <Header projectId={projectId} id={datasetId} name={header.name} rowCount={header.rowCount} columnCount={header.columns.length} live={false} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Dataset views">
          <Tab value="data" icon="table">
            Data
          </Tab>
          <Tab value="quality" icon="circle-check" count={failing ? `${formatNumber(failing)} failing` : undefined}>
            Quality
          </Tab>
          <Tab value="columns" icon="columns">
            Columns
          </Tab>
          {/* T2.11: what the app found in this table, and the versions kept on refresh. */}
          <Tab value="insights" icon="zap">
            Insights
          </Tab>
          <Tab value="snapshots" icon="history">
            Snapshots
          </Tab>
        </TabList>
        <TabPanel value="data">
          <DataTab projectId={projectId} datasetId={datasetId} header={header} />
        </TabPanel>
        <TabPanel value="quality">
          <QualityTab projectId={projectId} datasetId={datasetId} header={header} />
        </TabPanel>
        <TabPanel value="columns">
          <ColumnsTab projectId={projectId} datasetId={datasetId} header={header} />
        </TabPanel>
        <TabPanel value="insights">
          <InsightsTab projectId={projectId} datasetId={datasetId} />
        </TabPanel>
        <TabPanel value="snapshots">
          <SnapshotsTab projectId={projectId} datasetId={datasetId} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
