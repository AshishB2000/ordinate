// What the builder's stage draws for the chosen type (renderVizInArea's
// ladder): a map through MapView, the table through DataTable, a Chart.js
// chart through <Chart>; a pivot / cohort / event funnel says honestly that
// its grid has not reached the browser; a type this data cannot draw says what
// it needs. The overlay caption (vs previous year) sits under a chart that
// draws the muted prior series.

import { useMemo, useRef, type ReactNode } from 'react';
import { Chart, type ChartHandle } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import { MapView } from '../../charts/maps/MapView';
import { isMapChartType } from '../../charts/maps/mapKinds';
import type { MapData } from '../../charts/maps/types';
import type { ChartDataShape, Overrides } from '../../charts/types';
import { EmptyState } from '../../ui/States';
import type { Preview } from './api';
import { GRID_TYPES } from './eligibility';
import { FacetGrid, facetGridOf, type PanelMark } from './facets/FacetGrid';
import { typeLabel } from './model';
import { VizIcon } from './VizIcon';
import s from './Builder.module.css';

const GRID_NAMES: Record<string, string> = { pivot: 'Pivot tables', cohort: 'Cohort grids', event_funnel: 'Event funnels' };
const OVERLAY_TYPES =new Set(['line', 'area', 'line_markers', 'column', 'clustered_column', 'bar', 'clustered_bar']);

/** A stage message: the type's glyph over one line (the desktop's .cv-chart-fallback). */
export function StageNote({ type = 'column', children }: { type?: string; children: ReactNode }) {
  return (
    <div className={s.fallback} role="note">
      <span className={s.fallbackGlyph}>
        <VizIcon type={type} size={22} />
      </span>
      <span>{children}</span>
    </div>
  );
}

export function ChartStage({
  projectId,
  type,
  reply,
  overrides,
  canRender,
  needs,
  label,
  onChart,
  onMark,
}: {
  projectId: string;
  type: string;
  reply: Preview;
  overrides: Overrides;
  canRender: boolean;
  needs: string;
  label: string;
  onChart: (c: ChartHandle | null) => void;
  /** A click on a mark (the drill): the chart to hit-test, and a facet panel's own filter steps. */
  onMark?: PanelMark;
}) {
  const held = useRef<ChartHandle | null>(null);
  const data = reply.data as ChartDataShape & { geo?: unknown };
  const grid = useMemo(() => facetGridOf(data, type, overrides), [data, type, overrides]);
  if (GRID_TYPES.has(type)) {
    return (
      <div className={s.gridNote}>
        <EmptyState icon="table" title={`${typeLabel(type)} isn’t in the browser yet`}>
          {GRID_NAMES[type]}, with their own shelves and server-computed subtotals, arrive in a coming update. A saved one keeps its definition
          here: edit it in the desktop app, or pick another chart type to draw these figures now.
        </EmptyState>
      </div>
    );
  }
  if (!canRender) return <StageNote type={type}>{`${typeLabel(type)} needs ${needs} — it doesn't fit this data.`}</StageNote>;
  if (type === 'table') return <DataTable data={data} label={label} />;
  if (isMapChartType(type)) return <MapView data={data as unknown as MapData} chartType={type} label={label} projectId={projectId} className={s.map} />;
  if (grid) return <FacetGrid grid={grid} data={data} type={type} overrides={overrides} onMark={onMark} />;
  const ov = reply.overlay;
  const pct = Number(ov?.pct);
  return (
    <>
      <div className={s.canvas} onClick={(e) => held.current && onMark?.(held.current, e.nativeEvent, [])}>
        <Chart
          type={type}
          data={data}
          overrides={overrides}
          label={label}
          onChart={(c) => {
            held.current = c;
            onChart(c);
          }}
        />
      </div>
      {ov?.caption && OVERLAY_TYPES.has(type) && (
        <p className={[s.caption, Number.isFinite(pct) && Math.abs(pct) >= 0.5 ? s.captionStrong : ''].join(' ')}>
          <span className={s.captionKey} aria-hidden="true" />
          <span>{ov.caption}</span>
        </p>
      )}
    </>
  );
}
