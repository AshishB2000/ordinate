// The Report builder — the three-pane editor for one Report record.
//
// Thin by design: everything that resolves a page, captures a chart, writes a
// sentence or produces a file lives in reportRender.ts / reportWriters.ts /
// src/ipc/reports.ts. This file moves state between the record and the DOM, and
// owns the scheduled run's driver (reportsRunDue) because the rendering it
// drives is all here in the renderer. The Reports TAB is reportList.ts.
//
// Loads after dashShare.js and reportRender.js: it calls `buildReportPages`,
// `renderPreviewPage`, `reportBytes` and `effectiveFilters`, all at call time.
//
// THREE PANES, the app's usual rhythm: the page list (reorder, include, add),
// the live preview at true page size, and the settings. At 1000px the settings
// pane collapses (hub.css) — the preview is the part that has to stay readable.

let rbReport: any = null;
let rbAnalysis: any = null;
let rbSelected = 0;
/** The app's sentence for the page on screen, so "Reset to app caption" has
 *  something to show once the author has overwritten it. */
let rbAppCaption = '';
let rbDirty = false;
/** Bumped on every preview request; a slow capture whose page is no longer
 *  selected drops its own result instead of painting over the new one. */
let rbPreviewSeq = 0;

function rbEl(id: string): HTMLElement | null { return document.getElementById(id); }
function rbInput(id: string): HTMLInputElement | null { return document.getElementById(id) as HTMLInputElement | null; }
function rbSelect(id: string): HTMLSelectElement | null { return document.getElementById(id) as HTMLSelectElement | null; }

/**
 * The filters a report prints under.
 *
 * When the builder was opened from the dashboard that is still on screen, the
 * filter bar's LIVE selections apply — that is the slice the author is looking
 * at, and the cover says so. Otherwise (the Reports tab, a scheduled run) only
 * the analysis's own stored filters do: there is no reader to have made a
 * selection, and inventing one would print a figure nobody asked for.
 */
function rbFilters(): any[] {
  if (dashCurrent && rbAnalysis && dashCurrent.id === rbAnalysis.id) return effectiveFilters();
  return (rbAnalysis && Array.isArray(rbAnalysis.filters)) ? rbAnalysis.filters : [];
}

/** The parameters a report prints under — the same live-or-saved rule as rbFilters. */
function rbParams(): any[] {
  if (dashCurrent && rbAnalysis && dashCurrent.id === rbAnalysis.id) return dashParamPayload();
  const list = rbAnalysis && Array.isArray(rbAnalysis.parameters) ? rbAnalysis.parameters : [];
  return list.map((p: any) => ({ name: p.name, kind: p.kind, value: p.value, min: p.min, max: p.max }));
}

function rbContext(report?: any): any {
  return { projectId: currentProjectId, analysis: rbAnalysis, filters: rbFilters(), report: report || rbReport, params: rbParams() };
}

// ── page list ────────────────────────────────────────────────────────────────

const RB_KIND_LABEL: Record<string, string> = {
  cover: 'Cover', summary: 'Summary', sheet: 'Sheet', tile: 'Tile',
  notes: 'Notes', narrative: 'Narrative',
};

/** What the row under the page's kind says — enough to tell two Tile pages
 *  apart without opening them. */
function rbPageSubtitle(page: any): string {
  if (page.kind === 'sheet') {
    const s = (rbAnalysis.sheets || [])[Number(page.sheetIdx) || 0];
    return s ? (s.name || 'Sheet') : 'Missing sheet';
  }
  if (page.kind === 'tile') {
    const card = rbFindCard(page.cardId);
    return card ? (rbCardName(card) || 'Tile') : 'No longer on the dashboard';
  }
  if (page.kind === 'notes') return (page.notes || '').slice(0, 40) || 'Empty';
  return '';
}

function rbFindCard(cardId: string): any {
  for (const sheet of (rbAnalysis.sheets || [])) {
    for (const card of (sheet.cards || [])) if (card && card.id === cardId) return card;
  }
  return null;
}

/** A card's name for a list row or a menu row. */
function rbCardName(card: any): string {
  if (card.visual && card.visual.name) return card.visual.name;
  return card._rbName || 'Chart';
}

/**
 * Resolve every visual card's TITLE once, when the builder opens.
 *
 * Without this the page list reads "Tile / Chart" three times over, which tells
 * the author nothing about which chart each page holds — and a visual card
 * stores only a `visualId`, so the name is one fetch away and not in the record.
 * Cached on the card as `_rbName`; the resolve is per-visual, not per-card, so a
 * dashboard showing one visual twice costs one call.
 */
async function rbResolveCardNames(): Promise<void> {
  if (!rbAnalysis || !currentProjectId) return;
  const seen = new Map<string, string>();
  for (const sheet of (rbAnalysis.sheets || [])) {
    for (const card of (sheet.cards || [])) {
      if (!card || card.type !== 'visual' || !card.visualId || card._rbName) continue;
      if (!seen.has(card.visualId)) {
        let name = '';
        try {
          const v = await window.hub.getVisual(currentProjectId, card.visualId);
          name = (v && v.name) || '';
        } catch (_) { name = ''; }
        seen.set(card.visualId, name);
      }
      const resolved = seen.get(card.visualId);
      if (resolved) card._rbName = resolved;
    }
  }
}

function rbRenderPageList(): void {
  const list = rbEl('rp-page-list');
  if (!list || !rbReport) return;
  list.textContent = '';
  rbReport.pages.forEach((page: any, i: number) => {
    const li = document.createElement('li');
    li.className = 'rb-page' + (i === rbSelected ? ' is-active' : '') + (page.include === false ? ' is-off' : '');
    li.draggable = true;
    li.dataset.idx = String(i);

    const inc = document.createElement('input');
    inc.type = 'checkbox';
    inc.className = 'rb-page-inc';
    inc.checked = page.include !== false;
    inc.setAttribute('aria-label', 'Include this page');
    inc.addEventListener('change', () => {
      page.include = inc.checked;
      rbMarkDirty();
      rbRenderPageList();
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rb-page-btn';
    const k = document.createElement('span');
    k.className = 'rb-page-kind';
    k.textContent = RB_KIND_LABEL[page.kind] || page.kind;
    btn.appendChild(k);
    const sub = rbPageSubtitle(page);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'rb-page-sub';
      s.textContent = sub;
      btn.appendChild(s);
    }
    btn.addEventListener('click', () => rbSelectPage(i));

    li.appendChild(inc);
    li.appendChild(btn);
    // Cover and Summary are the report's frame; every other page can go.
    if (page.kind !== 'cover') {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rb-page-del';
      del.textContent = '×';
      del.title = 'Remove this page';
      del.setAttribute('aria-label', 'Remove this page');
      del.addEventListener('click', () => {
        rbReport.pages.splice(i, 1);
        if (rbSelected >= rbReport.pages.length) rbSelected = Math.max(0, rbReport.pages.length - 1);
        rbMarkDirty();
        rbRenderPageList();
        void rbPreview();
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  });
}

/** Drag to reorder, by delegation — the list rebuilds on every change, so
 *  per-row listeners would have to be re-attached each time. */
function rbInitDrag(list: HTMLElement): void {
  let from = -1;
  list.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest('.rb-page') as HTMLElement | null;
    from = li ? Number(li.dataset.idx) : -1;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => { e.preventDefault(); });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const li = (e.target as HTMLElement).closest('.rb-page') as HTMLElement | null;
    const to = li ? Number(li.dataset.idx) : -1;
    if (from < 0 || to < 0 || from === to || !rbReport) return;
    const moved = rbReport.pages.splice(from, 1)[0];
    rbReport.pages.splice(to, 0, moved);
    rbSelected = to;
    from = -1;
    rbMarkDirty();
    rbRenderPageList();
    void rbPreview();
  });
}

function rbSelectPage(i: number): void {
  rbSelected = i;
  rbRenderPageList();
  void rbPreview();
}

// ── preview ──────────────────────────────────────────────────────────────────

/**
 * Resolve and draw the SELECTED page only.
 *
 * One page, not the whole report: resolving a page captures its charts, and
 * re-capturing every page on every click of the list would make the builder
 * unusable on a dashboard with a dozen tiles. Generate resolves the lot.
 */
async function rbPreview(): Promise<void> {
  const stage = rbEl('rp-stage');
  if (!stage || !rbReport) return;
  const page = rbReport.pages[rbSelected];
  const seq = ++rbPreviewSeq;
  if (!page) { renderPreviewPage(stage, null, rbReport); rbShowCaptionRow(null); return; }
  stage.classList.add('is-loading');
  let rp: any = null;
  try {
    const one = { ...rbReport, pages: [{ ...page, include: true }] };
    const built = await buildReportPages(rbContext(one));
    rp = built[0] || null;
  } catch (e) {
    console.error('[report] preview failed', e);
  }
  if (seq !== rbPreviewSeq) return; // a newer selection already won
  stage.classList.remove('is-loading');
  renderPreviewPage(stage, rp, rbReport);
  rbShowCaptionRow(rp);
}

/**
 * The caption editor under the preview.
 *
 * `rbAppCaption` is what the app WOULD say for this page; the textarea shows
 * the author's override when there is one. Resolving the app's sentence fresh
 * each time is what keeps "Reset to app caption" honest as the data moves.
 */
function rbShowCaptionRow(rp: any): void {
  const row = rbEl('rp-caption-row');
  const box = document.getElementById('rp-caption') as HTMLTextAreaElement | null;
  const reset = rbEl('rp-caption-reset');
  const page = rbReport && rbReport.pages[rbSelected];

  // A Notes page has no caption — it IS prose — so the same strip under the
  // preview becomes its editor rather than the page growing a second one.
  const notesRow = rbEl('rp-notes-row');
  const notes = document.getElementById('rp-notes') as HTMLTextAreaElement | null;
  const isNotes = !!page && page.kind === 'notes';
  if (notesRow) notesRow.hidden = !isNotes;
  if (isNotes && notes) notes.value = page.notes || '';

  const captionable = !isNotes && !!rp && (rp.kind === 'tile' || rp.kind === 'sheet' || rp.kind === 'summary');
  if (row) row.hidden = !captionable;
  if (!captionable || !box || !page) return;
  // buildReportPages already applied the override, so the app's own sentence is
  // only visible when there is none — cache it then, and keep the last one.
  if (!page.caption) rbAppCaption = rp.caption || '';
  box.value = page.caption || rp.caption || '';
  if (reset) reset.hidden = !page.caption;
}

// ── settings ─────────────────────────────────────────────────────────────────

function rbLoadSettings(): void {
  if (!rbReport) return;
  const set = (id: string, v: string) => { const el = rbInput(id) || rbSelect(id); if (el) (el as any).value = v; };
  const check = (id: string, v: boolean) => { const el = rbInput(id); if (el) el.checked = v; };
  set('rp-set-name', rbReport.name || '');
  set('rp-set-format', rbReport.format || 'pdf');
  set('rp-set-title', (rbReport.cover && rbReport.cover.title) || '');
  set('rp-set-subtitle', (rbReport.cover && rbReport.cover.subtitle) || '');
  check('rp-set-logo', !(rbReport.cover && rbReport.cover.logo === false));
  set('rp-set-paper', (rbReport.paper && rbReport.paper.size) || 'letter');
  set('rp-set-orient', (rbReport.paper && rbReport.paper.orientation) || 'portrait');
  check('rp-set-filters', rbReport.includeFilters !== false);
  check('rp-set-narrative', rbReport.narrative === true);
  const sch = rbReport.schedule || { cadence: 'off', at: '09:00', folder: '' };
  set('rp-set-cadence', sch.cadence);
  set('rp-set-at', sch.at);
  const folder = rbEl('rp-set-folder-path');
  if (folder) folder.textContent = sch.folder || 'No folder chosen';
  rbSyncSettingsVisibility();
}

/** Paper only means something on paper, a schedule's time and folder only when
 *  there is a cadence, and Narrative only with a model configured. */
function rbSyncSettingsVisibility(): void {
  const isPptx = (rbSelect('rp-set-format') || {} as any).value === 'pptx';
  const paperRow = rbEl('rp-paper-row');
  if (paperRow) paperRow.hidden = isPptx;
  const note = rbEl('rp-paper-note');
  if (note) note.hidden = !isPptx;
  const cadence = (rbSelect('rp-set-cadence') || {} as any).value;
  const schedRow = rbEl('rp-schedule-rows');
  if (schedRow) schedRow.hidden = !cadence || cadence === 'off';
}

function rbReadSettings(): void {
  if (!rbReport) return;
  const val = (id: string) => { const el = rbInput(id) || rbSelect(id); return el ? String((el as any).value || '') : ''; };
  const on = (id: string) => { const el = rbInput(id); return !!(el && el.checked); };
  rbReport.name = val('rp-set-name').trim() || rbReport.name;
  rbReport.format = val('rp-set-format') || 'pdf';
  rbReport.cover = { title: val('rp-set-title').trim() || rbReport.name, subtitle: val('rp-set-subtitle').trim(), logo: on('rp-set-logo') };
  rbReport.paper = { size: val('rp-set-paper') || 'letter', orientation: val('rp-set-orient') || 'portrait' };
  rbReport.includeFilters = on('rp-set-filters');
  rbReport.narrative = on('rp-set-narrative');
  const cadence = val('rp-set-cadence') || 'off';
  const folderEl = rbEl('rp-set-folder-path');
  const folder = folderEl && folderEl.dataset.path ? folderEl.dataset.path : (rbReport.schedule && rbReport.schedule.folder) || '';
  rbReport.schedule = { cadence, at: val('rp-set-at') || '09:00', folder };
  // The Narrative page is a PAGE, so the toggle adds or removes one rather than
  // living only as a flag the writers would have to re-interpret.
  const hasNarrative = rbReport.pages.some((p: any) => p.kind === 'narrative');
  if (rbReport.narrative && !hasNarrative) {
    rbReport.pages.push({ id: rbUuid(), kind: 'narrative', include: true, layout: 'full' });
  } else if (!rbReport.narrative && hasNarrative) {
    rbReport.pages = rbReport.pages.filter((p: any) => p.kind !== 'narrative');
    if (rbSelected >= rbReport.pages.length) rbSelected = Math.max(0, rbReport.pages.length - 1);
  }
}

/** dashUuid (dashGrid.ts) is the hub's id generator; this is only a guard for
 *  the load order, never a second implementation. */
function rbUuid(): string {
  return typeof dashUuid === 'function' ? dashUuid() : String(Math.random()).slice(2);
}

function rbMarkDirty(): void {
  rbDirty = true;
  const save = rbEl('rp-save');
  if (save) save.textContent = 'Save';
  const badge = rbEl('rp-dirty');
  if (badge) badge.hidden = false;
}

// ── open / save / generate ───────────────────────────────────────────────────

/** Dashboard ⋯ → "Create report…". Creates the default report for the OPEN
 *  dashboard (main builds the page list from its sheets) and opens the builder. */
async function rbCreateForOpenDashboard(): Promise<void> {
  if (!currentProjectId || !dashCurrent || !dashCurrent.id) {
    window.alert('Open a dashboard first.');
    return;
  }
  if (dashDirty) await persistDashboard(); // print what is on disk, not a stale copy
  showToast('Creating report…');
  const res = await window.hub.reportsCreate(currentProjectId, dashCurrent.id);
  if (!res || res.ok === false) { showToast((res && res.error) || 'Could not create the report'); return; }
  await rbOpen(res.report);
}

/** Open a report by id — the Reports tab's Edit, and Home's Recent row. */
async function rbOpenReportById(id: string): Promise<void> {
  if (!currentProjectId) return;
  const report = await window.hub.reportsGet(currentProjectId, id);
  if (!report) { showToast('That report is gone'); return; }
  if (typeof selectSection === 'function') selectSection('analyses');
  await rbOpen(report);
}

async function rbOpen(report: any): Promise<void> {
  rbReport = report;
  rbSelected = 0;
  rbDirty = false;
  rbAnalysis = await window.hub.getAnalysis(currentProjectId as string, report.analysisId);
  if (!rbAnalysis) {
    showToast('The dashboard this report prints has been deleted');
    rbAnalysis = { id: report.analysisId, name: report.name, sheets: [], filters: [], style: {} };
  }
  closeDashboardEditor();
  dashShow('an-list-view', false);
  dashShow('rp-builder', true);
  const badge = rbEl('rp-dirty');
  if (badge) badge.hidden = true;
  rbLoadSettings();
  rbRenderPageList();
  // Names first, then repaint: the list is cheap to draw twice and painting it
  // once after the fetch would leave the pane empty for the whole round trip.
  await rbResolveCardNames();
  rbRenderPageList();
  await rbPreview();
}

function rbClose(): void {
  rbReport = null;
  rbAnalysis = null;
  dashShow('rp-builder', false);
  dashShow('an-list-view', true);
  void rbRefreshList();
  // tabNav.ts — the report's tab goes dark with the page (rbOpen reaches the
  // tabs through closeDashboardEditor's dkSync; closing reaches nothing else).
  if (typeof tabsSync === 'function') tabsSync();
}

async function rbSave(): Promise<boolean> {
  if (!rbReport || !currentProjectId) return false;
  rbReadSettings();
  const res = await window.hub.reportsUpdate(currentProjectId, rbReport.id, {
    name: rbReport.name, format: rbReport.format, pages: rbReport.pages,
    cover: rbReport.cover, paper: rbReport.paper,
    includeFilters: rbReport.includeFilters, narrative: rbReport.narrative,
    schedule: rbReport.schedule,
  });
  if (!res || res.ok === false) { showToast((res && res.error) || 'Could not save'); return false; }
  // Take main's clamped copy back: the record on disk is the sanitized one, and
  // keeping the unsanitized in-memory copy is how the two quietly diverge.
  rbReport = res.report;
  rbDirty = false;
  const badge = rbEl('rp-dirty');
  if (badge) badge.hidden = true;
  rbRenderPageList();
  return true;
}

/**
 * Build the whole report and save it through the native panel.
 *
 * Saves the record first: the file is generated from `rbReport`, and a
 * generated file whose settings were never written would not be reproducible
 * by the schedule that prints the same report tomorrow.
 */
async function rbGenerate(): Promise<void> {
  if (!rbReport || !currentProjectId) return;
  if (!(await rbSave())) return;
  const ctx = rbContext();
  if (!(await pvShareGate('report', await pvCardDatasetIds(ctx.analysis)))) return;
  showToast('Building report…');
  const report = rbReport;
  const projectId = currentProjectId;
  // A job (jobsPanel.ts rjRun): the Jobs popover shows it building, Cancel stops
  // it between stages, and Reveal opens the file main wrote.
  let failed = '';
  const out = await rjRun('report', `Report · ${report.name || 'Untitled'}`, projectId, async (step) => {
    await step(0.05, 'Laying out the pages');
    const pages = await buildReportPages(ctx);
    if (!pages.length) { failed = 'Every page is excluded — nothing to generate'; return null; }
    await step(0.6, `Writing ${pages.length} page${pages.length === 1 ? '' : 's'}`);
    const { base64, ext } = await reportBytes(pages, report);
    if (!base64) { failed = 'Couldn’t build the report'; return null; }
    await step(0.9, 'Saving');
    const res = await window.hub.reportsSaveAs(projectId, report.id, base64, ext);
    if (res && res.ok) return { path: String(res.dest), message: String(res.dest).split(/[\\/]/).pop() };
    if (!res || !res.canceled) failed = (res && res.error) || 'Save failed';
    return null;
  }).catch((e: any) => { failed = String((e && e.message) || 'Couldn’t build the report'); return null; });
  if (out && out.path) {
    showToast('Saved: ' + out.message);
    void window.hub.reportsReveal(projectId, report.id);
  } else if (failed) {
    showToast(failed);
  }
}

/**
 * Generate every report that is due — the scheduled path.
 *
 * Main decides WHAT is due and writes the bytes; this drives the rendering in
 * between, because the chart engine and the document libraries are here. Reports
 * run one at a time: each one captures charts through shared offscreen holders,
 * and two in flight would contend for them.
 *
 * `nowMs` is threaded all the way to the filename and the lastRunAt stamp, so a
 * faked clock produces a correctly dated file — which is how smoke-reports.ts
 * tests a daily schedule without waiting a day.
 */
async function reportsRunDue(nowMs?: number): Promise<number> {
  let due: any[] = [];
  try {
    due = await window.hub.reportsDue(nowMs);
  } catch (_) { return 0; }
  if (!Array.isArray(due) || !due.length) return 0;
  let written = 0;
  for (const d of due) {
    try {
      const report = await window.hub.reportsGet(d.projectId, d.id);
      if (!report) continue;
      const analysis = await window.hub.getAnalysis(d.projectId, report.analysisId);
      if (!analysis) continue;
      // A SILENT job: the Jobs popover shows the scheduled run, but main's own
      // "Report ready" notification (notifyFile) is the one the user gets.
      const out = await rjRun('report', `Scheduled report · ${report.name || 'Untitled'}`, d.projectId, async (step) => {
        await step(0.05, 'Laying out the pages');
        const pages = await buildReportPages({
          projectId: d.projectId, analysis,
          filters: Array.isArray(analysis.filters) ? analysis.filters : [],
          report,
        });
        if (!pages.length) return null;
        await step(0.6, 'Writing the document');
        const { base64 } = await reportBytes(pages, report);
        if (!base64) return null;
        await step(0.9, 'Saving');
        const res = await window.hub.reportsWriteScheduled(d.projectId, d.id, base64, nowMs);
        return res && res.ok ? { path: String(res.dest || ''), message: 'Written to the report folder' } : null;
      }, { silent: true });
      if (out) written++;
    } catch (e) {
      // One report that cannot be built must not stop the rest, and a schedule
      // that throws every minute is worse than one that quietly skips.
      console.error('[report] scheduled run failed', e);
    }
  }
  if (written && currentProjectId) void rbRefreshList();
  return written;
}

// ── boot wiring (once) ───────────────────────────────────────────────────────

function initReportBuilder(): void {
  const dashTab = rbEl('rp-tab-dashboards');
  if (dashTab) dashTab.addEventListener('click', () => rbSelectTab('dashboards'));
  const repTab = rbEl('rp-tab-reports');
  if (repTab) repTab.addEventListener('click', () => rbSelectTab('reports'));

  const back = rbEl('rp-back');
  if (back) {
    back.addEventListener('click', async () => {
      if (rbDirty && !window.confirm('Discard unsaved changes to this report?')) return;
      rbClose();
    });
  }
  const save = rbEl('rp-save');
  if (save) save.addEventListener('click', async () => { if (await rbSave()) showToast('Report saved'); });
  const gen = rbEl('rp-generate');
  if (gen) gen.addEventListener('click', () => void rbGenerate());

  const list = rbEl('rp-page-list');
  if (list) rbInitDrag(list);

  const addNotes = rbEl('rp-add-notes');
  if (addNotes) {
    addNotes.addEventListener('click', () => {
      if (!rbReport) return;
      rbReport.pages.push({ id: rbUuid(), kind: 'notes', notes: '', include: true, layout: 'full' });
      rbSelected = rbReport.pages.length - 1;
      rbMarkDirty();
      rbRenderPageList();
      void rbPreview();
    });
  }
  const addTile = rbEl('rp-add-tile');
  if (addTile) addTile.addEventListener('click', () => rbPickTile(addTile));

  // The caption editor. Typing stores an override ON THE PAGE; clearing it
  // removes the override rather than storing an empty string, so the page goes
  // back to following the app's sentence as the data moves.
  const caption = document.getElementById('rp-caption') as HTMLTextAreaElement | null;
  if (caption) {
    caption.addEventListener('input', () => {
      const page = rbReport && rbReport.pages[rbSelected];
      if (!page) return;
      const v = caption.value;
      if (v.trim() && v !== rbAppCaption) page.caption = v; else delete page.caption;
      const reset = rbEl('rp-caption-reset');
      if (reset) reset.hidden = !page.caption;
      rbMarkDirty();
    });
  }
  const reset = rbEl('rp-caption-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      const page = rbReport && rbReport.pages[rbSelected];
      if (!page) return;
      delete page.caption;
      rbMarkDirty();
      void rbPreview();
    });
  }
  // Notes text lives on the page, and the preview is the only place to type it.
  const notes = document.getElementById('rp-notes') as HTMLTextAreaElement | null;
  if (notes) {
    notes.addEventListener('input', () => {
      const page = rbReport && rbReport.pages[rbSelected];
      if (!page || page.kind !== 'notes') return;
      page.notes = notes.value;
      rbMarkDirty();
    });
  }

  // Settings: every control writes the record and repaints. `change` rather
  // than `input` on the text fields keeps the preview off the keystroke path.
  const SETTINGS = ['rp-set-name', 'rp-set-format', 'rp-set-title', 'rp-set-subtitle', 'rp-set-logo',
    'rp-set-paper', 'rp-set-orient', 'rp-set-filters', 'rp-set-narrative', 'rp-set-cadence', 'rp-set-at'];
  for (const id of SETTINGS) {
    const el = rbInput(id) || rbSelect(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      rbReadSettings();
      rbSyncSettingsVisibility();
      rbMarkDirty();
      rbRenderPageList();
      void rbPreview();
    });
  }
  const pick = rbEl('rp-set-folder');
  if (pick) {
    pick.addEventListener('click', async () => {
      const res = await window.hub.reportsPickFolder();
      if (!res || !res.ok) return;
      const label = rbEl('rp-set-folder-path');
      if (label) { label.textContent = res.folder; label.dataset.path = res.folder; }
      rbReadSettings();
      rbMarkDirty();
    });
  }

  // Main rings the bell at the end of the refresh tick; the hub does the work.
  if (window.hub && typeof window.hub.onReportsRunDue === 'function') {
    window.hub.onReportsRunDue(() => { void reportsRunDue(Date.now()); });
  }
  rbSelectTab('dashboards');
}

/** "+ Tile" — pick one of the dashboard's chart cards. */
function rbPickTile(anchor: HTMLElement): void {
  if (!rbReport || !rbAnalysis) return;
  const cards: any[] = [];
  for (const sheet of (rbAnalysis.sheets || [])) {
    for (const card of (sheet.cards || [])) if (card && card.type === 'visual') cards.push(card);
  }
  if (!cards.length) { showToast('This dashboard has no charts yet'); return; }
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    cards.forEach((card, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chart-menu-item';
      row.textContent = rbCardName(card) === 'Chart' ? 'Chart ' + (i + 1) : rbCardName(card);
      row.addEventListener('click', () => {
        close();
        rbReport.pages.push({ id: rbUuid(), kind: 'tile', cardId: card.id, include: true, layout: 'full' });
        rbSelected = rbReport.pages.length - 1;
        rbMarkDirty();
        rbRenderPageList();
        void rbPreview();
      });
      menu.appendChild(row);
    });
  });
}
