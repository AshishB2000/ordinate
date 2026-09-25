// Map OVERLAYS — the DOM that sits over a MapLibre map rather than in it: the
// "Couldn't place" note, the period dropdown, the Values menu, the ⋯ menu and
// the two legends. Split out of mapRender.ts under the 800-line cap (see
// .claude/rules/file-size.md). Classic global-scope renderer <script>; every
// function here is called at render time, so load order against mapRender.js
// does not matter.

function _addUnmatchedNote(wrap: HTMLElement, names: string[]): void {
  if (!names || names.length === 0) return;
  const note = document.createElement('div');
  note.className = 'cv-map-unmatched';
  note.title = 'Couldn\'t place: ' + names.join(', ');
  note.textContent = 'Couldn\'t place: ' + names.join(', ');
  wrap.appendChild(note);
}

// Top-center period dropdown for time-series maps. onChange(idx) recolors in place.
// (No Leaflet DomEvent guards needed — the controls are siblings of the map
// container, not children of it, so MapLibre never sees their events.)
function _addMapPeriodDropdown(wrap: HTMLElement, periods: string[], defaultIdx: number, onChange: (idx: number) => void): void {
  const box = document.createElement('div');
  box.className = 'cv-map-period';
  const select = document.createElement('select');
  select.className = 'cv-map-period-select';
  select.setAttribute('aria-label', 'Select period');
  periods.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p || ('Period ' + (i + 1));
    if (i === defaultIdx) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => onChange(parseInt(select.value, 10) || 0));
  box.appendChild(select);
  wrap.appendChild(box);
}

// Values ▾ menu for maps (same modes as charts). getMode()/onPick(mode) drive a single
// "series" = the selected period's region values, so Max/Min label the top/bottom region.
function _addMapValuesMenu(parent: HTMLElement, getMode: () => string, onPick: (mode: string) => void): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cv-values-btn';
  btn.append('Values', icon('chevron-down'));   // caret TRAILS the label, so not iconLabel()
  btn.setAttribute('aria-label', 'Value labels');
  const sync = () => btn.classList.toggle('active', getMode() !== 'off');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openValuesMenu(btn, getMode(), (mode) => { onPick(mode); sync(); });
  });
  parent.appendChild(btn);
  sync();
}

// Minimal ⋯ menu for maps — just Copy data (maps have no PNG/axis/color options).
function _addMapMenuButton(parent: HTMLElement, data: any): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cv-chart-menu-btn';
  iconOnly(btn, 'more-horizontal', 'Map options');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(btn, (el, close) => {
      const sec = document.createElement('div');
      sec.className = 'chart-menu-section';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chart-menu-item';
      row.textContent = 'Copy data';
      row.addEventListener('click', () => {
        close();
        if (window.hub) { window.hub.copyText(dataToTSV(data)); showToast('Data copied to clipboard'); }
      });
      sec.appendChild(row);
      el.appendChild(sec);
    });
  });
  parent.appendChild(btn);
}

function _addBubbleLegend(wrap: HTMLElement, minVal: number, maxVal: number, color: string, minR: number, maxR: number): void {
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend';

  const title = document.createElement('div');
  title.className = 'cv-map-legend-title';
  title.textContent = 'Size = value';
  leg.appendChild(title);

  [[minR, minVal], [maxR, maxVal]].forEach(([r, v]) => {
    const row = document.createElement('div');
    row.className = 'cv-map-legend-row';
    const sw = document.createElement('span');
    sw.className = 'cv-map-legend-bubble';
    sw.dataset.r = String(r);  // used in CSS via --r custom prop
    // Build a small inline SVG circle — avoids inline style
    sw.innerHTML = `<svg width="${r*2+2}" height="${r*2+2}" viewBox="0 0 ${r*2+2} ${r*2+2}" aria-hidden="true">` +
      `<circle cx="${r+1}" cy="${r+1}" r="${r}" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1.5"/>` +
      `</svg>`;
    const label = document.createElement('span');
    label.textContent = _fmtVal(v);
    row.appendChild(sw);
    row.appendChild(label);
    leg.appendChild(row);
  });

  wrap.appendChild(leg);
}

function _addChoroplethLegend(wrap: HTMLElement, minVal: number, maxVal: number): void {
  const stops = isDarkSurface(wrap) ? CHOROPLETH_STOPS_DARK : CHOROPLETH_STOPS_LIGHT;
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend';

  const title = document.createElement('div');
  title.className = 'cv-map-legend-title';
  title.textContent = 'Value';
  leg.appendChild(title);

  // Gradient bar as inline SVG — no inline CSS needed
  const barW = 96, barH = 8;
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('width', String(barW));
  svgEl.setAttribute('height', String(barH));
  svgEl.setAttribute('viewBox', `0 0 ${barW} ${barH}`);
  svgEl.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.id = 'cv-choro-grad-' + (Math.random() * 1e6 | 0);
  grad.setAttribute('x1', '0%');  grad.setAttribute('x2', '100%');
  grad.setAttribute('y1', '0%');  grad.setAttribute('y2', '0%');
  stops.forEach((c, i) => {
    const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop.setAttribute('offset', (i / (stops.length - 1) * 100) + '%');
    stop.setAttribute('stop-color', c);
    grad.appendChild(stop);
  });
  defs.appendChild(grad);
  svgEl.appendChild(defs);
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '0');  rect.setAttribute('y', '0');
  rect.setAttribute('width', String(barW));  rect.setAttribute('height', String(barH));
  rect.setAttribute('rx', '4');
  rect.setAttribute('fill', `url(#${grad.id})`);
  svgEl.appendChild(rect);
  leg.appendChild(svgEl);

  const labels = document.createElement('div');
  labels.className = 'cv-map-legend-range';
  const lo = document.createElement('span');  lo.textContent = _fmtVal(minVal);
  const hi = document.createElement('span');  hi.textContent = _fmtVal(maxVal);
  labels.appendChild(lo);
  labels.appendChild(hi);
  leg.appendChild(labels);

  wrap.appendChild(leg);
}
