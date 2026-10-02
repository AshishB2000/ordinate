'use strict';

// What the app can be told to do — the registry's contents (the machinery is
// commands.ts).
//
// Every entry calls the SAME function the button beside it calls. Nothing here
// re-implements a flow: a command that opened its own import dialog would be a
// second import dialog to keep working, and the first bug report would be that
// the two disagree. Where a command needs a different shape than the click
// handler has, the shape is fixed in the surface and both callers get it.
//
// `when()` is what makes one flat list context-aware: "Add a metric" is not
// hidden by the palette, it is absent because there is no dashboard open.
//
// Classic global-scope renderer <script>: no import/export. Loads AFTER every
// surface it calls into, and BEFORE palette.js reads the registry.

// ── Context predicates ───────────────────────────────────────────────────────
// One definition each, because "is a dashboard open?" answered two ways is how
// a command ends up visible and inert.

function cmdHasProject(): boolean {
  return !!currentProjectId;
}

/** A dataset is open in the explorer AND the Data section is the one showing. */
function cmdDatasetOpen(): boolean {
  return currentSection === 'datasets' && typeof expId === 'string' && !!expId;
}

/** The dashboard EDITOR — not the list, and not a published read-only snapshot. */
function cmdDashboardOpen(): boolean {
  if (!dashCurrent || dashReadOnly) return false;
  const ed = document.getElementById('dash-editor') as HTMLElement | null;
  return !!ed && !ed.hidden;
}

function cmdVisualBuilderOpen(): boolean {
  return currentSection === 'visuals' && typeof vizDatasetId === 'string' && !!vizDatasetId;
}

/** The record the Assistant would answer about, if any (dock.ts owns the rule). */
function cmdContextRef(): { kind: string; id: string; label: string; name: string } {
  return typeof dkContextRef === 'function'
    ? dkContextRef()
    : { kind: '', id: '', label: t('common.whole_project'), name: '' };
}

// ── Small shared actions ─────────────────────────────────────────────────────

/**
 * Go to a section, resolving (or creating) a project first where one is needed.
 *
 * An OPEN analysis is closed on the way out, and that is not tidiness: authoring
 * one puts the app in focus mode (body.an-focus), which hides the sidebar, and
 * "‹ Back" in the editor head was the only way out because nothing else could
 * navigate. ⌘1 can — so without this it lands you on Home with no rail and no
 * obvious way to get it back. Same call the Back button makes, so a dirty
 * dashboard is still persisted first.
 */
async function cmdGoto(section: string): Promise<void> {
  if (section !== 'analyses' && dashCurrent && typeof handleBackToList === 'function') {
    await handleBackToList();
  }
  if (section !== 'home' && !currentProjectId && typeof resolveProjectId === 'function') {
    await resolveProjectId();
  }
  selectSection(section);
}

/** Open the Data section, then start an import there. */
async function cmdImport(mode: 'file' | 'paste'): Promise<void> {
  await cmdGoto('datasets');
  openImportDialog(mode);
}

/** Make sure the Assistant is open, and put the caret where a question goes. */
function cmdOpenDock(): void {
  if (typeof dkAllowed === 'function' && !dkAllowed()) return;
  if (typeof dkIsOpen === 'function' && !dkIsOpen()) dkToggle();
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (input && !input.disabled) input.focus();
}

/**
 * The SHORTCUT is a toggle, because the dock is a panel and a panel's key has
 * to put it away again — ⌘L has always closed it, and the button beside it
 * carries aria-expanded for the same reason. `cmdOpenDock` above is the
 * ensure-open half, which is what "New conversation" and "Ask about this" want.
 */
function cmdToggleDock(): void {
  const wasOpen = typeof dkIsOpen === 'function' && dkIsOpen();
  dkToggle();
  if (!wasOpen) cmdOpenDock();
}

/** Move to another page of the open dashboard. dashGrid.ts owns the repaint. */
function cmdDashPage(delta: number): void {
  const pages = (dashCurrent && dashCurrent.pages) || [];
  if (pages.length < 2) return;
  dashPageIdx = (dashPageIdx + delta + pages.length) % pages.length;
  renderDashPages();
  renderDashGrid();
}

function cmdOpenLink(url: string): void {
  if (window.hub && typeof window.hub.openExternal === 'function') window.hub.openExternal(url);
}

/** webFrame zoom, through the preload bridge — the page's own scale, kept by Electron. */
function cmdZoom(step: number | null): void {
  const bridge = window.hub as any;
  if (bridge && typeof bridge.setZoom === 'function') bridge.setZoom(step);
}

// ── The list ─────────────────────────────────────────────────────────────────

function registerAppCommands(): void {
  // ── Navigate ───────────────────────────────────────────────────────────────
  registerCommand({ id: 'nav.home', title: t('commandDefs.go_to_home'), group: t('common.navigate'), icon: 'home', keys: 'mod+1', run: () => cmdGoto('home') });
  registerCommand({ id: 'nav.data', title: t('commandDefs.go_to_data'), group: t('common.navigate'), icon: 'database', keys: 'mod+2', run: () => cmdGoto('datasets') });
  registerCommand({ id: 'nav.visuals', title: t('commandDefs.go_to_visuals'), group: t('common.navigate'), icon: 'columns', keys: 'mod+3', run: () => cmdGoto('visuals') });
  registerCommand({ id: 'nav.dashboards', title: t('commandDefs.go_to_dashboards'), group: t('common.navigate'), icon: 'grid', keys: 'mod+4', run: () => cmdGoto('analyses') });
  registerCommand({ id: 'nav.connect', title: t('commandDefs.go_to_connect_a_source'), group: t('common.navigate'), icon: 'plug', run: () => cmdGoto('connect') });
  registerCommand({ id: 'nav.settings', title: t('common.settings'), group: t('common.navigate'), icon: 'settings', keys: 'mod+,', run: () => showSettingsPanel() });

  // ── Create ─────────────────────────────────────────────────────────────────
  registerCommand({ id: 'create.import', title: t('commandDefs.new_dataset_from_a_file'), group: t('common.create'), icon: 'upload', keys: 'mod+i', run: () => cmdImport('file') });
  registerCommand({ id: 'create.paste', title: t('commandDefs.new_dataset_from_pasted_text'), group: t('common.create'), icon: 'clipboard', run: () => cmdImport('paste') });
  registerCommand({ id: 'create.connect', title: t('commandDefs.new_dataset_from_a_connection'), group: t('common.create'), icon: 'plug', run: () => cmdGoto('connect') });
  registerCommand({ id: 'create.capture', title: t('commandDefs.new_dataset_from_a_screenshot'), group: t('common.create'), icon: 'camera', run: () => doCapture() });
  registerCommand({ id: 'create.visual', title: t('common.new_visual'), group: t('common.create'), icon: 'columns', keys: 'mod+shift+n', run: () => handleNewVisual() });
  registerCommand({ id: 'create.dashboard', title: t('common.new_dashboard'), group: t('common.create'), icon: 'grid', keys: 'mod+n', run: () => anCreateWizard() });
  registerCommand({
    id: 'create.dashboardFromTemplate',
    title: t('commandDefs.new_dashboard_from_a_template'),
    group: t('common.create'),
    icon: 'layers',
    // The wizard's step 2 IS the template gallery, but it can only be opened on
    // a dataset the user has already picked — so with one open we skip ahead,
    // and without one the wizard asks for it first, as it does from anywhere else.
    run: () => (cmdDatasetOpen() ? anCreateWizard(expId, { step: 2 }) : anCreateWizard()),
  });

  // ── Data (a dataset is open) ───────────────────────────────────────────────
  registerCommand({ id: 'data.prepare', title: t('commandDefs.prepare_this_dataset'), group: t('common.data'), icon: 'sliders', when: cmdDatasetOpen, run: () => togglePreparePanel() });
  registerCommand({
    id: 'data.addStep',
    title: t('commandDefs.add_a_prepare_step'),
    group: t('common.data'),
    icon: 'plus',
    when: cmdDatasetOpen,
    // The panel first: the step editor opens INSIDE it, and an editor in a
    // collapsed panel is an invisible dialog.
    run: () => { togglePreparePanel(); (document.getElementById('ds-step-add') as HTMLElement | null)?.click(); },
  });
  registerCommand({
    id: 'data.calcField',
    title: t('commandDefs.add_a_calculated_field'),
    group: t('common.data'),
    icon: 'zap',
    when: cmdDatasetOpen,
    run: () => { togglePreparePanel(); openStepEditor('calculated_field', -1); },
  });
  registerCommand({
    id: 'data.profile',
    title: t('commandDefs.profile_a_column'),
    group: t('common.data'),
    icon: 'eye',
    when: cmdDatasetOpen,
    // Which column is the question, so this re-opens the palette scoped to the
    // open dataset's columns rather than guessing one.
    run: () => paletteOpen('@'),
  });
  registerCommand({ id: 'data.refresh', title: t('commandDefs.refresh_this_dataset'), group: t('common.data'), icon: 'refresh', when: cmdDatasetOpen, run: () => { void handleRefreshDataset(expId, null, null); } });
  registerCommand({ id: 'data.history', title: t('common.pipeline_history'), group: t('common.data'), icon: 'history', when: cmdDatasetOpen, run: () => { void vhOpen('dataset', expId, expName); } });
  registerCommand({ id: 'data.lineage', title: t('commandDefs.show_lineage'), group: t('common.data'), icon: 'lineage', when: cmdDatasetOpen, run: () => { void lnOpen('dataset', expId, expName); } });
  // Find segments (segments.ts) — the same page the dataset's ⋯ menu opens.
  registerCommand({ id: 'data.segments', title: t('commandDefs.find_segments_in_this_dataset'), group: t('common.data'), icon: 'layers', when: cmdDatasetOpen, run: () => { void sgOpen(expId, expName); } });
  registerCommand({ id: 'data.rfm', title: t('commandDefs.score_customers_rfm'), group: t('common.data'), icon: 'user', when: cmdDatasetOpen, run: () => { void sgOpen(expId, expName, 'rfm'); } });

  // ── Visual ─────────────────────────────────────────────────────────────────
  registerCommand({
    id: 'visual.fromDataset',
    title: t('commandDefs.new_visual_from_this_dataset'),
    group: 'Visual',
    icon: 'columns',
    when: cmdDatasetOpen,
    run: () => handleNewVisual({ datasetId: expId }),
  });
  registerCommand({ id: 'visual.save', title: t('commandDefs.save_this_visual'), group: 'Visual', icon: 'check', when: cmdVisualBuilderOpen, run: () => handleSaveVisual() });
  registerCommand({ id: 'visual.suggest', title: t('common.suggest_a_visual'), group: 'Visual', icon: 'sparkles', when: cmdVisualBuilderOpen, run: () => handleSuggestVisual() });
  registerCommand({ id: 'visual.history', title: t('common.version_history'), group: 'Visual', icon: 'history', when: () => cmdVisualBuilderOpen() && !!vizEditingId, run: () => { document.getElementById('viz-history-btn')?.click(); } });
  registerCommand({ id: 'visual.lineage', title: t('commandDefs.show_lineage'), group: 'Visual', icon: 'lineage', when: () => cmdVisualBuilderOpen() && !!vizEditingId, run: () => { void lnOpen('visual', vizEditingId, document.getElementById('viz-builder-name')?.textContent || ''); } });

  // ── Dashboard (the editor is open) ─────────────────────────────────────────
  registerCommand({ id: 'dash.addVisual', title: t('common.add_a_visual'), group: t('common.dashboard'), icon: 'columns', when: cmdDashboardOpen, run: () => handleAddVisual() });
  registerCommand({ id: 'dash.addMetric', title: t('common.add_a_metric'), group: t('common.dashboard'), icon: 'zap', when: cmdDashboardOpen, run: () => handleAddMetric() });
  registerCommand({ id: 'dash.addText', title: t('common.add_text'), group: t('common.dashboard'), icon: 'pencil', when: cmdDashboardOpen, run: () => handleAddText() });
  registerCommand({ id: 'dash.addControl', title: t('common.add_a_control'), group: t('common.dashboard'), icon: 'sliders', when: cmdDashboardOpen, run: () => handleAddControl() });
  // ONE history, two editors: ⌘Z walks the open story's stack when a story is
  // open (storyPage.ts keeps it in dashHistory's own structure), else the dashboard's.
  // One undo binding: a dashboard, a story, or an input table's grid (inputPage.ts).
  registerCommand({ id: 'dash.undo', title: t('common.undo'), group: t('common.dashboard'), icon: 'undo', keys: 'mod+z', when: () => cmdDashboardOpen() || stIsOpen() || itIsActive(), run: () => (itIsActive() ? itUndo() : stIsOpen() ? stUndo() : dashUndo()) });
  registerCommand({ id: 'dash.redo', title: t('common.redo'), group: t('common.dashboard'), icon: 'redo', keys: ['mod+shift+z', 'mod+y'], when: () => cmdDashboardOpen() || stIsOpen() || itIsActive(), run: () => (itIsActive() ? itRedo() : stIsOpen() ? stRedo() : dashRedo()) });
  registerCommand({ id: 'story.present', title: t('commandDefs.present_this_story'), group: t('common.dashboard'), icon: 'maximize', when: stIsOpen, run: () => { void stEnterPresent(); } });
  registerCommand({ id: 'story.exportPdf', title: t('commandDefs.export_this_story_as_pdf'), group: t('common.dashboard'), icon: 'download', when: stIsOpen, run: () => { void stExportPdf(); } });
  registerCommand({ id: 'story.new', title: t('common.new_story'), group: t('common.create'), icon: 'file-text', when: () => !!currentProjectId, run: () => { void stNewStory(); } });
  registerCommand({ id: 'dash.save', title: t('common.save'), group: t('common.dashboard'), icon: 'check', keys: 'mod+s', when: cmdDashboardOpen, run: () => handleSaveDashboard() });
  registerCommand({ id: 'dash.present', title: t('common.present'), group: t('common.dashboard'), icon: 'maximize', keys: 'mod+p', when: () => !!dashCurrent, run: () => enterDashPresent() });
  registerCommand({ id: 'dash.history', title: t('common.version_history'), group: t('common.dashboard'), icon: 'history', when: () => !!dashCurrent, run: () => { void vhOpen('dashboard', String(dashCurrent.id), String(dashCurrent.name || '')); } });
  registerCommand({ id: 'dash.lineage', title: t('commandDefs.show_lineage'), group: t('common.dashboard'), icon: 'lineage', when: () => !!dashCurrent, run: () => { void lnOpen('dashboard', String(dashCurrent.id), String(dashCurrent.name || '')); } });
  registerCommand({ id: 'dash.export', title: t('common.export'), group: t('common.dashboard'), icon: 'download', keys: 'mod+e', when: () => !!dashCurrent, run: () => handleDashExport() });
  registerCommand({ id: 'dash.exportPdf', title: t('commandDefs.export_as_pdf'), group: t('common.dashboard'), icon: 'download', when: () => !!dashCurrent, run: () => dashExportAs('pdf') });
  registerCommand({ id: 'dash.exportPng', title: t('commandDefs.export_as_png'), group: t('common.dashboard'), icon: 'download', when: () => !!dashCurrent, run: () => dashExportAs('png') });
  registerCommand({ id: 'dash.exportHtml', title: t('commandDefs.export_as_html'), group: t('common.dashboard'), icon: 'download', when: () => !!dashCurrent, run: () => dashExportAs('html') });
  registerCommand({ id: 'dash.style', title: t('commandDefs.change_the_style_preset'), group: t('common.dashboard'), icon: 'layers', when: cmdDashboardOpen, run: () => handleDashStyle() });
  registerCommand({ id: 'dash.nextPage', title: t('commandDefs.next_page'), group: t('common.dashboard'), icon: 'grid', when: () => !!dashCurrent, run: () => cmdDashPage(1) });
  registerCommand({ id: 'dash.prevPage', title: t('commandDefs.previous_page'), group: t('common.dashboard'), icon: 'grid', when: () => !!dashCurrent, run: () => cmdDashPage(-1) });
  registerCommand({ id: 'dash.clearFilters', title: t('common.clear_filters'), group: t('common.dashboard'), icon: 'filter', when: () => !!dashCurrent && dashFilters().length > 0, run: () => handleClearDashFilters() });

  // ── Assistant ──────────────────────────────────────────────────────────────
  // ⌘L was the dock's own binding before there was a registry; it still works,
  // declared here instead of bound in dock.ts, so the sheet and the menu can see it.
  registerCommand({ id: 'ai.open', title: t('commandDefs.toggle_the_assistant'), group: t('common.assistant'), icon: 'sparkles', keys: ['mod+j', 'mod+l'], run: () => cmdToggleDock() });
  registerCommand({ id: 'ai.new', title: t('common.new_conversation'), group: t('common.assistant'), icon: 'plus', when: cmdHasProject, run: async () => { cmdOpenDock(); await dkNew(); } });
  registerCommand({
    id: 'ai.askAboutThis',
    title: t('commandDefs.ask_about_this'),
    group: t('common.assistant'),
    icon: 'send',
    when: () => !!cmdContextRef().kind,
    // No question is invented for the user: the dock opens on the record and the
    // caret lands in the composer.
    run: () => cmdOpenDock(),
  });

  // ── View ───────────────────────────────────────────────────────────────────
  registerCommand({ id: 'view.palette', title: t('common.command_palette'), group: t('common.view'), icon: 'search', keys: 'mod+k', run: () => paletteOpen('') });
  registerCommand({
    id: 'view.theme',
    title: t('commandDefs.toggle_dark_mode'),
    group: t('common.view'),
    icon: 'eye',
    keys: 'mod+shift+d',
    run: () => setThemePreference(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
  });
  registerCommand({
    id: 'view.sidebar',
    title: t('commandDefs.toggle_the_sidebar'),
    group: t('common.view'),
    icon: 'list',
    run: () => { document.body.classList.toggle('no-sidebar'); },
  });
  registerCommand({ id: 'view.zoomIn', title: t('commandDefs.zoom_in'), group: t('common.view'), icon: 'plus', keys: 'mod+=', run: () => cmdZoom(1) });
  registerCommand({ id: 'view.zoomOut', title: t('commandDefs.zoom_out'), group: t('common.view'), icon: 'minus', keys: 'mod+-', run: () => cmdZoom(-1) });
  registerCommand({ id: 'view.zoomReset', title: t('commandDefs.reset_zoom'), group: t('common.view'), icon: 'refresh', keys: 'mod+0', run: () => cmdZoom(null) });
  registerCommand({ id: 'view.escape', title: t('commandDefs.close_the_top_most_layer'), group: t('common.view'), icon: 'x', keys: 'escape', run: () => { paletteCloseTop(); } });

  // ── Help ───────────────────────────────────────────────────────────────────
  registerCommand({ id: 'help.shortcuts', title: t('common.keyboard_shortcuts'), group: t('common.help'), icon: 'info', keys: '?', run: () => paletteShowShortcuts() });
  registerCommand({ id: 'help.whatsNew', title: t('common.what_s_new'), group: t('common.help'), icon: 'star', run: () => cmdOpenLink(HELP_LINKS.whatsnew) });
  registerCommand({ id: 'help.report', title: t('commandDefs.report_a_problem'), group: t('common.help'), icon: 'alert', run: () => cmdOpenLink(HELP_LINKS.help) });
}

/**
 * Put registry shortcuts on the controls that already exist.
 *
 * The dashboard header and the dock header printed their own tooltips, so a
 * rebinding left the old key on a button. One helper, one source — and the
 * places that had NO hint gain one for free.
 */
function applyCommandTooltips(): void {
  applyTooltip('dash-save-btn', 'dash.save');
  applyTooltip('dash-present-btn', 'dash.present');
  applyTooltip('dash-export-btn', 'dash.export');
  applyTooltip('dash-style-btn', 'dash.style');
  applyTooltip('side-ai-btn', 'ai.open');
  applyTooltip('dk-new', 'ai.new');
  applyTooltip('settings-gear', 'nav.settings');
  // Undo/redo are NOT here: dashHistory.ts rewrites their titles on every edit
  // to name the change they would revert, which says more than the key does.

  // The top bar prints its own shortcut beside the search box. It was the
  // string "⌘K", which is a lie on Windows and Linux — and the comment beside
  // it already said the binding had to exist "or the chrome is lying". Same
  // registry, same helper as the sheet and the keycaps.
  const hint = document.querySelector('.hub-search .menu-shortcut');
  const palette = getCommand('view.palette');
  if (hint && palette) hint.textContent = keyLabel(palette.keys);
}
