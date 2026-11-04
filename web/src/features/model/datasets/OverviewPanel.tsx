// A dataset's Overview on the Data model: what one row is, its role and key (edited in place, as on the
// dataset's About tab), the filters always applied to it, its quality checks, who may see what, and what
// is built on it. Every figure here is the server's; each row links to the screen that changes it.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { DatasetColumns, DatasetSummary } from '../../../api/datasets';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Skeleton } from '../../../ui/Skeleton';
import { GrainField, KeyField, RoleField } from '../../data/AboutTab';
import { useColumnDocs, useLineage, useQualityRules } from '../../data/api';
import { formatNumber } from '../../data/format';
import { usedInText } from '../../data/LineageDrawer';
import type { TableDoc } from '../../data/tableApi';
import { useCan } from '../../projects/api';
import { FilterSummary } from '../../visuals/filters/FilterRows';
import type { ModelTable } from '../api';
import m from '../Model.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={m.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const Busy = ({ label }: { label: string }) => (
  <span role="status" aria-busy="true" aria-label={label} className={m.rowBusy}>
    <Skeleton className={m.skLine} />
  </span>
);

function AlwaysApplied({ projectId, datasetId, table }: { projectId: string; datasetId: string; table: ModelTable | undefined }) {
  const live = table?.alwaysApplied.kind === 'live';
  const steps = table?.alwaysApplied.steps ?? [];
  return (
    <div className={m.stack}>
      {steps.length ? (
        <ul className={m.steps}>
          {steps.map((step, i) => (
            <li key={i}>
              {table?.valuesHidden ? (
                `${step.column} · values hidden by row access rules`
              ) : (
                <>
                  <span className={m.stepColumn}>{step.column}</span> <FilterSummary step={step} />
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span className={m.muted}>None</span>
      )}
      {live ? <Link to={`/data/${projectId}/${datasetId}?tab=schema`}>Open the Schema tab</Link> : <Link to={`/data/${projectId}/${datasetId}/prepare`}>Open Prepare</Link>}
    </div>
  );
}

function Quality({ projectId, dataset }: { projectId: string; dataset: DatasetSummary }) {
  const q = useQualityRules(projectId, dataset.id);
  if (q.isPending) return <Busy label="Loading the quality checks" />;
  const rules = q.data?.rules.length ?? 0;
  const failing = dataset.qualityFailing ?? 0;
  const verdict = q.isError ? (
    <span className={m.muted}>The checks could not be read</span>
  ) : !rules ? (
    <span className={m.muted}>No checks yet</span>
  ) : dataset.scoped ? (
    <span className={m.muted}>Hidden by row access rules</span>
  ) : !q.data?.latest ? (
    <span className={m.muted}>Not run yet</span>
  ) : failing > 0 ? (
    <Badge tone="warn">{`${formatNumber(failing)} failing`}</Badge>
  ) : (
    <Badge tone="ok">{`${formatNumber(rules)} ${rules === 1 ? 'check passes' : 'checks pass'}`}</Badge>
  );
  return (
    <span className={m.inline}>
      {verdict}
      <Link to={`/data/${projectId}/${dataset.id}?tab=quality`}>Quality checks</Link>
    </span>
  );
}

function Access({ projectId, dataset, header }: { projectId: string; dataset: DatasetSummary; header: DatasetColumns }) {
  const admin = useCan(projectId)('admin');
  const docs = useColumnDocs(projectId, dataset.id);
  const marked = (kind: 'personal' | 'financial') => header.columns.filter((c) => docs.data?.[c.name]?.sensitivity === kind).map((c) => c.name);
  const personal = marked('personal');
  const financial = marked('financial');
  const parts = [personal.length && `Personal: ${personal.join(', ')}`, financial.length && `Financial: ${financial.join(', ')}`].filter(Boolean);
  return (
    <div className={m.stack}>
      {docs.isPending ? (
        <Busy label="Loading the column notes" />
      ) : (
        <span className={parts.length ? undefined : m.muted}>{parts.length ? parts.join(' · ') : 'No column is marked personal or financial'}</span>
      )}
      {dataset.scoped && <span className={m.muted}>Row access rules limit what you see here</span>}
      {admin && <Link to={`/data/${projectId}/${dataset.id}?tab=access`}>Row access rules</Link>}
    </div>
  );
}

function UsedBy({ projectId, datasetId, onLineage }: { projectId: string; datasetId: string; onLineage: () => void }) {
  const g = useLineage(projectId, datasetId);
  const text = g.data ? usedInText(g.data.usedIn) : '';
  return (
    <span className={m.inline}>
      {g.isPending ? <Busy label="Loading what uses it" /> : <span className={text ? undefined : m.muted}>{text || 'Nothing is built on it yet'}</span>}
      <Button size="sm" variant="ghost" icon="lineage" onClick={onLineage}>
        See lineage
      </Button>
    </span>
  );
}

export function OverviewPanel({ projectId, dataset, header, doc, table, onLineage }: {
  projectId: string;
  dataset: DatasetSummary;
  header: DatasetColumns;
  doc: TableDoc;
  table: ModelTable | undefined;
  onLineage: () => void;
}) {
  const at = { projectId, datasetId: dataset.id, table: doc };
  return (
    <dl className={m.rows}>
      <Row label="What one row is">
        <GrainField {...at} rowLabel="What one row is" />
      </Row>
      <Row label="Role">
        <RoleField {...at} rowLabel="Role" />
      </Row>
      <Row label="Key">
        <KeyField {...at} header={header} live={dataset.mode === 'live'} rowLabel="Key" />
      </Row>
      <Row label="Always applied">
        <AlwaysApplied projectId={projectId} datasetId={dataset.id} table={table} />
      </Row>
      <Row label="Quality">
        <Quality projectId={projectId} dataset={dataset} />
      </Row>
      <Row label="Access">
        <Access projectId={projectId} dataset={dataset} header={header} />
      </Row>
      <Row label="Used by">
        <UsedBy projectId={projectId} datasetId={dataset.id} onLineage={onLineage} />
      </Row>
    </dl>
  );
}
