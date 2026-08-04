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
  row.className = 'dash-list-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dash-list-open';
  const nameRow = document.createElement('span');
  nameRow.className = 'dash-list-name';
  nameRow.textContent = a && a.name ? String(a.name) : 'Untitled analysis';
  open.appendChild(nameRow);
  const dirty = analysisHasUnpublishedChanges(a);
  if (dirty) {
    // Stays a sibling of the name, not a child of it, so the name can ellipsis
    // without taking the badge with it.
    const badge = document.createElement('span');
    badge.className = 'dash-list-badge dash-list-badge--dirty';
    badge.textContent = 'Unpublished changes';
    open.appendChild(badge);
  }
  open.addEventListener('click', () => openAnalysis(String(a.id)));

  const sheets = a && typeof a.sheetCount === 'number' ? a.sheetCount : 1;
  const sheetCell = document.createElement('span');
  sheetCell.className = 'an-cell';
  sheetCell.textContent = String(sheets);

  // Three states, and the pill says which: published & current, published &
  // drifted, never published. The dirty case already carries a badge on the
  // name, so here it reads as the plain published time.
  const statusCell = document.createElement('span');
  statusCell.className = 'an-cell';
  const pill = document.createElement('span');
  if (a && a.lastPublishedAt) {
    pill.className = 'an-status an-status--published';
    pill.textContent = 'Published ' + formatSidebarTime(a.lastPublishedAt);
  } else {
    pill.className = 'an-status an-status--draft';
    pill.textContent = 'Not published';
  }
  statusCell.appendChild(pill);

  const updCell = document.createElement('span');
  updCell.className = 'an-cell';
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

// ── Create-analysis wizard ──────────────────────────────────────────────────
// Two steps: pick the data, then optionally describe what you want and let the
// model draft it. Step 2 is genuinely optional — Skip creates the blank analysis
// immediately, and with no model configured the AI half is disabled but the Skip
// path is not, which is the whole of what "AI is optional" costs this surface.
//
// ponytail: no pagination and no server-side search — the list is one project's
// datasets, filtered in memory. Add paging when a project has enough datasets to
// need it; `dataset:list` already returns summaries, not rows, so this is cheap.
const AN_WIZ_EXAMPLES = [
  'Show revenue by region over time, and flag any concentration risk.',
  'Which categories are growing fastest, and which are shrinking?',
  'Give me an overview sheet, then a sheet per region.',
];

async function anCreateWizard(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }

  let sets: any[] = [];
  try {
    sets = await window.hub.listDatasets(currentProjectId);
  } catch (_) { sets = []; }
  if (!Array.isArray(sets)) sets = [];

  // Readiness comes from the ONE source main already exposes (publicConfig
  // .isReady = Local CLI OR BYOK). No new IPC, and no second definition of
  // "ready" that can disagree with the one gating capture.
  let aiReady = false;
  try {
    const st: any = await window.hub.getKeyStatus();
    aiReady = !!(st && st.isReady);
  } catch (_) { aiReady = false; }

  let selectedId: string | null = null;
  let step = 1;

  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal an-wiz';
  overlay.appendChild(box);

  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // ── Header + step rail ────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'an-wiz-head';
  const titles = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'ws-modal-title';
  h.textContent = 'Create analysis';
  const sub = document.createElement('p');
  sub.className = 'an-wiz-sub';
  titles.appendChild(h);
  titles.appendChild(sub);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'an-wiz-x';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '✕';
  x.addEventListener('click', close);
  head.appendChild(titles);
  head.appendChild(x);

  const rail = document.createElement('div');
  rail.className = 'an-wiz-rail';
  const railSteps = [
    { n: 1, label: 'Choose data' },
    { n: 2, label: 'Start from' },
    { n: 3, label: 'Describe it', opt: true },
  ].map((s) => {
    const el = document.createElement('div');
    el.className = 'an-wiz-step';
    const dot = document.createElement('span');
    dot.className = 'an-wiz-dot';
    dot.textContent = String(s.n);
    const lab = document.createElement('span');
    lab.className = 'an-wiz-step-label';
    lab.textContent = s.label;
    el.appendChild(dot);
    el.appendChild(lab);
    if (s.opt) {
      const o = document.createElement('span');
      o.className = 'an-wiz-optional';
      o.textContent = 'Optional';
      el.appendChild(o);
    }
    rail.appendChild(el);
    return { el, dot };
  });

  // ── Step 1: the dataset picker ────────────────────────────────────────────
  const pane1 = document.createElement('div');
  pane1.className = 'an-wiz-pane';

  const bar = document.createElement('div');
  bar.className = 'an-wiz-bar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ws-modal-input an-wiz-search';
  search.placeholder = 'Search datasets by name';
  const mkDataset = document.createElement('button');
  mkDataset.type = 'button';
  mkDataset.className = 'btn';
  mkDataset.textContent = 'Create dataset';
  mkDataset.addEventListener('click', () => {
    // Leaves the wizard for the existing import flow rather than re-hosting it
    // in a modal. Deliberate: one import path, not two.
    close();
    selectSection('sources');
  });
  bar.appendChild(search);
  bar.appendChild(mkDataset);

  const table = document.createElement('div');
  table.className = 'an-wiz-table';
  const cols = document.createElement('div');
  cols.className = 'an-wiz-cols';
  ['', 'Dataset name', 'Rows', 'Columns', 'Source', 'Last modified'].forEach((c) => {
    const s = document.createElement('span');
    s.textContent = c;
    cols.appendChild(s);
  });
  const rowsHost = document.createElement('div');
  rowsHost.className = 'an-wiz-rows';
  table.appendChild(cols);
  table.appendChild(rowsHost);

  const noneEl = document.createElement('p');
  noneEl.className = 'an-wiz-none';
  noneEl.hidden = true;

  const nameWrap = document.createElement('label');
  nameWrap.className = 'an-wiz-name';
  const nameLab = document.createElement('span');
  nameLab.textContent = 'Analysis name';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.className = 'ws-modal-input';
  nameIn.placeholder = 'Untitled analysis';
  // Tracks the dataset until the user types their own, then stops fighting them.
  let nameTouched = false;
  nameIn.addEventListener('input', () => { nameTouched = true; });
  nameWrap.appendChild(nameLab);
  nameWrap.appendChild(nameIn);

  pane1.appendChild(bar);
  pane1.appendChild(table);
  pane1.appendChild(noneEl);
  pane1.appendChild(nameWrap);

  function renderRows(): void {
    const q = search.value.trim().toLowerCase();
    const shown = sets.filter((d) => !q || String(d.name || '').toLowerCase().includes(q));
    rowsHost.innerHTML = '';
    table.hidden = sets.length === 0;
    noneEl.hidden = sets.length !== 0;
    nameWrap.hidden = sets.length === 0;
    if (sets.length === 0) {
      noneEl.textContent = 'This project has no datasets yet. Create one first — an analysis is built on data.';
      return;
    }
    if (shown.length === 0) {
      const p = document.createElement('p');
      p.className = 'an-wiz-none';
      p.textContent = 'No dataset matches “' + search.value.trim() + '”.';
      rowsHost.appendChild(p);
      return;
    }
    shown.forEach((d) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'an-wiz-row' + (selectedId === d.id ? ' is-selected' : '');
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', selectedId === d.id ? 'true' : 'false');
      const radio = document.createElement('span');
      radio.className = 'an-wiz-radio';
      const nm = document.createElement('span');
      nm.className = 'an-wiz-dsname';
      nm.textContent = String(d.name || 'Untitled');
      const rc = document.createElement('span');
      rc.className = 'an-wiz-cell';
      rc.textContent = typeof d.rowCount === 'number' ? d.rowCount.toLocaleString() : '—';
      const cc = document.createElement('span');
      cc.className = 'an-wiz-cell';
      cc.textContent = typeof d.columnCount === 'number' ? String(d.columnCount) : '—';
      const sk = document.createElement('span');
      sk.className = 'an-wiz-cell';
      const chip = document.createElement('span');
      chip.className = 'an-wiz-kind';
      chip.textContent = String(d.sourceKind || 'csv');
      sk.appendChild(chip);
      const up = document.createElement('span');
      up.className = 'an-wiz-cell';
      up.textContent = formatSidebarTime(d.updatedAt || null);
      [radio, nm, rc, cc, sk, up].forEach((c) => row.appendChild(c));
      row.addEventListener('click', () => {
        selectedId = String(d.id);
        if (!nameTouched) nameIn.value = String(d.name || '').trim() + ' analysis';
        renderRows();
        sync();
      });
      rowsHost.appendChild(row);
    });
  }

  // ── Step 2: what to start from ────────────────────────────────────────────
  // Layout and AI are ONE step, not two. Asking for a starting layout and then
  // discarding it because the model defined its own sheets is a dialog that
  // lies about what it does. Picking AI here is what reveals step 3.
  //
  // The first three are the REAL `.dash-starters` scaffolds (dashboards.ts
  // applyStarter), so every option does something. QuickSight's Interactive-vs-
  // Pixel-Perfect / Layout / Optimize-for-width pickers are deliberately absent:
  // Ordinate has one layout, no paginated-report mode and no fixed-width canvas,
  // so those three controls would change nothing.
  type StartKind = 'blank' | 'kpis' | 'twoup' | 'ai';
  let startFrom: StartKind = 'blank';

  const pane2 = document.createElement('div');
  pane2.className = 'an-wiz-pane';
  pane2.hidden = true;
  const startGrid = document.createElement('div');
  startGrid.className = 'an-wiz-starts';
  const START_OPTS: Array<{ id: StartKind; title: string; body: string; art: string[] }> = [
    { id: 'blank', title: 'Blank sheet', body: 'One empty sheet. Add cards as you go.', art: ['b-full'] },
    { id: 'kpis', title: 'KPIs + chart', body: 'A KPI strip across the top, with a wide chart beneath it.', art: ['b-strip', 'b-wide'] },
    { id: 'twoup', title: 'Two-up', body: 'Two charts side by side, with a notes card below.', art: ['b-half', 'b-half', 'b-strip'] },
    { id: 'ai', title: '✨ Let AI design it', body: 'Describe what you want and a model proposes the sheets. You review it first.', art: ['b-ai'] },
  ];
  const startCards = START_OPTS.map((o) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'an-wiz-start' + (o.id === 'ai' ? ' an-wiz-start--ai' : '');
    c.setAttribute('role', 'radio');
    c.dataset.kind = o.id;
    const art = document.createElement('span');
    art.className = 'an-wiz-start-art';
    o.art.forEach((cls) => {
      const b = document.createElement('span');
      b.className = 'an-wiz-block ' + cls;
      art.appendChild(b);
    });
    const t = document.createElement('span');
    t.className = 'an-wiz-start-t';
    t.textContent = o.title;
    const p = document.createElement('span');
    p.className = 'an-wiz-start-p';
    p.textContent = o.body;
    c.appendChild(art);
    c.appendChild(t);
    c.appendChild(p);
    c.addEventListener('click', () => { startFrom = o.id; sync(); });
    startGrid.appendChild(c);
    return { el: c, id: o.id };
  });
  pane2.appendChild(startGrid);
  const startNote = document.createElement('p');
  startNote.className = 'an-wiz-note';
  startNote.textContent =
    'No model is configured, so AI drafting is unavailable. Everything else works without one — pick any of the other three, or connect a model in Settings → Execution.';
  startNote.hidden = true;
  pane2.appendChild(startNote);

  // ── Step 3: the AI step ───────────────────────────────────────────────────
  // Reachable ONLY when step 2's AI card was chosen, which step 2 disables
  // without a model. That is the single gate — this pane deliberately does not
  // re-check readiness, because two guards for one condition is how they drift.
  const pane3 = document.createElement('div');
  pane3.className = 'an-wiz-pane';
  pane3.hidden = true;

  const aiCard = document.createElement('div');
  aiCard.className = 'an-wiz-ai';
  const aiH = document.createElement('h3');
  aiH.className = 'an-wiz-ai-h';
  aiH.textContent = '✨ Describe what you want to see';
  const aiP = document.createElement('p');
  aiP.className = 'an-wiz-ai-p';
  aiP.textContent =
    'The model proposes structure only — which sheets, which charts, which calculated fields. ' +
    'Every number is computed by the app from your data, and you review the whole draft before anything is created.';
  const ta = document.createElement('textarea');
  ta.className = 'an-wiz-ta';
  ta.rows = 4;
  ta.placeholder = 'e.g. Revenue by region over the last year, with a sheet breaking down the top region.';
  const chips = document.createElement('div');
  chips.className = 'an-wiz-chips';
  AN_WIZ_EXAMPLES.forEach((ex) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'an-wiz-chip';
    c.textContent = ex;
    c.addEventListener('click', () => { ta.value = ex; ta.focus(); });
    chips.appendChild(c);
  });
  aiCard.appendChild(aiH);
  aiCard.appendChild(aiP);
  aiCard.appendChild(ta);
  aiCard.appendChild(chips);
  pane3.appendChild(aiCard);

  const body = document.createElement('div');
  body.className = 'an-wiz-body';
  body.appendChild(pane1);
  body.appendChild(pane2);
  body.appendChild(pane3);

  // ── Footer ────────────────────────────────────────────────────────────────
  const foot = document.createElement('div');
  foot.className = 'ws-modal-actions an-wiz-foot';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn an-wiz-back';
  backBtn.textContent = '‹ Back';
  backBtn.addEventListener('click', () => { step = Math.max(1, step - 1); sync(); });
  const spacer = document.createElement('span');
  spacer.className = 'an-wiz-spacer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  // Only on step 3: a way out of the AI step that still produces the analysis.
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'btn';
  skip.textContent = 'Skip — blank sheet';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn btn-primary';
  next.textContent = 'Next';
  foot.appendChild(backBtn);
  foot.appendChild(spacer);
  foot.appendChild(cancel);
  foot.appendChild(skip);
  foot.appendChild(next);

  function sync(): void {
    pane1.hidden = step !== 1;
    pane2.hidden = step !== 2;
    pane3.hidden = step !== 3;
    sub.textContent =
      step === 1 ? 'Choose the dataset to build from. You can add more sheets and datasets later.'
      : step === 2 ? 'Pick a starting layout, or let a model design the whole analysis for you.'
      : 'Describe the analysis and the AI will draft it. You review everything before it is created.';

    // Step 3 exists only on the AI route, so the rail dims it otherwise rather
    // than pretending there is a third step everyone has to walk through.
    railSteps.forEach((s, i) => {
      const n = i + 1;
      const skipped = n === 3 && startFrom !== 'ai';
      s.el.className = 'an-wiz-step'
        + (n === step ? ' is-active' : '')
        + (n < step ? ' is-done' : '')
        + (skipped ? ' is-skipped' : '');
      s.dot.textContent = n < step ? '✓' : String(n);
    });

    startCards.forEach((c) => {
      const on = c.id === startFrom;
      c.el.classList.toggle('is-selected', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
      // With no model the AI card is not a choice, and says why below.
      if (c.id === 'ai') (c.el as HTMLButtonElement).disabled = !aiReady;
    });
    startNote.hidden = step !== 2 || aiReady;

    backBtn.hidden = step === 1;
    skip.hidden = step !== 3;
    // Step 2 finishes the wizard for the three non-AI routes — there is nothing
    // left to ask, so it says Create rather than marching through a dead step.
    next.textContent =
      step === 1 ? 'Next'
      : step === 2 ? (startFrom === 'ai' ? 'Next' : 'Create analysis')
      : 'Draft with AI';
    next.disabled = step === 1 ? !selectedId : false;
    if (step === 3) setTimeout(() => ta.focus(), 0);
  }

  const chosenName = (): string => nameIn.value.trim() || 'Untitled analysis';

  // Non-AI path: create it, open it, then scaffold.
  //
  // The starter is applied AFTER opening rather than packed into createAnalysis,
  // because `applyStarter` already does exactly this against the open editor —
  // including asking which saved visual belongs in each slot. Re-implementing it
  // over a sheets array would be a second scaffolder that has to be kept in step
  // with the one the "+ Page" button uses.
  async function createFromStarter(kind: StartKind): Promise<void> {
    let res: any;
    try {
      res = await window.hub.createAnalysis({ projectId: currentProjectId, name: chosenName() });
    } catch (_) { res = null; }
    if (!res || res.ok === false || !res.id) {
      window.alert((res && res.error) || 'Failed to create the analysis.');
      return;
    }
    close();
    await refreshAnalysisList();
    anLastPublishedName = null;
    openAnalysisFrom(res);
    if (kind === 'kpis' || kind === 'twoup') await applyStarter(kind);
  }

  skip.addEventListener('click', () => { createFromStarter('blank'); });
  next.addEventListener('click', async () => {
    if (step === 1) { step = 2; sync(); return; }
    if (step === 2) {
      if (startFrom === 'ai') { step = 3; sync(); return; }
      await createFromStarter(startFrom);
      return;
    }
    // AI path. The wizard stays open and busy while the model works — closing it
    // first would leave nothing on screen to explain the wait.
    const label = next.textContent;
    next.disabled = true;
    skip.disabled = true;
    next.textContent = 'Thinking…';
    let res: any;
    try {
      res = await window.hub.draftDashboard(currentProjectId, {
        datasetId: selectedId || undefined,
        intent: ta.value.trim(),
      });
    } catch (_) {
      res = { ok: false, error: 'Could not draft an analysis.' };
    }
    next.disabled = false;
    skip.disabled = false;
    next.textContent = label || 'Draft with AI';
    // Step 2 gates this route on aiReady, so notReady here means the model went
    // away between opening the wizard and pressing the button. Send them back to
    // the step that can still produce an analysis rather than stranding them.
    if (res && res.notReady) {
      aiReady = false;
      startFrom = 'blank';
      step = 2;
      sync();
      return;
    }
    if (!res || res.ok === false) {
      window.alert((res && res.error) || 'Could not draft an analysis.');
      return;
    }
    close();
    await anMaterialiseDraft(res, nameTouched ? chosenName() : '');
  });

  box.appendChild(head);
  box.appendChild(rail);
  box.appendChild(body);
  box.appendChild(foot);
  document.body.appendChild(overlay);

  search.addEventListener('input', renderRows);
  // Preselect when there is only one dataset — the step is then a confirmation,
  // not a decision, and Next is live immediately.
  if (sets.length === 1) {
    selectedId = String(sets[0].id);
    nameIn.value = String(sets[0].name || '').trim() + ' analysis';
  }
  renderRows();
  sync();
  (sets.length === 0 ? mkDataset : search).focus();
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

  await anMaterialiseDraft(res);
}

// Review → build → open. Split out of handleDraftAnalysis because the create
// wizard's AI step ends in exactly the same place, and two copies of the
// plan-vs-sheets decision below is how they drift apart.
// `preferredName` is the wizard's name field, which the user typed before the
// model proposed one; theirs wins.
async function anMaterialiseDraft(res: any, preferredName?: string): Promise<void> {
  if (!currentProjectId) return;
  const approved = await anDraftReviewModal(res);
  if (!approved) return;

  // Two ways to materialise, decided by what main actually sent — never by a
  // version flag. A `plan` means the Phase E pipeline owns the write (it has to:
  // calculated fields and visuals are records this renderer cannot mint).
  // Otherwise the draft is already a sheet array and createAnalysis takes it.
  const name = (preferredName || '').trim() || res.name || 'AI analysis';
  let saved: any = null;
  try {
    if (res.plan && typeof window.hub.buildAnalysisPlan === 'function') {
      // The plan carries the model's own name. If the user typed one in the
      // wizard first, that is the one they expect to see in the list.
      const planToBuild =
        (preferredName || '').trim() ? { ...res.plan, name } : res.plan;
      const built = await window.hub.buildAnalysisPlan(currentProjectId, planToBuild);
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
