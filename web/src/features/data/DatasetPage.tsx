// /data/:projectId/:datasetId — a dataset's rows in the DataGrid, paged from
// the server. The shell of the dataset page: T2.3 adds the profile, search,
// sort, prepare and lineage around the same grid.

import { useMemo } from 'react';
import { useParams } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { datasetPageSource, useDatasetColumns } from '../../api/datasets';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { DataGrid } from '../../ui/DataGrid/DataGrid';
import s from './DatasetPage.module.css';

export default function DatasetPage() {
  const { projectId, datasetId } = useParams();
  const q = useDatasetColumns(projectId, datasetId);
  const source = useMemo(
    () => (projectId && datasetId ? datasetPageSource(projectId, datasetId) : null),
    [projectId, datasetId],
  );

  if (q.isPending || !source) return <PageSkeleton />;
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
        <EmptyState icon="database" title="Dataset not found">
          It may have been deleted, or moved to the Trash with its project.
        </EmptyState>
      </Page>
    );
  }
  const d = q.data;
  const rows = d.rowCount === 1 ? '1 row' : `${formatNumber(d.rowCount)} rows`;
  const cols = d.columns.length === 1 ? '1 column' : `${d.columns.length} columns`;
  return (
    <Page title={d.name} sub={`${rows} · ${cols}`}>
      <div className={s.grid}>
        <DataGrid columns={d.columns} source={source} label={`${d.name} rows`} />
      </div>
    </Page>
  );
}
