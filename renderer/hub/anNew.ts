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

// `opts.step` lets a caller that has ALREADY chosen the dataset open straight on
// the gallery — the Data page's "New dashboard" button knows which dataset you
// were looking at, so making you confirm it is a step that asks nothing.
async function anCreateWizard(datasetId?: string, opts: { step?: number } = {}): Promise<void> {
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
  iconOnly(x, 'x', 'Close');
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
    // `label` and `opt` are returned because step 3 is TWO steps wearing one
    // dot: "Describe it" on the AI route, "Map columns" on a template's.
    return { el, dot, label: lab, opt: el.querySelector('.an-wiz-optional') as HTMLElement };
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
    selectSection('datasets');
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
        // The mapping is a fact about the DATASET, so a different dataset means
        // a different catalogue — and a template card that was pickable on the
        // old one may be dimmed on this one.
        if (tplFor !== selectedId) { tplData = null; tplPicked = ''; if (startFrom === 'template') startFrom = 'blank'; }
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
  type StartKind = 'blank' | 'kpis' | 'twoup' | 'ai' | 'template';
  let startFrom: StartKind = 'blank';
  // The chosen TEMPLATE, when startFrom === 'template'. Kept beside startFrom
  // rather than inside it so going back to the gallery and forward again lands
  // on the same card.
  let tplPicked = '';
  let tplData: any = null; // the last `template:list` reply, cached per dataset
  let tplFor = ''; // which dataset id tplData describes

  const pane2 = document.createElement('div');
  pane2.className = 'an-wiz-pane';
  pane2.hidden = true;

  // ── The TEMPLATE gallery ──
  // Six subject dashboards, above the three layouts. A template is not a
  // different kind of thing from a layout — both are entries in the same
  // catalogue (src/analysis/templates.ts) and both end up in `buildPlan` — so
  // the two rows differ only in what they promise, not in how they are built.
  const tplHead = document.createElement('div');
  tplHead.className = 'an-wiz-grouph';
  const tplHeadT = document.createElement('span');
  tplHeadT.textContent = 'Templates';
  const tplHeadP = document.createElement('span');
  tplHeadP.className = 'an-wiz-grouph-p';
  tplHeadP.textContent = 'A complete dashboard, mapped to your columns.';
  tplHead.appendChild(tplHeadT);
  tplHead.appendChild(tplHeadP);
  const tplGrid = document.createElement('div');
  tplGrid.className = 'an-wiz-tpls';
  const tplNote = document.createElement('p');
  tplNote.className = 'an-wiz-none';
  tplNote.textContent = 'Reading your columns…';
  // r7:templates — the user's own templates, FIRST (userTemplateGallery.ts).
  const yoursHost = document.createElement('div');
  yoursHost.className = 'ut-yours-host';
  pane2.appendChild(yoursHost);
  pane2.appendChild(tplHead);
  pane2.appendChild(tplGrid);
  pane2.appendChild(tplNote);

  const layoutHead = document.createElement('div');
  layoutHead.className = 'an-wiz-grouph';
  const layoutHeadT = document.createElement('span');
  layoutHeadT.textContent = 'Layouts';
  const layoutHeadP = document.createElement('span');
  layoutHeadP.className = 'an-wiz-grouph-p';
  layoutHeadP.textContent = 'A scaffold to fill in yourself.';
  layoutHead.appendChild(layoutHeadT);
  layoutHead.appendChild(layoutHeadP);
  pane2.appendChild(layoutHead);

  const startGrid = document.createElement('div');
  startGrid.className = 'an-wiz-starts';
  const START_OPTS: Array<{ id: StartKind; title: string; body: string; art: string[] }> = [
    { id: 'blank', title: 'Blank sheet', body: 'One empty sheet. Add cards as you go.', art: ['b-full'] },
    { id: 'kpis', title: 'KPIs + chart', body: 'A KPI strip across the top, with a wide chart beneath it.', art: ['b-strip', 'b-wide'] },
    { id: 'twoup', title: 'Two-up', body: 'Two charts side by side, with a notes card below.', art: ['b-half', 'b-half', 'b-strip'] },
    { id: 'ai', title: 'Let the Assistant design it', body: 'Describe what you want and a model proposes the sheets. You review it first.', art: ['b-ai'] },
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
    // The AI card is the only one that carries an icon — its title used to
    // carry a ✨ glyph, and the sparkle is what marks the model route apart
    // from the three the app builds itself.
    if (o.id === 'ai') iconLabel(t, 'sparkles', o.title);
    else t.textContent = o.title;
    const p = document.createElement('span');
    p.className = 'an-wiz-start-p';
    p.textContent = o.body;
    c.appendChild(art);
    c.appendChild(t);
    c.appendChild(p);
    c.addEventListener('click', () => { startFrom = o.id; tplPicked = ''; sync(); });
    startGrid.appendChild(c);
    return { el: c, id: o.id };
  });
  pane2.appendChild(startGrid);
  const startNote = document.createElement('p');
  startNote.className = 'an-wiz-note';
  startNote.textContent =
    AI_NOT_CONFIGURED + ' Drafting is unavailable, but everything else works without one — pick any of the other three.';
  startNote.hidden = true;
  pane2.appendChild(startNote);

  // ── Step 3: describe it, OR map the template's columns ────────────────────
  // ONE step with two occupants, because it answers the same question for both
  // routes — "what should this be built from?" — and a fourth rail dot for a
  // step only one route ever walks would be a step counter, not a map.
  //
  // The AI half is reachable ONLY when step 2's AI card was chosen, which step 2
  // disables without a model. That is the single gate — this pane deliberately
  // does not re-check readiness, because two guards for one condition is how
  // they drift.
  const pane3 = document.createElement('div');
  pane3.className = 'an-wiz-pane';
  pane3.hidden = true;

  const aiCard = document.createElement('div');
  aiCard.className = 'an-wiz-ai';
  const aiH = document.createElement('h3');
  aiH.className = 'an-wiz-ai-h';
  iconLabel(aiH, 'sparkles', 'Describe what you want to see');
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

  // The template route's occupant of step 3 (anNewTemplates.ts). Built once and
  // re-`load`ed per template, so switching cards does not leak listeners.
  const mapPane = anTplMapPane();
  mapPane.el.hidden = true;
  pane3.appendChild(mapPane.el);

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
  iconLabel(backBtn, 'chevron-left', 'Back');
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
    const onTemplate = startFrom === 'template';
    sub.textContent =
      step === 1 ? 'Choose the dataset to build from. You can add more sheets and datasets later.'
      : step === 2 ? 'Start from a template built for your data, a plain layout, or let a model design it.'
      : onTemplate ? 'Check which column plays which part. Every figure below is computed from your data.'
      : 'Describe the dashboard and the Assistant will draft it. You review everything before it is created.';

    // Step 3 belongs to the AI and TEMPLATE routes; the three plain layouts
    // finish at step 2, so the rail dims it for them rather than pretending
    // there is a third step everyone has to walk through.
    const hasStep3 = startFrom === 'ai' || onTemplate;
    railSteps[2].label.textContent = onTemplate ? 'Map columns' : 'Describe it';
    // "Optional" is the AI step's promise (Skip still creates the dashboard);
    // mapping is not optional, so the chip goes away on that route.
    railSteps[2].opt.hidden = onTemplate;
    railSteps.forEach((s, i) => {
      const n = i + 1;
      const skipped = n === 3 && !hasStep3;
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
    // The two occupants of step 3, one at a time.
    aiCard.hidden = onTemplate;
    mapPane.el.hidden = !onTemplate;

    backBtn.hidden = step === 1;
    skip.hidden = step !== 3 || onTemplate;
    // Step 2 finishes the wizard for the three plain layouts — there is nothing
    // left to ask, so it says Create rather than marching through a dead step.
    next.textContent =
      step === 1 ? 'Next'
      : step === 2 ? (hasStep3 ? 'Next' : 'Create dashboard')
      : onTemplate ? 'Create dashboard'
      : 'Draft with the Assistant';
    next.disabled = step === 1 ? !selectedId : false;
    if (step === 3 && !onTemplate) setTimeout(() => ta.focus(), 0);
  }

  // ── The template catalogue for the chosen dataset ─────────────────────────
  //
  // ONE call per dataset, cached: `template:list` maps every template's roles
  // against that dataset's columns and app-computed summaries, which is what
  // decides whether a card is offered or dimmed. Re-fetched when the dataset
  // changes, because the mapping is a fact about the dataset, not the wizard.
  async function loadTemplates(): Promise<void> {
    const ds = selectedId || '';
    if (!ds) return;
    if (tplFor === ds && tplData) { paintTemplates(); return; }
    tplNote.hidden = false;
    tplNote.textContent = 'Reading your columns…';
    tplGrid.innerHTML = '';
    let res: any;
    try {
      res = await window.hub.listTemplates(currentProjectId, ds);
    } catch (_) { res = null; }
    if (selectedId !== ds) return; // the user moved on while this was in flight
    if (!res || res.ok === false) {
      tplData = null;
      tplNote.textContent = (res && res.error) || 'Templates are unavailable for this dataset.';
      return;
    }
    tplData = res;
    tplFor = ds;
    paintTemplates();
  }

  function paintTemplates(): void {
    if (!tplData) return;
    const subject = (tplData.templates || []).filter((t: any) => t.group === 'Templates');
    tplNote.hidden = subject.length > 0;
    const pick = (id: string): void => {
      startFrom = 'template';
      tplPicked = id;
      paintTemplates();
      sync();
    };
    anTplRenderGallery(tplGrid, subject, tplPicked, pick);
    utPaintYours(yoursHost, (tplData.templates || []).filter((t: any) => t.group === 'Yours'), tplPicked, pick, () => {
      tplData = null;
      if (startFrom === 'template') { startFrom = 'blank'; tplPicked = ''; }
      void loadTemplates();
      sync();
    });
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
    if (kind === 'kpis' || kind === 'twoup') {
      await applyStarter(kind, selectedId || undefined);
      sumAddToTop(); // summaryCard.ts — every gallery dashboard opens on its Summary
    }
  }

  // TEMPLATE path: the plan the mapping step already previewed, built through
  // the SAME `analysis:buildPlan` the Assistant's approved plan goes through.
  // No second builder, no second validator — the plan is re-validated in main
  // on the way in, which is what makes "what you previewed is what you get" a
  // property of the code rather than a promise of this function.
  async function createFromTemplate(): Promise<void> {
    const plan = mapPane.plan();
    if (!plan) { window.alert('That mapping could not be built. Change a column and try again.'); return; }
    const label = next.textContent;
    next.disabled = true;
    next.textContent = 'Creating…';
    let res: any;
    try {
      // r7:templates — a user template builds through its own apply, same mapping.
      res = plan.user
        ? await window.hubTemplates.apply({ projectId: currentProjectId, datasetId: selectedId, templateId: tplPicked, mapping: mapPane.mapping(), name: chosenName() })
        : await window.hub.buildAnalysisPlan(currentProjectId, plan);
    } catch (_) { res = null; }
    next.disabled = false;
    next.textContent = label || 'Create dashboard';
    if (!res || res.ok === false || !res.analysis) {
      window.alert((res && res.error) || 'Failed to create the dashboard.');
      return;
    }
    close();
    await refreshAnalysisList();
    openAnalysisFrom(res.analysis);
    sumAddToTop(); // summaryCard.ts — every gallery dashboard opens on its Summary
    if (plan.user && res.dropped && res.dropped.length) showToast(`${res.dropped.length} skipped — ${res.dropped[0]}${res.dropped.length > 1 ? ' …' : ''}`);
  }

  skip.addEventListener('click', () => { createFromStarter('blank'); });
  next.addEventListener('click', async () => {
    if (step === 1) { step = 2; loadTemplates(); sync(); return; }
    if (step === 2) {
      if (startFrom === 'ai') { step = 3; sync(); return; }
      if (startFrom === 'template') {
        const tpl = (tplData?.templates || []).find((t: any) => t.id === tplPicked);
        if (!tpl) return;
        step = 3;
        sync();
        mapPane.load(currentProjectId, selectedId || '', tpl, tplData.columns || [], chosenName());
        return;
      }
      await createFromStarter(startFrom);
      return;
    }
    if (startFrom === 'template') { await createFromTemplate(); return; }
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
  // Opening straight on the gallery is only honest once a dataset IS chosen —
  // the cards are dimmed or offered BY that dataset's columns, so a step 2 with
  // nothing selected would show six cards it cannot judge.
  if (opts.step === 2 && selectedId) { step = 2; loadTemplates(); }
  sync();
  (sets.length === 0 ? mkDataset : step === 2 ? next : search).focus();
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
    // The title is part of the record persistAnalysis writes, so a rename is an
    // undoable change like any other — it just reaches the record by its own IPC.
    markDashDirty('Rename dashboard');
    await refreshAnalysisListKeepEditor();
    return;
  }
  await refreshAnalysisList();
}

// Deleting a dashboard moves it to the Trash; the toast offers Undo, which is
// why there is no confirm in front of it any more.
async function handleDeleteAnalysis(id: string): Promise<void> {
  if (!currentProjectId) return;
  // To the Trash, with Undo on the toast (trashPage.ts).
  let res: any = null;
  try {
    res = await window.hub.deleteAnalysis(currentProjectId, id);
  } catch (_) { res = null; }
  trDeletedToast('dashboard', id, (res && res.name) || '', res, () => void refreshAnalysisList());
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

