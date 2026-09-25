// POINT MAPS, the pure half: which columns are latitude and longitude, and the
// app's own grid clustering. Shared the geoMatch way — main detects columns
// with it (src/analysis/mapData.ts), the renderer clusters with it on every
// zoom (mapPoints.ts), and scripts/test-mapPoints.js requires it.
(function (global: any) {
  /** Clustering starts above this many points; at or below it every point draws. */
  const CLUSTER_MIN = 2000;

  function tokens(name: string): string[] {
    return String(name || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  /** 'lat' / 'lon' by NAME — `latitude`, `Lat`, `pickup_lat`, `lngDeg`, `LONGITUDE`. */
  function axisOf(name: string): 'lat' | 'lon' | null {
    const t = tokens(name);
    if (t.some((w) => w === 'lat' || w === 'latitude')) return 'lat';
    if (t.some((w) => w === 'lon' || w === 'lng' || w === 'long' || w === 'longitude')) return 'lon';
    return null;
  }

  /**
   * The latitude and longitude columns, by name AND range: a number column
   * whose name says lat/lon, and — when `sample` can produce its values — at
   * least 95% of whose finite values fall in [-90, 90] / [-180, 180]. Name
   * alone is not enough ("long" might be a duration); range alone never is.
   */
  function detectLatLon(
    columns: Array<{ name: string; type: string }>,
    sample?: (name: string) => unknown[],
  ): { lat: string; lon: string } | null {
    const inRange = (name: string, lim: number): boolean => {
      if (!sample) return true;
      let n = 0;
      let ok = 0;
      for (const v of sample(name)) {
        const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
        if (!Number.isFinite(x)) continue;
        n++;
        if (Math.abs(x) <= lim) ok++;
      }
      return n > 0 && ok / n >= 0.95;
    };
    const pick = (axis: 'lat' | 'lon', lim: number): string | null => {
      const cands = columns.filter((c) => c && c.type === 'number' && axisOf(c.name) === axis);
      // An exact name first: "lat" before "pickup_lat_rounded".
      cands.sort((a, b) => tokens(a.name).length - tokens(b.name).length);
      const hit = cands.find((c) => inRange(c.name, lim));
      return hit ? hit.name : null;
    };
    const lat = pick('lat', 90);
    const lon = pick('lon', 180);
    return lat && lon && lat !== lon ? { lat, lon } : null;
  }

  function mercX(lng: number): number {
    return (lng + 180) / 360;
  }
  function mercY(lat: number): number {
    const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  /**
   * Grid clustering at `zoom`: the world (Web Mercator, so cells are square on
   * screen) cut into `cellPx`-pixel cells; each cell's points become one cluster
   * at their mean position, with a count and a value sum. A cell with one point
   * is that point (carrying its index). At or below CLUSTER_MIN points nothing
   * clusters.
   *
   * DETERMINISTIC in the strong sense: the points are ordered by position before
   * any sum, so the same points in ANY order give byte-identical clusters (a
   * float mean depends on summation order otherwise).
   */
  function gridCluster(points: Array<{ lat: number; lng: number; value?: number }>, zoom: number, cellPx = 64): any[] {
    const idx = points.map((_, i) => i);
    if (points.length <= CLUSTER_MIN) {
      return idx.map((i) => ({ lat: points[i].lat, lng: points[i].lng, count: 1, sum: points[i].value ?? 0, index: i }));
    }
    idx.sort((a, b) => points[a].lng - points[b].lng || points[a].lat - points[b].lat || a - b);
    const n = (256 * Math.pow(2, Math.max(0, Math.floor(zoom)))) / cellPx;
    const cells = new Map<string, { cx: number; cy: number; lat: number; lng: number; count: number; sum: number; index: number }>();
    for (const i of idx) {
      const p = points[i];
      const cx = Math.floor(mercX(p.lng) * n);
      const cy = Math.floor(mercY(p.lat) * n);
      const k = cx + ',' + cy;
      const c = cells.get(k) || { cx, cy, lat: 0, lng: 0, count: 0, sum: 0, index: i };
      c.lat += p.lat;
      c.lng += p.lng;
      c.count += 1;
      c.sum += typeof p.value === 'number' ? p.value : 0;
      cells.set(k, c);
    }
    return [...cells.values()]
      .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
      .map((c) => (c.count === 1
        ? { lat: c.lat, lng: c.lng, count: 1, sum: c.sum, index: c.index }
        : { lat: c.lat / c.count, lng: c.lng / c.count, count: c.count, sum: c.sum }));
  }

  const api = { CLUSTER_MIN, axisOf, detectLatLon, gridCluster };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.geoCluster = api;
})(typeof window !== 'undefined' ? window : globalThis);
