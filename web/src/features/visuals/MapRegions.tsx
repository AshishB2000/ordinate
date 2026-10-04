// "Map regions" (encodingForm's geo select + encodingMap.ts): the bundled
// geographies, latitude/longitude points, world cities, hexbin density, flows,
// and the project's own imported boundaries — with "Import boundaries…" at the
// end, which uploads a GeoJSON (T0.4) instead of opening a native picker.
// Under the select, only the fields the chosen level needs.

import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { axisOf, detectLatLon } from '../../charts/maps/geoCluster';
import { Select, type SelectOption } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { upload } from '../../api/client';
import { importBoundaries, useBoundaries, type Boundary, type Geo } from './api';
import type { Column } from './model';
import s from './Builder.module.css';

const LEVELS: SelectOption[] = [
  { value: '', label: 'Off' },
  { value: 'country', label: 'Countries' },
  { value: 'us_state', label: 'US states' },
  { value: 'us_county', label: 'US counties' },
  { value: 'us_city', label: 'US cities' },
  { value: 'us_zip', label: 'US ZIP codes' },
  { value: 'point', label: 'Latitude / longitude points' },
  { value: 'world_city', label: 'World cities' },
  { value: 'hexbin', label: 'Hexbin density (latitude / longitude)' },
  { value: 'flow', label: 'Flows (origin → destination)' },
];
const XY = ['point', 'hexbin', 'flow'];
const IMPORT = '__import';

const opt = (value: string, label = value): SelectOption => ({ value, label });

/** A level's geo with every field defaulted the way the desktop's selects were. */
export function geoFor(level: string, cols: readonly Column[], boundaries: readonly Boundary[], prev?: Geo): Geo | undefined {
  if (!level) return undefined;
  const nums = cols.filter((c) => c.type === 'number').map((c) => c.name);
  const custom = level.startsWith('custom:');
  const geo: Geo = { level: (custom ? 'custom' : level) as Geo['level'] };
  if (XY.includes(geo.level)) {
    const found = detectLatLon(cols);
    geo.lat = prev?.lat || found?.lat || nums[0];
    geo.lon = prev?.lon || found?.lon || nums[0];
    if (!geo.lat) delete geo.lat;
    if (!geo.lon) delete geo.lon;
  }
  if (geo.level === 'point' && prev?.color) geo.color = prev.color;
  if (geo.level === 'flow') {
    const like = (n: string, axis: 'lat' | 'lon') => axisOf(n) === axis || (axis === 'lat' ? /lat/i : /lng|lon/i).test(n);
    const pick = (axis: 'lat' | 'lon', not?: string) => nums.find((n) => n !== not && like(n, axis)) ?? nums[0];
    const lat2 = prev?.lat2 || pick('lat', geo.lat);
    const lon2 = prev?.lon2 || pick('lon', geo.lon);
    if (lat2) geo.lat2 = lat2;
    if (lon2) geo.lon2 = lon2;
    if (prev?.from) geo.from = prev.from;
    if (prev?.to) geo.to = prev.to;
  }
  if (custom) {
    geo.boundaryId = level.slice('custom:'.length);
    const b = boundaries.find((x) => x.id === geo.boundaryId);
    const property = prev?.boundaryId === geo.boundaryId && prev.property ? prev.property : (b?.properties.find((p) => p.unique) ?? b?.properties[0])?.key;
    if (property) geo.property = property;
  }
  if (prev?.basemap === 'none') geo.basemap = 'none';
  return geo;
}

export function MapRegions({ projectId, cols, geo, onChange }: { projectId: string; cols: readonly Column[]; geo: Geo | undefined; onChange: (g: Geo | undefined) => void }) {
  const qc = useQueryClient();
  const list = useBoundaries(projectId);
  const boundaries = list.data ?? [];
  const file = useRef<HTMLInputElement>(null);
  const level = geo ? (geo.level === 'custom' && geo.boundaryId ? `custom:${geo.boundaryId}` : geo.level) : '';
  const options: SelectOption[] = [
    ...LEVELS,
    ...(boundaries.length ? [{ value: '__group', label: 'Your boundaries', disabled: true }] : []),
    ...boundaries.map((b) => opt(`custom:${b.id}`, `${b.name} (${b.featureCount} regions)`)),
    { value: IMPORT, label: 'Import boundaries…' },
  ];

  async function imported(f: File) {
    try {
      const up = await upload(f, f.name);
      const b = await importBoundaries(projectId, up.fileToken);
      toast(`Imported ${b.featureCount} regions from ${b.name}`, { kind: 'success' });
      await qc.invalidateQueries({ queryKey: ['boundary:list', projectId] });
      onChange(geoFor(`custom:${b.id}`, cols, [b], geo));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not import those boundaries.', { kind: 'error' });
    }
  }

  const set = (patch: Partial<Geo>) => {
    if (!geo) return;
    const next = { ...geo, ...patch };
    for (const k of Object.keys(patch) as (keyof Geo)[]) if (!next[k]) delete next[k];
    onChange(next);
  };
  const nums = cols.filter((c) => c.type === 'number').map((c) => opt(c.name));
  const names = [opt('', 'None — show coordinates'), ...cols.filter((c) => c.type !== 'number').map((c) => opt(c.name))];
  const lvl = geo?.level ?? '';
  const b = boundaries.find((x) => x.id === geo?.boundaryId);
  const field = (label: string, value: string | undefined, options: SelectOption[], key: keyof Geo) => (
    <Select label={label} size="sm" value={value ?? ''} options={options} onValueChange={(v) => set({ [key]: v })} />
  );

  return (
    <div className={s.row}>
      <Select
        label="Map regions"
        aria-label="Geographic level"
        value={level}
        options={options}
        onValueChange={(v) => (v === IMPORT ? file.current?.click() : onChange(geoFor(v, cols, boundaries, geo)))}
      />
      <input
        ref={file}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        className={s.hiddenFile}
        aria-label="GeoJSON boundaries file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void imported(f);
        }}
      />
      {geo && (
        <div className={s.mapFields}>
          {XY.includes(lvl) && field(lvl === 'flow' ? 'Origin latitude' : 'Latitude', geo.lat, nums, 'lat')}
          {XY.includes(lvl) && field(lvl === 'flow' ? 'Origin longitude' : 'Longitude', geo.lon, nums, 'lon')}
          {lvl === 'flow' && field('Destination latitude', geo.lat2, nums, 'lat2')}
          {lvl === 'flow' && field('Destination longitude', geo.lon2, nums, 'lon2')}
          {lvl === 'flow' && field('Origin name', geo.from, names, 'from')}
          {lvl === 'flow' && field('Destination name', geo.to, names, 'to')}
          {lvl === 'point' && field('Colour by', geo.color, [opt('', 'One colour'), ...cols.map((c) => opt(c.name))], 'color')}
          {lvl === 'custom' &&
            field('Joins on', geo.property, (b?.properties ?? []).map((p) => opt(p.key, p.unique ? p.key : `${p.key} (repeats)`)), 'property')}
          {field('Basemap', geo.basemap === 'none' ? 'none' : '', [opt('', 'Map tiles (OpenStreetMap)'), opt('none', 'None — offline land and water')], 'basemap')}
          {lvl === 'hexbin' && <p className={s.note}>Each hexagon shows the first measure — a count of points, or its sum or average. Hexagons get finer as you zoom.</p>}
          {lvl === 'flow' && <p className={s.note}>Each route is one origin → destination pair; line width is the first measure (count, sum or average).</p>}
        </div>
      )}
    </div>
  );
}
