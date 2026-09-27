// The column profile's COLOURS section: the project's colour for each value of
// a text column — the same map every chart, legend, map and export in the
// project draws from (fmtColors.ts). Click a swatch to pick one of the eight
// slots; Apply palette deals them out again in the column's own order; Reset
// forgets them, and each value is dealt a colour the next time it is drawn.
//
// The values are the column's distinct values in first-seen order, through the
// same `dataset:distinct` the filter picker uses — computed in main off the
// stored table, never by hydrating it here.
//
// Called by dsProfile.dsOpenProfile once the panel is painted.
// Classic global-scope renderer <script>: no import/export.

/** Values listed — a profile is ~300px wide; past this, "N more" says so. */
const FMT_PROFILE_VALUES = 40;

async function fmtPaintProfileColors(col: any): Promise<void> {
  const host = dsEl('ds-profile');
  const body = host ? (host.querySelector('.dsp-body') as HTMLElement | null) : null;
  if (!body) return;
  let sec = body.querySelector('.fmt-dsp-colors') as HTMLElement | null;
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'fmt-dsp-colors';
    sec.setAttribute('aria-label', 'Colours');
    body.appendChild(sec);
  }
  sec.innerHTML = '';
  // Colour is for categories. A number or a date is drawn on an axis or a
  // ramp, never as one colour per value.
  sec.hidden = !col || col.type !== 'text' || !currentProjectId;
  if (sec.hidden) return;

  const column = String(col.name);
  const want = expId;
  const stillHere = () => want === expId && dsProfileCol >= 0
    && !!expColumns[dsProfileCol] && expColumns[dsProfileCol].name === column;

  const head = document.createElement('p');
  head.className = 'dsp-head';
  head.textContent = 'Colours';
  sec.appendChild(head);
  const note = document.createElement('p');
  note.className = 'dsp-note';
  note.textContent = 'Every chart in this project draws these values in these colours.';
  sec.appendChild(note);

  let res: any = null;
  try {
    res = await window.hub.datasetDistinct(currentProjectId, want, column, FMT_PROFILE_VALUES);
  } catch (_) {
    res = null;
  }
  if (!stillHere()) return;
  const values: string[] = res && Array.isArray(res.values) ? res.values : [];
  if (!values.length) {
    const none = document.createElement('p');
    none.className = 'dsp-note';
    none.textContent = 'No values to colour in this column.';
    sec.appendChild(none);
    return;
  }
  fmtColorsReady(); // make sure the map for this project is the one in memory
  const repaint = () => { if (stillHere()) void fmtPaintProfileColors(col); };
  const palette = fmtThemePalette(sec);
  const list = document.createElement('div');
  list.className = 'fmt-color-list';
  values.forEach((v) => fmtColorRow(list, v, fmtTokenOf(column, v), palette, (t) => {
    void fmtSetColor(column, v, t).then((ok) => { if (ok) repaint(); });
  }));
  sec.appendChild(list);
  const total = res && typeof res.total === 'number' ? res.total : values.length;
  if (total > values.length) {
    const more = document.createElement('p');
    more.className = 'dsp-note';
    more.textContent = 'First ' + values.length + ' of ' + total.toLocaleString()
      + ' values. The rest are dealt a colour the first time a chart draws them.';
    sec.appendChild(more);
  }

  const actions = document.createElement('div');
  actions.className = 'fmt-actions';
  const btn = (text: string, title: string, run: () => Promise<boolean>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', () => { void run().then((ok) => { if (ok) repaint(); }); });
    actions.appendChild(b);
  };
  btn('Apply palette', 'Deal the eight colours out again, in this column’s order', () => fmtApplyPalette(column, values));
  btn('Reset', 'Forget these colours — each value is dealt one when a chart next draws it', () => fmtResetColors(column));
  sec.appendChild(actions);
}
