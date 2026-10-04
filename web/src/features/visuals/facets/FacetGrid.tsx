// Small multiples — the trellis grid (facetGrid.ts). Two things arrive here:
//   • a faceted visual — `data.facets`, the grid the SERVER computed (panels,
//     titles, the filter steps behind each, the shared value domain);
//   • a share chart (pie, donut, gauge, treemap, funnel, histogram) over 2+
//     series — one panel per series, because those types cannot stack series.
// Every panel is an ordinary <Chart> over that panel's {labels, series}; a
// shared scale spans the union domain the server computed. Computes nothing.

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { chartSeries } from '../../../charts/build';
import { Chart, type ChartHandle } from '../../../charts/Chart';
import { isMapChartType } from '../../../charts/maps/mapKinds';
import { chartIsSmallMultiple } from '../../../charts/traits';
import type { ChartDataShape, ChartSeriesShape, Cx, Overrides } from '../../../charts/types';
import s from './Facets.module.css';

interface Panel {
  row: number;
  col: number;
  title: string;
  steps: Cx[];
  labels: Cx[];
  series: ChartSeriesShape[];
  empty: boolean;
  analytics?: Cx[];
  pivot?: Cx;
  seriesName?: string;
}
export interface Grid {
  rows: string[];
  cols: string[];
  scale: 'shared' | 'independent';
  domain: { min: number; max: number; stackMin: number; stackMax: number } | null;
  panels: Panel[];
  folded?: boolean;
}

/** What a click on a panel's mark carries out: the chart to hit-test and the panel's own filters. */
export type PanelMark = (chart: ChartHandle, e: MouseEvent, steps: Cx[], seriesName?: string) => void;

/** The grid to draw for `data` as `type`, or null for one ordinary chart. */
export function facetGridOf(data: ChartDataShape & { facets?: Grid }, type: string, overrides?: Overrides): Grid | null {
  if (type === 'table' || type === 'cohort' || type === 'event_funnel' || isMapChartType(type)) return null;
  const g = data && data.facets;
  if (g && Array.isArray(g.panels) && g.panels.length) return g;
  const series = chartSeries(data);
  if (!chartIsSmallMultiple(type, series.length)) return null;
  // Periods ▾ on a share chart hides PANELS (one per series).
  const hidden = new Set(Array.isArray(overrides?.hiddenSeries) ? (overrides!.hiddenSeries as number[]) : []);
  const panels: Panel[] = [];
  series.forEach((x, i) => {
    if (hidden.has(i)) return;
    panels.push({ row: 0, col: panels.length, title: x.name || `Series ${i + 1}`, steps: [], labels: data.labels || [], series: [x], empty: false, seriesName: x.name });
  });
  return { rows: [], cols: panels.map((p) => p.title), scale: 'independent', domain: null, panels };
}

/** What Values / Periods should list for a faceted reply: ONE panel's series, not the flattened set. */
export function facetControlsData<T extends ChartDataShape & { facets?: Grid }>(data: T): T {
  const p = data && data.facets && Array.isArray(data.facets.panels) ? data.facets.panels.find((x) => !x.empty) : null;
  return p ? { ...data, labels: p.labels, series: p.series } : data;
}

/** A shared scale: every panel's value axis spans the union domain. */
function shareScale(grid: Grid, chart: ChartHandle | null): void {
  if (!chart || grid.scale !== 'shared' || !grid.domain) return;
  const scales = chart.options && chart.options.scales;
  const axis = scales && scales[chart.options.indexAxis === 'y' ? 'x' : 'y'];
  if (!axis || axis.type === 'category' || typeof axis.max === 'number') return; // a 0–100% axis is already shared
  axis.suggestedMin = axis.stacked ? grid.domain.stackMin : grid.domain.min;
  axis.suggestedMax = axis.stacked ? grid.domain.stackMax : grid.domain.max;
  chart.update('none');
}

type Swatch = { label: string; color: string };

function PanelChart({ p, grid, data, type, ov, onMark, onLegend }: {
  p: Panel;
  grid: Grid;
  data: ChartDataShape;
  type: string;
  ov: Overrides;
  onMark?: PanelMark;
  onLegend?: (l: Swatch[]) => void;
}) {
  const chart = useRef<ChartHandle | null>(null);
  const panelData = useMemo(() => ({ ...data, labels: p.labels, series: p.series, analytics: p.analytics ?? undefined }), [data, p]);
  return (
    <div className={s.canvas} onClick={(e) => chart.current && onMark?.(chart.current, e.nativeEvent, p.steps, p.seriesName)}>
      <Chart
        type={type}
        data={panelData}
        overrides={ov}
        label={`${p.title} chart`}
        onChart={(c) => {
          chart.current = c;
          shareScale(grid, c);
          if (c && onLegend) {
            onLegend(
              (c.data.datasets as Cx[])
                .filter((d) => typeof d.label === 'string')
                .map((d) => ({ label: d.label as string, color: [d.borderColor, d.backgroundColor].find((x) => typeof x === 'string') ?? '' })),
            );
          }
        }}
      />
    </div>
  );
}

export function FacetGrid({ grid, data, type, overrides, onMark }: { grid: Grid; data: ChartDataShape; type: string; overrides: Overrides; onMark?: PanelMark }) {
  const [legend, setLegend] = useState<Swatch[]>([]);
  const gridLegend = overrides.showLegend === undefined; // one legend under the grid, not one per panel
  const ov = useMemo(() => {
    const o: Overrides = { ...overrides, _smallMultiple: true };
    delete o.title; // the panel title already names the value
    delete o.commentPins;
    if (!(data as { facets?: Grid }).facets) delete o.hiddenSeries; // share charts: Periods picked the panels above
    if (o.showLegend === undefined) o.showLegend = false;
    return o;
  }, [overrides, data]);
  const matrix = grid.rows.length > 0;
  const firstDrawn = grid.panels.findIndex((p) => !p.empty && !p.pivot);

  const cells: ReactNode[] = [];
  if (matrix) {
    cells.push(<div key="corner" />);
    grid.cols.forEach((c, i) =>
      cells.push(
        <div key={`h${i}`} className={s.headCell} title={c}>
          {c}
        </div>,
      ),
    );
  }
  let row = -1;
  grid.panels.forEach((p, i) => {
    if (matrix && p.row !== row) {
      row = p.row;
      cells.push(
        <div key={`r${row}`} className={s.rowHead} title={grid.rows[row]}>
          {grid.rows[row]}
        </div>,
      );
    }
    cells.push(
      <div key={i} className={p.empty ? `${s.cell} ${s.isEmpty}` : s.cell} aria-label={p.title} role="group">
        {!matrix && (
          <div className={s.cellTitle} title={p.title}>
            {p.title}
          </div>
        )}
        {p.empty ? (
          <div className={s.none}>No data</div>
        ) : p.pivot ? (
          <div className={s.none}>Pivot grids arrive in a coming update.</div>
        ) : (
          <PanelChart
            p={p}
            grid={grid}
            data={data}
            type={type}
            ov={ov}
            onMark={onMark}
            onLegend={i === firstDrawn && gridLegend ? (l) => setLegend((prev) => (JSON.stringify(prev) === JSON.stringify(l) ? prev : l)) : undefined}
          />
        )}
      </div>,
    );
  });

  return (
    <div className={s.wrap}>
      <div className={s.scroll}>
        <div
          className={matrix ? `${s.grid} ${s.matrix}` : s.grid}
          role="group"
          aria-label="Small multiples"
          style={matrix ? ({ '--fc-cols': String(grid.cols.length) } as CSSProperties) : undefined}
        >
          {cells}
        </div>
      </div>
      {gridLegend && legend.length > 1 && (
        <div className={s.legend}>
          {legend.map((l) => (
            <span key={l.label} className={s.legendItem}>
              <span className={s.swatch} style={l.color ? { background: l.color } : undefined} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {grid.folded && <p className={s.note}>Values past the panel limit are grouped as Other.</p>}
    </div>
  );
}
