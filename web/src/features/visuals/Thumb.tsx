// A gallery card's live thumbnail (vizThumbs.ts): rendered when the tile
// scrolls into view, from the server's `visual:thumbs` (each saved visual's own
// figures — never stored, never computed here). A chart is drawn small and
// inert: no animation, legend, gridlines, value labels, title, ticks or
// pointer events. Maps draw the static mini-map; tables and grids keep the
// glyph, and ANY failure leaves the glyph — a plain card beats a broken one.
// `accentOnly` (Home) draws every chart in the member's accent instead of the
// visual's own colours, and redraws when the theme or the accent changes.

import { useEffect, useRef } from 'react';
import { buildChart } from '../../charts/build';
import type { ChartHandle } from '../../charts/Chart';
import { loadChartJs } from '../../charts/loadChartJs';
import { MapThumb } from '../../charts/maps/MapThumb';
import { isMapChartType } from '../../charts/maps/mapKinds';
import type { MapData } from '../../charts/maps/types';
import { useDocAppearance } from '../../charts/maps/useDocTheme';
import { getCSSVar } from '../../charts/palette';
import { resolveChartType } from '../../charts/typeSpec';
import type { ChartDataShape, Cx, Overrides } from '../../charts/types';
import { buildWordCloud } from '../../charts/wordCloud';
import { Skeleton } from '../../ui/Skeleton';
import { useThumb, type VisualSummary } from './api';
import { GRID_TYPES } from './eligibility';
import s from './Visuals.module.css';

/** Chart types whose tile keeps its glyph: a shrunken table or grid is unreadable. */
export const NO_THUMB = new Set(['table', ...GRID_TYPES]);
const THUMB: Overrides = { noAnimate: true, showLegend: false, showGridlines: false, valueMode: 'off', title: '' };

/** The override keys that colour a chart (charts/build.ts, fmtApply.ts). */
const OWN_COLOURS = ['color', 'seriesColors', 'colorByCategory', 'measurePalettes', '_colorScope'];

/** A visual's overrides with its own colours dropped and its palette seeded from `accent` (a #rrggbb, or none). */
export function accentOverrides(overrides: Overrides, accent: string): Overrides {
  const out: Overrides = { ...overrides };
  for (const k of OWN_COLOURS) delete out[k];
  if (/^#[0-9a-f]{6}$/i.test(accent)) out.color = accent;
  return out;
}

/** Axis ticks, titles and borders off; inert — what buildChart's overrides cannot say. */
function trim(chart: ChartHandle): void {
  const o = chart.options || {};
  o.events = [];
  if (o.plugins?.tooltip) o.plugins.tooltip.enabled = false;
  for (const [k, sc] of Object.entries((o.scales || {}) as Record<string, Cx>)) {
    if (!sc) continue;
    if (k === 'r') {
      sc.pointLabels = { ...sc.pointLabels, display: false }; // a radar's rings ARE the chart
      continue;
    }
    sc.ticks = { ...sc.ticks, display: false };
    sc.grid = { ...sc.grid, display: false, drawOnChartArea: false };
    sc.border = { ...sc.border, display: false };
    if (sc.title) sc.title.display = false;
  }
  chart.update('none');
}

/** A chart drawn small and inert — a gallery card's, and an Explore suggestion's. */
export function ChartThumb({ type, data, overrides, onDrawn, accentOnly }: { type: string; data: ChartDataShape; overrides: Overrides; onDrawn: () => void; accentOnly?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const look = useDocAppearance();
  const redraw = accentOnly ? look : '';
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let chart: ChartHandle | null = null;
    let cancelled = false;
    const spec = resolveChartType(type);
    (spec.isWordCloud ? Promise.resolve(null) : loadChartJs(spec.chartType))
      .then((ChartJs) => {
        if (cancelled) return;
        const own = accentOnly ? accentOverrides(overrides, getCSSVar('--chart-accent', canvas)) : overrides;
        const built = buildChart(canvas, data, type, { ...own, ...THUMB });
        if (!built) return;
        if (built.kind === 'wordCloud') {
          chart = buildWordCloud(canvas, built.labels, built.series, built.overrides, built.theme) as ChartHandle;
        } else {
          chart = new ChartJs!(canvas, built.config as never) as unknown as ChartHandle;
          trim(chart);
        }
        onDrawn();
      })
      .catch(() => {
        // the glyph stays
      });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [type, data, overrides, onDrawn, accentOnly, redraw]);
  return (
    <span className={s.thumb}>
      <canvas ref={ref} aria-hidden="true" />
    </span>
  );
}

/** The tile's picture: skeleton while queued, then the chart or map, else the glyph underneath. */
export function Thumb({ projectId, v, visible, onDrawn, accentOnly }: { projectId: string; v: VisualSummary; visible: boolean; onDrawn: () => void; accentOnly?: boolean }) {
  const wanted = visible && !NO_THUMB.has(v.chartType);
  const q = useThumb(projectId, v, wanted);
  if (!wanted) return null;
  if (q.isPending) return <Skeleton className={s.thumbSkel} />;
  const t = q.data;
  if (!t || !t.ok || !t.data) return null;
  // A caller that knows only the id (a dashboard's preview on Home) takes the chart type from the reply.
  const type = v.chartType || t.chartType;
  if (NO_THUMB.has(type)) return null;
  if (isMapChartType(type)) return <MapTile data={t.data as unknown as MapData} v={{ ...v, chartType: type }} projectId={projectId} onDrawn={onDrawn} accentOnly={accentOnly} />;
  return <ChartThumb type={type} data={t.data} overrides={t.overrides} onDrawn={onDrawn} accentOnly={accentOnly} />;
}

/** MapThumb keeps its own map glyph until the shapes are drawn, so it replaces the card's at once. */
function MapTile({ data, v, projectId, onDrawn, accentOnly }: { data: MapData; v: VisualSummary; projectId: string; onDrawn: () => void; accentOnly?: boolean }) {
  useEffect(onDrawn, [onDrawn]);
  return (
    <span className={s.thumb}>
      <MapThumb data={data} chartType={v.chartType} label={v.name} projectId={projectId} accentOnly={accentOnly} />
    </span>
  );
}
