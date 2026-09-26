'use strict';

// The builder's MAP settings, mounted under the encoding form's "Map regions"
// select. Classic global-scope renderer <script>.
//
// The select gains three kinds of place — latitude/longitude points, world
// cities, and the project's own imported boundaries (listed beside the bundled
// geographies, with "Import boundaries…" at the end) — and a row of fields
// that only shows for the level that needs it: the two coordinate columns and
// a colour column for points, the joining property for a custom boundary set,
// and the basemap for every map.

interface EncMapApi {
  set(geo: any, columns: EncCol[]): void;
  get(): any;
}

const ENC_MAP_LEVELS: Array<[string, string]> = [['point', 'Latitude / longitude points'], ['world_city', 'World cities']];

function encMapMount(root: HTMLElement, geoSel: HTMLSelectElement | null, onChange: () => void): EncMapApi {
  let columns: EncCol[] = [];
  let boundaries: any[] = [];
  let last = '';
  const noop: EncMapApi = { set: () => {}, get: () => null };
  if (!geoSel) return noop;
  for (const [v, t] of ENC_MAP_LEVELS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    geoSel.appendChild(o);
  }
  const group = document.createElement('optgroup');
  group.label = 'Your boundaries';
  geoSel.appendChild(group);
  const importOpt = document.createElement('option');
  importOpt.value = '__import';
  importOpt.textContent = 'Import boundaries…';
  geoSel.appendChild(importOpt);

  const box = document.createElement('div');
  box.className = 'enc-map-fields';
  (geoSel.closest('.viz-build-row') as HTMLElement).after(box);
  const field = (label: string): HTMLSelectElement => {
    const wrap = document.createElement('label');
    wrap.className = 'enc-map-field';
    const t = document.createElement('span');
    t.className = 'viz-field-label';
    t.textContent = label;
    const sel = document.createElement('select');
    sel.className = 'viz-select';
    sel.addEventListener('change', onChange);
    wrap.append(t, sel);
    box.appendChild(wrap);
    return sel;
  };
  const latSel = field('Latitude');
  const lonSel = field('Longitude');
  const colorSel = field('Colour by');
  const propSel = field('Joins on');
  const baseSel = field('Basemap');
  const opts = (sel: HTMLSelectElement, items: Array<[string, string]>, value: string): void => {
    sel.innerHTML = '';
    for (const [v, t] of items) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = items.some(([v]) => v === value) ? value : items.length ? items[0][0] : '';
  };
  opts(baseSel, [['', 'Map tiles (OpenStreetMap)'], ['none', 'None — offline land and water']], '');

  const levelOf = (): string => (geoSel.value.startsWith('custom:') ? 'custom' : geoSel.value);
  const show = (): void => {
    const lvl = levelOf();
    box.hidden = !lvl;
    (latSel.parentElement as HTMLElement).hidden = lvl !== 'point';
    (lonSel.parentElement as HTMLElement).hidden = lvl !== 'point';
    (colorSel.parentElement as HTMLElement).hidden = lvl !== 'point';
    (propSel.parentElement as HTMLElement).hidden = lvl !== 'custom';
    if (lvl === 'custom') {
      const b = boundaries.find((x) => 'custom:' + x.id === geoSel.value);
      const props: Array<[string, string]> = b ? b.properties.map((p: any) => [p.key, p.unique ? p.key : p.key + ' (repeats)']) : [];
      opts(propSel, props, propSel.value || (b && (b.properties.find((p: any) => p.unique) || b.properties[0] || {}).key) || '');
    }
  };
  const fillBoundaries = async (select?: string): Promise<void> => {
    if (!currentProjectId) return;
    const res = await window.hubAuthoring.listBoundaries(currentProjectId).catch(() => null);
    boundaries = res && res.ok ? res.boundaries : [];
    group.innerHTML = '';
    for (const b of boundaries) {
      const o = document.createElement('option');
      o.value = 'custom:' + b.id;
      o.textContent = `${b.name} (${b.featureCount} regions)`;
      group.appendChild(o);
    }
    group.hidden = boundaries.length === 0;
    if (select) geoSel.value = select;
    show();
  };
  geoSel.addEventListener('change', async () => {
    if (geoSel.value === '__import') {
      geoSel.value = last;
      if (!currentProjectId) return;
      const res = await window.hubAuthoring.importBoundaries(currentProjectId);
      if (res && res.ok) {
        showToast(`Imported ${res.boundary.featureCount} regions from ${res.boundary.name}`, { kind: 'success' });
        await fillBoundaries('custom:' + res.boundary.id);
        onChange();
      } else if (res && res.error) showToast(res.error, { kind: 'error' });
      return;
    }
    last = geoSel.value;
    show();
  });

  return {
    set(geo: any, cols: EncCol[]): void {
      columns = cols;
      const nums: Array<[string, string]> = columns.filter((c) => c.type === 'number').map((c) => [c.name, c.name]);
      const found = geoCluster.detectLatLon(columns);
      opts(latSel, nums, (geo && geo.lat) || (found && found.lat) || '');
      opts(lonSel, nums, (geo && geo.lon) || (found && found.lon) || '');
      opts(colorSel, [['', 'One colour'] as [string, string]].concat(columns.map((c) => [c.name, c.name] as [string, string])), (geo && geo.color) || '');
      opts(baseSel, [['', 'Map tiles (OpenStreetMap)'], ['none', 'None — offline land and water']], (geo && geo.basemap === 'none') ? 'none' : '');
      const want = geo && geo.level === 'custom' && geo.boundaryId ? 'custom:' + geo.boundaryId : (geo && geo.level) || '';
      if (geo && geo.property) opts(propSel, [[geo.property, geo.property]], geo.property);
      geoSel.value = want;
      last = geoSel.value;
      void fillBoundaries(want.startsWith('custom:') ? want : undefined);
      show();
    },
    get(): any {
      const lvl = levelOf();
      if (!lvl) return null;
      const geo: any = { level: lvl };
      if (lvl === 'point') {
        if (latSel.value) geo.lat = latSel.value;
        if (lonSel.value) geo.lon = lonSel.value;
        if (colorSel.value) geo.color = colorSel.value;
      }
      if (lvl === 'custom') {
        geo.boundaryId = geoSel.value.slice('custom:'.length);
        if (propSel.value) geo.property = propSel.value;
      }
      if (baseSel.value === 'none') geo.basemap = 'none';
      return geo;
    },
  };
}
