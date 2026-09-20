// The create-analysis wizard: name it, choose its data, and land in the
// workbench.
//
// Split verbatim out of analyses.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

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

async function anCreateWizard(datasetId?: string): Promise<void> {
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
  h.textContent = 'Create dashboard';
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
  nameLab.textContent = 'Dashboard name';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.className = 'ws-modal-input';
  nameIn.placeholder = 'Untitled dashboard';
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
      noneEl.textContent = 'This project has no datasets yet. Create one first — a dashboard is built on data.';
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
        if (!nameTouched) nameIn.value = String(d.name || '').trim() + ' dashboard';
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
    { id: 'ai', title: '✨ Let the Assistant design it', body: 'Describe what you want and a model proposes the sheets. You review it first.', art: ['b-ai'] },
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
    'No model is configured, so drafting is unavailable. Everything else works without one — pick any of the other three. ' + AI_NOT_CONFIGURED;
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
      : step === 2 ? 'Pick a starting layout, or let a model design the whole dashboard for you.'
      : 'Describe the dashboard and the Assistant will draft it. You review everything before it is created.';

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
      : step === 2 ? (startFrom === 'ai' ? 'Next' : 'Create dashboard')
      : 'Draft with the Assistant';
    next.disabled = step === 1 ? !selectedId : false;
    if (step === 3) setTimeout(() => ta.focus(), 0);
  }

  const chosenName = (): string => nameIn.value.trim() || 'Untitled dashboard';

  // Non-AI path: create it, open it, then scaffold.
  //
  // The starter is applied AFTER opening rather than packed into createAnalysis,
  // because `applyStarter` already does exactly this against the open editor.
  // Re-implementing it over a sheets array would be a second scaffolder that has
  // to be kept in step with the one the empty-state buttons use. The wizard's
  // chosen dataset is passed through, so it never re-asks for one.
  async function createFromStarter(kind: StartKind): Promise<void> {
    let res: any;
    try {
      res = await window.hub.createAnalysis({ projectId: currentProjectId, name: chosenName() });
    } catch (_) { res = null; }
    if (!res || res.ok === false || !res.id) {
      window.alert((res && res.error) || 'Failed to create the dashboard.');
      return;
    }
    close();
    await refreshAnalysisList();
      openAnalysisFrom(res);
    if (kind === 'kpis' || kind === 'twoup') await applyStarter(kind, selectedId || undefined);
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
      res = { ok: false, error: 'Could not draft a dashboard.' };
    }
    next.disabled = false;
    skip.disabled = false;
    next.textContent = label || 'Draft with the Assistant';
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
      window.alert((res && res.error) || 'Could not draft a dashboard.');
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
  // Preselect the dataset the caller opened this ON — the Data page's "New
  // dashboard" button knows which one you were looking at, so step 1 is a
  // confirmation rather than a decision and Next is live immediately. Falls
  // back to the only dataset there is, which was the original rule.
  const preset = sets.find((d) => String(d.id) === String(datasetId || ''))
    || (sets.length === 1 ? sets[0] : null);
  if (preset) {
    selectedId = String(preset.id);
    nameIn.value = String(preset.name || '').trim() + ' dashboard';
  }
  renderRows();
  sync();
  (sets.length === 0 ? mkDataset : search).focus();
}

async function handleRenameAnalysis(id: string, currentName: string): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename dashboard', currentName || 'Untitled dashboard', 'Save');
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
  if (!window.confirm('Delete this dashboard? This cannot be undone.')) return;
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
    window.alert('That dashboard could not be loaded.');
    await refreshAnalysisList();
    return;
  }
  openAnalysisFrom(a);
}

