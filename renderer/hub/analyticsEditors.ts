// The Analytics section's INLINE EDITORS — one small form per overlay kind.
// RENDERER ONLY. Classic global-scope <script>: no import/export.
//
// Split from analyticsPane.ts (one job each: that file owns the list and its
// state, this one the fields of an open row). Every control writes straight
// into the overlay definition and calls `anpChanged()`, which re-renders the
// list and schedules the recompute that brings main's readout back. Loads after
// analyticsPane.js.

function anpField(label: string, control: HTMLElement, wide = false): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'anp-field' + (wide ? ' anp-field--wide' : '');
  const l = document.createElement('span');
  l.className = 'anp-field-label';
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

function anpSelect(items: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void, aria: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'viz-select anp-select';
  sel.setAttribute('aria-label', aria);
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/** A number input that commits on change (not per keystroke — each commit is a recompute). */
function anpNumber(value: number | undefined, onChange: (v: number) => void, aria: string, opts: { min?: number; max?: number; step?: string } = {}): HTMLInputElement {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'anp-input';
  inp.setAttribute('aria-label', aria);
  if (opts.min !== undefined) inp.min = String(opts.min);
  if (opts.max !== undefined) inp.max = String(opts.max);
  inp.step = opts.step || 'any';
  if (typeof value === 'number' && Number.isFinite(value)) inp.value = String(value);
  inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (inp.value.trim() !== '' && Number.isFinite(v)) onChange(v);
  });
  return inp;
}

function anpText(value: string, placeholder: string, onChange: (v: string) => void, aria: string): HTMLInputElement {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'anp-input';
  inp.setAttribute('aria-label', aria);
  inp.placeholder = placeholder;
  inp.value = value || '';
  inp.maxLength = 280;
  inp.addEventListener('change', () => onChange(inp.value.trim()));
  return inp;
}

/**
 * A value source: Constant (number) · Average · Median · Minimum · Maximum ·
 * Percentile (p) · Metric… (the metric picker — resolved by main under the
 * chart's scope).
 */
function anpSourceEditor(src: any, onChange: (src: any) => void, aria: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'anp-source';
  const cur = !src ? 'avg' : src.type === 'constant' ? 'constant' : src.type === 'metric' ? 'metric' : src.stat;
  const sel = anpSelect(ANP_SOURCES, cur, async (v) => {
    if (v === 'constant') onChange({ type: 'constant', value: src && src.type === 'constant' ? src.value : anpSuggestTarget() });
    else if (v === 'metric') {
      const picked = await openMetricPicker(sel, { datasetId: vizDatasetId || undefined });
      if (picked && picked.kind === 'metric' && picked.metric) onChange({ type: 'metric', metricId: picked.metric.id });
      else anpRender(); // cancelled: put the select back
    } else if (v === 'percentile') onChange({ type: 'stat', stat: 'percentile', p: 90 });
    else onChange({ type: 'stat', stat: v });
  }, aria);
  box.appendChild(sel);
  if (src && src.type === 'constant') {
    box.appendChild(anpNumber(src.value, (n) => onChange({ type: 'constant', value: n }), aria + ' value'));
  } else if (src && src.type === 'stat' && src.stat === 'percentile') {
    box.appendChild(anpNumber(src.p, (n) => onChange({ type: 'stat', stat: 'percentile', p: n }), aria + ' percentile', { min: 0, max: 100, step: '1' }));
  } else if (src && src.type === 'metric') {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'anp-metric-chip';
    chip.textContent = t('common.metric');
    // The readout names the metric; the chip changes it.
    void anpMetricName(src.metricId).then((n) => { chip.textContent = n; });
    chip.addEventListener('click', async () => {
      const picked = await openMetricPicker(chip, { datasetId: vizDatasetId || undefined });
      if (picked && picked.kind === 'metric' && picked.metric) onChange({ type: 'metric', metricId: picked.metric.id });
    });
    box.appendChild(chip);
  }
  return box;
}

async function anpMetricName(id: string): Promise<string> {
  try {
    const m = currentProjectId ? await window.hub.getMetric(currentProjectId, id) : null;
    return m && m.name ? String(m.name) : t('common.missing_metric');
  } catch (_) { return t('common.metric'); }
}

function anpEditor(ov: any, res: any): HTMLElement {
  const ed = document.createElement('div');
  ed.className = 'anp-editor';
  const set = (patch: any) => { Object.assign(ov, patch); anpChanged(); };

  ed.appendChild(anpField(t('common.label'), anpText(ov.label || '', (res && res.label) || anpKindInfo(ov.kind).label, (v) => {
    if (v) ov.label = v; else delete ov.label;
    anpChanged();
  }, t('analyticsEditors.overlay_label')), true));

  if (anpSeries.length > 1 && ov.kind !== 'band') {
    ed.appendChild(anpField(t('common.series'), anpSelect(anpSeries.map((n, i) => ({ value: String(i), label: n })), String(ov.series || 0),
      (v) => { const i = Number(v); if (i) ov.series = i; else delete ov.series; anpChanged(); }, t('common.series'))));
  }

  switch (ov.kind) {
    case 'reference':
    case 'target':
      ed.appendChild(anpField(t('common.value'), anpSourceEditor(ov.value, (src) => set({ value: src }), t('common.value')), true));
      break;
    case 'band': {
      const mode = ov.sd ? 'sd' : 'values';
      ed.appendChild(anpField(t('analyticsEditors.shade'), anpSelect([{ value: 'sd', label: t('analyticsEditors.mean') }, { value: 'values', label: t('analyticsEditors.between_two_values') }], mode, (v) => {
        if (v === 'sd') { ov.sd = ov.sd || 1; delete ov.from; delete ov.to; }
        else { delete ov.sd; ov.from = ov.from || { type: 'stat', stat: 'min' }; ov.to = ov.to || { type: 'stat', stat: 'avg' }; }
        anpChanged();
      }, t('analyticsEditors.band_mode'))));
      if (ov.sd) ed.appendChild(anpField('σ', anpNumber(ov.sd, (n) => set({ sd: Math.max(0.1, Math.min(6, n)) }), t('analyticsEditors.standard_deviations'), { min: 0.1, max: 6, step: '0.5' })));
      else {
        ed.appendChild(anpField(t('common.from'), anpSourceEditor(ov.from, (src) => set({ from: src }), t('common.from')), true));
        ed.appendChild(anpField(t('common.to'), anpSourceEditor(ov.to, (src) => set({ to: src }), t('common.to')), true));
      }
      break;
    }
    case 'moving_average':
      ed.appendChild(anpField(t('common.window'), anpNumber(ov.window, (n) => set({ window: Math.max(2, Math.min(60, Math.round(n))) }), t('common.window'), { min: 2, max: 60, step: '1' })));
      break;
    case 'forecast':
      ed.appendChild(anpField(t('common.method'), anpSelect([
        { value: 'linear', label: t('analyticsEditors.linear') }, { value: 'seasonal_naive', label: t('analyticsEditors.seasonal_naive') }, { value: 'holt_winters', label: 'Holt-Winters' },
      ], ov.method || 'linear', (v) => set({ method: v }), t('analyticsEditors.forecast_method'))));
      ed.appendChild(anpField(t('common.periods'), anpNumber(ov.horizon, (n) => set({ horizon: Math.max(1, Math.min(36, Math.round(n))) }), t('analyticsEditors.forecast_periods'), { min: 1, max: 36, step: '1' })));
      ed.appendChild(anpField(t('analyticsEditors.season'), anpSelect([
        { value: 'auto', label: t('analyticsEditors.detect_4_7_12') }, { value: '0', label: t('common.none') },
        { value: '4', label: t('analyticsEditors.4_quarters') }, { value: '7', label: t('analyticsEditors.7_weekdays') }, { value: '12', label: t('analyticsEditors.12_months') },
      ], String(ov.season === undefined ? 'auto' : ov.season), (v) => set({ season: v === 'auto' ? 'auto' : Number(v) }), t('analyticsEditors.season'))));
      if (res && res.forecast) {
        const note = document.createElement('p');
        note.className = 'anp-note';
        note.textContent = (res.forecast.season ? t('analyticsEditors.season_2', { season: res.forecast.season }) : t('analyticsEditors.no_season'))
          + (ov.season === 'auto' || ov.season === undefined ? ' (detected)' : '') + t('analyticsEditors.shaded_band_is_the_80_interval');
        ed.appendChild(note);
      }
      break;
    case 'annotation': {
      const labels = anpLabels.length ? anpLabels : [ov.at || ''];
      ed.appendChild(anpField(t('common.at'), anpSelect(labels.map((l) => ({ value: l, label: l })), ov.at || labels[0], (v) => set({ at: v }), t('common.category')), true));
      ed.appendChild(anpField(t('common.note'), anpText(ov.text || '', t('analyticsEditors.what_happened_here'), (v) => { if (v) set({ text: v }); }, t('analyticsEditors.annotation_text')), true));
      break;
    }
    case 'highlight':
      ed.appendChild(anpField(t('common.rule'), anpSelect([
        { value: 'top', label: t('common.top_n') }, { value: 'bottom', label: t('analyticsEditors.bottom_n') },
        { value: 'above', label: t('analyticsEditors.above_a_value') }, { value: 'below', label: t('analyticsEditors.below_a_value') },
      ], ov.rule || 'top', (v) => {
        ov.rule = v;
        if (v === 'top' || v === 'bottom') { ov.n = ov.n || 3; delete ov.threshold; } else { ov.threshold = ov.threshold || 0; delete ov.n; }
        anpChanged();
      }, t('analyticsEditors.highlight_rule'))));
      if (ov.rule === 'above' || ov.rule === 'below') ed.appendChild(anpField(t('common.value'), anpNumber(ov.threshold, (n) => set({ threshold: n }), t('common.threshold'))));
      else ed.appendChild(anpField('N', anpNumber(ov.n, (n) => set({ n: Math.max(1, Math.min(50, Math.round(n))) }), t('common.how_many'), { min: 1, max: 50, step: '1' })));
      break;
    default:
      break;
  }

  if (ov.kind === 'trend' && res && res.trend) {
    const note = document.createElement('p');
    note.className = 'anp-note';
    note.textContent = t('analyticsEditors.least_squares_over_points_r2_the', { anpLabelsCount: anpLabels.length, p1: res.trend.r2 === null ? 'n/a' : res.trend.r2.toFixed(2) });
    ed.appendChild(note);
  }

  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'anp-color';
  color.setAttribute('aria-label', t('analyticsEditors.overlay_colour'));
  color.value = ov.color || '#6366f1';
  color.addEventListener('change', () => set({ color: color.value }));
  ed.appendChild(anpField(t('common.colour'), color));
  if ((ov.kind === 'reference' || ov.kind === 'target') && ov.value && ov.value.type === 'constant') {
    const tip = document.createElement('p');
    tip.className = 'anp-note';
    tip.textContent = t('analyticsEditors.tip_drag_the_line_on_the');
    ed.appendChild(tip);
  }
  return ed;
}
