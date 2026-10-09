// One saved visual drawn from the server's answer — a card on the sheet, a
// list card's preview, a draft's preview. The engines are the shared ones
// (web/src/charts, web/src/charts/maps); this file only picks which, and owns
// the tile's loading / error states. It computes nothing.

import { useMemo, useRef } from 'react';
import { Chart, type ChartHandle } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import { MapThumb } from '../../charts/maps/MapThumb';
import { MapView } from '../../charts/maps/MapView';
import type { MapData } from '../../charts/maps/types';
import type { ChartDataShape, Cx } from '../../charts/types';
import { VIZ_LABELS, VIZ_RENDERER, type VizId } from '../../charts/vizLabels';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { markAt } from '../visuals/drill/mark';
import { GRID_IDS, GridViz, type GridData } from '../../charts/grids/GridViz';
import { useTile, type ParamPayload, type Step, type VisualDef, type VisualTile } from './api';
import { useTileAsOf } from './editor/tileAsOf';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import s from './Tiles.module.css';

/** The family glyph a chart type wears where it is not drawn (a map preview, a missing visual). */
export function vizGlyph(type: string): IconName {
  if (type.startsWith('map_')) return 'map';
  if (type === 'table' || type === 'pivot' || type === 'cohort') return 'table';
  if (/line|area|candlestick/.test(type)) return type.includes('area') ? 'chart-area' : 'chart-line';
  if (/pie|donut|gauge/.test(type)) return 'chart-pie';
  if (/scatter|bubble|radar|heatmap|calendar|treemap|word_cloud|sankey/.test(type)) return 'grid';
  return 'chart-bar';
}

export const vizLabel = (type: string): string => VIZ_LABELS[type as VizId] ?? type;

/** A dashboard filter list merged in front of a card's own, exact duplicates dropped (dashboardFilters.mergeDashboardFilters). */
export function mergeFilters(dash: readonly Step[], own: readonly Step[]): Step[] {
  const out: Step[] = [];
  const seen = new Set<string>();
  for (const st of [...dash, ...own]) {
    if (!st || st.type !== 'filter') continue;
    const k = JSON.stringify([st.column, st.op, st.value ?? null, st.values ?? null, st.period ?? null, st.radius ?? null, st.context === true]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(st);
  }
  return out;
}

/** The thumbnail look (vizThumbs.ts): no legend, no grid, no value labels, the final frame at once. */
const THUMB = { showLegend: false, showGridlines: false, valueMode: 'off', noAnimate: true, showTooltips: false, title: '' };

/** Axis ticks, titles and borders off, and inert — what buildChart's overrides cannot say (vizThumbs.ts). */
export function trimThumb(chart: ChartHandle | null): void {
  if (!chart) return;
  const o = chart.options || {};
  o.events = [];
  for (const [k, sc] of Object.entries((o.scales || {}) as Record<string, Cx>)) {
    if (!sc) continue;
    if (k === 'r') {
      sc.pointLabels = { ...sc.pointLabels, display: false };
      continue;
    }
    sc.ticks = { ...sc.ticks, display: false };
    sc.grid = { ...sc.grid, display: false, drawOnChartArea: false };
    sc.border = { ...sc.border, display: false };
    if (sc.title) sc.title.display = false;
  }
  chart.update('none');
}

export function DrawnVisual({
  type,
  data,
  overrides,
  label,
  projectId,
  thumb,
  onChart,
  onMapMark,
}: {
  type: string;
  data: ChartDataShape & Record<string, unknown>;
  overrides?: Record<string, unknown>;
  label: string;
  projectId: string;
  thumb?: boolean;
  onChart?: (chart: ChartHandle | null) => void;
  /** A click on a map region or point (T2.9: the dashboard's selection or tile actions). */
  onMapMark?: (column: string | undefined, category: string) => void;
}) {
  const renderer = VIZ_RENDERER[type as VizId];
  const merged = useMemo(() => (thumb ? { ...overrides, ...THUMB } : overrides), [thumb, overrides]);
  // A map's thumbnail is the static mini-map; a shrunken table is unreadable, so its glyph IS the presentation.
  if (thumb && renderer === 'map') return <MapThumb data={data as unknown as MapData} chartType={type} label={label} projectId={projectId} />;
  if (thumb && renderer === 'table') {
    return (
      <span className={s.glyph} aria-hidden="true">
        <Icon name={vizGlyph(type)} size={24} />
      </span>
    );
  }
  // Pivot / cohort / event funnel: T1.2's tables over the server's grid (never recomputed here).
  if (GRID_IDS.has(type)) {
    if (thumb) {
      return (
        <span className={s.glyph} aria-hidden="true">
          <Icon name={vizGlyph(type)} size={24} />
        </span>
      );
    }
    return <GridViz type={type} data={data as GridData} label={label} fill />;
  }
  if (renderer === 'map') return <MapView data={data as unknown as MapData} chartType={type} label={label} projectId={projectId} onMarkClick={onMapMark} />;
  if (renderer === 'table') return <DataTable data={data} label={label} />;
  return <Chart type={type} data={data} overrides={merged} label={label} onChart={thumb ? trimThumb : onChart} />;
}

/** A visual card's body: its definition, the sheet's filters and parameters → the server's answer → the drawing. */
export function VisualTileBody({
  projectId,
  def,
  filters,
  params,
  thumb,
  asTable,
  onMark,
  onHover,
  onPinAt,
  onMapMark,
}: {
  projectId: string;
  def: VisualDef;
  filters: readonly Step[];
  params: ParamPayload;
  thumb?: boolean;
  /** The figures as an accessible table instead of the chart (tileActions.ts "View as table"). */
  asTable?: boolean;
  /** Click-to-filter (dashFiltersUi.ts wireCrossFilter): the clicked mark's category. */
  onMark?: (category: string | number, series?: string) => void;
  /** A tile's tooltip_visual (T2.9): the hovered mark's category, or null off a mark. */
  onHover?: (category: string | number | null, e: React.MouseEvent) => void;
  /** ⌘/Ctrl-click on a mark (T2.9, commentDoors.ts cmtOnChartClick): a comment pinned to that point. */
  onPinAt?: (category: string | number, series?: string) => void;
  onMapMark?: (column: string | undefined, category: string) => void;
}) {
  const chart = useRef<ChartHandle | null>(null);
  const req = useMemo(
    () => ({
      kind: 'visual' as const,
      datasetId: def.datasetId,
      encoding: def.encoding,
      filters: mergeFilters(filters, def.filters),
      ...(def.analytics ? { analytics: def.analytics } : {}),
    }),
    [def, filters],
  );
  const q = useTile<VisualTile>(projectId, params, req);
  useTileAsOf(!thumb && q.data?.ok ? q.data.asOf : undefined);
  const label = def.name || vizLabel(def.chartType);
  if (q.isPending) return <SkeletonBlock label={`Loading ${label}`} />;
  if (q.isError || !q.data.ok) {
    const message = q.isError ? q.error.message : q.data.ok ? '' : q.data.error;
    if (thumb) {
      return (
        <span className={s.glyph} aria-hidden="true">
          <Icon name={vizGlyph(def.chartType)} size={24} />
        </span>
      );
    }
    // Off for a Live dataset (L2.6): the server's reason and a copy, not a retry that would refuse again.
    const live = liveRefusalOf(q.isError ? q.error : q.data);
    if (live !== null) return <LiveRefusal message={live} projectId={projectId} datasetId={def.datasetId} />;
    return <ErrorState compact heading={3} title="No data for this chart" message={message} onRetry={() => void q.refetch()} />;
  }
  const click =
    onMark || onPinAt
      ? (e: React.MouseEvent) => {
          // A click on empty canvas, a map or a table is not a filter (no Chart.js mark).
          const m = markAt(chart.current, e.nativeEvent);
          if (!m) return;
          if (onPinAt && (e.metaKey || e.ctrlKey)) return onPinAt(m.category, m.series);
          onMark?.(m.category, m.series);
        }
      : undefined;
  return (
    <div
      className={onMark ? `${s.drawn} ${s.crossFilter}` : s.drawn}
      onClick={click}
      onMouseMove={onHover ? (e) => onHover(markAt(chart.current, e.nativeEvent)?.category ?? null, e) : undefined}
      onMouseLeave={onHover ? (e) => onHover(null, e) : undefined}
    >
      {asTable && !def.chartType.startsWith('map_') ? (
        <DataTable data={q.data.data} label={label} />
      ) : (
        <DrawnVisual type={def.chartType} data={q.data.data} overrides={def.overrides} label={label} projectId={projectId} thumb={thumb} onChart={(c) => (chart.current = c)} onMapMark={thumb ? undefined : onMapMark} />
      )}
      {!thumb && q.data.paramErrors && q.data.paramErrors.length > 0 && <p className={s.paramErr}>{q.data.paramErrors[0]}</p>}
    </div>
  );
}
