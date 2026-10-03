// <MapView> — every map kind from one `visual:data` reply: region
// (choropleth), bubble, point (clustered), hexbin density and flow routes.
// Port of renderMapInArea (mapRender.ts) and its fallbacks.
//
// The component owns the MapLibre instance: created when the reply, kind or
// theme changes, removed on unmount. Interactive state that does not need a
// new map (Values labels, the period) goes through the controller draw.ts
// returns. MapLibre loads on first use (./maplibre.ts); the boundary shapes
// come from the server (./boundaries.ts).

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { formatCompact } from '../../../../src/app/format.ts';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonBlock } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { boundariesFor, bundledBoundaries } from './boundaries';
import { CHART_PALETTE, isDarkHex } from './colors';
import { drawMap, type Drawn, type MapTheme, type Overlay } from './draw';
import { choroplethLayer } from './features';
import { hasCoords } from './geometry';
import { addOfflineLand, createMap, cssVar, hasWebGL2, loadMapLibre, whenLoaded, type MlMap } from './maplibre';
import { MapOverlays } from './MapOverlays';
import type { MapData } from './types';
import { useDocTheme } from './useDocTheme';
import s from './MapView.module.css';

export interface MapViewProps {
  data: MapData;
  /** map_choropleth | map_bubble | map_hexbin | map_flow (a point or density reply draws as its own kind). */
  chartType: string;
  /** Names the map for assistive tech. */
  label: string;
  /** A custom choropleth's project (its boundaries come over `boundary:get`). */
  projectId?: string;
  /** A click on a region or point: the value, as a click on a bar gives it (dashboard actions). */
  onMarkClick?: (column: string | undefined, category: string) => void;
  className?: string;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'empty' }
  | { kind: 'nowebgl' }
  | { kind: 'fallback'; note: string }
  | { kind: 'error'; message: string };

function themeOf(el: Element): MapTheme & { inset: string } {
  const surface = cssVar(el, '--surface', '#ffffff');
  return {
    accent: cssVar(el, '--accent', '#3b82f6'),
    surface,
    noData: cssVar(el, '--surface-3', '#e5e7eb'),
    noDataBorder: cssVar(el, '--border-2', '#d1d5db'),
    border: cssVar(el, '--border', '#e5e7eb'),
    muted: cssVar(el, '--text-faint', '#aeb4bf'),
    inset: cssVar(el, '--inset', '#eef1f5'),
    palette: CHART_PALETTE.map((fallback, i) => cssVar(el, `--chart-${i + 1}`, fallback)),
    dark: isDarkHex(surface),
  };
}

/** "Showing the data instead": the reply's own figures as a table, when the regions cannot be drawn. */
function DataInstead({ data, note }: { data: MapData; note: string }) {
  const series = data.series[0];
  const rows = series ? data.labels.map((l, i) => [l, series.values[i]] as const) : (data.geo?.items || []).map((i) => [i.name, i.value] as const);
  return (
    <div className={s.fallback}>
      <p className={s.fallbackNote}>
        <Icon name="map-pin" /> {note}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Region</th>
            <th scope="col">{series?.name || 'Value'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, v], i) => (
            <tr key={i}>
              <td>{String(name)}</td>
              <td>{typeof v === 'number' ? formatCompact(v) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MapView({ data, chartType, label, projectId, onMarkClick, className }: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const onMark = useRef(onMarkClick);
  useEffect(() => {
    onMark.current = onMarkClick;
  });
  const theme = useDocTheme();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [controls, setControls] = useState<Pick<Drawn, 'setValueMode' | 'setPeriod'>>({});
  const [tilesFailed, setTilesFailed] = useState(false);
  // Busy until MapLibre's first `idle` (tiles in, nothing pending), so a screenshot or a test waits for the paint.
  const [idle, setIdle] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    setControls({});
    setStatus({ kind: 'loading' });
    setOverlay(null);
    setTilesFailed(false);
    setIdle(false);

    void (async () => {
      const geo = data.geo;
      if (!geo || !Array.isArray(geo.items) || (geo.items.length === 0 && !geo.hex && !geo.flow)) return setStatus({ kind: 'empty' });
      if (!hasWebGL2()) return setStatus({ kind: 'nowebgl' });
      const wrap = wrapRef.current;
      const host = canvasRef.current;
      if (!wrap || !host) return;
      const t = themeOf(wrap);
      const region = !geo.points && !geo.hex && !geo.flow;
      const needsShapes = region && (chartType === 'map_choropleth' || (chartType === 'map_bubble' && !geo.items.every(hasCoords)));
      const offline = geo.basemap === 'none';
      const [ml, shapes, world] = await Promise.all([
        loadMapLibre(),
        needsShapes ? boundariesFor(geo, projectId) : null,
        offline ? bundledBoundaries('country') : null,
      ]);
      if (cancelled) return;

      // A choropleth that cannot be drawn degrades, never to a blank globe:
      // a bubble map when the items carry coordinates, else the figures as a table.
      let type = chartType;
      if (region && chartType === 'map_choropleth') {
        const why = !shapes
          ? 'No map boundaries for this level — showing the data instead.'
          : choroplethLayer(shapes.features, geo.items, geo.level, { min: 0, max: 1, dark: false, noData: '' }, String).matched.size === 0
            ? "Couldn't place these regions on the map — showing the data instead."
            : '';
        if (why && geo.items.every(hasCoords)) type = 'map_bubble';
        else if (why) return setStatus({ kind: 'fallback', note: why });
      }

      try {
        map = createMap(ml, host, offline ? t.inset : null);
      } catch {
        return setStatus({ kind: 'nowebgl' });
      }
      // Tile failures (offline, a proxy refusing OSM) are a note, not a console error; anything else is a bug.
      map.on('error', (e: { error?: unknown; sourceId?: string }) => {
        if (e.sourceId === 'osm') setTilesFailed(true);
        else console.error(e.error);
      });
      await whenLoaded(map);
      if (cancelled || !map) return;
      map.resize();
      if (world) addOfflineLand(map, world, t.surface, t.noDataBorder);

      let ready = false;
      const pending: Partial<Overlay> = {};
      const result = drawMap({
        ml,
        map,
        data,
        type,
        features: shapes ? shapes.features : null,
        theme: t,
        onMark: (column, category) => onMark.current?.(column, category),
        emit: (patch) => (ready ? setOverlay((o) => (o ? { ...o, ...patch } : o)) : Object.assign(pending, patch)),
      });
      setControls({ setValueMode: result.setValueMode, setPeriod: result.setPeriod });
      // After the data layers: the first idle once THEY are painted (one may already have fired on load).
      void map.once('idle', () => !cancelled && setIdle(true));
      map.triggerRepaint(); // a kind that added nothing (an empty state) still gets its idle
      setOverlay({ ...result.overlay, ...pending });
      ready = true;
      setStatus({ kind: 'ready' });
    })().catch((err: unknown) => {
      if (!cancelled) setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [data, chartType, projectId, theme, attempt]);

  const stats = overlay?.stats ?? {};
  return (
    <div
      ref={wrapRef}
      className={className ? `${s.wrap} ${className}` : s.wrap}
      role="figure"
      aria-label={label}
      aria-busy={status.kind === 'loading' || (status.kind === 'ready' && !idle)}
      data-map-status={status.kind}
      data-points={stats.points}
      data-clusters={stats.clusters}
      data-hexes={stats.hexes}
      data-flows={stats.flows}
      data-matched={stats.matched}
    >
      <div ref={canvasRef} className={s.canvas} />
      {status.kind === 'ready' && overlay && (
        <MapOverlays
          overlay={overlay}
          tilesFailed={tilesFailed}
          onValueMode={controls.setValueMode}
          onPeriod={controls.setPeriod}
        />
      )}
      {status.kind !== 'ready' && (
        <div className={s.state}>
          {status.kind === 'loading' && <SkeletonBlock label={`Loading ${label}`} />}
          {status.kind === 'empty' && (
            <EmptyState icon="map" title="Nothing to map" compact heading={3}>
              No geographic data available for this map.
            </EmptyState>
          )}
          {status.kind === 'nowebgl' && (
            <EmptyState icon="globe" title="This map needs WebGL" compact heading={3}>
              WebGL 2 is not available in this browser, so the map cannot be drawn here.
            </EmptyState>
          )}
          {status.kind === 'fallback' && <DataInstead data={data} note={status.note} />}
          {status.kind === 'error' && (
            <ErrorState title="The map could not be drawn" message={status.message} compact heading={3} onRetry={() => setAttempt((n) => n + 1)} />
          )}
        </div>
      )}
    </div>
  );
}
