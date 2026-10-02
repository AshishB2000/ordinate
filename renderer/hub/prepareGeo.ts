// The SPATIAL JOIN step's editor and summary line — "Assign regions" in the
// Prepare panel (depth round 6). Classic global-scope script (NO import/export),
// loaded after the prepare family (prepare.js / prepareForms.js /
// prepareCombine.js), whose dispatchers route `spatial_join` here.
//
// The boundaries are the three bundled sets or one of the project's imported
// ones (with the property that names a region), listed by main
// (window.hubGeo.boundarySources). The preview is COUNTED by main over the
// step's real input — "4,812 of 5,000 points matched · 7 regions" — and Save
// runs as a job (window.hubGeo.saveSpatialStep), because point in polygon over
// every row is the one prepare edit that can take a while.

const SJ_BUNDLED_HINTS: Record<string, string> = {
  us_state: '50 states, DC and Puerto Rico',
  country: 'Every country, by name',
  us_county: '3,221 counties, named with their state',
};

function buildSpatialJoinForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const nums = expColumns.filter((c) => c.type === 'number').map((c) => c.name);
  const found = geoCluster.detectLatLon(expColumns);
  const latSel = makeNameSelect(nums, e.lat || (found && found.lat) || '');
  const lngSel = makeNameSelect(nums, e.lng || (found && found.lon) || '');
  const asIn = textInput(e.as || 'region');
  const unmatchedIn = textInput(e.unmatched || '');
  unmatchedIn.placeholder = '(empty)';
  let boundary: string = e.boundary || 'us_state';
  let boundaryId: string = e.boundaryId || '';
  let custom: any[] = [];
  const propHost = document.createElement('div');
  let propSel = makeNameSelect([], '');
  propHost.appendChild(propSel);
  const propRow = fieldRow('Region name property', propHost);
  const preview = makePreviewBox();
  let seq = 0;

  const sources = document.createElement('div');
  sources.className = 'sj-sources';
  sources.setAttribute('role', 'radiogroup');
  sources.setAttribute('aria-label', 'Boundaries');
  const sourceRow = document.createElement('div');
  sourceRow.className = 'ds-step-field';
  const sourceLabel = document.createElement('span');
  sourceLabel.className = 'ds-step-field-label';
  sourceLabel.textContent = 'Boundaries';
  sourceRow.append(sourceLabel, sources);

  const read = (): any => {
    const step: any = { type: 'spatial_join', lat: latSel.value, lng: lngSel.value, boundary, as: asIn.value.trim() || 'region', unmatched: unmatchedIn.value };
    if (boundary === 'custom') { step.boundaryId = boundaryId; step.property = propSel.value; }
    return step;
  };
  const refresh = async (): Promise<void> => {
    if (!latSel.value || !lngSel.value || (boundary === 'custom' && (!boundaryId || !propSel.value))) return setPreview(preview, []);
    const mine = ++seq;
    setPreview(preview, ['Counting…']);
    let res: any = null;
    try { res = await window.hubGeo.spatialPreview(currentProjectId || '', expId || '', dsStepEditIndex, read()); } catch (_) { res = null; }
    if (mine !== seq) return;
    if (!res || !res.ok) return setPreview(preview, [(res && res.error) || 'Could not preview.'], true);
    paintSpatialPreview(preview, res.stats);
  };
  const paintProps = (): void => {
    const set = custom.find((b) => b.id === boundaryId);
    const props: string[] = set ? set.properties.map((p: any) => String(p.key)) : [];
    const want = boundary === 'custom' && e.boundaryId === boundaryId ? e.property : (set && (set.properties.find((p: any) => p.unique) || set.properties[0] || {}).key) || '';
    const next = makeNameSelect(props, want);
    next.addEventListener('change', () => void refresh());
    propHost.replaceChild(next, propSel);
    propSel = next;
    propRow.hidden = boundary !== 'custom';
  };
  const tile = (id: string, name: string, hint: string, on: () => boolean, pick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sj-source';
    b.setAttribute('role', 'radio');
    const n = document.createElement('span');
    n.className = 'sj-source-name';
    n.textContent = name;
    const h = document.createElement('span');
    h.className = 'sj-source-hint';
    h.textContent = hint;
    b.append(n, h);
    b.dataset.source = id;
    b.addEventListener('click', () => { pick(); paintTiles(); paintProps(); void refresh(); });
    (b as any).__on = on; // any: the tile's own "am I selected" test, read by paintTiles
    return b;
  };
  const paintTiles = (): void => {
    sources.querySelectorAll('.sj-source').forEach((el) => {
      const on = (el as any).__on(); // any: set by tile() above
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  };
  const paintSources = (): void => {
    sources.innerHTML = '';
    for (const id of ['us_state', 'country', 'us_county']) {
      const label = id === 'us_state' ? 'US states' : id === 'country' ? 'Countries' : 'US counties';
      sources.appendChild(tile(id, label, SJ_BUNDLED_HINTS[id], () => boundary === id, () => { boundary = id; }));
    }
    for (const b of custom) {
      sources.appendChild(tile('custom:' + b.id, b.name, `${Number(b.featureCount).toLocaleString('en-US')} regions · your boundaries`,
        () => boundary === 'custom' && boundaryId === b.id, () => { boundary = 'custom'; boundaryId = b.id; }));
    }
    paintTiles();
  };

  paintSources();
  paintProps();
  void (async () => {
    try {
      const res = await window.hubGeo.boundarySources(currentProjectId || '');
      custom = res && Array.isArray(res.custom) ? res.custom : [];
    } catch (_) { custom = []; }
    paintSources();
    paintProps();
    void refresh();
  })();
  [latSel, lngSel].forEach((s) => s.addEventListener('change', () => void refresh()));
  unmatchedIn.addEventListener('change', () => void refresh());

  const grid = document.createElement('div');
  grid.className = 'sj-grid';
  grid.append(fieldRow('Latitude', latSel), fieldRow('Longitude', lngSel), fieldRow('New column', asIn), fieldRow('Points in no region get', unmatchedIn));
  body.appendChild(sourceRow);
  body.appendChild(propRow);
  body.appendChild(grid);
  if (nums.length < 2) {
    const hint = document.createElement('div');
    hint.className = 'ds-step-hint';
    hint.textContent = 'This step needs two number columns — a latitude and a longitude.';
    body.appendChild(hint);
  }
  body.appendChild(preview);
  return () => {
    const step = read();
    if (!step.lat || !step.lng) { window.alert('Pick the latitude and longitude columns.'); return null; }
    if (step.lat === step.lng) { window.alert('Latitude and longitude must be two different columns.'); return null; }
    if (boundary === 'custom' && (!step.boundaryId || !step.property)) { window.alert('Pick the boundary set and the property that names each region.'); return null; }
    return step;
  };
}

/** "4,812 of 5,000 points matched · 7 regions", a meter, and the busiest regions — every figure from main. */
function paintSpatialPreview(box: HTMLElement, s: any): void {
  box.innerHTML = '';
  const pct = s.total ? Math.round((s.matched / s.total) * 1000) / 10 : 0;
  const head = document.createElement('div');
  head.textContent = `${fmtN(s.matched)} of ${fmtN(s.total)} points matched · ${fmtN(s.regions)} region${s.regions === 1 ? '' : 's'}`;
  const meter = document.createElement('div');
  meter.className = 'sj-meter';
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', pct + '% of points matched');
  const fill = document.createElement('div');
  fill.className = 'sj-meter-fill';
  fill.style.width = pct + '%';
  meter.appendChild(fill);
  box.append(head, meter);
  if (s.top && s.top.length) {
    const top = document.createElement('div');
    top.className = 'sj-top';
    for (const t of s.top) {
      const chip = document.createElement('span');
      chip.className = 'sj-top-chip';
      chip.textContent = `${t.name} · ${fmtN(t.count)}`;
      top.appendChild(chip);
    }
    box.appendChild(top);
  }
  const outside = s.total - s.matched - s.noCoords;
  const notes: string[] = [];
  if (s.noCoords) notes.push(`${fmtN(s.noCoords)} row${s.noCoords === 1 ? '' : 's'} with no usable coordinates`);
  if (outside > 0) notes.push(`${fmtN(outside)} outside every region`);
  if (notes.length) {
    const n = document.createElement('div');
    n.textContent = notes.join(' · ');
    box.appendChild(n);
  }
  box.classList.toggle('is-warn', s.matched < s.total);
  box.hidden = false;
}

/** prepareCombine.powerStepSummary's spatial_join line. */
function geoStepSummary(step: any): string {
  if (!step || step.type !== 'spatial_join') return '';
  const set = step.boundary === 'us_state' ? 'US states' : step.boundary === 'country' ? 'countries' : step.boundary === 'us_county' ? 'US counties' : 'your boundaries';
  return `Assign ${step.as || 'region'} from ${step.lat}, ${step.lng} by ${set}`;
}
