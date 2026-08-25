// Analyses section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts (loaded AFTER
// dashboards.js, so dashEl / dashChooseModal / openAnalysisFrom / dashCurrent /
// promptModal / formatSidebarTime / showToast / selectSection all resolve at
// call time).
//
// A DASHBOARD is the authoring container the user sees: sheets of cards plus
// dashboard-wide filters. Internally it is still an `analysis` record
// (src/analysis.ts) — the `an*` names and the `analyses` section id are kept.
//
// This file owns the LIST (create / rename / delete / open) and the AI draft.
// It owns no editing UI at all: the authoring surface IS the shared editor in
// dashboards.ts, re-parented into #an-editor-host, because a sheet is literally
// a `Page` and the grid, tabs, cards and cross-visual filters already work on
// exactly that shape.
//
// ponytail: analysis/sheet/card envelopes are owned by src/analysis.ts; the
// renderer forwards them, so they are typed `any` here rather than re-declared.

// Table and empty state are mutually exclusive — one or the other is on screen,
// never both and never neither.
function anShowList(count: number): void {
  const table = dashEl('an-table');
  const empty = dashEl('an-list-empty');
  const has = count > 0;
  if (table) table.hidden = !has;
  if (empty) empty.hidden = has;
}

// ── Boot wiring (once) ──────────────────────────────────────────────────────
function initAnalyses(): void {
  // Two Create buttons (table header, empty state) and two AI ones — whichever
  // is on screen runs the same handler. Same call, not a copy of it.
  ['an-new-btn', 'an-empty-new'].forEach((id) => {
    const b = dashEl(id);
    if (b) b.addEventListener('click', () => anCreateWizard());
  });
  ['an-draft-btn', 'an-empty-draft'].forEach((id) => {
    const b = dashEl(id);
    if (b) b.addEventListener('click', () => handleDraftAnalysis());
  });
}
