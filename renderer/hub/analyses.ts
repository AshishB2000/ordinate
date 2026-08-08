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

// The intro banner is shown until dismissed, once per machine. localStorage
// rather than config.json: it is a per-install UI preference with no bearing on
// data or a project, and config is main-process-only.
const AN_HERO_KEY = 'anHeroDismissed';

// Table and empty state are mutually exclusive — one or the other is on screen,
// never both and never neither. The hero rides with the table, because on an
// empty page the empty state already makes the pitch and says it better.
function anShowList(count: number): void {
  const table = dashEl('an-table');
  const empty = dashEl('an-list-empty');
  const hero = dashEl('an-hero');
  const has = count > 0;
  if (table) table.hidden = !has;
  if (empty) empty.hidden = has;
  let dismissed = false;
  try { dismissed = localStorage.getItem(AN_HERO_KEY) === '1'; } catch (_) { /* private mode */ }
  if (hero) hero.hidden = !has || dismissed;
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
  // Three Create buttons (table header, hero, empty state) and two AI ones —
  // whichever is on screen runs the same handler. Same call, not a copy of it.
  ['an-new-btn', 'an-hero-new', 'an-empty-new'].forEach((id) => {
    const b = dashEl(id);
    if (b) b.addEventListener('click', () => anCreateWizard());
  });
  ['an-draft-btn', 'an-empty-draft'].forEach((id) => {
    const b = dashEl(id);
    if (b) b.addEventListener('click', () => handleDraftAnalysis());
  });
  const dismiss = dashEl('an-hero-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      try { localStorage.setItem(AN_HERO_KEY, '1'); } catch (_) { /* private mode */ }
      const hero = dashEl('an-hero');
      if (hero) hero.hidden = true;
    });
  }
  const pub = dashEl('an-publish-btn');
  if (pub) pub.addEventListener('click', () => handlePublishAnalysis(false));
  const republish = dashEl('an-republish-btn');
  if (republish) republish.addEventListener('click', () => handlePublishAnalysis(true));
  const openAn = dashEl('dash-open-analysis');
  if (openAn) openAn.addEventListener('click', () => handleOpenAnalysisForDashboard());
  const wrap = dashEl('dash-legacy-wrap-btn');
  if (wrap) wrap.addEventListener('click', () => handleOpenAnalysisForDashboard());
}
