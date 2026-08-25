// The dashboards list (internally the analyses list): the table and its count.
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

// One row = one grid row, cells in the order the column labels declare them:
// Name · Sheets · Last updated · Action. There is deliberately no
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
  nameRow.textContent = a && a.name ? String(a.name) : 'Untitled dashboard';
  open.appendChild(nameRow);
  open.addEventListener('click', () => openAnalysis(String(a.id)));

  const sheets = a && typeof a.sheetCount === 'number' ? a.sheetCount : 1;
  const sheetCell = document.createElement('span');
  sheetCell.className = 'an-cell ws-cell';
  sheetCell.textContent = String(sheets);

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
  menuBtn.setAttribute('aria-label', 'Dashboard options');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.textContent = '⋯';
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
  row.appendChild(updCell);
  row.appendChild(actions);
  return row;
}

