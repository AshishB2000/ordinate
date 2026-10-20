'use strict';

// The published site's renderer, DOM half: the MAPS — a region or point map, a
// hexbin or a flow map — as still SVG pictures over the page's bundled
// boundaries, placed by publishCore.ts's projections. A classic script inlined
// after publishTiles.js. Nothing here computes a figure; a region's shade is
// its value's place between the smallest and the largest (pkRampT).

// src/analysis/geoMatch.js, inlined
declare function matchGeoItem(items: any[], props: any, shapeNames?: Set<string>): any;
declare function featureNameSet(features: any[]): Set<string>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A published HEXBIN or FLOW map (r6:geo): a still picture framed to the data
 * over the offline world land — the one hex level the site carries (the finest
 * that stays legible), or the routes with their main-computed arcs and widths.
 */
function pcGeoDensity(geo: any, page: any): HTMLElement {
  const level = geo.hex && Array.isArray(geo.hex.levels) ? geo.hex.levels[0] : null;
  const hexes: any[] = level && Array.isArray(level.hexes) ? level.hexes : [];
  const flows: any[] = geo.flow && Array.isArray(geo.flow.flows) ? geo.flow.flows : [];
  const pts: number[][] = [];
  for (const h of hexes) for (let i = 0; i + 1 < h.ring.length; i += 2) pts.push(pkWorld(h.ring[i], h.ring[i + 1]));
  for (const f of flows) for (let i = 0; i + 1 < f.path.length; i += 2) pts.push(pkWorld(f.path[i], f.path[i + 1]));
  const wrap = pcEl('div', 'pub-map-wrap');
  if (!pts.length) { wrap.appendChild(pcEl('div', 'pub-broken', 'No points to place on the map.')); return wrap; }
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const px = Math.max(0.002, (x1 - x0) * 0.12), py = Math.max(0.002, (y1 - y0) * 0.12);
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const W = 960;
  const scale = W / (x1 - x0);
  const H = Math.max(160, Math.min(720, Math.round((y1 - y0) * scale)));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pub-map');
  svg.setAttribute('role', 'img');
  const add = (d: string, cls: string, title: string, attrs: Record<string, string> = {}): void => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    for (const k of Object.keys(attrs)) path.setAttribute(k, attrs[k]);
    if (title) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = title; path.appendChild(t); }
    svg.appendChild(path);
  };
  const land = page.geo && page.geo.country;
  for (const f of (land && land.features) || []) add(pkPathD(f.geometry, pkWorld, scale, x0, y0), 'pub-land', '');
  const xy = (lng: number, lat: number): string => {
    const p = pkWorld(lng, lat);
    return ((p[0] - x0) * scale).toFixed(1) + ',' + ((p[1] - y0) * scale).toFixed(1);
  };
  const vals = hexes.map((h) => h.value).concat(flows.map((f) => f.value)).filter((v) => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const label = (geo.hex && geo.hex.label) || (geo.flow && geo.flow.label) || 'Value';
  for (const h of hexes) {
    let d = '';
    for (let i = 0; i + 1 < h.ring.length; i += 2) d += (i ? 'L' : 'M') + xy(h.ring[i], h.ring[i + 1]);
    const t = pkRampT(h.value, min, max);
    add(d + 'Z', t === null ? 'pub-land' : 'pub-region', `${label}: ${h.value == null ? 'no data' : pcFmt(h.value)} · ${h.n} points`,
      t === null ? {} : { 'fill-opacity': String(0.18 + 0.82 * t) });
  }
  for (const f of flows) {
    let d = '';
    for (let i = 0; i + 1 < f.path.length; i += 2) d += (i ? 'L' : 'M') + xy(f.path[i], f.path[i + 1]);
    const w = typeof f.value === 'number' && max > 0 && f.value > 0 ? 1 + Math.sqrt(f.value / max) * 6 : 1;
    add(d, 'pub-flow', `${f.name}: ${f.value == null ? 'no data' : pcFmt(f.value)}`, { 'stroke-width': w.toFixed(1) });
  }
  wrap.appendChild(svg);
  if (geo.flow && geo.flow.routes > flows.length) {
    wrap.appendChild(pcEl('p', 'pub-note', `The top ${flows.length} of ${geo.flow.routes} routes by ${String(label).toLowerCase()}.`));
  }
  return wrap;
}

function pcMap(payload: any, page: any, chartType: string): HTMLElement {
  const geo = payload.geo || { level: 'country', items: [] };
  if (geo.hex || geo.flow) return pcGeoDensity(geo, page);
  const key = geo.level === 'custom' ? Object.keys(page.geo).find((k: string) => k.indexOf('custom:') === 0) : geo.level;
  const base = page.geo[key || ''] || page.geo[geo.level === 'us_county' ? 'us_county' : 'country'] || page.geo.country;
  const land = page.geo[geo.level === 'us_state' || geo.level === 'us_county' || geo.level === 'us_city' || geo.level === 'us_zip' ? 'us_state' : 'country'] || base;
  const project = pkProjectionFor(geo.level);
  const features: any[] = (base && base.features) || [];
  const usa = project === pkAlbersUsa;
  const covered = (f: any): boolean => {
    if (!usa) return true;
    const p = pkFirstPoint(f.geometry);
    return !!p && pkUsaCovers(p[0], p[1]);
  };
  const drawn = features.filter((f) => f.properties && f.properties.name !== 'Antarctica' && covered(f));
  const b = pkBounds(drawn, project);
  const W = 960;
  const scale = W / Math.max(1e-9, b[2] - b[0]);
  const H = Math.max(120, Math.round((b[3] - b[1]) * scale));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pub-map');
  svg.setAttribute('role', 'img');
  const items: any[] = Array.isArray(geo.items) ? geo.items : [];
  const vals = items.map((i) => i.value).filter((v: any) => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const points = geo.points || chartType === 'map_bubble';
  const shapeNames = featureNameSet(features); // every shape of the level, drawn or not
  // The offline basemap: land shapes from the bundled boundaries, under everything.
  for (const f of (points ? (land && land.features) || [] : drawn)) {
    if (!f.properties || f.properties.name === 'Antarctica' || !covered(f)) continue;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pkPathD(f.geometry, project, scale, b[0], b[1]));
    let t: number | null = null;
    let hit: any;
    if (!points) {
      hit = matchGeoItem(items, f.properties, shapeNames);
      t = hit ? pkRampT(hit.value, min, max) : null;
    }
    path.setAttribute('class', t === null ? 'pub-land' : 'pub-region');
    if (t !== null) path.setAttribute('fill-opacity', String(0.18 + 0.82 * t));
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = f.properties.name + (hit && typeof hit.value === 'number' ? ': ' + pcFmt(hit.value) : '');
    path.appendChild(title);
    svg.appendChild(path);
  }
  if (points) {
    for (const it of items) {
      if (typeof it.lat !== 'number' || typeof it.lng !== 'number' || (usa && !pkUsaCovers(it.lng, it.lat))) continue;
      const p = project(it.lng, it.lat);
      const c = document.createElementNS(SVG_NS, 'circle');
      const t = pkRampT(it.value, min, max);
      c.setAttribute('cx', ((p[0] - b[0]) * scale).toFixed(1));
      c.setAttribute('cy', ((p[1] - b[1]) * scale).toFixed(1));
      c.setAttribute('r', String(3 + 12 * (t === null ? 0 : Math.sqrt(t))));
      c.setAttribute('class', 'pub-point');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = it.name + (typeof it.value === 'number' ? ': ' + pcFmt(it.value) : '');
      c.appendChild(title);
      svg.appendChild(c);
    }
  }
  const wrap = pcEl('div', 'pub-map-wrap');
  wrap.appendChild(svg);
  return wrap;
}
