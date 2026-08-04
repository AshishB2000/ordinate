// Analyses section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts (loaded AFTER
// dashboards.js, so dashEl / dashChooseModal / openAnalysisFrom / dashCurrent /
// promptModal / formatSidebarTime / showToast / selectSection all resolve at
// call time).
//
// An ANALYSIS is the authoring container: sheets of cards plus analysis-wide
// filters (src/analysis.ts). A DASHBOARD is what you get when you publish one —
// a snapshot, read-only, still drawing live data through a frozen definition.
//
// This file owns the LIST (create / rename / delete / open), the AI draft, and
// PUBLISH. It owns no editing UI at all: the authoring surface IS the dashboard
// editor in dashboards.ts, re-parented into #an-editor-host, because a sheet is
// literally a dashboards `Page` and the grid, tabs, cards and cross-visual
// filters already work on exactly that shape.
//
// ponytail: analysis/sheet/card envelopes are owned by src/analysis.ts; the
// renderer forwards them, so they are typed `any` here rather than re-declared.

// The name of the dashboard the most recent publish produced, so the editor can
// say WHICH dashboard it wrote. Session-only — provenance lives on the record.
let anLastPublishedName: string | null = null;

// ── List view ───────────────────────────────────────────────────────────────
async function refreshAnalysisList(): Promise<void> {
  // Flush a pending debounced edit before the editor is torn down, so a quick
  // section switch never drops the last few edits.
  if (dashDirty && dashCurrent) await persistDashboard();
  closeDashboardEditor();
  const list = dashEl('an-list');
  const empty = dashEl('an-list-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listAnalyses(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((a) => list.appendChild(makeAnListItem(a)));
}

// Refresh the summaries without tearing down an open editor.
async function refreshAnalysisListKeepEditor(): Promise<void> {
  if (!currentProjectId) return;
  const list = dashEl('an-list');
  if (!list) return;
  try {
    const items = await window.hub.listAnalyses(currentProjectId);
    if (!Array.isArray(items)) return;
    list.innerHTML = '';
    items.forEach((a) => list.appendChild(makeAnListItem(a)));
    const empty = dashEl('an-list-empty');
    if (empty) empty.hidden = items.length > 0;
  } catch (_) { /* ignore */ }
}

// `updatedAt > lastPublishedAt` is the whole "does this have unpublished
// changes?" test — no diff, no `dirty` flag to go stale. `analysis:publish`
// deliberately does NOT bump updatedAt (src/analysis.ts bumpUpdatedAt:false),
// which is what stops this reading true the instant a publish finishes.
function analysisHasUnpublishedChanges(a: any): boolean {
  if (!a || !a.lastPublishedAt) return false; // never published → "not published yet"
  const up = Date.parse(a.updatedAt || '');
  const pub = Date.parse(a.lastPublishedAt);
  if (!Number.isFinite(up) || !Number.isFinite(pub)) return false;
  return up > pub;
}

function makeAnListItem(a: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dash-list-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dash-list-open';
  const nameRow = document.createElement('span');
  nameRow.className = 'dash-list-name';
  nameRow.textContent = a && a.name ? String(a.name) : 'Untitled analysis';
  if (analysisHasUnpublishedChanges(a)) {
    const badge = document.createElement('span');
    badge.className = 'dash-list-badge dash-list-badge--dirty';
    badge.textContent = 'Unpublished changes';
    nameRow.appendChild(badge);
  }
  const meta = document.createElement('span');
  meta.className = 'dash-list-meta';
  const sheets = a && typeof a.sheetCount === 'number' ? a.sheetCount : 1;
  meta.textContent =
    sheets + (sheets === 1 ? ' sheet · ' : ' sheets · ') +
    (a && a.lastPublishedAt
      ? 'published ' + formatSidebarTime(a.lastPublishedAt)
      : 'never published') +
    ' · edited ' + formatSidebarTime(a && a.updatedAt);
  open.appendChild(nameRow);
  open.appendChild(meta);
  open.addEventListener('click', () => openAnalysis(String(a.id)));

  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'dash-list-btn';
  ren.setAttribute('aria-label', 'Rename analysis');
  ren.textContent = '✎';
  ren.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRenameAnalysis(String(a.id), a && a.name ? String(a.name) : '');
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'dash-list-btn';
  del.setAttribute('aria-label', 'Delete analysis');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteAnalysis(String(a.id)); });

  row.appendChild(open);
  row.appendChild(ren);
  row.appendChild(del);
  return row;
}

async function handleNewAnalysis(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const name = await promptModal('New analysis', 'Untitled analysis', 'Create');
  if (name === null) return;
  let res: any;
  try {
    res = await window.hub.createAnalysis({ projectId: currentProjectId, name });
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.id) {
    window.alert((res && res.error) || 'Failed to create the analysis.');
    return;
  }
  await refreshAnalysisList();
  openAnalysisFrom(res);
}

async function handleRenameAnalysis(id: string, currentName: string): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename analysis', currentName || 'Untitled analysis', 'Save');
  if (name === null) return;
  try {
    await window.hub.renameAnalysis(currentProjectId, id, name);
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashMode === 'analysis' && dashCurrent.id === id) {
    dashCurrent.name = name.trim() || dashCurrent.name;
    const nameEl = dashEl('dash-name');
    if (nameEl) nameEl.textContent = dashCurrent.name;
    await refreshAnalysisListKeepEditor();
    return;
  }
  await refreshAnalysisList();
}

// Deleting an analysis deliberately does NOT delete the dashboards it published
// — a published dashboard is a standalone snapshot and outlives its author. The
// confirmation says so, because "delete" usually means the opposite.
async function handleDeleteAnalysis(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this analysis? Dashboards it already published are kept — they are standalone snapshots. This cannot be undone.')) return;
  try {
    await window.hub.deleteAnalysis(currentProjectId, id);
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashMode === 'analysis' && dashCurrent.id === id) closeDashboardEditor();
  await refreshAnalysisList();
}

async function openAnalysis(id: string): Promise<void> {
  if (!currentProjectId) return;
  let a: any = null;
  try {
    a = await window.hub.getAnalysis(currentProjectId, id);
  } catch (_) {
    a = null;
  }
  if (!a) {
    window.alert('That analysis could not be loaded.');
    await refreshAnalysisList();
    return;
  }
  anLastPublishedName = null;
  openAnalysisFrom(a);
}

// ── Publish state (editor) ──────────────────────────────────────────────────
// Called by dashboards.ts on open and after every analysis save.
function renderAnalysisPubState(): void {
  const el = dashEl('an-pubstate');
  const republish = dashEl('an-republish-btn');
  if (!el) return;
  if (dashMode !== 'analysis' || !dashCurrent) {
    el.hidden = true;
    if (republish) republish.hidden = true;
    return;
  }
  const ids: any[] = Array.isArray(dashCurrent.publishedDashboardIds) ? dashCurrent.publishedDashboardIds : [];
  if (republish) republish.hidden = ids.length === 0;

  el.hidden = false;
  el.innerHTML = '';
  const line = document.createElement('span');
  if (!dashCurrent.lastPublishedAt) {
    line.textContent = 'Not published yet. Publishing takes a snapshot of these sheets as a dashboard — the read-only surface people open.';
  } else {
    line.textContent =
      'Published ' + formatSidebarTime(dashCurrent.lastPublishedAt) +
      (anLastPublishedName ? ' to “' + anLastPublishedName + '”' : '') +
      ' · ' + ids.length + (ids.length === 1 ? ' dashboard' : ' dashboards');
  }
  el.appendChild(line);
  if (analysisHasUnpublishedChanges(dashCurrent)) {
    const dirty = document.createElement('span');
    dirty.className = 'an-pubstate-dirty';
    dirty.textContent = ' · Unpublished changes — republish to update the dashboard.';
    el.appendChild(dirty);
  }
}

// ── Publish / republish ─────────────────────────────────────────────────────
// A snapshot, not a link: each referenced visual's DEFINITION is copied by value
// into the published card, so editing the analysis (or the visual) afterwards
// cannot move the dashboard. The DATA is deliberately NOT snapshotted — the
// dashboard keeps reading live rows through the frozen definition — which is
// stated on the confirmation because "snapshot" could reasonably be read the
// other way.
async function handlePublishAnalysis(chooseTarget: boolean): Promise<void> {
  if (!currentProjectId || !dashCurrent || dashMode !== 'analysis') return;
  const analysisId = String(dashCurrent.id);
  // Publish WHAT YOU SEE: flush any debounced edit before main reads the file.
  if (dashSaveTimer !== null || dashDirty) await handleSaveDashboard();

  let dashboardId: string | undefined;
  if (chooseTarget) {
    const ids: string[] = Array.isArray(dashCurrent.publishedDashboardIds)
      ? dashCurrent.publishedDashboardIds.map(String) : [];
    let all: any[] = [];
    try { all = await window.hub.listDashboards(currentProjectId); } catch (_) { all = []; }
    if (!Array.isArray(all)) all = [];
    const options = ids
      .map((id) => all.find((d: any) => String(d.id) === id))
      .filter(Boolean)
      .map((d: any) => ({ value: String(d.id), label: 'Replace “' + (d.name || 'Untitled dashboard') + '”' }));
    options.push({ value: '', label: 'Publish as a new dashboard' });
    const pick = await dashChooseModal('Republish this analysis', options, 'Publish');
    if (pick === null) return;
    if (pick) dashboardId = pick;
  }

  const btn = dashEl(chooseTarget ? 'an-republish-btn' : 'an-publish-btn') as HTMLButtonElement | null;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  let res: any;
  try {
    res = await window.hub.publishAnalysis(currentProjectId, analysisId, dashboardId ? { dashboardId } : {});
  } catch (_) {
    res = { ok: false, error: 'Could not publish this analysis.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = label || 'Publish'; }

  if (!res || res.ok === false || !res.dashboard) {
    window.alert((res && res.error) || 'Could not publish this analysis.');
    return;
  }

  // Reflect the new provenance locally (main wrote it; we are not re-reading the
  // file just to repaint one line).
  const d = res.dashboard;
  anLastPublishedName = d.name ? String(d.name) : 'Untitled dashboard';
  dashCurrent.lastPublishedAt = d.publishedAt || new Date().toISOString();
  if (!Array.isArray(dashCurrent.publishedDashboardIds)) dashCurrent.publishedDashboardIds = [];
  if (!dashCurrent.publishedDashboardIds.includes(d.id)) dashCurrent.publishedDashboardIds.push(d.id);
  renderAnalysisPubState();
  await refreshAnalysisListKeepEditor();
  showToast((res.created ? 'Published to a new dashboard “' : 'Republished over “') + anLastPublishedName + '”');
}

// ── The AI draft — a REVIEWED plan that lands on an ANALYSIS ────────────────
// The model proposes STRUCTURE only; main resolves every name→id, verifies each
// column exists, compiles each calculated field, clamps aggregations, assigns
// the grid itself, and computes every figure at render. Nothing is saved until
// the user says so. Execution-gated → a gentle hint, never an error dialog.
//
// PHASE E WIDENED THE REPLY. `analysis:draft` now resolves to
//   { ok, name, rationale, sheets: [{ name, visuals: VisualPreview[] }],
//     calculatedFields, dropped: [{ kind, where, message }], plan }
// where a VisualPreview's `data` is ALREADY the exact {labels, series} (+ geo)
// object chartRender.buildChart consumes — this file adds no charting code — and
// `data === null` always arrives with a `note` saying why (typically: the
// encoding depends on a calculated field that does not exist yet). The note is
// what gets shown. A placeholder number is NEVER substituted: a figure the app
// did not compute must not appear, and that rule does not soften for a preview.
//
// `dropped` IS SHOWN, deliberately and prominently. An invalid chart type, an
// uncompilable formula and a bad encoding are all dropped on purpose, and the
// design depends on the user seeing what the model got wrong — hiding it would
// make the model look better than it was.
//
// The older reply (`sheets: [{ name, cards }]`, no plan) is still accepted, so
// this call site works either side of the Phase E merge.
async function handleDraftAnalysis(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const btn = dashEl('an-draft-btn') as HTMLButtonElement | null;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  let res: any;
  try {
    res = await window.hub.draftDashboard(currentProjectId);
  } catch (_) {
    res = { ok: false, error: 'Could not draft an analysis.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = label || '✨ AI draft analysis'; }

  if (res && res.notReady) {
    window.alert('Connect a model in Execution settings to draft an analysis.');
    return;
  }
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Could not draft an analysis.');
    return;
  }

  const approved = await anDraftReviewModal(res);
  if (!approved) return;

  // Two ways to materialise, decided by what main actually sent — never by a
  // version flag. A `plan` means the Phase E pipeline owns the write (it has to:
  // calculated fields and visuals are records this renderer cannot mint).
  // Otherwise the draft is already a sheet array and createAnalysis takes it.
  const name = res.name || 'AI analysis';
  let saved: any = null;
  try {
    if (res.plan && typeof window.hub.buildAnalysisPlan === 'function') {
      const built = await window.hub.buildAnalysisPlan(currentProjectId, res.plan);
      if (built && built.ok === false) {
        window.alert(built.error || 'Failed to build the analysis.');
        return;
      }
      // Accept either { ok, analysis } or a bare Analysis — whichever main returns.
      saved = built && built.analysis ? built.analysis : built;
    } else {
      saved = await window.hub.createAnalysis({
        projectId: currentProjectId,
        name,
        sheets: Array.isArray(res.sheets) ? res.sheets : [],
      });
    }
  } catch (_) {
    saved = null;
  }

  await refreshAnalysisList();
  anLastPublishedName = null;
  if (saved && saved.ok !== false && saved.id) {
    openAnalysisFrom(saved);
    return;
  }
  // The write may well have succeeded even if we cannot recognise what came
  // back — the refreshed list above is the honest fallback, and it is visible.
  window.alert((saved && saved.error) || 'The analysis was not opened. Check the list below.');
}

// Review-before-create. Everything the model produced, plus everything main
// REFUSED, in one dialog. Built with the same .ws-modal furniture as the rest of
// the workspace; every label goes in via textContent and every rule is a class
// (the hub CSP forbids inline style=).
function anDraftReviewModal(draft: any): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal an-draft-modal';

    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'AI draft — review before creating';
    box.appendChild(h);

    const scroll = document.createElement('div');
    scroll.className = 'an-draft-body';

    const name = document.createElement('div');
    name.className = 'an-draft-name';
    name.textContent = draft && draft.name ? String(draft.name) : 'AI analysis';
    scroll.appendChild(name);

    // The model's own reasoning, labelled as interpretation — the same badge the
    // summary/anomaly panels use, so AI prose never reads as an app-computed fact.
    if (draft && typeof draft.rationale === 'string' && draft.rationale.trim()) {
      const panel = document.createElement('div');
      panel.className = 'ai-interp an-draft-rationale';
      panel.appendChild(mkAiPanel('Why the model proposed this'));
      const body = document.createElement('div');
      body.className = 'ai-interp-body';
      body.textContent = draft.rationale;
      panel.appendChild(body);
      scroll.appendChild(panel);
    }

    // WHAT WAS DROPPED. Never collapsed, never behind a toggle — and FIRST,
    // above the previews. At its natural height a preview chart pushes this
    // below the fold in a multi-visual draft, and a list of the model's
    // mistakes that the user has to scroll to find defeats the point of
    // showing it: they approve the plan having seen only the parts that worked.
    const dropped: any[] = Array.isArray(draft && draft.dropped) ? draft.dropped : [];
    if (dropped.length) {
      scroll.appendChild(anDraftSectionLabel(
        dropped.length + (dropped.length === 1 ? ' thing was dropped' : ' things were dropped'),
      ));
      const why = document.createElement('div');
      why.className = 'an-draft-note';
      why.textContent = 'The app refused these because it could not verify them. They are listed so the draft is not flattered by hiding its own mistakes.';
      scroll.appendChild(why);
      dropped.forEach((d: any) => {
        const row = document.createElement('div');
        row.className = 'an-draft-dropped';
        const where = document.createElement('span');
        where.className = 'an-draft-dropped-where';
        where.textContent = String((d && d.where) || '');
        const kind = document.createElement('span');
        kind.className = 'an-draft-dropped-kind';
        kind.textContent = String((d && d.kind) || 'dropped');
        const msg = document.createElement('span');
        msg.className = 'an-draft-dropped-msg';
        msg.textContent = String((d && d.message) || '');
        row.appendChild(kind);
        if (where.textContent) row.appendChild(where);
        row.appendChild(msg);
        scroll.appendChild(row);
      });
    }

    // Calculated fields the plan wants to add, shown with their formulas: they
    // are new columns in the user's data and must not arrive unannounced.
    const calcs: any[] = Array.isArray(draft && draft.calculatedFields) ? draft.calculatedFields : [];
    if (calcs.length) {
      scroll.appendChild(anDraftSectionLabel('Calculated fields it will add'));
      calcs.forEach((c: any) => {
        const row = document.createElement('div');
        row.className = 'an-draft-calc';
        const cn = document.createElement('span');
        cn.className = 'an-draft-calc-name';
        cn.textContent = String((c && (c.name || c.column)) || 'field');
        const cf = document.createElement('code');
        cf.className = 'an-draft-calc-formula';
        cf.textContent = String((c && (c.formula || c.expression)) || '');
        row.appendChild(cn);
        row.appendChild(cf);
        scroll.appendChild(row);
      });
    }

    // Sheets, and each visual previewed from data the APP computed.
    const sheets: any[] = Array.isArray(draft && draft.sheets) ? draft.sheets : [];
    sheets.forEach((sheet: any, si: number) => {
      scroll.appendChild(anDraftSectionLabel(
        (sheet && sheet.name ? String(sheet.name) : 'Sheet ' + (si + 1)),
      ));
      // New shape: `visuals` (previewable). Old shape: `cards` (no preview data).
      const visuals: any[] = Array.isArray(sheet && sheet.visuals) ? sheet.visuals : [];
      const cards: any[] = Array.isArray(sheet && sheet.cards) ? sheet.cards : [];
      if (!visuals.length && !cards.length) {
        const none = document.createElement('div');
        none.className = 'an-draft-note';
        none.textContent = 'Nothing survived on this sheet.';
        scroll.appendChild(none);
        return;
      }
      if (!visuals.length) {
        const summary = document.createElement('div');
        summary.className = 'an-draft-note';
        summary.textContent = cards.length + (cards.length === 1 ? ' card' : ' cards');
        scroll.appendChild(summary);
        return;
      }
      visuals.forEach((v: any) => scroll.appendChild(anDraftVisualEl(v)));
    });


    box.appendChild(scroll);

    const foot = document.createElement('p');
    foot.className = 'an-draft-foot';
    foot.textContent = 'Every figure here was computed by the app, not written by the model. You can edit everything after, and nothing is published until you publish it.';
    box.appendChild(foot);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Discard';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'Create analysis';

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: boolean): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      // Tear down any preview chart before its container leaves the document.
      scroll.querySelectorAll('.an-draft-viz .dash-viz-area').forEach((c) => {
        try {
          const inst = chartInstances.get(c as HTMLElement);
          if (inst && typeof inst.destroy === 'function') inst.destroy();
          chartInstances.delete(c as HTMLElement);
        } catch (_) { /* already gone */ }
        try { if (typeof destroyMapInContainer === 'function') destroyMapInContainer(c as HTMLElement); } catch (_) {}
      });
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'AI draft — review before creating', ok);
  });
}

function anDraftSectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'an-draft-section';
  el.textContent = text;
  return el;
}

// One previewed visual. `data` is the app-computed {labels, series} (+ geo) the
// existing render path already takes, so this REUSES renderVizInArea and adds no
// charting code. `data === null` means the app could not compute it yet — show
// the model's note verbatim and draw nothing.
function anDraftVisualEl(v: any): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'an-draft-visual';

  const head = document.createElement('div');
  head.className = 'an-draft-visual-head';
  const title = document.createElement('span');
  title.className = 'an-draft-visual-title';
  title.textContent = String((v && (v.name || v.title)) || 'Visual');
  head.appendChild(title);
  const type = v && typeof v.chartType === 'string' ? v.chartType : '';
  if (type) {
    const badge = document.createElement('span');
    badge.className = 'an-draft-visual-type';
    badge.textContent = String((typeof VIZ_LABELS !== 'undefined' && VIZ_LABELS[type]) || type);
    head.appendChild(badge);
  }
  wrap.appendChild(head);

  const data = v ? v.data : null;
  if (!data) {
    const note = document.createElement('div');
    note.className = 'an-draft-note an-draft-note--why';
    // No placeholder, no zero, no "—" pretending to be a value: only the reason.
    note.textContent = String((v && v.note) || 'The app could not compute this one yet.');
    wrap.appendChild(note);
    return wrap;
  }

  // A fixed-height box holding the exact `.dash-viz-area .cv-viz-area` pairing
  // the dashboard grid uses — that combination is what bounds a chart to its
  // container, and it is already proven at card size. `.cv-viz-area` alone
  // carries `min-height: 300px` and a viewport-sized canvas wrapper, which
  // painted straight through the card below this one.
  const box = document.createElement('div');
  box.className = 'an-draft-viz';
  const area = document.createElement('div');
  area.className = 'dash-viz-area cv-viz-area';
  box.appendChild(area);
  wrap.appendChild(box);
  // Deferred so the container has its box before Chart.js measures it — a chart
  // sized inside a not-yet-laid-out modal renders at zero height.
  window.setTimeout(() => {
    try {
      renderVizInArea(area, data, type || 'column', { id: 'draft-preview', chartOverrides: {} }, 'v');
    } catch (_) {
      area.textContent = 'This one could not be drawn.';
    }
  }, 0);
  return wrap;
}

// ── The route from a dashboard back to its analysis ─────────────────────────
// For a PUBLISHED dashboard this resolves the analysis it was snapshotted from.
// For a LEGACY standalone one it performs the implicit wrap (§4 of
// docs/analysis/00-model.md) — a WRITE, and therefore only ever on this explicit
// user action, never on a list or a read. The wrap is one-way: from then on the
// dashboard is a snapshot and edits happen in the analysis.
async function handleOpenAnalysisForDashboard(): Promise<void> {
  if (!currentProjectId || !dashCurrent || dashMode !== 'dashboard') return;
  const dashboardId = String(dashCurrent.id);
  const legacy = !dashCurrent.analysisId;
  if (legacy && !window.confirm('Editing moves to an analysis: this dashboard becomes a published snapshot, and changes reach it when you publish again. This cannot be undone. Continue?')) return;
  let res: any;
  try {
    res = await window.hub.analysisForDashboard(currentProjectId, dashboardId);
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.analysis) {
    window.alert((res && res.error) || 'Could not open the analysis for this dashboard.');
    return;
  }
  closeDashboardEditor();
  selectSection('analyses');
  anLastPublishedName = null;
  openAnalysisFrom(res.analysis);
}

// ── Boot wiring (once) ──────────────────────────────────────────────────────
function initAnalyses(): void {
  const newBtn = dashEl('an-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => handleNewAnalysis());
  const draftBtn = dashEl('an-draft-btn');
  if (draftBtn) draftBtn.addEventListener('click', () => handleDraftAnalysis());
  const pub = dashEl('an-publish-btn');
  if (pub) pub.addEventListener('click', () => handlePublishAnalysis(false));
  const republish = dashEl('an-republish-btn');
  if (republish) republish.addEventListener('click', () => handlePublishAnalysis(true));
  const openAn = dashEl('dash-open-analysis');
  if (openAn) openAn.addEventListener('click', () => handleOpenAnalysisForDashboard());
  const wrap = dashEl('dash-legacy-wrap-btn');
  if (wrap) wrap.addEventListener('click', () => handleOpenAnalysisForDashboard());
}
