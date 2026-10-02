// THE RADIUS CONTROL — "within [25] km of [place]" in a dashboard's filter bar
// (depth round 6). Classic global-scope renderer <script>, loaded after
// dashControls.js / dashControlBar.js / dashAddControl.js, whose chip, state and
// dialog conventions it follows.
//
// A radius reads TWO columns of one dataset (`column` = latitude, `lngColumn`),
// and its selection is a CENTRE resolved from the offline places table by main
// (window.hubGeo.resolvePlace) and a distance. The match is SHOWN before it is
// applied — "Austin, TX" — and a place the table does not know applies nothing
// and says so. The selection becomes one `within_km` filter step
// (radiusStepsRenderer, the mirror of src/analysis/geo/radius.radiusControlSteps),
// which main compiles for every card: the resident SQL where the dataset is on
// Parquet, the JS fold otherwise. A card over a dataset without those columns
// skips the step with the usual "unknown column" warning, exactly like every
// other dashboard filter.
//
// The state is `{ value, place, lat, lng, km }` where `value` is the sentence
// ("within 25 km of Austin, TX"): every existing "is anything selected" and
// "export header" read of `value` works on it unchanged.

const RADIUS_PRESETS = [5, 10, 25, 50, 100];

function radiusSentence(km: number, place: string): string {
  const k = Number.isInteger(km) ? String(km) : String(Math.round(km * 10) / 10);
  return t('geoRadius.within_km_of', { k, place });
}

/** controlStepsRenderer's radius branch: one within_km step, or none while unset. */
function radiusStepsRenderer(control: any, state: any): any[] {
  if (!state || !state.value || typeof state.lat !== 'number' || typeof state.lng !== 'number' || !(state.km > 0)) return [];
  if (!control.lngColumn) return [];
  return [{
    type: 'filter', column: control.column, op: 'within_km',
    radius: { lngColumn: control.lngColumn, lat: state.lat, lng: state.lng, km: state.km, place: state.place || '' },
  }];
}

/** The place box + km box + the resolved match, shared by the chip popover and the add/edit dialog. */
function radiusEditor(seed: any, onChange: (v: any) => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'geo-radius-editor';
  const row = document.createElement('div');
  row.className = 'geo-radius-row';
  const within = document.createElement('span');
  within.className = 'geo-radius-word';
  within.textContent = t('geoRadius.within');
  const km = document.createElement('input');
  km.type = 'number';
  km.min = '0.1';
  km.max = '20016';
  km.step = 'any';
  km.className = 'ws-modal-input geo-radius-km';
  km.setAttribute('aria-label', t('geoRadius.distance_in_kilometres'));
  km.value = String(seed && seed.km > 0 ? seed.km : 25);
  const of = document.createElement('span');
  of.className = 'geo-radius-word';
  of.textContent = t('geoRadius.km_of');
  const place = document.createElement('input');
  place.type = 'text';
  place.className = 'ws-modal-input geo-radius-place';
  place.placeholder = t('geoRadius.city_county_or_zip_e_g');
  place.setAttribute('aria-label', t('common.place'));
  place.value = seed && seed.place ? String(seed.place) : '';
  row.append(within, km, of, place);

  const presets = document.createElement('div');
  presets.className = 'geo-radius-presets';
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', t('geoRadius.common_distances'));
  RADIUS_PRESETS.forEach((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'geo-radius-preset';
    b.textContent = n + ' km';
    b.addEventListener('click', () => { km.value = String(n); emit(); });
    presets.appendChild(b);
  });

  const match = document.createElement('div');
  match.className = 'geo-radius-match';
  match.setAttribute('aria-live', 'polite');
  box.append(row, presets, match);

  let resolved: any = seed && typeof seed.lat === 'number' ? { label: seed.place, lat: seed.lat, lng: seed.lng } : null;
  let seq = 0;
  let timer: number | null = null;
  const paint = (text: string, kind: '' | 'ok' | 'err'): void => {
    match.textContent = '';
    match.className = 'geo-radius-match' + (kind ? ' is-' + kind : '');
    if (kind === 'ok') match.appendChild(icon('map-pin', 14));
    const t = document.createElement('span');
    t.textContent = text;
    match.appendChild(t);
  };
  const emit = (): void => {
    const k = Number(km.value);
    const good = resolved && k > 0 && k <= 20016;
    presets.querySelectorAll('.geo-radius-preset').forEach((b) => b.classList.toggle('is-on', (b.textContent || '') === k + ' km'));
    onChange(good ? { value: radiusSentence(k, resolved.label), place: resolved.label, lat: resolved.lat, lng: resolved.lng, km: k } : null);
  };
  const lookup = async (): Promise<void> => {
    const text = place.value.trim();
    const mine = ++seq;
    if (!text) { resolved = null; paint(t('geoRadius.type_a_place_to_measure_from'), ''); emit(); return; }
    paint(t('geoRadius.looking_up', { text }), '');
    let res: any = null;
    try { res = await window.hubGeo.resolvePlace(text); } catch (_) { res = null; }
    if (mine !== seq) return;
    if (res && res.ok) {
      resolved = res.place;
      paint(`${res.place.label} · ${res.place.lat.toFixed(3)}, ${res.place.lng.toFixed(3)}`, 'ok');
    } else {
      resolved = null;
      paint((res && res.error) || t('geoRadius.that_place_could_not_be_looked'), 'err');
    }
    emit();
  };
  place.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; void lookup(); }, 250);
  });
  km.addEventListener('input', emit);
  if (resolved) paint(`${resolved.label} · ${resolved.lat.toFixed(3)}, ${resolved.lng.toFixed(3)}`, 'ok');
  else paint(t('geoRadius.type_a_place_to_measure_from'), '');
  emit();
  return box;
}

// ── The chip in the filter bar ───────────────────────────────────────────────

function renderRadiusControl(card: any, wrap: HTMLElement): void {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'dash-ctrl-chip dash-ctrl-radius';
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.appendChild(icon('map-pin', 14));
  const txt = document.createElement('span');
  const cur = controlCurrentValue(card);
  txt.textContent = cur && cur.value ? cur.value : t('geoRadius.anywhere');
  chip.appendChild(txt);
  wrap.appendChild(chip);
  chip.addEventListener('click', () => openRadiusPopover(card, chip));
}

function openRadiusPopover(card: any, anchor: HTMLElement): void {
  if (openControlPopover) openControlPopover();
  const control = card.control;
  const pop = document.createElement('div');
  pop.className = 'dash-ctrl-popover geo-radius-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('geoRadius.distance_from_a_place', { p0: (control.label || t('common.radius')) }));
  let pending: any = null;
  const actions = document.createElement('div');
  actions.className = 'dash-ctrl-popover-actions';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm';
  clear.textContent = t('geoRadius.anywhere');
  clear.setAttribute('aria-label', t('geoRadius.clear_the_radius'));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm';
  cancel.textContent = t('common.cancel');
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-primary btn-sm';
  apply.textContent = t('common.apply');
  actions.append(clear, cancel, apply);
  // After the buttons exist: the editor reports its seed at once.
  pop.appendChild(radiusEditor(controlCurrentValue(card), (v) => { pending = v; apply.disabled = !v; }));
  pop.appendChild(actions);

  const position = (): void => {
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - 380)) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
  };
  function close(): void {
    if (openControlPopover === close) openControlPopover = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
  }
  function onDocDown(e: MouseEvent): void {
    const t = e.target as Node;
    if (!pop.contains(t) && !anchor.contains(t)) close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
    else if (e.key === 'Enter' && !apply.disabled && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); apply.click(); }
  }
  cancel.addEventListener('click', () => close());
  clear.addEventListener('click', () => { close(); controlState.delete(card.id); renderDashGrid(); });
  apply.addEventListener('click', () => {
    if (!pending) return;
    close();
    controlState.set(card.id, pending);
    renderDashGrid(); // every card recomputes through effectiveFilters()
  });
  document.body.appendChild(pop);
  openControlPopover = close;
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', position, true);
  position();
  const input = pop.querySelector('.geo-radius-place') as HTMLInputElement | null;
  if (input) input.focus();
}

// ── Add / edit ───────────────────────────────────────────────────────────────

/** `+ Control` → Radius, and a radius chip's Edit…: dataset, the two columns, label, optional default. */
function openRadiusControlDialog(datasets: any[], existing?: any): Promise<any> { // the control, or null on cancel
  return new Promise((resolve) => {
    let done = false;
    const editing = !!(existing && existing.kind === 'radius');
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-control-modal geo-radius-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = editing ? t('geoRadius.edit_radius_control') : t('geoRadius.add_a_radius_control');
    const lede = document.createElement('p');
    lede.className = 'geo-radius-lede';
    lede.textContent = t('geoRadius.keeps_the_rows_whose_point_lies');
    const field = (text: string, el: HTMLElement): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'dm-field';
      const span = document.createElement('span');
      span.className = 'dm-field-label';
      span.textContent = text;
      row.append(span, el);
      return row;
    };
    const select = (): HTMLSelectElement => { const s = document.createElement('select'); s.className = 'ws-modal-input'; return s; };
    const dsSel = select();
    datasets.forEach((d) => {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d && d.name ? String(d.name) : t('common.untitled_dataset');
      dsSel.appendChild(o);
    });
    if (editing && existing.datasetId) dsSel.value = String(existing.datasetId);
    const latSel = select();
    const lngSel = select();
    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'ws-modal-input';
    label.value = editing && existing.label ? String(existing.label) : t('geoRadius.near');
    const note = document.createElement('p');
    note.className = 'geo-radius-cols-note';
    let def: any = editing && existing.default ? existing.default : null;
    const editor = radiusEditor(def, (v) => { def = v; });

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('common.cancel');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = editing ? t('common.save') : t('common.add');
    actions.append(cancel, ok);

    const loadColumns = async (): Promise<void> => {
      const id = dsSel.value;
      let meta: any = null;
      try { meta = currentProjectId && id ? await window.hub.getDatasetMeta(currentProjectId, id) : null; } catch (_) { meta = null; }
      if (done || dsSel.value !== id) return;
      const cols = meta && Array.isArray(meta.columns) ? meta.columns : [];
      const nums = cols.filter((c: any) => c && c.type === 'number').map((c: any) => String(c.name));
      const found = geoCluster.detectLatLon(cols);
      for (const [sel, want] of [[latSel, editing && existing.column], [lngSel, editing && existing.lngColumn]] as Array<[HTMLSelectElement, any]>) {
        sel.innerHTML = '';
        nums.forEach((n: string) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
        const guess = sel === latSel ? found && found.lat : found && found.lon;
        const pick = [want, guess].find((v) => v && nums.indexOf(v) >= 0);
        if (pick) sel.value = pick;
      }
      note.textContent = nums.length < 2 ? t('geoRadius.this_dataset_needs_two_number_columns') : '';
      note.hidden = !note.textContent;
      ok.disabled = nums.length < 2;
    };
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: any): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function submit(): void {
      if (ok.disabled || !dsSel.value || !latSel.value || !lngSel.value) return;
      if (latSel.value === lngSel.value) { note.textContent = t('geoRadius.pick_two_different_columns_for_latitude'); note.hidden = false; return; }
      const out: any = { kind: 'radius', datasetId: dsSel.value, column: latSel.value, lngColumn: lngSel.value, label: label.value.trim() || t('geoRadius.near') };
      if (def) out.default = def;
      close(out);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (a11y) a11y.onTabKey(e);
    }
    dsSel.addEventListener('change', () => { void loadColumns(); });
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    box.append(h, lede);
    if (!datasets.length) {
      const empty = document.createElement('p');
      empty.className = 'dash-modal-empty';
      empty.textContent = t('geoRadius.import_a_dataset_with_latitude_and');
      box.appendChild(empty);
      ok.disabled = true;
    } else {
      const cols = document.createElement('div');
      cols.className = 'geo-radius-cols';
      cols.append(field(t('common.latitude'), latSel), field(t('common.longitude'), lngSel));
      box.append(field(t('common.dataset'), dsSel), cols, note, field(t('common.label'), label), field(t('geoRadius.default_optional_applied_when_the_sheet'), editor));
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, h.textContent || t('geoRadius.radius_control'), datasets.length ? dsSel : cancel);
    if (datasets.length) void loadColumns();
  });
}

/** `+ Control` → Radius: the dialog, then the card, with its default live at once. */
async function addRadiusControl(datasets: any[]): Promise<void> {
  const control = await openRadiusControlDialog(datasets);
  if (!control) return;
  const id = dashUuid();
  if (control.default) controlState.set(id, control.default);
  pushCard({ id, type: 'control', control, layout: { x: 0, y: 0, w: 0, h: 0 } });
}

/** A radius chip's Edit…: the same dialog, prefilled. */
async function editRadiusControl(card: any, datasets: any[]): Promise<void> {
  const next = await openRadiusControlDialog(datasets, card.control);
  if (!next) return;
  card.control = next;
  controlState.delete(card.id);
  if (next.default) controlState.set(card.id, next.default);
  markDashDirty(t('common.edit_control'));
  renderDashGrid();
}
