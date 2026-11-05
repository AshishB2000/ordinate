// The picked dataset's panel on the Data model's Datasets tab: its name, role and description, its
// Details popover (description, tags, owner), the way to the dataset itself, and four tabs (?panel=):
// Overview, Fields, Guide and Lineage. Each edits through the editor the dataset page already has.
// A Live dataset's panel reads metadata only: no tab here asks a row channel for it.

import { Link, useSearchParams } from 'react-router';
import { useDatasetColumns, type DatasetSummary } from '../../../api/datasets';
import { StatusActions } from '../status/StatusActions';
import { StatusBadge } from '../status/StatusBadge';
import { Badge } from '../../../ui/Badge';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../../ui/Tabs';
import { TableGuide } from '../../data/AboutTab';
import { RecordDetails } from '../../data/Details';
import { ago } from '../../data/format';
import { useTableDoc } from '../../data/tableApi';
import { useRoles } from '../../projects/api';
import type { ModelTable } from '../api';
import { ColumnLineage } from '../lineage/ColumnLineage';
import { FieldsPanel } from './FieldsPanel';
import { SourceNotes } from './SourceNotes';
import { OverviewPanel } from './OverviewPanel';
import m from '../Model.module.css';

const ROLE_WORD = { fact: 'Fact', dimension: 'Dimension' } as const;
const PANELS = ['overview', 'fields', 'guide', 'lineage'] as const;
type PanelId = (typeof PANELS)[number];

function Body({ projectId, dataset, table }: { projectId: string; dataset: DatasetSummary; table: ModelTable | undefined }) {
  const [params, setParams] = useSearchParams();
  const doc = useTableDoc(projectId, dataset.id);
  const header = useDatasetColumns(projectId, dataset.id);
  // Held on the skeleton until the roles are known too: an editor never reads the viewer's version first.
  const roles = useRoles();
  const asked = params.get('panel');
  const panel: PanelId = (PANELS as readonly string[]).includes(asked ?? '') ? (asked as PanelId) : 'overview';
  const setPanel = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v === 'overview') q.delete('panel');
      else q.set('panel', v);
      return q;
    }, { replace: true });

  if (doc.isPending || header.isPending || roles.isPending) {
    return (
      <div className={m.bodyLoading}>
        <SkeletonBlock label={`Loading ${dataset.name}`} />
      </div>
    );
  }
  if (doc.isError || header.isError) {
    return (
      <ErrorState
        heading={3}
        title={`${dataset.name} could not be loaded`}
        message={(doc.error ?? header.error)?.message || 'Try again.'}
        onRetry={() => {
          void doc.refetch();
          void header.refetch();
        }}
      />
    );
  }
  if (!header.data) {
    return (
      <EmptyState icon="database" heading={3} title="This dataset is gone">
        It may have been deleted, or moved to the Trash.
      </EmptyState>
    );
  }
  const at = { projectId, datasetId: dataset.id, table: doc.data };
  return (
    <Tabs value={panel} onValueChange={setPanel}>
      <TabList label={`About ${dataset.name}`}>
        <Tab value="overview" icon="info">
          Overview
        </Tab>
        <Tab value="fields" icon="columns">
          Fields
        </Tab>
        <Tab value="guide" icon="file-text">
          Guide
        </Tab>
        <Tab value="lineage" icon="lineage">
          Lineage
        </Tab>
      </TabList>
      <TabPanel value="overview">
        <OverviewPanel projectId={projectId} dataset={dataset} header={header.data} doc={doc.data} table={table} onLineage={() => setPanel('lineage')} />
      </TabPanel>
      <TabPanel value="fields">
        <FieldsPanel projectId={projectId} header={header.data} table={table} />
      </TabPanel>
      <TabPanel value="guide">
        <div className={m.guide}>
          <TableGuide {...at} />
          {doc.data.updatedAt && <p className={m.stamp}>{`Updated by ${doc.data.updatedBy || 'someone'} · ${ago(doc.data.updatedAt)}`}</p>}
        </div>
        <SourceNotes projectId={projectId} datasetId={dataset.id} />
      </TabPanel>
      <TabPanel value="lineage">
        <ColumnLineage projectId={projectId} datasetId={dataset.id} columns={header.data.columns} />
      </TabPanel>
    </Tabs>
  );
}

export function DatasetPanel({ projectId, dataset, table }: { projectId: string; dataset: DatasetSummary; table: ModelTable | undefined }) {
  const role = table?.role || '';
  const description = table?.description ?? '';
  return (
    <section className={m.panel} aria-label={`About ${dataset.name}`}>
      <div className={m.panelHead}>
        <div>
          <div className={m.panelTitle}>
            <h2>{dataset.name}</h2>
            {role ? <Badge tone={role === 'fact' ? 'neutral' : 'ok'}>{ROLE_WORD[role]}</Badge> : <Badge>Role not set</Badge>}
            {dataset.mode === 'live' && <Badge tone="accent">Live</Badge>}
            <StatusBadge status={dataset.status} />
          </div>
          <p className={description ? m.desc : `${m.desc} ${m.muted}`}>{description || 'No description yet'}</p>
        </div>
        <div className={m.panelActions}>
          <StatusActions projectId={projectId} kind="dataset" id={dataset.id} name={dataset.name} status={dataset.status} />
          <RecordDetails projectId={projectId} kind="dataset" id={dataset.id} name={dataset.name} trigger={<Button size="sm" icon="info">Details</Button>} />
          <Link className={buttonClass('ghost', 'sm')} to={`/data/${projectId}/${dataset.id}`}>
            <Icon name="external-link" size={16} />
            <span>Open dataset</span>
          </Link>
        </div>
      </div>
      <Body projectId={projectId} dataset={dataset} table={table} />
    </section>
  );
}
