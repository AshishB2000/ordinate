// One saved visual drawn from the server's answer — a card on the sheet, a
// list card's preview, a draft's preview. The engines are the shared ones
// (web/src/charts, web/src/charts/maps); this file only picks which, and owns
// the tile's loading / error states. It computes nothing.

import { useMemo, useRef } from 'react';
import { drawnLabels, rawOf, shownName, type ValueLabelPairs } from '../../charts/valueLabelMap';
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
import { pointAt, type ChartPoint } from '../analytics/explain/pointAt';
import { GRID_IDS, GridViz, type GridData } from '../../charts/grids/GridViz';
import { useTile, type ParamPayload, type Step, type VisualDef, type VisualTile } from './api';
import { useTileAsOf } from './editor/tileAsOf';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { RetiredNote } from '../model/status/RetiredNote';
import { switchTo } from '../model/status/switchTo';
import s from './Tiles.module.css';
import { figureAsk, figureAskKey } from '../../../../src/analysis/figureAsk.ts';
import { isKeptStep, keptKey, markScopeTerms } from '../visuals/keptStep';

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

/** A dashboard filter list merged in front of a card's own, exact duplicates dropped (dashboardFilters.mergeDashboardFilters); a `via`, a date control's mark (`fromControl`) or a row lock makes it another filter. A step the web cannot edit (a term) is kept once, whole; the dashboard's terms are marked (markScopeTerms). */
export function mergeFilters(dash: readonly Step[], own: readonly Step[]): Step[] {
  const out: Step[] = [];
  const seen = new Set<string>();
  for (const st of [...markScopeTerms(dash), ...own]) { // a scope term a tile cannot use: a note on the tile
    const kept = isKeptStep(st);
    if (!st || (st.type !== 'filter' && !kept)) continue;
    const k = kept ? keptKey(st) : JSON.stringify([st.column, st.op, st.value ?? null, st.values ?? null, st.period ?? null, st.radius ?? null, st.context === true, st.via ?? null, st.fromControl === true, st.lock === true]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(st);
  }
  return out;
}

/**
 * The server's own label for a clicked mark. A first-of-month axis is drawn as "Jan 2023" (build.ts asMonthLabels),
 * a labelled value as its label (`pairs`, "EU" drawn "Europe"); a filter on that text would match no row, so a
 * click-filter carries the label the server sent for that position.
 */
export function serverLabel(labels: readonly unknown[] | undefined, shown: string | number, pairs?: ValueLabelPairs): string | number {
  if (!labels) return shown;
  const i = drawnLabels(labels as unknown[], pairs).findIndex((l) => String(l) === String(shown));
  const raw = i < 0 ? shown : labels[i];
  return typeof raw === 'number' ? raw : String(raw);
}

/** What a clicked mark was drawn as and on what axis: the tile's drill names it ("Drill into Mar 2024 · by day"). */
export interface MarkInfo {
  shown: string;
  time: boolean;
  grain?: string;
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
  filterMark,
  onHover,
  onPinAt,
  onMapMark,
  serverMark,
  onMarkMenu,
  onMarkTap,
  onSwitch,
  staleTime,
}: {
  projectId: string;
  def: VisualDef;
  /** An editor's "Switch to <replacement>" on a measure whose metric is retired: the new encoding, to be saved by the caller. */
  onSwitch?: (encoding: VisualDef['encoding']) => void;
  filters: readonly Step[];
  params: ParamPayload;
  thumb?: boolean;
  /** The figures as an accessible table instead of the chart (tileActions.ts "View as table"). */
  asTable?: boolean;
  /**
   * A left click on a mark (click-to-filter, a tile action, the drill): its category and series as STORED, the click
   * itself, and, on a chart that draws value labels, the mark as drawn ("Europe" for EU) for a chip to say.
   */
  onMark?: (category: string | number, series?: string, event?: React.MouseEvent, drawn?: { category: string; series?: string }, info?: MarkInfo) => void;
  /**
   * `onMark` is click-to-filter: ⌘/Ctrl-click reaches it (multi-select) instead of pinning a comment, and the
   * category is the SERVER's label for the mark, not the axis text a month axis shows in its place.
   */
  filterMark?: boolean;
  /** A tile's tooltip_visual (T2.9): the hovered mark's category as stored, or null off a mark, and as drawn. */
  onHover?: (category: string | number | null, e: React.MouseEvent, drawn?: string) => void;
  /** ⌥-click on a mark, or ⌘/Ctrl-click where that does not multi-select (T2.9, commentDoors.ts cmtOnChartClick): a comment pinned to that point. */
  onPinAt?: (category: string | number, series?: string) => void;
  onMapMark?: (column: string | undefined, category: string) => void;
  /** `onMark` gets the category as the SERVER labelled it, as `filterMark` does, without that prop's ⌘-click meaning — for the drill. */
  serverMark?: boolean;
  /**
   * A RIGHT-click on a bar or a point ("Show the rows behind this point", "Explain this change"): the point as the
   * server names it, and whether the server bucketed the axis by date. Its own path — `onMark` is the left click's.
   */
  onMarkMenu?: (point: ChartPoint, e: React.MouseEvent, time: boolean, info: MarkInfo) => void;
  /**
   * A phone (docs/phone-dashboards): a tap on a mark asks what to do with it instead of doing it. The point as the
   * server names it, whether the axis is time, the category as click-to-filter wants it (the server's own label), and
   * the label as the axis draws it ("Mar 2025" for "2025-03-01").
   * Wins over `onMark`. The server's date grain of the axis comes last.
   */
  onMarkTap?: (point: ChartPoint, time: boolean, value: string | number, shown: string, drawn?: { category: string; series?: string }, grain?: string) => void;
  /** How long a read answer stays fresh (ms): a drilled tile's levels (dashboards/useTileDrill). */
  staleTime?: number;
}) {
  const chart = useRef<ChartHandle | null>(null);
  const req = useMemo(
    () => ({
      kind: 'visual' as const,
      datasetId: def.datasetId,
      encoding: def.encoding,
      filters: mergeFilters(filters, def.filters),
      ...(def.analytics ? { analytics: def.analytics } : {}),
      ...figureAsk(def.chartType, def.overrides), // a figure type's figures come with its answer (docs/chart-figures)
      // The saved visual: a waterfall's stored totals are filled server-side for a viewer not sent them (R19).
      ...(def.id ? { visualId: def.id } : {}),
    }),
    [def, filters],
  );
  const q = useTile<VisualTile>(projectId, params, req, staleTime);
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
    if (live !== null) return <LiveRefusal refusal={q.isError ? q.error : q.data} projectId={projectId} datasetId={def.datasetId} />;
    return <ErrorState compact heading={3} title="No data for this chart" message={message} onRetry={() => void q.refetch()} />;
  }
  // A held answer for another ask (the type or a figure override just changed): loading, never drawn as this one.
  if (q.data.ask !== undefined && q.data.ask !== figureAskKey(def.chartType, def.overrides)) return <SkeletonBlock label={`Loading ${label}`} />;
  const labels: readonly unknown[] | undefined = q.data.data.labels;
  // A mark drawn by its value label ("Europe") is sent back as its stored value (EU): every filter, pin and drill.
  const pairs = q.data.data.valueLabels;
  const storedSeries = (name: string | undefined) => (name === undefined ? undefined : String(rawOf(name, pairs?.series)));
  // "time": the SERVER bucketed the axis by date (its `category.kind`).
  const time = q.data.category?.kind === 'date';
  const grain = time ? q.data.category?.grain : undefined;
  const click =
    onMark || onPinAt || onMarkTap
      ? (e: React.MouseEvent) => {
          // A click on empty canvas, a map or a table is not a filter (no Chart.js mark).
          const m = markAt(chart.current, e.nativeEvent);
          if (onMarkTap) {
            // A bar or a line names its point by the axis — the nearest one, as a fingertip is wider than a point; a
            // pie, a scatter or a treemap by the mark that was hit.
            const p = pointAt(chart.current, e.nativeEvent, labels ?? [], pairs) ?? (m ? { bucket: String(serverLabel(labels, m.category, pairs)), ...(m.series ? { series: storedSeries(m.series) } : {}) } : null);
            if (!p) return;
            const i = labels ? labels.findIndex((l) => String(l) === p.bucket) : -1;
            const raw = i >= 0 ? labels?.[i] : undefined;
            const shown = i >= 0 ? String(drawnLabels(labels, pairs)[i]) : p.bucket;
            const drawn = pairs ? { category: shown, ...(p.series !== undefined ? { series: String(shownName(p.series, pairs)) } : {}) } : undefined;
            return onMarkTap(p, time, typeof raw === 'number' ? raw : p.bucket, shown, drawn, grain);
          }
          if (!m) return;
          if (onPinAt && (e.altKey || (!filterMark && (e.metaKey || e.ctrlKey)))) return onPinAt(rawOf(m.category, pairs?.category), storedSeries(m.series));
          const drawn = pairs ? { category: String(m.category), ...(m.series ? { series: m.series } : {}) } : undefined;
          onMark?.(filterMark || serverMark ? serverLabel(labels, m.category, pairs) : rawOf(m.category, pairs?.category), storedSeries(m.series), e, drawn, { shown: String(m.category), time, ...(grain ? { grain } : {}) });
        }
      : undefined;
  const hover = (drawn: string | number | undefined, e: React.MouseEvent) => onHover?.(drawn === undefined ? null : rawOf(drawn, pairs?.category), e, drawn === undefined ? undefined : String(drawn));
  // On a bar or a point of a chart with a category axis; off one, and on any other chart, the browser's own menu opens.
  const tile = q.data;
  const menu =
    onMarkMenu && !thumb && !asTable && def.encoding.category
      ? (e: React.MouseEvent) => {
          const p = pointAt(chart.current, e.nativeEvent, tile.data.labels ?? [], tile.data.valueLabels);
          if (!p) return;
          e.preventDefault();
          const i = tile.data.labels?.findIndex((l) => String(l) === p.bucket) ?? -1;
          onMarkMenu(p, e, time, { shown: i >= 0 ? String(drawnLabels(tile.data.labels, tile.data.valueLabels)[i]) : p.bucket, time, ...(grain ? { grain } : {}) });
        }
      : undefined;
  return (
    <div
      className={onMark || onMarkTap ? `${s.drawn} ${s.crossFilter}` : s.drawn}
      onClick={click}
      onContextMenu={menu}
      onMouseMove={onHover ? (e) => hover(markAt(chart.current, e.nativeEvent)?.category, e) : undefined}
      onMouseLeave={onHover ? (e) => onHover(null, e) : undefined}
    >
      {asTable && !def.chartType.startsWith('map_') ? (
        <DataTable data={q.data.data} label={label} />
      ) : (
        <DrawnVisual type={def.chartType} data={q.data.data} overrides={def.overrides} label={label} projectId={projectId} thumb={thumb} onChart={(c) => (chart.current = c)} onMapMark={thumb ? undefined : onMapMark} />
      )}
      {!thumb && def.encoding.values.some((v) => (v as { metricId?: string }).metricId) && (
        <RetiredNote projectId={projectId} metricIds={def.encoding.values.map((v) => (v as { metricId?: string }).metricId)} onSwitch={onSwitch && ((i, to) => onSwitch(switchTo(def.encoding, i, to)))} />
      )}
      {!thumb && q.data.paramErrors && q.data.paramErrors.length > 0 && <p className={s.paramErr}>{q.data.paramErrors[0]}</p>}
      {!thumb && q.data.periodOn && <p className={s.periodOn}>Date range applied to {q.data.periodOn}</p>}
      {!thumb && q.data.notes?.map((n) => <p key={n} role="note" className={s.periodOn}>{n}</p>) /* a dashboard term this tile leaves out */}
    </div>
  );
}
