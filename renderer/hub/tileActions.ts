'use strict';

// What a visual TILE does when it is clicked, opened from its ⋯ menu, or
// hovered — the runtime half of `card.actions` (renderer/hub/cardModel.ts is
// the model: carry, URL building and validation). Classic global-scope script.
//
//   navigate        open another dashboard or page, carrying a selection
//   url             open https://…{{value}} in the browser, value URL-encoded
//   filter_target   narrow NAMED tiles instead of the whole sheet
//   tooltip_visual  draw another visual, filtered to the hovered mark, in the tooltip

/** The clicked value as a filter — the category column is what a mark means. */
function tileClicked(visual: any, category: unknown): any {
  const col = visual && visual.encoding && visual.encoding.category;
  return col && category !== undefined ? { column: String(col), value: category } : null;
}

async function runTileAction(action: any, card: any, visual: any, category?: unknown): Promise<void> {
  const clicked = category === undefined ? null : tileClicked(visual, category);
  const steps = cardModel.carrySteps(action, { clicked, filters: effectiveFilters(), selection: [] });
  if (action.kind === 'navigate') {
    if (!action.target) { showToast('This action has no dashboard to open yet.', { kind: 'info' }); return; }
    await dashNavigate(action.target, steps);
    return;
  }
  if (action.kind === 'url') {
    const r = cardModel.actionUrl(action.url, category === undefined ? '' : category);
    if (!r.ok) { showToast(r.error, { kind: 'error' }); return; }
    window.hub.openExternal(r.url);
    return;
  }
  if (action.kind === 'filter_target') {
    const tiles = (action.tiles || []).filter((t: string) => t !== card.id);
    if (!tiles.length) { showToast('This action has no tiles to narrow yet.', { kind: 'info' }); return; }
    dashNarrowTiles(tiles, clicked ? [{ type: 'filter', column: clicked.column, op: '=', value: clicked.value }] : steps);
  }
}

/**
 * Wire a drawn tile. Returns true when a CLICK action owns the plain click —
 * the caller then skips cross-filter and drill, exactly as cross-filter already
 * outranks drill. Hover (tooltip_visual) is wired either way.
 */
function wireTileActions(area: HTMLElement, card: any, visual: any): boolean {
  const actions: any[] = Array.isArray(card && card.actions) ? card.actions : [];
  const tip = actions.find((a) => a.kind === 'tooltip_visual' && a.tooltipVisualId);
  if (tip) wireTooltipVisual(area, visual, tip);
  const clicks = actions.filter((a) => a.trigger === 'click' && a.kind !== 'tooltip_visual');
  if (!clicks.length) {
    // No action owns the click: a clicked map region or point joins the sheet's
    // selection layer (a chart bar keeps cross-filter / drill, wired by the caller).
    area.addEventListener('cv-mark-click', (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d && d.column && d.category !== undefined) dashSelToggle({ type: 'filter', column: String(d.column), op: '=', value: d.category });
    });
    return false;
  }
  area.classList.add('has-tile-actions');
  area.addEventListener('click', (e) => {
    const mark = chartMarkAt(area, e);
    if (!mark) return;
    for (const a of clicks) void runTileAction(a, card, visual, mark.category);
  });
  // A map has no Chart.js marks; mapRender dispatches its clicked region/point.
  area.addEventListener('cv-mark-click', (e: Event) => {
    const d = (e as CustomEvent).detail;
    for (const a of clicks) void runTileAction(a, card, visual, d && d.category);
  });
  return true;
}

/** The ⋯-menu entries for a tile's `menu`-triggered actions. */
function tileActionMenuItems(card: any): Array<[string, () => void]> {
  const actions: any[] = card && card.type === 'visual' && Array.isArray(card.actions) ? card.actions : [];
  return actions
    .filter((a) => a.trigger === 'menu' && a.kind !== 'tooltip_visual')
    .map((a) => [a.label || tileActionLabel(a), () => {
      void (async () => {
        const v = card.visualId && currentProjectId ? await window.hub.getVisual(currentProjectId, card.visualId) : null;
        await runTileAction(a, card, v);
      })();
    }] as [string, () => void]);
}

function tileActionLabel(a: any): string {
  if (a.kind === 'navigate') return 'Open linked dashboard';
  if (a.kind === 'url') return 'Open link';
  if (a.kind === 'filter_target') return 'Narrow linked tiles';
  return 'Show tooltip visual';
}

// ── tooltip_visual ───────────────────────────────────────────────────────────

let tvTip: HTMLElement | null = null;
let tvChart: any = null;

function tvHide(): void {
  if (tvChart) { try { tvChart.destroy(); } catch (_) { /* already gone */ } tvChart = null; }
  if (tvTip) { tvTip.remove(); tvTip = null; }
}

function wireTooltipVisual(area: HTMLElement, visual: any, action: any): void {
  let lastKey: string | null = null;
  let seq = 0;
  let tipVisual: any = null;
  // The tile's own Chart.js tooltip would sit on top of this one.
  requestAnimationFrame(() => {
    const ch = chartInstances.get(area);
    if (ch && ch.options && ch.options.plugins && ch.options.plugins.tooltip) {
      ch.options.plugins.tooltip.enabled = false;
      ch.update('none');
    }
  });
  const place = (e: MouseEvent): void => {
    if (!tvTip) return;
    const w = 272;
    const x = Math.min(e.clientX + 16, window.innerWidth - w - 8);
    const y = Math.min(e.clientY + 16, window.innerHeight - 200);
    tvTip.style.left = x + 'px';
    tvTip.style.top = y + 'px';
  };
  area.addEventListener('mouseleave', () => { lastKey = null; tvHide(); });
  area.addEventListener('mousemove', async (e) => {
    const mark = chartMarkAt(area, e);
    if (!mark) { lastKey = null; tvHide(); return; }
    const key = String(mark.category);
    if (key === lastKey) { place(e); return; }
    lastKey = key;
    const my = ++seq;
    tvHide();
    tvTip = document.createElement('div');
    tvTip.className = 'tv-tip';
    tvTip.setAttribute('role', 'tooltip');
    const head = document.createElement('div');
    head.className = 'tv-tip-head';
    head.textContent = key;
    const box = document.createElement('div');
    box.className = 'tv-tip-chart';
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 140;
    box.appendChild(canvas);
    tvTip.append(head, box);
    document.body.appendChild(tvTip);
    place(e);
    if (!currentProjectId) return;
    if (!tipVisual) tipVisual = await window.hub.getVisual(currentProjectId, action.tooltipVisualId).catch(() => null);
    if (my !== seq || !tvTip) return;
    if (!tipVisual) { box.textContent = 'The tooltip visual was deleted.'; return; }
    const clicked = tileClicked(visual, mark.category);
    const filters = mergeDashFilters(effectiveFilters(), tipVisual.filters)
      .concat(clicked ? [{ type: 'filter', column: clicked.column, op: '=', value: clicked.value }] : []);
    const res = await window.hub.computeVisualData(currentProjectId, tipVisual.datasetId, tipVisual.encoding, filters).catch(() => null);
    if (my !== seq || !tvTip) return;
    if (!res || !res.ok) { box.textContent = 'No data for ' + key + '.'; return; }
    const sub = document.createElement('div');
    sub.className = 'tv-tip-sub';
    sub.textContent = String(tipVisual.name || 'Visual');
    head.after(sub);
    const type = String(tipVisual.chartType || 'column');
    tvChart = buildChart(canvas, res.data, type.indexOf('map_') === 0 ? 'column' : type, {
      showLegend: false, valueMode: 'off', noAnimate: true, showTooltips: false,
    });
    if (!tvChart) box.textContent = 'No data for ' + key + '.';
  });
}
