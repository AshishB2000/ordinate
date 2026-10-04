// The one entry for the three grid chart ids (renderResult.renderVizInArea's
// dispatch): `pivot` → PivotTable over data.pivot, `cohort` / `event_funnel`
// → the engine views over data.cohort / data.eventFunnel — each with the
// desktop's empty state when the encoding cannot draw yet.

import { EmptyState } from '../../ui/States';
import type { ChartDataShape } from '../types';
import { CohortView, FunnelView, type EngineData } from './Engine';
import type { CohortGridShape, EventFunnelShape, PivotGridShape, PivotSort } from './model';
import { PivotTable } from './PivotTable';
import { t } from './strings';

export const GRID_IDS: ReadonlySet<string> = new Set(['pivot', 'cohort', 'event_funnel']);

export type GridData = ChartDataShape & { pivot?: PivotGridShape; cohort?: CohortGridShape; eventFunnel?: EventFunnelShape };

export function GridViz({
  type,
  data,
  label,
  onSort,
  exportData,
  fill,
}: {
  type: string;
  data: GridData;
  label: string;
  /** Pivot: re-ask the server sorted. */
  onSort?: (sort: PivotSort) => void;
  /** Cohort / funnel: the Share-policy-shaped reply, for Export CSV. */
  exportData?: () => Promise<EngineData>;
  fill?: boolean;
}) {
  if (type === 'pivot') {
    if (!data.pivot || !Array.isArray(data.pivot.cells)) {
      return <EmptyState icon="table" title={t('pivotRender.pick_a_row_dimension_and_at')} compact heading={3} />;
    }
    return <PivotTable grid={data.pivot} label={label} onSort={onSort} fill={fill} />;
  }
  if (type === 'cohort') {
    const g = data.cohort;
    if (!g || g.needs || !g.cohorts.length) {
      return (
        <EmptyState icon="grid" title={g ? g.needs || t('cohortRender.no_events_to_group_yet') : t('cohortRender.build_a_cohort_from_a_dataset')} compact heading={3}>
          {t('cohortRender.members_are_grouped_by_the_period')}
        </EmptyState>
      );
    }
    return <CohortView data={data as EngineData & { cohort: CohortGridShape }} label={label} exportData={exportData} fill={fill} />;
  }
  const f = data.eventFunnel;
  if (!f || f.needs) {
    return (
      <EmptyState icon="filter" title={f ? f.needs : t('cohortRender.build_an_event_funnel_from_a')} compact heading={3}>
        {t('cohortRender.entities_move_through_the_steps_in')}
      </EmptyState>
    );
  }
  return <FunnelView data={data as EngineData & { eventFunnel: EventFunnelShape }} label={label} exportData={exportData} fill={fill} />;
}
