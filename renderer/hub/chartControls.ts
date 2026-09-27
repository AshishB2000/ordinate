// Chart controls — the per-graph ⋯ context menu (openChartMenu), the control
// cluster (Values menu, period multi-select, recolor/customize), and the
// override helpers. Extracted from hub.js as a pure structural move (no logic
// changes). The chart-menu DOM element + swatch setup and the image-action menu
// stay in hub.js. Classic script sharing global scope: chartMenuEl/CURATED_COLORS/
// cm* refs (hub.js), buildChart (chartRender.js), renderVizInArea (renderResult.js).

// Persist a chart's merged overrides. A Visuals adapter entry supplies its own
// `saveOverride` (routing to visual:update instead of the history thread); capture
// entries never set it, so they fall through to the byte-identical history path.
function persistOverride(entry, overrideKey, merged) {
  if (typeof entry.saveOverride === 'function') { entry.saveOverride(merged); return; }
  if (window.hub && window.hub.saveChartOverrides) {
    window.hub.saveChartOverrides(entry.id, overrideKey, merged).catch(() => {});
  }
}

function closeChartMenu() {
  chartMenuEl.hidden = true;
  if (_chartMenuDismiss) { document.removeEventListener('click', _chartMenuDismiss, true); _chartMenuDismiss = null; }
  if (_chartMenuEscape)  { document.removeEventListener('keydown', _chartMenuEscape, true); _chartMenuEscape = null; }
}

function openChartMenu(anchorBtn, container, canvas, data, type, entry, turnIdx, overrideKey) {
  closeChartMenu();

  const currentOverrides = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};

  // ── Populate customize fields with current values ────────────────────
  if (cmTitleInput) cmTitleInput.value = currentOverrides.title || '';

  // Swatches — mark the currently active color
  if (cmSwatches) {
    cmSwatches.querySelectorAll('.cm-swatch').forEach(sw => {
      sw.classList.toggle('cm-swatch-active', (sw as HTMLElement).dataset.color === currentOverrides.color);
    });
  }

  // Toggles
  function setSwitch(btn, on) {
    if (!btn) return;
    btn.setAttribute('aria-checked', String(on));
    btn.classList.toggle('cm-switch-on', on);
  }
  // Advanced controls — populate current values + show only where they apply.
  // Legend, axes (titles, start at zero, gridlines) and Sort live in the
  // Format panel below (formatPanel.ts).
  const isLineType = ['line', 'area', 'stacked_area', 'line_markers', 'combo'].includes(type);
  if (cmNumFmt) cmNumFmt.value = currentOverrides.numberFormat || 'auto';
  // A bullet's fixed target — used when the chart has no second (target) measure.
  if (cmTarget) cmTarget.value = typeof currentOverrides.bulletTarget === 'number' ? String(currentOverrides.bulletTarget) : '';
  if (cmTargetField) cmTargetField.hidden = type !== 'bullet';
  setSwitch(cmSmooth, currentOverrides.smooth !== false);
  if (cmSmoothRow) cmSmoothRow.hidden = !isLineType;

  // Legend, axes, data labels, sort and colours for THIS chart (formatPanel.ts).
  fmtMountChartMenu(cmFormatMount, container, data, type, entry, turnIdx, overrideKey);

  // Collapse customize panel on fresh open
  if (cmCustomize) cmCustomize.hidden = true;
  if (cmCustomToggle) cmCustomToggle.classList.remove('cm-cust-open');

  // ── Position the menu ────────────────────────────────────────────────
  const rect = anchorBtn.getBoundingClientRect();
  chartMenuEl.hidden = false;
  const menuW = chartMenuEl.offsetWidth || 220;
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  const menuH = chartMenuEl.offsetHeight || 320;
  let top = rect.bottom + 4;
  // Flip above if it would overflow the bottom; clamp to viewport top as fallback.
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
  if (top < 8) top = 8;
  // Cap scrollable height to remaining space below the menu's top edge.
  chartMenuEl.style.maxHeight = (window.innerHeight - top - 8) + 'px';
  chartMenuEl.style.left = left + 'px';
  chartMenuEl.style.top  = top + 'px';

  // ── Helper: apply overrides + save ──────────────────────────────────
  function applyOverride(partial) {
    const base = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
    const merged = Object.assign({}, base, partial);
    if (!entry.chartOverrides) entry.chartOverrides = {};
    entry.chartOverrides[overrideKey] = merged;
    renderVizInArea(container, data, type, entry, turnIdx);
    persistOverride(entry, overrideKey, merged);
    // Refresh the active-swatch highlight
    if (cmSwatches) {
      cmSwatches.querySelectorAll('.cm-swatch').forEach(sw => {
        sw.classList.toggle('cm-swatch-active', (sw as HTMLElement).dataset.color === merged.color);
      });
    }
  }

  // Get the live canvas — re-queries after each override re-render.
  function getLiveCanvas() { return container.querySelector('canvas') || canvas; }

  // ── Action: copy chart as image ──────────────────────────────────────
  function onCopyImg() {
    closeChartMenu();
    const dataUrl = getLiveCanvas().toDataURL('image/png');
    if (window.hub) { window.hub.copyImage(dataUrl); showToast('Chart copied to clipboard'); }
  }

  // ── Action: download chart PNG ───────────────────────────────────────
  async function onDownload() {
    closeChartMenu();
    const dataUrl = getLiveCanvas().toDataURL('image/png');
    if (!window.hub) return;
    const result = await window.hub.saveImage(dataUrl);
    if (result && result.ok) {
      const name = result.dest ? result.dest.split('/').pop() : 'chart.png';
      showToast(`Saved: ${name}`);
    }
  }

  // ── Action: copy data as TSV ─────────────────────────────────────────
  // A copy LEAVES the app, so a dataset-backed chart's labels go through the
  // Share policy first (privacyShare.ts); a capture's chart has no dataset.
  async function onCopyData() {
    closeChartMenu();
    const shaped = await pvShareData(entry.drill || null, data, 'export');
    if (shaped && window.hub) { window.hub.copyText(dataToTSV(shaped)); showToast('Data copied to clipboard'); }
  }

  // ── Action: show the rows behind this visual ─────────────────────────
  // The ⋯ route carries NO mark — it drills the whole visual, which is the
  // only entry point maps and tables have (neither has a Chart.js instance to
  // hit-test). Gated on entry.drill, so the capture result surface — which has
  // no dataset behind its chart — never offers it.
  function onDrill() {
    closeChartMenu();
    const d = entry.drill;
    if (!d) return;
    openDrillPanel({
      name: d.name,
      projectId: d.projectId,
      datasetId: d.datasetId,
      encoding: d.encoding,
      filters: d.filters,
      mark: null,
      trigger: anchorBtn,
    });
  }

  // ── Customize: toggle expand/collapse ────────────────────────────────
  function onCustomizeToggle() {
    if (!cmCustomize) return;
    const open = cmCustomize.hidden;
    cmCustomize.hidden = !open;
    if (cmCustomToggle) cmCustomToggle.classList.toggle('cm-cust-open', open as boolean);
  }

  // ── Customize: title input (debounced) ──────────────────────────────
  let _titleTimer = null;
  function onTitleInput() {
    clearTimeout(_titleTimer);
    _titleTimer = setTimeout(() => applyOverride({ title: cmTitleInput.value.trim() || null }), 300);
  }

  // ── Customize: swatch click ──────────────────────────────────────────
  function onSwatchClick(e) {
    const sw = e.target.closest('.cm-swatch[data-color]');
    if (!sw) return;
    const active = (entry.chartOverrides && entry.chartOverrides[overrideKey] && entry.chartOverrides[overrideKey].color) === sw.dataset.color;
    applyOverride({ color: active ? null : sw.dataset.color });
  }

  // ── Customize: toggle switches ───────────────────────────────────────
  function onToggleSwitch(btn, field, defaultOn) {
    const on = btn.getAttribute('aria-checked') !== 'true';
    setSwitch(btn, on);
    const val = (on === defaultOn) ? undefined : on;
    const patch = {};
    patch[field] = (val === undefined) ? null : val;
    // Normalize: null means "use default", so remove the key
    const base = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
    const merged = Object.assign({}, base);
    if (val === undefined || val === null) {
      delete merged[field];
    } else {
      merged[field] = val;
    }
    if (!entry.chartOverrides) entry.chartOverrides = {};
    entry.chartOverrides[overrideKey] = merged;
    renderVizInArea(container, data, type, entry, turnIdx);
    persistOverride(entry, overrideKey, merged);
  }

  // ── Customize: reset to default ──────────────────────────────────────
  function onReset() {
    if (!entry.chartOverrides) entry.chartOverrides = {};
    entry.chartOverrides[overrideKey] = {};
    renderVizInArea(container, data, type, entry, turnIdx);
    persistOverride(entry, overrideKey, null);
    closeChartMenu();
  }

  // ── Wire up event listeners (one-time; removed on close via AbortController) ──
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  if (cmCopyImg)       cmCopyImg.addEventListener('click', onCopyImg, sig);
  if (cmDownload)      cmDownload.addEventListener('click', onDownload, sig);
  if (cmCopyData)      cmCopyData.addEventListener('click', onCopyData, sig);
  if (cmDrill)       { cmDrill.hidden = !entry.drill; cmDrill.addEventListener('click', onDrill, sig); }
  if (cmExplain) {
    cmExplain.hidden = !entry.drill;
    cmExplain.addEventListener('click', () => {
      closeChartMenu();
      const d = entry.drill;
      void ansExplain({ tile: { datasetId: d.datasetId, encoding: d.encoding, filters: d.filters, chartType: type, name: d.name } });
    }, sig);
  }
  if (cmCustomToggle)  cmCustomToggle.addEventListener('click', onCustomizeToggle, sig);
  if (cmTitleInput)    cmTitleInput.addEventListener('input', onTitleInput, sig);
  if (cmSwatches)      cmSwatches.addEventListener('click', onSwatchClick, sig);
  if (cmNumFmt)        cmNumFmt.addEventListener('change', () => applyOverride({ numberFormat: cmNumFmt.value === 'auto' ? null : cmNumFmt.value }), sig);
  if (cmTarget)        cmTarget.addEventListener('change', () => {
    const n = parseFloat(cmTarget.value);
    applyOverride({ bulletTarget: Number.isFinite(n) ? n : null });
  }, sig);
  if (cmSmooth)        cmSmooth.addEventListener('click', () => onToggleSwitch(cmSmooth, 'smooth', true), sig);
  if (cmReset)         cmReset.addEventListener('click', onReset, sig);

  // Clean up all listeners on menu close
  _chartMenuDismiss = (e) => {
    if (!chartMenuEl.contains(e.target)) { ac.abort(); closeChartMenu(); }
  };
  _chartMenuEscape = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); ac.abort(); closeChartMenu(); }
  };
  setTimeout(() => {
    document.addEventListener('click', _chartMenuDismiss, true);
    document.addEventListener('keydown', _chartMenuEscape, true);
  }, 0);
}

// ── The clicked mark ────────────────────────────────────────────────────────
//
// ONE hit-test, shared by cross-filtering (dashboards.ts) and drill-down
// (drill.ts). Two copies of this would be two answers to "which bar did they
// click", and the drill panel's whole claim is that its rows are the ones
// behind the mark the user pointed at.
//
// A DOM listener hit-testing the stored Chart instance, NOT options.onClick:
// buildChart is shared with the capture surface and the Visuals builder, and
// neither of those should grow a dashboard behaviour.
//
// Returns null for a click on empty canvas, and for a map or a table — neither
// draws a Chart.js instance, so neither has a mark to identify.
//
// `series` is the clicked DATASET'S LABEL, which is a split value only when the
// encoding actually splits. On a two-MEASURE chart the same field holds "sum of
// price" — a legend entry, not a column value. The chart cannot tell those
// apart; the encoding can, so the caller decides whether to send it (see
// wireDrillClick in drill.ts). Passing it blindly would compose an equality
// filter on a column the visual never split by.
function chartMarkAt(area, e) {
  const chart = chartInstances.get(area);
  if (!chart || typeof chart.getElementsAtEventForMode !== 'function') return null;
  let hit = [];
  try {
    hit = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
  } catch (_) {
    hit = [];
  }
  if (!hit.length) return null;
  const labels = (chart.data && chart.data.labels) || [];
  const category = labels[hit[0].index];
  if (category === undefined) return null;
  const sets = (chart.data && chart.data.datasets) || [];
  const split = sets.length > 1 ? sets[hit[0].datasetIndex] : null;
  const series = split && typeof split.label === 'string' ? split.label : undefined;
  return { category, series };
}

// ── Per-graph control cluster: Values menu, period multi-select, ⋯ ──────────

// Merge a partial into entry.chartOverrides[overrideKey] (null values drop the key)
// and persist. Returns the merged overrides object.
function patchOverride(entry, overrideKey, partial) {
  const base = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
  const merged = Object.assign({}, base, partial);
  Object.keys(merged).forEach(k => { if (merged[k] == null) delete merged[k]; });
  if (!entry.chartOverrides) entry.chartOverrides = {};
  entry.chartOverrides[overrideKey] = merged;
  persistOverride(entry, overrideKey, merged);
  return merged;
}

// Flatten {labels, series} into a TSV string (header = Label + series names).
function dataToTSV(data) {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  const header = ['Label', ...series.map(s => s.name || '')].join('\t');
  const rows = labels.map((label, i) =>
    [label, ...series.map(s => (s.values && s.values[i] != null) ? s.values[i] : '')].join('\t'));
  return [header, ...rows].join('\n');
}

// Generic single-use popover styled like the chart menu. `populate(el, close)` fills it.
// Positions under the anchor and dismisses on outside-click / Esc.
// `onClose` (optional) fires however the menu goes away — the only way an anchor
// can keep its aria-expanded honest, since Esc and outside-click close from here.
let _activeMiniMenu = null;
function openMiniMenu(anchorBtn, populate, onClose?) {
  if (_activeMiniMenu) _activeMiniMenu();   // close any open mini menu first
  const el = document.createElement('div');
  el.className = 'chart-menu';
  el.setAttribute('role', 'menu');
  const ac = new AbortController();
  const close = () => {
    ac.abort();
    el.remove();
    if (_activeMiniMenu === close) _activeMiniMenu = null;
    if (onClose) onClose();
  };
  _activeMiniMenu = close;
  populate(el, close);
  document.body.appendChild(el);
  // Menu semantics, ↑↓ Home End, focus in and back to the trigger (a11y.ts).
  a11yMenu(el, anchorBtn);
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = el.offsetWidth || 200;
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  const menuH = el.offsetHeight || 200;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
  if (top < 8) top = 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.maxHeight = (window.innerHeight - top - 8) + 'px';
  // Escape binds SYNCHRONOUSLY. Deferring it by a tick meant a keypress landing
  // in that window was lost outright — the listener did not exist yet, and a
  // keydown is not replayed — so the menu simply stayed open. Rare by hand,
  // reproducible on a loaded machine, and it is the kind of thing a user reads
  // as "Escape doesn't work here". A keydown has no in-flight event to worry
  // about, unlike the click below.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, { capture: true, signal: ac.signal });
  // The outside-click listener STAYS deferred: it is registered from inside the
  // dispatch of the click that opened this menu, and binding it synchronously
  // risks that same click closing the menu it just opened.
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      if (!el.contains(e.target as Node) && e.target !== anchorBtn) close();
    }, { capture: true, signal: ac.signal });
  }, 0);
  return close;
}

// A check + label row for the mini menus (label via textNode — never innerHTML).
function miniMenuRow(label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chart-menu-item cv-menu-item';
  const chk = document.createElement('span');
  chk.className = 'cv-menu-check';
  b.appendChild(chk);
  b.appendChild(document.createTextNode(label));
  return b;
}
function setRowCheck(rowBtn, on) {
  const c = rowBtn.querySelector('.cv-menu-check');
  if (c) c.textContent = on ? '✓' : '';
}

const VALUE_MODES = [
  ['off', 'Off'], ['all', 'All'], ['maxmin', 'Max & min'], ['max', 'Max'], ['min', 'Min'],
];

// Single-select Values menu. onPick(mode) fires once, then the menu closes.
function openValuesMenu(anchorBtn, currentMode, onPick) {
  openMiniMenu(anchorBtn, (el, close) => {
    const sec = document.createElement('div');
    sec.className = 'chart-menu-section';
    VALUE_MODES.forEach(([val, label]) => {
      const row = miniMenuRow(label);
      setRowCheck(row, val === currentMode);
      row.addEventListener('click', () => { close(); onPick(val); });
      sec.appendChild(row);
    });
    el.appendChild(sec);
  });
}

// Multi-select periods/series menu. Mutates the live `hidden` Set and calls
// onCommit() after each change (menu stays open). Keeps ≥1 series visible.
function openPeriodsMenu(anchorBtn, names, hidden, onCommit) {
  openMiniMenu(anchorBtn, (el, close) => {
    const sec = document.createElement('div');
    sec.className = 'chart-menu-section';
    const rows = [];
    const refresh = () => {
      setRowCheck(allRow, hidden.size === 0);
      names.forEach((_, i) => setRowCheck(rows[i], !hidden.has(i)));
    };
    const allRow = miniMenuRow('All');
    allRow.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hidden.size === 0) return;
      hidden.clear(); refresh(); onCommit();
    });
    sec.appendChild(allRow);
    const sep = document.createElement('div');
    sep.className = 'chart-menu-sep';
    sec.appendChild(sep);
    names.forEach((name, i) => {
      const row = miniMenuRow(name || ('Series ' + (i + 1)));
      rows[i] = row;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hidden.has(i)) hidden.delete(i);
        else { if (names.length - hidden.size <= 1) return; hidden.add(i); } // keep one visible
        refresh(); onCommit();
      });
      sec.appendChild(row);
    });
    el.appendChild(sec);
    refresh();
  });
}

// [label][chevron-down] — iconLabel() puts the icon first, and a caret goes last.
function cvLabelCaret(el: HTMLElement, label: string): void {
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span, icon('chevron-down'));
}

// Build the top-right control cluster for a chart and append it to chartWrapper.
function addChartControls(chartWrapper, container, canvas, data, type, entry, turnIdx, overrideKey) {
  const cluster = document.createElement('div');
  cluster.className = 'cv-graph-controls';
  const overrides = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
  const series = chartSeries(data);
  const valueMode = overrides.valueMode || (overrides.showValues ? 'all' : 'maxmin');

  // Values ▾ (only where the renderer can actually draw value labels)
  if (!NO_VALUE_LABEL_TYPES.has(type)) {
    const valuesBtn = document.createElement('button');
    valuesBtn.type = 'button';
    valuesBtn.className = 'cv-values-btn' + (valueMode !== 'off' ? ' active' : '');
    cvLabelCaret(valuesBtn, 'Values');
    valuesBtn.setAttribute('aria-label', 'Value labels');
    valuesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openValuesMenu(valuesBtn, valueMode, (mode) => {
        // Store the chosen mode verbatim (incl. 'off') — the default is now 'maxmin',
        // so 'off' must be persisted explicitly rather than as an absent key.
        patchOverride(entry, overrideKey, { valueMode: mode });
        renderVizInArea(container, data, type, entry, turnIdx);
      });
    });
    cluster.appendChild(valuesBtn);
  }

  // Periods ▾ / Series ▾ — multi-series charts that filter by series, plus the
  // grouped share types (which filter which small-multiple minis render).
  if (chartHasPeriodDropdown(type, series.length) || chartIsSmallMultiple(type, series.length)) {
    const hidden = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
    const periodsBtn = document.createElement('button');
    periodsBtn.type = 'button';
    periodsBtn.className = 'cv-periods-btn' + (hidden.size ? ' active' : '');
    cvLabelCaret(periodsBtn, data.dataShape === 'time_series' ? 'Periods' : 'Series');
    periodsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPeriodsMenu(periodsBtn, series.map(s => s.name), hidden, () => {
        const arr = Array.from(hidden).sort((a: any, b: any) => a - b);
        patchOverride(entry, overrideKey, { hiddenSeries: arr.length ? arr : null });
        const chart = chartInstances.get(container);
        if (chartIsSmallMultiple(type, series.length)) {
          // Re-render the grid so hidden periods drop out (chart is an array here).
          renderVizInArea(container, data, type, entry, turnIdx);
        } else if (PER_SERIES_DATASET_TYPES.has(type) && chart) {
          // One dataset per series → toggle visibility live (keeps the menu open).
          series.forEach((_, i) => chart.setDatasetVisibility(i, !hidden.has(i)));
          chart.update();
        } else {
          // Heatmap etc.: rebuild the chart on the same canvas (filter applied in buildChart),
          // leaving the cluster + open menu intact.
          const canvas = container.querySelector('canvas');
          if (chart) { try { chart.destroy(); } catch (_) {} }
          const ov = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
          const rebuilt = canvas && buildChart(canvas, data, type, fmtWithScope(ov, entry.drill));
          if (rebuilt) chartInstances.set(container, rebuilt);
        }
        periodsBtn.classList.toggle('active', hidden.size > 0);
      });
    });
    cluster.appendChild(periodsBtn);
  }

  // Sankey shows ONE period's flows at a time (like maps), switched via a single-
  // select dropdown — not small multiples. Default is the latest period.
  if (type === 'sankey' && series.length >= 2) {
    const box = document.createElement('div');
    box.className = 'cv-map-period';                 // reuse the map period dropdown styling
    const select = document.createElement('select');
    select.className = 'cv-map-period-select';
    select.setAttribute('aria-label', 'Select period');
    const curIdx = Number.isInteger(overrides.periodIdx)
      ? Math.max(0, Math.min(overrides.periodIdx, series.length - 1))
      : series.length - 1;
    series.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.name || ('Period ' + (i + 1));
      if (i === curIdx) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      patchOverride(entry, overrideKey, { periodIdx: parseInt(select.value, 10) || 0 });
      const chart = chartInstances.get(container);
      if (chart) { try { chart.destroy(); } catch (_) {} }
      const cv = container.querySelector('canvas');
      const ov = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
      const rebuilt = cv && buildChart(cv, data, type, fmtWithScope(ov, entry.drill));
      if (rebuilt) chartInstances.set(container, rebuilt);
    });
    box.appendChild(select);
    cluster.appendChild(box);
  }

  // ⋯ menu
  const menuBtn = document.createElement('button');
  menuBtn.className = 'cv-chart-menu-btn';
  menuBtn.type = 'button';
  iconOnly(menuBtn, 'more-horizontal', 'Chart options');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openChartMenu(menuBtn, container, canvas, data, type, entry, turnIdx, overrideKey);
  });
  cluster.appendChild(menuBtn);

  chartWrapper.appendChild(cluster);
}
