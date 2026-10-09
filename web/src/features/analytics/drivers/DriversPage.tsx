// /analytics/:projectId/:datasetId/drivers — "Why did this change?" asked of a
// dataset: a measure (a number column and how it rolls up) and the date column
// whose two latest periods it compares — the same question an alert event's
// "Why?" asks (drivers:explain with compare 'latest'). The desktop's other
// doors — a KPI card with Compare on, a point on a line chart — ask through
// DriversView with their own request when their screens port.

import { useState } from 'react';
import { formatNumber } from '../../../../../src/app/format.ts';
import type { DatasetColumns } from '../../../api/datasets';
import { EmptyState } from '../../../ui/States';
import { Select } from '../../../ui/Select';
import { DatasetRoute, WorkbenchHead } from '../Workbench';
import type { DriversRequest } from '../api';
import { DriversView } from './DriversView';
import a from '../Analytics.module.css';
import s from './Drivers.module.css';

type Agg = NonNullable<DriversRequest['metric']['aggregation']>;
const AGGS: Array<{ value: Agg; label: string }> = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'count', label: 'Count' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
];

function Drivers({ projectId, datasetId, ds }: { projectId: string; datasetId: string; ds: DatasetColumns }) {
  const nums = ds.columns.filter((c) => c.type === 'number').map((c) => c.name);
  const dates = ds.columns.filter((c) => c.type === 'date').map((c) => c.name);
  // A money-like measure first (revenue, sales, amount), as a KPI usually is.
  const [column, setColumn] = useState(nums.find((c) => /revenue|sales|amount|total/i.test(c)) ?? nums[0] ?? '');
  const [agg, setAgg] = useState<Agg>('sum');
  const [date, setDate] = useState(dates[0] ?? '');
  const request: DriversRequest | null =
    column && date ? { datasetId, metric: { column, aggregation: agg }, compare: { mode: 'latest', column: date }, path: [] } : null;
  return (
    <div className={a.wb}>
      <WorkbenchHead
        icon="trending-up"
        title="Why did this change?"
        sub={`${ds.name} · ${formatNumber(ds.rowCount)} rows · the latest period against the one before`}
        projectId={projectId}
        datasetId={datasetId}
        kind="drivers"
        back={{ to: `/analytics?project=${projectId}`, label: 'Close' }}
      />
      {!nums.length || !dates.length ? (
        <div className={a.state}>
          <EmptyState icon="calendar" title="Nothing to explain here">
            {!dates.length
              ? 'A change is explained between two periods, and this dataset has no date column to cut them on.'
              : 'This dataset has no number column to measure.'}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className={s.question} role="group" aria-label="The question">
            <Select label="Measure" value={column} options={nums.map((c) => ({ value: c, label: c }))} onValueChange={setColumn} />
            <Select label="Rolled up as" value={agg} options={AGGS} onValueChange={(v) => setAgg(v as Agg)} />
            <Select label="Periods from" value={date} options={dates.map((c) => ({ value: c, label: c }))} onValueChange={setDate} />
          </div>
          {request && <DriversView key={JSON.stringify(request)} projectId={projectId} request={request} />}
        </>
      )}
    </div>
  );
}

export default function DriversPage() {
  return (
    <DatasetRoute title="Why did this change?" kind="drivers">
      {(projectId, datasetId, ds) => <Drivers key={datasetId} projectId={projectId} datasetId={datasetId} ds={ds} />}
    </DatasetRoute>
  );
}
