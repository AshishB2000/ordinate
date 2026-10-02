// Version history — the History panel, the read-only preview and Restore.
// Classic global-scope renderer <script>: no import/export.
//
// Every save of a dashboard, visual, metric, report or dataset pipeline is a
// version (src/app/versions.ts). This file lists them in the shared right panel
// (sidePanel.ts), each with the app-written summary of what that save changed
// and, for a dashboard, a thumbnail of its layout drawn from the snapshot.
//
// PREVIEW IS IN PLACE where the record has a page of its own: a dashboard
// version opens in the dashboard editor, read-only (dashReadOnly — the same
// switch a published snapshot uses, so autosave cannot fire), and a visual
// version opens in the builder with its controls locked. A banner on that page
// says which version is showing and offers Restore and Back to current. A
// metric, report or pipeline version previews inside the panel.
//
// RESTORE IS A SAVE (src/ipc/versions.ts): history stays append-only, so the
// way to undo a restore is to restore the version before it.

const VH_TYPE_WORD: Record<string, string> = {
  dashboard: t('common.dashboard'), visual: 'Visual', metric: t('common.metric'), report: t('common.report'), dataset: 'Pipeline',
};

interface VhState {
  type: string;
  id: string;
  name: string;
  list: any[];
  /** The key of the version being previewed, '' for the current one. */
  sel: string;
  body: HTMLElement;
}
let vhState: VhState | null = null;

/** Open the History panel for one record of the active project. `word` names
 *  the record where its type's word does not — an input table is a 'Table'. */
async function vhOpen(type: string, id: string, name?: string, word0?: string): Promise<void> {
  if (!currentProjectId || !id || !VH_TYPE_WORD[type]) return;
  const word = word0 || VH_TYPE_WORD[type];
  const panel = spOpen({
    kind: 'history',
    title: name || word,
    sub: t('versionsPanel.version_history', { word }),
    onClose: () => { vhEndPreview(); vhState = null; },
  });
  vhState = { type, id, name: name || word, list: [], sel: '', body: panel.body };
  panel.el.dataset.recordId = id;
  await vhReload();
}

async function vhReload(): Promise<void> {
  const st = vhState;
  if (!st || !currentProjectId) return;
  let list: any[] = [];
  try {
    list = await window.hub.versionsList(currentProjectId, st.type, st.id);
  } catch (_) { list = []; }
  if (vhState !== st) return; // closed or re-pointed while loading
  st.list = Array.isArray(list) ? list : [];
  vhPaint();
}

function vhPaint(): void {
  const st = vhState;
  if (!st) return;
  st.body.textContent = '';
  if (!st.list.length) {
    st.body.appendChild(makeEmptyState({
      variant: 'starred',
      iconName: 'history',
      title: t('versionsPanel.no_saved_versions_yet'),
      line: t('versionsPanel.every_save_from_now_on_is'),
    }));
    return;
  }
  const preview = document.createElement('div');
  preview.className = 'vh-preview';
  preview.hidden = true;
  st.body.appendChild(preview);

  const list = document.createElement('div');
  list.className = 'vh-list';
  list.setAttribute('role', 'list');
  let day = '';
  st.list.forEach((v, i) => {
    const d = vhDayLabel(v.savedAt);
    if (d !== day) {
      day = d;
      const h = document.createElement('div');
      h.className = 'vh-day';
      h.textContent = d;
      list.appendChild(h);
    }
    list.appendChild(vhRow(v, i === 0));
  });
  st.body.appendChild(list);
  const note = document.createElement('p');
  note.className = 'dsp-note vh-foot-note';
  note.textContent = st.list.length >= 50
    ? t('versionsPanel.the_50_most_recent_saves_are')
    : t('versionsPanel.kept_up_to_50', { listCount: st.list.length });
  st.body.appendChild(note);
}

function vhDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return t('common.today');
  if (days === 1) return t('common.yesterday');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function vhRow(v: any, isCurrent: boolean): HTMLElement {
  const st = vhState as VhState;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'vh-row';
  row.setAttribute('role', 'listitem');
  row.dataset.key = String(v.key);
  const selected = st.sel ? st.sel === v.key : isCurrent;
  row.classList.toggle('is-selected', selected);
  row.classList.toggle('is-current', isCurrent);

  if (st.type === 'dashboard') row.appendChild(vhThumb(Array.isArray(v.thumb) ? v.thumb : []));
  else {
    const dot = document.createElement('span');
    dot.className = 'vh-dot';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
  }

  const main = document.createElement('span');
  main.className = 'vh-row-main';
  const top = document.createElement('span');
  top.className = 'vh-row-top';
  const when = document.createElement('span');
  when.className = 'vh-when tnum';
  when.textContent = new Date(v.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  top.appendChild(when);
  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'vh-badge';
    badge.textContent = t('common.current');
    top.appendChild(badge);
  }
  const summary = document.createElement('span');
  summary.className = 'vh-summary';
  summary.textContent = String(v.summary || '');
  main.append(top, summary);
  if (v.restoredFrom) {
    const r = document.createElement('span');
    r.className = 'vh-restored';
    r.appendChild(icon('rotate-ccw', 12));
    const tv = document.createElement('span');
    tv.textContent = t('versionsPanel.restored_from', { restoredFrom: spWhen(v.restoredFrom) });
    r.appendChild(tv);
    main.appendChild(r);
  }
  row.appendChild(main);
  row.setAttribute('aria-label', t('versionsPanel.text', { savedAt: spWhen(v.savedAt), p1: !!(isCurrent), p2: v.summary || '' }));
  row.addEventListener('click', () => {
    if (isCurrent) void vhBackToCurrent();
    else void vhPreview(v);
  });
  return row;
}

/**
 * The layout of a dashboard version's first sheet, drawn from the snapshot:
 * each tile a rounded rect on the 12-column grid, tinted by what it is. Small
 * enough to scan a list by shape — "the one before the map went full width".
 */
function vhThumb(tiles: Array<{ x: number; y: number; w: number; h: number; type: string }>): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 64;
  const H = 44;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'vh-thumb');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  const rows = Math.max(8, ...tiles.map((t) => t.y + t.h));
  const cw = (W - 4) / 12;
  const rh = (H - 4) / rows;
  for (const t of tiles) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(2 + t.x * cw + 0.6));
    r.setAttribute('y', String(2 + t.y * rh + 0.6));
    r.setAttribute('width', String(Math.max(1, t.w * cw - 1.2)));
    r.setAttribute('height', String(Math.max(1, t.h * rh - 1.2)));
    r.setAttribute('rx', '1.5');
    r.setAttribute('class', 'vh-thumb-tile vh-thumb-tile--' + (t.type || 'visual'));
    svg.appendChild(r);
  }
  return svg;
}

// ── Preview ──────────────────────────────────────────────────────────────────

async function vhPreview(v: any): Promise<void> {
  const st = vhState;
  if (!st || !currentProjectId) return;
  let snap: any = null;
  try {
    snap = await window.hub.versionsGet(currentProjectId, st.type, st.id, String(v.key));
  } catch (_) { snap = null; }
  if (!snap || !snap.record) { showToast(t('versionsPanel.that_version_could_not_be_read')); return; }
  if (vhState !== st) return;
  st.sel = String(v.key);
  st.body.querySelectorAll('.vh-row').forEach((r) => {
    (r as HTMLElement).classList.toggle('is-selected', (r as HTMLElement).dataset.key === st.sel);
  });
  if (st.type === 'dashboard') await vhPreviewDashboard(snap.record, v);
  else if (st.type === 'visual') await vhPreviewVisual(snap.record, v);
  else vhPreviewInPanel(snap.record, v);
}

/** The banner every preview carries: which version, and the two ways out. */
function vhBanner(v: any): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'vh-banner';
  bar.setAttribute('role', 'status');
  const ic = document.createElement('span');
  ic.className = 'vh-banner-ic';
  ic.appendChild(icon('history'));
  const text = document.createElement('div');
  text.className = 'vh-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = t('versionsPanel.viewing_version_from', { savedAt: spWhen(v.savedAt) });
  const sub = document.createElement('span');
  sub.textContent = t('versionsPanel.read_only', { p0: String(v.summary || '') });
  text.append(strong, sub);
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-sm btn-primary vh-restore-btn';
  iconLabel(restore, 'rotate-ccw', t('common.restore'));
  restore.addEventListener('click', () => void vhRestore(v));
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-sm btn-ghost vh-back-btn';
  back.textContent = t('versionsPanel.back_to_current');
  back.addEventListener('click', () => void vhBackToCurrent());
  const actions = document.createElement('div');
  actions.className = 'vh-banner-actions';
  actions.append(restore, back);
  bar.append(ic, text, actions);
  return bar;
}

function vhDropBanners(): void {
  document.querySelectorAll('.vh-banner').forEach((b) => b.remove());
  document.body.classList.remove('vh-previewing');
  const vb = document.getElementById('viz-builder');
  if (vb) vb.classList.remove('viz-builder--preview');
}

async function vhPreviewDashboard(rec: any, v: any): Promise<void> {
  const st = vhState as VhState;
  // An edit still waiting on the 600 ms autosave is saved first — it is the
  // current version, and the preview is about to replace the editor's state.
  if (dashDirty && dashCurrent && String(dashCurrent.id) === st.id && !dashReadOnly) await persistDashboard();
  const live = await window.hub.getAnalysis(currentProjectId as string, st.id).catch(() => null);
  if (!live) { showToast(t('versionsPanel.that_dashboard_is_gone')); return; }
  vhDropBanners();
  // The editor opens the SNAPSHOT with dashReadOnly already set, so the cards
  // draw without drag handles and the 600 ms autosave cannot fire.
  const snap = {
    ...live, name: rec.name || live.name, sheets: Array.isArray(rec.sheets) ? rec.sheets : live.sheets,
    filters: Array.isArray(rec.filters) ? rec.filters : [], style: rec.style || live.style,
  };
  dashMode = 'analysis';
  dashReadOnly = true;
  mountDashEditor('an-editor-host');
  if (!Array.isArray(snap.sheets) || !snap.sheets.length) snap.sheets = [{ id: dashUuid(), name: t('common.sheet_1'), cards: [] }];
  snap.pages = snap.sheets;
  dashShow('an-list-view', false);
  openEditorWith(snap, snap.name);
  // Above the page tabs: the top of the sheet, whether or not focus mode has
  // lifted the head out of the editor.
  const ed = document.getElementById('dash-editor');
  if (ed) ed.insertBefore(vhBanner(v), document.getElementById('dash-pages'));
  document.body.classList.add('vh-previewing');
}

async function vhPreviewVisual(rec: any, v: any): Promise<void> {
  const st = vhState as VhState;
  const live = await window.hub.getVisual(currentProjectId as string, st.id).catch(() => null);
  if (!live) { showToast(t('versionsPanel.that_visual_is_gone')); return; }
  vhDropBanners();
  await vizOpenRecord({ ...live, ...rec, id: live.id, datasetId: live.datasetId });
  const vb = document.getElementById('viz-builder');
  if (!vb) return;
  vb.classList.add('viz-builder--preview');
  const head = vb.querySelector('.viz-builder-head');
  if (head) head.after(vhBanner(v));
  document.body.classList.add('vh-previewing');
}

/** Metric, report and pipeline versions: the version's content, read-only,
 *  at the top of the panel. */
function vhPreviewInPanel(rec: any, v: any): void {
  const st = vhState as VhState;
  const box = st.body.querySelector('.vh-preview') as HTMLElement | null;
  if (!box) return;
  box.textContent = '';
  box.appendChild(vhBanner(v));
  const facts = document.createElement('dl');
  facts.className = 'dsp-facts vh-facts';
  const add = (k: string, val: string): void => {
    if (!val) return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    facts.append(dt, dd);
  };
  if (st.type === 'metric') {
    add(t('common.name'), rec.name || '');
    const def = rec.definition || {};
    add(t('common.definition'), def.formula ? String(def.formula) : `${def.aggregation || 'sum'}(${def.column || ''})`);
    add(t('common.filters'), Array.isArray(rec.filters) && rec.filters.length ? vhFilterWords(rec.filters) : t('common.none'));
    const f = rec.format || {};
    add(t('common.format'), [f.kind, f.decimals !== undefined ? f.decimals + ' dp' : '', f.compact ? 'compact' : ''].filter(Boolean).join(' · '));
    if (rec.description) add(t('common.description'), rec.description);
  } else if (st.type === 'report') {
    add(t('common.name'), rec.name || '');
    add(t('common.format'), String(rec.format || '').toUpperCase());
    const pages = Array.isArray(rec.pages) ? rec.pages : [];
    add(t('common.pages'), t('versionsPanel.of_included', { p0: pages.filter((p: any) => p && p.include !== false).length, pagesCount: pages.length }));
    add(t('common.cover'), rec.cover && rec.cover.title ? rec.cover.title : '');
    add(t('common.schedule'), rec.schedule && rec.schedule.cadence && rec.schedule.cadence !== 'off'
      ? `${rec.schedule.cadence} at ${rec.schedule.at}` : t('common.off'));
  } else if (st.type === 'dataset') {
    const steps = Array.isArray(rec.steps) ? rec.steps : [];
    if (rec.table) { vhPreviewTable(box, facts, add, rec.table, steps.length); return; }
    add(t('common.steps'), steps.length ? String(steps.length) : t('versionsPanel.none_the_source_as_imported'));
    box.appendChild(facts);
    const ol = document.createElement('ol');
    ol.className = 'vh-steps';
    for (const s of steps) {
      const li = document.createElement('li');
      li.textContent = vhStepWords(s);
      ol.appendChild(li);
    }
    if (steps.length) box.appendChild(ol);
    box.hidden = false;
    return;
  }
  box.appendChild(facts);
  box.hidden = false;
}

/** An input table's version: its size, and its first rows as they were. */
function vhPreviewTable(box: HTMLElement, facts: HTMLElement, add: (k: string, v: string) => void, table: any, steps: number): void {
  const cols: any[] = Array.isArray(table.columns) ? table.columns : [];
  const rows: any[][] = Array.isArray(table.rows) ? table.rows : [];
  add(t('common.rows'), rows.length.toLocaleString('en-US'));
  add(t('common.columns'), cols.map((c) => String(c && c.name)).join(', '));
  if (steps) add(t('versionsPanel.prepare_steps'), String(steps));
  box.appendChild(facts);
  const tv = document.createElement('table');
  tv.className = 'vh-table';
  const hr = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = String(c && c.name);
    hr.appendChild(th);
  }
  tv.appendChild(hr);
  for (const r of rows.slice(0, 8)) {
    const tr = document.createElement('tr');
    cols.forEach((_c, i) => {
      const td = document.createElement('td');
      td.textContent = r && r[i] != null ? String(r[i]) : '';
      tr.appendChild(td);
    });
    tv.appendChild(tr);
  }
  if (rows.length) box.appendChild(tv);
  if (rows.length > 8) {
    const more = document.createElement('p');
    more.className = 'dsp-note';
    more.textContent = t('versionsPanel.and_more_rows', { p0: (rows.length - 8).toLocaleString('en-US') });
    box.appendChild(more);
  }
  box.hidden = false;
}

function vhFilterWords(filters: any[]): string {
  return filters.map((f: any) => `${f.column} ${f.op} ${Array.isArray(f.values) ? f.values.join(', ') : (f.value ?? '')}`.trim()).join('; ');
}

function vhStepWords(s: any): string {
  if (!s || typeof s !== 'object') return t('common.step');
  switch (s.type) {
    case 'calculated_field': return t('versionsPanel.calculated_field', { name: s.name, expression: s.expression });
    case 'filter': return t('common.filter_2', { p0: vhFilterWords([s]) });
    case 'rename_column': return t('common.rename_2', { from: s.from, to: s.to });
    case 'drop_column': return t('versionsPanel.drop', { column: s.column });
    case 'fill_empty': return t('versionsPanel.fill_empty_with', { column: s.column, value: s.value });
    case 'trim': return s.column ? t('versionsPanel.trim', { column: s.column }) : t('versionsPanel.trim_text_columns');
    case 'dedupe': return t('versionsPanel.remove_duplicate_rows');
    case 'group_aggregate': return t('versionsPanel.group_by', { p0: (s.groupBy || []).join(', ') });
    default: return pvMaskSummary(s) || String(s.type || t('common.step'));
  }
}

/** Leave a preview: the live record goes back on its page. */
async function vhBackToCurrent(): Promise<void> {
  const st = vhState;
  const wasPreviewing = document.body.classList.contains('vh-previewing');
  vhDropBanners();
  if (st) {
    st.sel = '';
    const box = st.body.querySelector('.vh-preview') as HTMLElement | null;
    if (box) { box.hidden = true; box.textContent = ''; }
    st.body.querySelectorAll('.vh-row').forEach((r, i) => (r as HTMLElement).classList.toggle('is-selected', i === 0));
  }
  if (!st || !wasPreviewing) return;
  if (st.type === 'dashboard' && typeof openAnalysis === 'function') await openAnalysis(st.id);
  else if (st.type === 'visual' && typeof openSavedVisual === 'function') await openSavedVisual(st.id);
}

/** Called when the panel closes: leave no preview behind. */
function vhEndPreview(): void {
  if (document.body.classList.contains('vh-previewing')) void vhBackToCurrent();
  else vhDropBanners();
}

async function vhRestore(v: any): Promise<void> {
  const st = vhState;
  if (!st || !currentProjectId) return;
  let res: any = null;
  try {
    res = await window.hub.versionsRestore(currentProjectId, st.type, st.id, String(v.key));
  } catch (_) { res = null; }
  if (!res || !res.ok) { showToast((res && res.error) || t('versionsPanel.could_not_restore_that_version')); return; }
  showToast(res.unchanged
    ? t('versionsPanel.that_version_is_already_the_current')
    : t('versionsPanel.restored_the_version_from_the_one', { savedAt: spWhen(v.savedAt) }));
  // Back to current reopens a dashboard or visual from disk — which now IS the
  // restored content. The panel-previewed kinds repaint whatever shows them.
  await vhBackToCurrent();
  if (st.type === 'dataset' && typeof openSavedDataset === 'function' && expId === st.id) openSavedDataset(st.id);
  if (st.type === 'report' && typeof rbRefreshList === 'function') void rbRefreshList();
  await vhReload();
}

/** Dashboard editor / visual builder closed under a preview: drop its banner
 *  and forget the selection, without reopening anything. */
function vhReset(): void {
  if (!document.body.classList.contains('vh-previewing')) return;
  vhDropBanners();
  if (vhState) vhState.sel = '';
}

/** Boot wiring: the two page-level History buttons. Every other door (a ⋯
 *  menu, the palette) calls vhOpen directly. */
function initVersionsPanel(): void {
  const dashBtn = document.getElementById('dash-history-btn');
  if (dashBtn) {
    dashBtn.addEventListener('click', () => {
      if (!dashCurrent) return;
      if (spIsOpen('history') && vhState && vhState.id === String(dashCurrent.id)) { spClose(); return; }
      void vhOpen('dashboard', String(dashCurrent.id), String(dashCurrent.name || ''));
    });
  }
  const vizBtn = document.getElementById('viz-history-btn');
  if (vizBtn) {
    vizBtn.addEventListener('click', () => {
      if (!vizEditingId) return;
      if (spIsOpen('history') && vhState && vhState.id === vizEditingId) { spClose(); return; }
      const nameEl = document.getElementById('viz-builder-name');
      void vhOpen('visual', vizEditingId, nameEl ? String(nameEl.textContent || '') : '');
    });
  }
}
