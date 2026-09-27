// Format → Colours, and the one swatch control it shares with the column
// profile (fmtProfile.ts).
//
// Three kinds of colour, each written where it belongs:
//
//   · a DIMENSION VALUE's colour ("Technology") is the PROJECT's — the colour
//     map on the project record, edited here or in the column's profile, and
//     drawn by every chart, legend, map and export in the project;
//   · a MEASURE series' colour ("sum of profit") is this visual's own —
//     `overrides.seriesColors`;
//   · a VALUE PALETTE (sequential / diverging) colours one measure's marks by
//     their value — `overrides.measurePalettes`, per measure.
//
// A colour is a ramp SLOT ('chart-3'), picked from the eight swatches the
// theme draws right now; "Auto" forgets the choice.
//
// Classic global-scope renderer <script>: no import/export.

/** Rows a Colours list shows before pointing at the column's profile for the rest. */
const FMT_COLOR_ROWS = 24;

/** The eight colours a slot is drawn in on this chart (a picked seed colour re-derives them). */
function fmtPanelPalette(ov: any, el?: Element | null): string[] {
  const theme = fmtThemePalette(el);
  return ov && ov.color ? paletteFromSeed(ov.color, theme.length) : theme;
}

/**
 * One row: a swatch button showing the value's colour (dashed when it has none
 * yet — it is dealt one the first time it is drawn) and its name. Clicking the
 * swatch opens the eight slots, plus Auto, under the row.
 */
function fmtColorRow(
  list: HTMLElement, label: string, token: string | null, palette: string[],
  onPick: (token: string | null) => void,
): void {
  const row = document.createElement('div');
  row.className = 'fmt-color-row';
  const name = label === '' ? '(empty)' : label;
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'fmt-swatch' + (token ? '' : ' is-auto');
  sw.dataset.fmtKey = 'color:' + label;
  if (token) sw.style.background = fmtHex(token, palette);
  sw.setAttribute('aria-label', 'Colour of ' + name + (token ? ': colour ' + (OrdColorMap.slotIndex(token) + 1) : ': not set'));
  sw.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'fmt-color-name';
  text.textContent = name;
  text.title = name;
  row.append(sw, text);

  const picker = document.createElement('div');
  picker.className = 'fmt-slots';
  picker.hidden = true;
  OrdColorMap.COLOR_TOKENS.forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-swatch' + (t === token ? ' cm-swatch-active' : '');
    b.dataset.token = t;
    b.style.setProperty('--sw-color', palette[i % palette.length]);
    b.setAttribute('aria-label', 'Colour ' + (i + 1));
    b.addEventListener('click', (e) => { e.stopPropagation(); onPick(t); });
    picker.appendChild(b);
  });
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'fmt-slot-auto';
  auto.textContent = 'Auto';
  auto.title = 'Forget this colour — it is dealt again when next drawn';
  auto.addEventListener('click', (e) => { e.stopPropagation(); onPick(null); });
  picker.appendChild(auto);

  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = picker.hidden;
    list.querySelectorAll('.fmt-slots').forEach((p) => { (p as HTMLElement).hidden = true; });
    list.querySelectorAll('.fmt-swatch').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    picker.hidden = !open;
    sw.setAttribute('aria-expanded', String(open));
  });
  list.append(row, picker);
}

/** A list of a COLUMN's values, coloured from and written to the project's map. */
function fmtProjectColorList(body: HTMLElement, ctx: FmtPanelCtx, column: string, values: any[]): void {
  const head = document.createElement('div');
  head.className = 'fmt-sub';
  head.textContent = '“' + column + '” colours';
  body.appendChild(head);
  fmtNote(body, 'Shared by every chart in this project.');
  const palette = fmtPanelPalette(ctx.ov(), ctx.colorEl() || body);
  const list = document.createElement('div');
  list.className = 'fmt-color-list';
  const shown = values.slice(0, FMT_COLOR_ROWS);
  shown.forEach((v) => fmtColorRow(list, String(v), fmtTokenOf(column, v), palette, (t) => {
    void fmtSetColor(column, v, t).then((ok) => { if (ok) ctx.repaint(); });
  }));
  body.appendChild(list);
  if (values.length > shown.length) {
    fmtNote(body, (values.length - shown.length) + ' more — every value is in the column’s profile, under Data.');
  }
  const actions = document.createElement('div');
  actions.className = 'fmt-actions';
  const btn = (text: string, title: string, run: () => Promise<boolean>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', () => { void run().then((ok) => { if (ok) ctx.repaint(); }); });
    actions.appendChild(b);
  };
  btn('Apply palette', 'Deal the palette out again, in this chart’s order', () => fmtApplyPalette(column, values));
  btn('Reset', 'Forget these colours — each value is dealt one when next drawn', () => fmtResetColors(column));
  body.appendChild(actions);
}

/** Can this chart colour its bars per category (a one-measure bar or column)? */
function fmtCanColorByCategory(type: string, data: any): boolean {
  return fmtColorsByCategory(type, chartSeries(data || {}), { colorByCategory: true })
    && !fmtColorsByCategory(type, chartSeries(data || {}), {});
}

function fmtColoursSection(host: HTMLElement, ctx: FmtPanelCtx): void {
  const type = ctx.type;
  if (type === 'table' || type.indexOf('map_') === 0 || type === 'pivot') return;
  const ov = ctx.ov();
  const series = chartSeries(ctx.data || {}).filter((s) => s.role !== 'overlay');
  const body = fmtSection(host, 'Colours');
  if (!ctx.data) { fmtNote(body, 'Reading the chart…'); return; }
  const scope = ctx.scope;
  const s = resolveChartType(type);

  if (fmtCanColorByCategory(type, ctx.data)) {
    fmtSwitch(body, 'colorByCategory', 'Colour bars by category', !!ov.colorByCategory,
      (on) => ctx.patch({ colorByCategory: on || null }));
  }

  // Dimension values: the category, when the chart colours by it…
  const labels = Array.isArray(ctx.data.labels) ? ctx.data.labels : [];
  if (fmtColorsByCategory(type, series, ov)) {
    if (scope && scope.category) fmtProjectColorList(body, ctx, scope.category, labels);
    else fmtNote(body, 'Save this chart as a visual to give its categories project colours.');
  }
  // …and the series, when they are a split column's values.
  const perSeries = PER_SERIES_DATASET_TYPES.has(type);
  if (perSeries && scope && scope.series) {
    fmtProjectColorList(body, ctx, scope.series, series.map((x) => x.name));
  } else if (perSeries && series.length && !ov.colorByCategory) {
    // Measure series: this visual's own colours.
    const head = document.createElement('div');
    head.className = 'fmt-sub';
    head.textContent = series.length > 1 ? 'Series colours' : 'Series colour';
    body.appendChild(head);
    const palette = fmtPanelPalette(ov, ctx.colorEl() || body);
    const list = document.createElement('div');
    list.className = 'fmt-color-list';
    const own = ov.seriesColors || {};
    series.forEach((x) => {
      const name = String(x.name || '');
      fmtColorRow(list, name, own[name] || null, palette, (t) => {
        const next = Object.assign({}, own);
        if (t) next[name] = t; else delete next[name];
        ctx.patch({ seriesColors: Object.keys(next).length ? next : null });
      });
    });
    body.appendChild(list);
  }

  // Value palettes: a bar family's measures, or a heatmap's one measure.
  const valueKinds: Array<[string, string]> = [['', 'Categorical'], ['sequential', 'Sequential'], ['diverging', 'Diverging']];
  const barLike = s.chartType === 'bar' && !s.isFunnel && !s.isHistogram && !s.isWaterfall && !s.isBullet && !s.isPareto;
  const targets = s.isMatrix ? ctx.measures.slice(0, 1)
    : barLike && !(scope && scope.series) ? series.map((x) => String(x.name || '')) : [];
  if (!targets.length) return;
  const head = document.createElement('div');
  head.className = 'fmt-sub';
  head.textContent = 'Colour by value';
  body.appendChild(head);
  const mp = ov.measurePalettes || {};
  const accent = getCSSVar('--accent', ctx.colorEl() || body) || CHART_PALETTE[0];
  const surface = getCSSVar('--surface', ctx.colorEl() || body) || '#ffffff';
  targets.forEach((m) => {
    const kind = mp[m] || '';
    const field = fmtField(body, m, fmtSelect('palette:' + m, valueKinds, kind, (v) => {
      const next = Object.assign({}, mp);
      if (v) next[m] = v; else delete next[m];
      ctx.patch({ measurePalettes: Object.keys(next).length ? next : null });
    }));
    if (!kind) return;
    const strip = document.createElement('div');
    strip.className = 'fmt-ramp';
    strip.setAttribute('aria-hidden', 'true');
    valueRamp(kind, accent, surface).forEach((c) => {
      const cell = document.createElement('span');
      cell.style.background = c;
      strip.appendChild(cell);
    });
    field.appendChild(strip);
  });
}
