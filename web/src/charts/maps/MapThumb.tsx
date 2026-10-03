// <MapThumb> — a gallery card's static mini-map (mapThumb.ts / mapGeoThumb.ts):
// the shapes on a 2D canvas, no MapLibre, no WebGL, no tiles. When anything is
// missing (no geo, no boundaries for the level) it keeps the map glyph — a
// plain card beats a broken one.

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { boundariesFor, bundledBoundaries } from './boundaries';
import { isDarkHex } from './colors';
import { cssVar } from './maplibre';
import { drawGeoThumb, drawRegionThumb } from './thumb';
import type { MapData } from './types';
import { useDocTheme } from './useDocTheme';
import s from './MapThumb.module.css';

export function MapThumb({ data, chartType, label, projectId }: { data: MapData; chartType: string; label: string; projectId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useDocTheme();
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDrawn(false);
    void (async () => {
      const geo = data.geo;
      const canvas = ref.current;
      if (!geo || !canvas) return;
      const density = !!(geo.hex || geo.flow);
      const shapes = density ? await bundledBoundaries('country') : geo.items.length ? await boundariesFor(geo, projectId) : null;
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const ctx = canvas.getContext('2d');
      if (cancelled || !ctx || w < 8 || h < 8 || (!density && !shapes)) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = {
        empty: cssVar(canvas, '--surface-3', '#e5e7eb'),
        line: cssVar(canvas, '--border', '#d1d5db'),
        accent: cssVar(canvas, '--accent', '#3b82f6'),
        dark: isDarkHex(cssVar(canvas, '--surface', '#ffffff')),
      };
      const ok = density
        ? drawGeoThumb(ctx, w, h, geo, shapes ? shapes.features : [], t)
        : drawRegionThumb(ctx, w, h, geo, shapes ? shapes.features : [], chartType === 'map_bubble', t);
      if (!cancelled) setDrawn(ok);
    })().catch(() => {
      // a thumbnail never errors: the glyph stays
    });
    return () => {
      cancelled = true;
    };
  }, [data, chartType, projectId, theme]);

  return (
    <div className={s.thumb} role="img" aria-label={label} data-drawn={drawn ? 'true' : 'false'}>
      <canvas ref={ref} className={s.canvas} aria-hidden="true" />
      {!drawn && (
        <span className={s.glyph} aria-hidden="true">
          <Icon name="map" size={24} />
        </span>
      )}
    </div>
  );
}
