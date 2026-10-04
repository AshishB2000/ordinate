// A gallery card's live thumbnail (vizThumbs.ts): rendered when the tile
// scrolls into view, from the server's `visual:thumbs` (each saved visual's own
// figures — never stored, never computed here). A chart is drawn small and
// inert: no animation, legend, gridlines, value labels, title, ticks or
// pointer events. Maps draw the static mini-map; tables and grids keep the
// glyph, and ANY failure leaves the glyph — a plain card beats a broken one.

import { useEffect, useRef } from 'react';
import { buildChart } from '../../charts/build';
import type { ChartHandle } from '../../charts/Chart';
import { loadChartJs } from '../../charts/loadChartJs';
import { MapThumb } from '../../charts/maps/MapThumb';
import { isMapChartType } from '../../charts/maps/mapKinds';
import type { MapData } from '../../charts/maps/types';
import { resolveChartType } from '../../charts/typeSpec';
import type { ChartDataShape, Cx, Overrides } from '../../charts/types';
import { buildWordCloud } from '../../charts/wordCloud';
import { Skeleton } from '../../ui/Skeleton';
import { useThumb, type VisualSummary } from './api';
import { GRID_TYPES } from './eligibility';
import s from './Visuals.module.css';

const NO_THUMB = new Set(['table', ...GRID_TYPES]);
const THUMB: Overrides = { noAnimate: true, showLegend: false, showGridlines: false, valueMode: 'off', title: '' };

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

function ChartThumb({ type, data, overrides, onDrawn }: { type: string; data: ChartDataShape; overrides: Overrides; onDrawn: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let chart: ChartHandle | null = null;
    let cancelled = false;
    const spec = resolveChartType(type);
    (spec.isWordCloud ? Promise.resolve(null) : loadChartJs(spec.chartType))
      .then((ChartJs) => {
        if (cancelled) return;
        const built = buildChart(canvas, data, type, { ...overrides, ...THUMB });
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
  }, [type, data, overrides, onDrawn]);
  return (
    <span className={s.thumb}>
      <canvas ref={ref} aria-hidden="true" />
    </span>
  );
}

/** The tile's picture: skeleton while queued, then the chart or map, else the glyph underneath. */
export function Thumb({ projectId, v, visible, onDrawn }: { projectId: string; v: VisualSummary; visible: boolean; onDrawn: () => void }) {
  const wanted = visible && !NO_THUMB.has(v.chartType);
  const q = useThumb(projectId, v, wanted);
  if (!wanted) return null;
  if (q.isPending) return <Skeleton className={s.thumbSkel} />;
  const t = q.data;
  if (!t || !t.ok || !t.data) return null;
  if (isMapChartType(v.chartType)) return <MapTile data={t.data as unknown as MapData} v={v} projectId={projectId} onDrawn={onDrawn} />;
  return <ChartThumb type={v.chartType} data={t.data} overrides={t.overrides} onDrawn={onDrawn} />;
}

/** MapThumb keeps its own map glyph until the shapes are drawn, so it replaces the card's at once. */
function MapTile({ data, v, projectId, onDrawn }: { data: MapData; v: VisualSummary; projectId: string; onDrawn: () => void }) {
  useEffect(onDrawn, [onDrawn]);
  return (
    <span className={s.thumb}>
      <MapThumb data={data} chartType={v.chartType} label={v.name} projectId={projectId} />
    </span>
  );
}
