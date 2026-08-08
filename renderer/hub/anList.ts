// The analyses list: the table, its count, and the one status pill that carries
// all three states (Draft / Published / Unpublished changes).
//
// Split verbatim out of analyses.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER analyses.js,
// which keeps the module-local state every function here reads.

// ── List view ───────────────────────────────────────────────────────────────
async function refreshAnalysisList(): Promise<void> {
  // Flush a pending debounced edit before the editor is torn down, so a quick
  // section switch never drops the last few edits.
  if (dashDirty && dashCurrent) await persistDashboard();
  closeDashboardEditor();
  const list = dashEl('an-list');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    anShowList(0);
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listAnalyses(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  items.forEach((a) => list.appendChild(makeAnListItem(a)));
  anShowList(items.length);
  anRenderCount(items.length);
}

/** How many analyses, beside the heading. Hidden at zero — the empty state
 *  already says there are none, and "0" next to a title reads as an error. */
function anRenderCount(n: number): void {
  const chip = dashEl('an-count');
  if (!chip) return;
  chip.hidden = n === 0;
  chip.textContent = String(n);
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
    anShowList(items.length);
    anRenderCount(items.length);
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

// One row = one grid row, cells in the order the column labels declare them:
// Name · Sheets · Status · Last updated · Action. There is deliberately no
// Owner column (QuickSight has one) — every analysis in a local-first,
// single-user app is owned by the person reading the screen, so the column
// would say "Me" on every row forever.
function makeAnListItem(a: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dash-list-item ws-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dash-list-open';
  const nameRow = document.createElement('span');
  nameRow.className = 'dash-list-name';
  nameRow.textContent = a && a.name ? String(a.name) : 'Untitled analysis';
  open.appendChild(nameRow);
  open.addEventListener('click', () => openAnalysis(String(a.id)));

  const sheets = a && typeof a.sheetCount === 'number' ? a.sheetCount : 1;
  const sheetCell = document.createElement('span');
  sheetCell.className = 'an-cell ws-cell';
  sheetCell.textContent = String(sheets);

  // ONE pill, three states — published & current, published & drifted, never
  // published — the same three the editor's own pill shows, from the same
  // analysisHasUnpublishedChanges. The drifted case used to be a second badge
  // beside the name while the pill said "Published", which is two controls
  // for one fact and left the pill quietly wrong.
  const statusCell = document.createElement('span');
  statusCell.className = 'an-cell ws-cell';
  const pill = document.createElement('span');
  if (!a || !a.lastPublishedAt) {
    pill.className = 'an-status an-status--draft';
    pill.textContent = 'Draft';
    pill.title = 'Not published yet.';
  } else if (analysisHasUnpublishedChanges(a)) {
    pill.className = 'an-status an-status--dirty';
    pill.textContent = 'Unpublished changes';
    pill.title = 'Last published ' + formatSidebarTime(a.lastPublishedAt)
      + ' — republish to update the dashboard.';
  } else {
    pill.className = 'an-status an-status--published';
    pill.textContent = 'Published';
    pill.title = 'Published ' + formatSidebarTime(a.lastPublishedAt) + ' · up to date.';
  }
  statusCell.appendChild(pill);

  const updCell = document.createElement('span');
  updCell.className = 'an-cell ws-cell';
  updCell.textContent = formatSidebarTime(a && a.updatedAt);

  // One ⋯ trigger, opening the shared row menu from projects.ts. Rename and
  // Delete moved inside it: the row is a table now, and two glyphs per row read
  // as content competing with the data rather than as controls.
  const actions = document.createElement('span');
  actions.className = 'an-cell-actions';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'dash-list-btn an-row-menu';
  menuBtn.setAttribute('aria-label', 'Analysis options');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.textContent = '⋯';
  // ponytail: Open only, plus the two that were already here. Publish is NOT in
  // this menu — it needs the editor loaded (handlePublishAnalysis reads
  // dashCurrent), so from a list row it would be a race, not a shortcut.
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRowMenu(menuBtn, [
      { label: 'Open', onClick: () => { openAnalysis(String(a.id)); } },
      {
        label: 'Rename',
        onClick: () => handleRenameAnalysis(String(a.id), a && a.name ? String(a.name) : ''),
      },
      { label: 'Delete', danger: true, onClick: () => handleDeleteAnalysis(String(a.id)) },
    ]);
  });
  actions.appendChild(menuBtn);

  row.appendChild(open);
  row.appendChild(sheetCell);
  row.appendChild(statusCell);
  row.appendChild(updCell);
  row.appendChild(actions);
  return row;
}

