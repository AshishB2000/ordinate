// Dragging things OUT — of the app, and across it. Classic global-scope
// renderer <script>.
//
//   A chart → Finder / another app as a PNG. Hovering any Chart.js chart shows
//   one small grip at its corner; dragging the grip hands the canvas's pixels
//   (on the page's own background) to main, which writes a temp file and starts
//   the OS drag (src/ipc/dragDrop.ts). The canvas itself is not draggable: its
//   pointer drags already move reference lines (chartAnnotations.ts). Maps are
//   left out — their value labels are DOM markers a canvas copy drops.
//   A dataset row on Data → a CSV of its current (prepared) table, same way.
//   A Visuals card → an open dashboard tab in the tab strip, or the open
//   dashboard's canvas: added as a card through the ordinary pushCard path.

const DND_VISUAL_MIME = 'application/x-ordinate-visual';
let dndVisualId = '';
let dndGrip: HTMLButtonElement | null = null;
let dndGripCanvas: HTMLCanvasElement | null = null;

/** The Chart.js canvas under `el`, if any — its container is in chartInstances. */
function dndChartCanvas(el: EventTarget | null): HTMLCanvasElement | null {
  const c = el as HTMLCanvasElement | null;
  if (!c || c.tagName !== 'CANVAS') return null;
  let p: HTMLElement | null = c.parentElement;
  for (let i = 0; i < 3 && p; i++, p = p.parentElement) if (chartInstances.get(p)) return c;
  return null;
}

function dndChartName(c: HTMLCanvasElement): string {
  const card = c.closest('.dash-card');
  const t = card && card.querySelector('.dash-card-title');
  if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
  const b = c.closest('#viz-area') && document.getElementById('viz-builder-name');
  return (b && b.textContent && b.textContent.trim()) || 'Chart';
}

/** The canvas as a PNG on an opaque background — a transparent chart is unreadable on a dark desktop. */
function dndChartPng(c: HTMLCanvasElement): string {
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  const ctx = out.getContext('2d');
  if (!ctx) return c.toDataURL('image/png');
  let bg = '';
  for (let el: Element | null = c; el && !bg; el = el.parentElement) {
    const v = getComputedStyle(el).backgroundColor;
    if (v && v !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(v)) bg = v;
  }
  ctx.fillStyle = bg || '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out.toDataURL('image/png');
}

function dndPlaceGrip(c: HTMLCanvasElement | null): void {
  if (!dndGrip) return;
  dndGripCanvas = c;
  if (!c) { dndGrip.hidden = true; return; }
  const r = c.getBoundingClientRect();
  dndGrip.style.top = Math.round(r.top + 6) + 'px';
  dndGrip.style.left = Math.round(r.right - 34) + 'px';
  dndGrip.hidden = false;
}

function dndIsDashTab(el: EventTarget | null): HTMLElement | null {
  const e = el as Element | null;
  return e && e.closest ? e.closest('.tab-item[data-key^="analysis:"]') as HTMLElement | null : null;
}

function dndIsDashCanvas(el: EventTarget | null): boolean {
  const e = el as Element | null;
  return !!(e && e.closest && e.closest('#dash-grid') && dashCurrent && dashMode === 'analysis' && !dashReadOnly);
}

function dndClearMarks(): void {
  document.querySelectorAll('.dnd-target-over').forEach((el) => el.classList.remove('dnd-target-over'));
}

/** Add a saved visual to the dashboard behind tab `key` (or the open one), as the Add-visual picker does. */
async function dndAddVisual(visualId: string, key: string | null): Promise<void> {
  if (key) {
    await tabRun(() => tabSwitchTo(key));
    const want = key.slice('analysis:'.length);
    for (let i = 0; i < 50 && !(dashCurrent && String(dashCurrent.id) === want); i++) await new Promise((r) => setTimeout(r, 100));
    if (!dashCurrent || String(dashCurrent.id) !== want) { showToast(t('dndOut.that_dashboard_did_not_open'), { kind: 'error' }); return; }
  }
  if (!dashCurrent || dashReadOnly) { showToast(t('dndOut.a_published_dashboard_is_read_only'), { kind: 'error' }); return; }
  pushCard({ id: dashUuid(), type: 'visual', visualId, layout: { ...dashFindSlot(dashCards(), 6, 6), w: 6, h: 6 } });
  showToast(t('common.added_to', { p0: (dashCurrent.name || t('common.the_dashboard')) }), { kind: 'success' });
}

function initDndOut(): void {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'dnd-grip';
  grip.draggable = true;
  grip.hidden = true;
  grip.title = t('dndOut.drag_out_as_a_png');
  grip.setAttribute('aria-label', t('dndOut.drag_this_chart_out_as_a'));
  grip.appendChild(icon('grip-vertical', 16));
  document.body.appendChild(grip);
  dndGrip = grip;

  document.addEventListener('mouseover', (e) => {
    if (e.target === grip || grip.contains(e.target as Node)) return;
    dndPlaceGrip(dndChartCanvas(e.target));
  });
  document.addEventListener('scroll', () => dndPlaceGrip(null), true);

  document.addEventListener('dragstart', (e) => {
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    if (t === grip) {
      e.preventDefault(); // the OS drag main starts replaces the page's own
      if (dndGripCanvas) window.hubDrop.dragOutChart(dndChartName(dndGripCanvas), dndChartPng(dndGripCanvas));
      return;
    }
    const ds = t.closest('.ds-saved-item[data-rec-kind="dataset"]') as HTMLElement | null;
    if (ds && ds.dataset.recId && currentProjectId) {
      e.preventDefault();
      window.hubDrop.dragOutDataset(currentProjectId, ds.dataset.recId);
      return;
    }
    const card = t.closest('.viz-card[data-rec-kind="visual"]') as HTMLElement | null;
    if (card && card.dataset.recId && e.dataTransfer) {
      dndVisualId = card.dataset.recId;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(DND_VISUAL_MIME, dndVisualId);
      document.body.classList.add('dnd-visual-drag');
    }
  });
  document.addEventListener('dragend', () => {
    dndVisualId = '';
    document.body.classList.remove('dnd-visual-drag');
    dndClearMarks();
  });
  document.addEventListener('dragover', (e) => {
    if (!dndVisualId) return;
    const tab = dndIsDashTab(e.target);
    const onCanvas = !tab && dndIsDashCanvas(e.target);
    dndClearMarks();
    if (!tab && !onCanvas) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    (tab || document.getElementById('dash-grid'))!.classList.add('dnd-target-over');
  });
  document.addEventListener('drop', (e) => {
    if (!dndVisualId) return;
    const id = dndVisualId;
    const tab = dndIsDashTab(e.target);
    if (!tab && !dndIsDashCanvas(e.target)) return;
    e.preventDefault();
    dndVisualId = '';
    document.body.classList.remove('dnd-visual-drag');
    dndClearMarks();
    void dndAddVisual(id, tab ? tab.dataset.key || null : null);
  });
}

initDndOut();
