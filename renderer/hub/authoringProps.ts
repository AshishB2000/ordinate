// The Properties flyout: its tabs, the properties panel itself, the
// Interactions tab, and writing every edit back to the card.
//
// Split verbatim out of authoring.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── The Properties tabs ─────────────────────────────────────────────────────
// BUILD is what the visual plots, FORMAT is how it looks. They were one stacked
// column under a heading that named its own container ("Visual", inside a
// visual). Tabs, not disclosures, because the two jobs are alternatives — you
// are doing one or the other, and stacking them made both scroll.
//
// The active tab is remembered across card selection: re-binding a panel must
// not throw you back to Build every time you click a different card.
const AN_TAB_KEY = 'anPropsTab';
const AN_TABS = ['an-tabp-build', 'an-tabp-format', 'an-tabp-interact'];

function anSetTab(panelId: string): void {
  const id = AN_TABS.indexOf(panelId) >= 0 ? panelId : AN_TABS[0];
  try {
    localStorage.setItem(AN_TAB_KEY, id);
  } catch (_) { /* private mode — the tabs still switch, they just forget */ }
  AN_TABS.forEach((p) => {
    const panel = anEl(p);
    if (panel) panel.hidden = p !== id;
  });
  document.querySelectorAll('#an-tabs .an-tab').forEach((b) => {
    const el = b as HTMLElement;
    const on = el.dataset.tab === id;
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/** Properties is now one of the rail flyouts, not a column of its own. */
function anSetProps(on: boolean): void {
  if (on) anSetFlyout('an-pane-props');
  else if (anFlyout === 'an-pane-props') anSetFlyout(null);
}


// ── Writing back ────────────────────────────────────────────────────────────
// Debounced to match the editor's own 600 ms autosave: dragging a field fires
// several changes and each write re-renders the card.
function anScheduleWrite(): void {
  if (anSaveTimer !== null) window.clearTimeout(anSaveTimer);
  anSaveTimer = window.setTimeout(() => {
    anSaveTimer = null;
    anWriteVisual();
  }, 500);
}

async function anWriteVisual(): Promise<void> {
  if (!anVisual || !anForm || !currentProjectId || dashMode !== 'analysis') return;
  const encoding = anForm.getEncoding();
  if (!encoding.category || !encoding.values || encoding.values.length === 0) {
    setAnPropsNote('Pick a category and at least one measure for this visual to draw.');
    return;
  }
  setAnPropsNote('');
  try {
    await window.hub.updateVisual(currentProjectId, String(anVisual.id), {
      name: anVisual.name,
      chartType: anVisual.chartType || 'column',
      encoding,
      overrides: anVisual.overrides || {},
      filters: anForm.getFilters(),
    });
  } catch (_) {
    return;
  }
  // Redraw the sheet so the card shows the edit. The grid rebuild drops the
  // selection ring, so repaint it.
  renderDashGrid();
  anPaintSelection();
  // Eligibility depends on the data, and the data just changed.
  await anRenderSwitcher();
}

// ── The Interactions tab ────────────────────────────────────────────────────
// Two REAL behaviours, not placeholders. Both persist on the visual's existing
// `overrides` (whitelisted in src/visuals.ts) rather than a new storage field —
// two booleans do not justify a file-format decision.
function anRenderInteractions(card: any): void {
  const host = anEl('an-interact');
  if (!host) return;
  host.innerHTML = '';
  // Interactions are a VISUAL card's business; a text or metric card has no
  // chart to click and no tooltip to show.
  if (!card || card.type !== 'visual' || !anVisual) {
    const p = document.createElement('p');
    p.className = 'an-prop-note an-prop-note--info';
    p.textContent = card
      ? 'A ' + card.type + ' card has no chart to interact with.'
      : 'Select a visual card to set its interactions.';
    host.appendChild(p);
    return;
  }

  const ov = (): any => {
    if (!anVisual.overrides || typeof anVisual.overrides !== 'object') anVisual.overrides = {};
    return anVisual.overrides;
  };
  const toggle = (text: string, note: string, key: string, dflt: boolean): void => {
    const wrap = document.createElement('label');
    wrap.className = 'an-prop-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = ov()[key] !== undefined ? !!ov()[key] : dflt;
    box.addEventListener('change', () => {
      ov()[key] = box.checked;
      anScheduleWrite();
      // The card has to be redrawn, not just saved: cross-filter attaches its
      // listener at render time, and the tooltip option is baked into the chart.
      renderDashGrid();
      anPaintSelection();
    });
    const t = document.createElement('span');
    t.textContent = text;
    wrap.appendChild(box);
    wrap.appendChild(t);
    host.appendChild(wrap);
    const p = document.createElement('p');
    p.className = 'an-prop-note an-prop-note--info';
    p.textContent = note;
    host.appendChild(p);
  };

  const cat = (anVisual.encoding && anVisual.encoding.category) || '';
  toggle(
    'Clicking this visual filters the sheet',
    cat
      ? 'Click a bar or slice to filter every other card by that ' + cat + '. Click it again to clear. '
        + 'Cards whose dataset has no “' + cat + '” column are left alone.'
      : 'Give this visual a category first — a click has to mean one value of one column.',
    'crossFilter', false,
  );
  toggle(
    'Show tooltips',
    'The hover readout on bars, points and slices.',
    'showTooltips', true,
  );

  // Honest about the gap rather than silently doing nothing: maps and tables
  // draw no Chart.js instance, so a click on one cannot be hit-tested yet.
  const type = String(anVisual.chartType || '');
  if (type === 'table' || type.indexOf('map_') === 0) {
    const p = document.createElement('p');
    p.className = 'an-prop-note';
    p.textContent = 'Click-to-filter does not apply to ' + (VIZ_LABELS[type] || type)
      + ' yet — only charts are clickable.';
    host.appendChild(p);
  }
}

// ── The Properties panel ────────────────────────────────────────────────────
function setAnPropsNote(text: string): void {
  const note = anEl('an-props-note');
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

function anRenderProps(card: any): void {
  const host = anEl('an-props');
  const hint = anEl('an-props-hint');
  if (!host || !hint) return;
  host.innerHTML = '';
  hint.hidden = !!card;
  if (!card) return;

  /** One disclosure row: a header that toggles its body, collapsed by default
   *  unless it is the section you almost always want. */
  const section = (title: string, open: boolean): HTMLElement => {
    const sec = document.createElement('section');
    sec.className = 'an-sec' + (open ? ' is-open' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'an-sec-head';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = document.createElement('span');
    chev.className = 'an-sec-chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '›';
    const t = document.createElement('span');
    t.textContent = title;
    head.appendChild(chev);
    head.appendChild(t);
    const body = document.createElement('div');
    body.className = 'an-sec-body';
    head.addEventListener('click', () => {
      const on = sec.classList.toggle('is-open');
      head.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    sec.appendChild(head);
    sec.appendChild(body);
    host.appendChild(sec);
    return body;
  };

  // Every control below writes a field `chartRender.buildChart` already reads
  // (overrides.title / showLegend / legendPosition / showValues / showGridlines
  // / yZero / xAxisLabel / yAxisLabel). Nothing here is a new formatting engine:
  // the ⋯ Customize menu has driven these same keys since the capture surface.
  const ov = (): any => {
    if (!anVisual) return {};
    if (!anVisual.overrides || typeof anVisual.overrides !== 'object') anVisual.overrides = {};
    return anVisual.overrides;
  };
  const labelled = (host: HTMLElement, text: string, control: HTMLElement): void => {
    const l = document.createElement('span');
    l.className = 'an-prop-label';
    l.textContent = text;
    host.appendChild(l);
    host.appendChild(control);
  };
  const check = (host: HTMLElement, text: string, key: string, dflt: boolean): void => {
    const wrap = document.createElement('label');
    wrap.className = 'an-prop-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = ov()[key] !== undefined ? !!ov()[key] : dflt;
    box.addEventListener('change', () => { ov()[key] = box.checked; anScheduleWrite(); });
    const t = document.createElement('span');
    t.textContent = text;
    wrap.appendChild(box);
    wrap.appendChild(t);
    host.appendChild(wrap);
  };
  const textField = (host: HTMLElement, text: string, key: string): void => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'an-prop-input';
    inp.value = ov()[key] != null ? String(ov()[key]) : '';
    inp.addEventListener('input', () => { ov()[key] = inp.value; anScheduleWrite(); });
    labelled(host, text, inp);
  };

  const display = section('Display settings', true);
  if (card.type === 'visual' && anVisual) {
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'an-prop-input';
    nameIn.value = String(anVisual.name || '');
    nameIn.addEventListener('input', () => {
      if (anVisual) anVisual.name = nameIn.value;
      anScheduleWrite();
    });
    labelled(display, 'Title', nameIn);
    check(display, 'Show legend', 'showLegend', true);
    const legPos = document.createElement('select');
    legPos.className = 'an-prop-input';
    [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']].forEach(([v, l]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = l;
      legPos.appendChild(o);
    });
    legPos.value = String(ov().legendPosition || 'top');
    legPos.addEventListener('change', () => { ov().legendPosition = legPos.value; anScheduleWrite(); });
    labelled(display, 'Legend position', legPos);
    // ponytail: no "Show data labels" here. buildChart reads overrides.showValues,
    // but sanitizeOverrides (src/visuals.ts) does NOT whitelist it — a saved
    // visual drops the key, so the checkbox would tick and change nothing after a
    // reload. Add it to that whitelist and this becomes a two-line addition.

    const axes = section('Axes', false);
    textField(axes, 'X axis label', 'xAxisLabel');
    textField(axes, 'Y axis label', 'yAxisLabel');
    check(axes, 'Start Y axis at zero', 'yZero', false);
    check(axes, 'Show gridlines', 'showGridlines', true);
    // ponytail: colour, number format and sort are NOT here — they live in the
    // chart's own ⋯ Customize menu (chartControls.ts), which owns the swatch
    // grid and the per-series state. Duplicating that here would be a second
    // editor for one override object. Move them if Customize is retired.
  } else {
    const k = document.createElement('p');
    k.className = 'an-prop-note an-prop-note--info';
    k.textContent = 'A ' + card.type + ' card. Select a visual card to edit fields and a title.';
    display.appendChild(k);
  }

  const layout = section('Layout', false);
  // ponytail: no width/height numbers here on purpose — the card is dragged and
  // resized on the sheet, and a second way to set the same two integers is what
  // the steppers already were.
  const how = document.createElement('p');
  how.className = 'an-prop-note an-prop-note--info';
  how.textContent =
    'Drag the card to move it, or drag its right/bottom edge to resize. With the card focused, arrow keys move it and shift+arrows resize it.';
  layout.appendChild(how);

  if (card.type === 'visual' && anVisual) {
    const shared = section('Sharing', false);
    const p = document.createElement('p');
    p.className = 'an-prop-note an-prop-note--info';
    p.textContent =
      'This is a saved visual. Editing its fields changes it everywhere it is used — published dashboards keep the copy they were published with.';
    shared.appendChild(p);
  }

  const note = document.createElement('p');
  note.className = 'an-prop-note';
  note.id = 'an-props-note';
  note.hidden = true;
  host.appendChild(note);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-danger an-prop-del';
  del.textContent = 'Remove card';
  del.addEventListener('click', () => {
    removeCard(card);
    anSelectCard(null);
  });
  host.appendChild(del);
}

