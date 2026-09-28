// Gallery thumbnails for the hexbin and flow maps: a static 2D canvas picture of
// the SAME hexagons and arcs main computed — no MapLibre, no WebGL, no tiles —
// over the bundled world land as a faint basemap. mapThumb.drawMapThumb hands
// these two map kinds here. Classic global-scope renderer <script>; borrows
// mapThumbGeo / mapThumbProject / _mapThumbRings / _mapThumbTrace (mapThumb.js)
// and getChoroplethColor (mapRender.js) at call time.

const GEO_THUMB_MAX_HEXES = 600;

async function drawGeoThumb(canvas: HTMLCanvasElement, geo: any): Promise<boolean> {
  const hexLevels: any[] = geo.hex && Array.isArray(geo.hex.levels) ? geo.hex.levels : [];
  // The finest level that still reads at thumbnail size.
  const level = [...hexLevels].reverse().find((l) => l.hexes.length <= GEO_THUMB_MAX_HEXES) || hexLevels[0] || null;
  const flows: any[] = geo.flow && Array.isArray(geo.flow.flows) ? geo.flow.flows : [];
  let bbox: any = null;
  const grow = (lng: number, lat: number): void => { bbox = _extendBBox(bbox, [lng, lat, lng, lat]); };
  if (level) for (const h of level.hexes) for (let i = 0; i < h.ring.length; i += 2) grow(h.ring[i], h.ring[i + 1]);
  for (const f of flows) for (let i = 0; i < f.path.length; i += 2) grow(f.path[i], f.path[i + 1]);
  if (!bbox || !canvas.isConnected) return false;

  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const ctx = canvas.getContext('2d');
  if (!ctx || w < 8 || h < 8) return false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // A little air around the data, so a single city is not a wall of hexagons.
  const [x0, y0, x1, y1] = bbox;
  const padX = Math.max(0.5, (x1 - x0) * 0.15);
  const padY = Math.max(0.5, (y1 - y0) * 0.15);
  const project = mapThumbProject([x0 - padX, y0 - padY, x1 + padX, y1 + padY], w, h, MAP_THUMB_PAD);

  const world = await mapThumbGeo('country');
  if (world && canvas.isConnected) {
    ctx.fillStyle = getCSSVar('--surface-3', canvas) || '#e5e7eb';
    ctx.strokeStyle = getCSSVar('--border', canvas) || '#d1d5db';
    ctx.lineWidth = 0.4;
    for (const f of world.features) {
      const rings = _mapThumbRings(f && f.geometry);
      if (!rings.length) continue;
      _mapThumbTrace(ctx, rings, project);
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }

  if (level) {
    const vals = level.hexes.map((x: any) => x.value).filter((v: any) => typeof v === 'number');
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 1;
    for (const x of level.hexes) {
      if (typeof x.value !== 'number') continue;
      const ring: number[][] = [];
      for (let i = 0; i < x.ring.length; i += 2) ring.push([x.ring[i], x.ring[i + 1]]);
      _mapThumbTrace(ctx, [ring], project);
      ctx.fillStyle = getChoroplethColor(max > min ? (x.value - min) / (max - min) : 0.5, canvas);
      ctx.fill();
    }
  }
  if (flows.length) {
    const max = Math.max(0, ...flows.map((f) => (typeof f.value === 'number' ? f.value : 0)));
    ctx.strokeStyle = getCSSVar('--accent', canvas) || '#3b82f6';
    ctx.globalAlpha = 0.6;
    ctx.lineCap = 'round';
    for (const f of flows) {
      ctx.lineWidth = 0.6 + (max > 0 && typeof f.value === 'number' && f.value > 0 ? Math.sqrt(f.value / max) * 2.4 : 0);
      ctx.beginPath();
      for (let i = 0; i < f.path.length; i += 2) {
        const p = project(f.path[i], f.path[i + 1]);
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  return true;
}
