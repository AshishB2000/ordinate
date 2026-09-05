// Dock proposals — the reason the dock exists (Task 3,
// docs/superpowers/plans/2026-08-09-ai-dock.md). Classic global-scope
// renderer <script>: NO import/export. Loads AFTER dock.js (calls
// dkClearProposal/dkOfferProposal from dkSend), explore.js (xpScrollToBottom —
// the ask surface is the SECOND caller now; see below), prepare.js
// (stepSummaryText, applyStepResult, prefillCalcFieldEditor), renderResult.js
// (renderVizInArea, eligibleChartTypes, countNumericSeries), dashGrid.js
// (dashCurrentPage, dashUuid, nextFreeRow, openAnalysis), dashAdd.js
// (pushCard), dsExplorer.js (openSavedDataset) and dataSection.js
// (dxSelectTab) — see the load-order comment in index.html.
//
// Three fixed proposal types, each grounded in an existing IPC channel, each
// reversible, each requiring a click. ONE proposal per turn, decided by a
// cheap heuristic on the question/answer text — never a gallery, never more
// than one extra model call per turn.
//
// ONE engine, TWO mounts. The dock (#dk-messages) was the first caller; Ask
// (explore.ts, #xp-messages) is the second. The mount is a `containerId`
// threaded from dkOfferProposal down to dkAppendProposal / dkClearProposal,
// defaulting to 'dk-messages' so every dock call site is byte-for-byte
// unchanged. This is the same pattern explore.ts's own xpAppendBubble uses to
// serve both surfaces from one renderer — NOT a second copy for Ask. Retiring
// exploreChart.ts's parallel chart path (it drew a chart under every Ask
// answer, outside the one-proposal-per-turn rule) is what makes that honest:
// Ask now offers the SAME grounded step/calc/chart proposal the dock does.
//
// ⚠️ The one rule that matters most: a prepare-step proposal calls
// `addDatasetStep` (APPENDS one step) and NEVER `setDatasetSteps` (which
// REPLACES the whole pipeline — see applySuggestedSteps() in prepare.ts,
// correct for its own confirmed-batch flow, catastrophic here).

// ── Which type, if any, this turn offers ────────────────────────────────────
// The three keyword regexes that used to guess this are GONE. copilot:ask now
// returns a validated `suggestedAction` ({ kind, intent }) alongside the answer
// — the upgrade the ponytail comment here named, taken because the heuristic
// could not tell "show me revenue by region" from "build me a dashboard of
// revenue by region", and had no notion of a dashboard at all.
//
// The whitelist lives in main (src/ai/suggestedAction.ts) and is total: an
// absent, malformed or unknown action arrives as 'none'. This reads that field
// and nothing else — there is deliberately NO regex fallback, so a turn the
// model did not mark is a turn with no proposal.

// The intent accumulated across a conversation's dashboard turns. A follow-up
// ("add a KPI for total revenue") refines the SAME plan by re-drafting with
// everything asked so far, rather than starting over from the last sentence.
// Renderer-side only: a proposal is never persisted, and this dies with it.
let dkPlanIntent = '';
let dkPlanThreadId = '';

// Drop the accumulated intent. Called when the conversation changes underneath
// it (a different thread or project) and when a plan is built or dismissed —
// anything else would refine a plan the user has already finished with.
function dkResetPlanIntent(): void {
  dkPlanIntent = '';
  dkPlanThreadId = '';
}

// Fold this turn's intent into the running one, resetting first if the thread
// moved. Returns everything to draft from.
function dkAccumulateIntent(intent: string, threadId: string): string {
  if (threadId !== dkPlanThreadId) {
    dkPlanIntent = '';
    dkPlanThreadId = threadId;
  }
  const next = String(intent || '').trim();
  if (next) dkPlanIntent = dkPlanIntent ? dkPlanIntent + '\n' + next : next;
  return dkPlanIntent;
}

// Tear down any chart/map a proposal card drew BEFORE detaching it. A chart
// proposal renders through the shared renderVizInArea, which registers the
// instance in the chartInstances WeakMap keyed on the container — and for a
// map_bubble/map_choropleth encoding it spins up a real MapLibre map. A bare
// .remove() detaches the canvas but leaves the instance in the registry, and
// (chartRender.ts) "a leaked map holds a live WebGL context", of which a
// browser grants only a handful. Same idiom as renderResult.ts's own reset and
// dashGrid.ts's destroyDashCharts — the dock was the one .cv-viz-area host
// without it. Unchanged by the two-mount split: it walks the CARD's own
// subtree, so it tears down an Ask card exactly as it does a dock one.
function dkDestroyProposalCharts(root: HTMLElement): void {
  root.querySelectorAll('.cv-viz-area').forEach((el) => {
    try {
      const inst = chartInstances.get(el as HTMLElement);
      if (inst) {
        (Array.isArray(inst) ? inst : [inst]).forEach((c: any) => { try { c.destroy(); } catch (_) {} });
        chartInstances.delete(el as HTMLElement);
      }
    } catch (_) { /* already gone */ }
    try { if (typeof destroyMapInContainer === 'function') destroyMapInContainer(el as HTMLElement); } catch (_) {}
  });
}

// Detach a proposal card, tearing down anything it drew first. Every removal
// path goes through here so no site can forget the teardown.
function dkRemoveProposalCard(card: HTMLElement): void {
  dkDestroyProposalCharts(card);
  card.remove();
}

// Remove any proposal left over from a previous turn, in ONE mount. Called
// before a new question is asked and whenever the transcript is rebuilt from
// disk truth — a proposal is never persisted (dismiss, or a new turn, leaves no
// trace). `containerId` defaults to the dock so every dock caller is unchanged;
// Ask passes 'xp-messages'.
function dkClearProposal(containerId = 'dk-messages'): void {
  document.querySelectorAll('#' + containerId + ' .dk-proposal').forEach((el) => dkRemoveProposalCard(el as HTMLElement));
}

// Entry point — called by dkSend() (dock.ts) and xpSend() (explore.ts) after a
// successful answer. Silent on anything that doesn't pan out: no dataset in
// scope, no heuristic match, notReady, a failed suggestion, or an encoding that
// can't be drawn. The text answer already stands; a proposal is a bonus, never
// an error. `containerId` picks the mount — the dock by default, 'xp-messages'
// for Ask.
async function dkOfferProposal(
  ref: { kind: string; id: string },
  question: string,
  action: any,
  threadId: string,
  containerId = 'dk-messages',
): Promise<void> {
  if (!currentProjectId) return;
  const kind = action && typeof action.kind === 'string' ? action.kind : 'none';
  if (kind === 'none') return;
  const intent = action && typeof action.intent === 'string' ? action.intent : '';

  // A DASHBOARD proposal works at any scope: analysis:draft takes the whole
  // project when no dataset is named, which is what "✨ Get started with AI"
  // already does, and dkContextRef reports whole-project for every section
  // except an open dataset or visual. Gating it on an open dataset would make
  // "build me a sales dashboard" silently do nothing on the Dashboards page —
  // the exact place someone would ask it.
  if (kind === 'dashboard') {
    try {
      const datasetId = ref && ref.kind === 'dataset' ? ref.id : '';
      await dkOfferDashboardProposal(datasetId, dkAccumulateIntent(intent || question, threadId), containerId);
    } catch (_) { /* a proposal is a bonus, never an error */ }
    return;
  }

  // The other three read a dataset's columns, so they still need one open.
  if (!ref || ref.kind !== 'dataset' || !ref.id) return;
  try {
    if (kind === 'step') await dkOfferStepProposal(ref.id, containerId);
    else if (kind === 'calc') await dkOfferCalcFieldProposal(ref.id, containerId);
    else if (kind === 'chart') await dkOfferChartProposal(ref.id, intent || question, containerId);
  } catch (_) { /* a proposal is a bonus, never an error */ }
}

// ── Shared card scaffold ─────────────────────────────────────────────────────
// Reuses .ai-interp (mkAiPanel, dashAi.ts) for the badge/box look every other
// AI surface has — no second badge style.
function dkProposalCard(labelText: string): { card: HTMLElement; actions: HTMLElement } {
  const card = document.createElement('div');
  card.className = 'ai-interp dk-proposal';
  card.appendChild(mkAiPanel(labelText));
  const actions = document.createElement('div');
  actions.className = 'dk-proposal-actions';
  return { card, actions };
}

function dkAppendProposal(card: HTMLElement, containerId = 'dk-messages'): void {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.appendChild(card);
  xpScrollToBottom(containerId);
}

function dkMkBtn(label: string, primary: boolean, cb: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'btn btn-primary' : 'btn';
  b.textContent = label;
  b.addEventListener('click', cb);
  return b;
}

// ── 1. Prepare step — appends ONE step, never replaces the pipeline ─────────
async function dkOfferStepProposal(datasetId: string, containerId = 'dk-messages'): Promise<void> {
  let res: any;
  try {
    res = await window.hub.suggestDatasetSteps(currentProjectId, datasetId);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady || !Array.isArray(res.steps) || !res.steps.length) return;
  dkRenderStepCard(datasetId, res.steps[0], containerId); // first of possibly several — one proposal per turn
}

function dkRenderStepCard(datasetId: string, step: any, containerId = 'dk-messages'): void {
  const { card, actions } = dkProposalCard('Suggested step — review before it changes the pipeline');
  const body = document.createElement('div');
  body.className = 'ai-interp-body';
  body.textContent = stepSummaryText(step); // reused verbatim (prepare.ts) — no second summariser
  card.appendChild(body);

  const dismiss = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  const apply = dkMkBtn('Apply', true, () => {
    void (async () => {
      if (!currentProjectId) return;
      apply.disabled = true;
      dismiss.disabled = true;
      let res: any;
      try {
        // APPEND one step. Never setDatasetSteps — that replaces the whole pipeline.
        res = await window.hub.addDatasetStep(currentProjectId, datasetId, step);
      } catch (_) {
        res = { ok: false, error: 'Could not add the step.' };
      }
      if (!res || res.ok === false) {
        apply.disabled = false;
        dismiss.disabled = false;
        body.textContent = (res && res.error) || 'Could not add the step.';
        return;
      }
      // The mutation above already landed regardless of what's on screen — this
      // is only about making it VISIBLE. The dock persists across sections, so
      // expId may not even be this dataset any more; reopen it fresh (idempotent
      // if it already is) so applyStepResult (prepare.ts) refreshes the RIGHT
      // preview/steps-list/explorer rather than silently repainting whatever
      // happened to be open.
      if (typeof selectSection === 'function') selectSection('datasets');
      if (typeof openSavedDataset === 'function') await openSavedDataset(datasetId);
      if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-prepare', true);
      if (typeof applyStepResult === 'function') applyStepResult(res);
      const stepCount = res.dataset && Array.isArray(res.dataset.steps) ? res.dataset.steps.length : null;
      actions.remove();
      const note = document.createElement('div');
      note.className = 'ai-interp-hint';
      note.textContent = stepCount
        ? 'Added as step ' + stepCount + '. Remove it in Prepare to undo.'
        : 'Added. Remove it in Prepare to undo.';
      card.appendChild(note);
    })();
  });
  actions.appendChild(apply);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}

// ── 2. Calculated field — Apply opens the editor prefilled; it never appends ─
async function dkOfferCalcFieldProposal(datasetId: string, containerId = 'dk-messages'): Promise<void> {
  let res: any;
  try {
    res = await window.hub.suggestCalcField(currentProjectId, datasetId);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady || !res.expression) return;
  dkRenderCalcFieldCard(datasetId, res, containerId);
}

function dkRenderCalcFieldCard(datasetId: string, res: any, containerId = 'dk-messages'): void {
  const step = { type: 'calculated_field', name: res.name, expression: res.expression };
  const { card, actions } = dkProposalCard('Suggested calculated field — review before it’s added');
  const body = document.createElement('div');
  body.className = 'ai-interp-body';
  body.textContent = stepSummaryText(step); // same summariser as the step card
  card.appendChild(body);
  if (res.warning) {
    const warn = document.createElement('div');
    warn.className = 'ai-interp-hint';
    warn.textContent = String(res.warning);
    card.appendChild(warn);
  }

  const dismiss = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  // Apply does NOT apply — it opens the SAME step editor prepare.ts's own
  // "Suggest a calculated field" uses, prefilled, so the user reviews the
  // formula and clicks the editor's own Save. This never calls addDatasetStep.
  const apply = dkMkBtn('Apply', true, () => {
    void (async () => {
      if (!currentProjectId) return;
      apply.disabled = true;
      // Reopen the dataset fresh (idempotent if it's already the one showing) —
      // the dock persists across sections, so whatever was open when the
      // question was asked may not be what's on screen now. This guarantees
      // the editor lands on the RIGHT dataset regardless.
      if (typeof selectSection === 'function') selectSection('datasets');
      if (typeof openSavedDataset === 'function') await openSavedDataset(datasetId);
      if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-prepare', true);
      // Prepare owns the positional .ds-step-input contract (buildStepForm), so
      // the prefill lives THERE and both AI entry points call it — a second copy
      // here would silently prefill the wrong inputs the day a field is added.
      if (typeof prefillCalcFieldEditor !== 'function') { apply.disabled = false; return; }
      prefillCalcFieldEditor(res.name, res.expression, res.warning);
      dkRemoveProposalCard(card); // handed off to Prepare's own editor — nothing left to apply/dismiss here
    })();
  });
  actions.appendChild(apply);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}

// ── 3. A chart — computed by main, drawn with the same path visual cards use ─
// ── Dashboard proposal — the plan pipeline, mounted in the conversation ─────
//
// This is the whole point of the branch: "build me a sales dashboard for Adidas
// US Sales" produces a REVIEWABLE PLAN in the chat, not a paragraph about one.
//
// It adds no AI path and no charting code. `analysis:draft` is the same channel
// the Dashboards wizard uses; main runs validatePlan → previewPlan, so every
// tile below carries the exact {labels, series} the app computed with the same
// function that will draw the built Visual. The model contributed the structure
// and the captions, and nothing else.
//
// Silent on everything that does not pan out — no model, nothing draftable, a
// plan with no sheets. The answer already stands; a proposal is a bonus.
async function dkOfferDashboardProposal(datasetId: string, intent: string, containerId = 'dk-messages'): Promise<void> {
  let res: any;
  try {
    // No datasetId → the whole project. loadPlanContext then shows the model
    // every dataset and lets the plan name the one it wants, which beats
    // guessing "most recent" and silently drafting against the wrong table.
    res = await window.hub.draftDashboard(currentProjectId, {
      datasetId: datasetId || undefined,
      intent: intent || undefined,
    });
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady) return;
  const sheets: any[] = Array.isArray(res.sheets) ? res.sheets : [];
  // Nothing survived validation — say nothing rather than offer an empty plan.
  if (!sheets.length && !(Array.isArray(res.dropped) && res.dropped.length)) return;
  dkRenderPlanCard(res, containerId);
}

// The proposal card. Title, one line of rationale, the previewed tiles, and
// everything the app REFUSED — then two ways forward and a way out.
function dkRenderPlanCard(res: any, containerId = 'dk-messages'): void {
  const { card, actions } = dkProposalCard('Suggested dashboard');

  const name = document.createElement('div');
  name.className = 'dk-plan-name';
  name.textContent = res && res.name ? String(res.name) : 'AI dashboard';
  card.appendChild(name);

  if (res && typeof res.rationale === 'string' && res.rationale.trim()) {
    const why = document.createElement('div');
    why.className = 'ai-interp-body';
    why.textContent = String(res.rationale);
    card.appendChild(why);
  }

  // The tiles. anDraftVisualEl (anDraft.ts) is the SAME renderer the review
  // modal uses — it draws `v.data` through renderVizInArea when the app computed
  // one and shows `v.note` verbatim when it could not, drawing nothing. A
  // placeholder number is never substituted, and that rule does not soften
  // because the tile is small. `.dk-plan-grid` only shrinks it, in CSS.
  const sheets: any[] = Array.isArray(res && res.sheets) ? res.sheets : [];
  const grid = document.createElement('div');
  grid.className = 'dk-plan-grid';
  sheets.forEach((sheet: any) => {
    const visuals: any[] = Array.isArray(sheet && sheet.visuals) ? sheet.visuals : [];
    visuals.forEach((v: any) => {
      if (typeof anDraftVisualEl === 'function') grid.appendChild(anDraftVisualEl(v));
    });
  });
  if (grid.childNodes.length) card.appendChild(grid);

  // Always visible, never behind a toggle — same renderer as the modal, so the
  // two surfaces cannot drift into one of them quietly hiding it.
  if (typeof anDraftAppendDropped === 'function') anDraftAppendDropped(card, res && res.dropped);

  const build = dkMkBtn('Build dashboard', true, () => {
    void (async () => {
      if (!currentProjectId) return;
      build.disabled = true;
      try {
        // anBuildDraft is the review modal's own build half. The card the user
        // just read IS the review, so it is called directly and the modal is
        // skipped — but the plan-vs-sheets decision stays in one place.
        await anBuildDraft(res);
      } catch (_) {
        build.disabled = false;
        showToast('Could not build that dashboard.');
        return;
      }
      // Built and navigated to. The plan is finished with, so a later question
      // starts a fresh one rather than refining this.
      dkResetPlanIntent();
      dkRemoveProposalCard(card);
    })();
  });
  actions.appendChild(build);

  // "Adjust…" hands the accumulated intent back to the composer so the user can
  // edit the words that produced this, rather than having to remember them.
  const adjust = dkMkBtn('Adjust…', false, () => {
    const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
    if (input) {
      input.value = dkPlanIntent || (res && res.name ? String(res.name) : '');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* not focusable yet */ }
    }
  });
  actions.appendChild(adjust);

  const dismiss = dkMkBtn('Dismiss', false, () => {
    dkResetPlanIntent();
    dkRemoveProposalCard(card);
  });
  actions.appendChild(dismiss);

  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}

async function dkOfferChartProposal(datasetId: string, question: string, containerId = 'dk-messages'): Promise<void> {
  let res: any;
  try {
    res = await window.hub.suggestVisual(currentProjectId, datasetId, question);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady) return;
  const options = Array.isArray(res.options) ? res.options : [];
  if (!options.length) return;
  const option = options[0]; // first of possibly several — one proposal per turn

  let dataRes: any;
  try {
    dataRes = await window.hub.computeVisualData(currentProjectId, datasetId, option.encoding, []);
  } catch (_) {
    return;
  }
  const data = dataRes && dataRes.ok !== false ? dataRes.data : null;
  // Can't draw it → stay silent rather than show a broken tile: the dock only
  // ever offers ONE proposal, so there is no gallery to fall back to within.
  if (!data || !Array.isArray(data.labels) || !data.labels.length) return;

  const eligible = eligibleChartTypes(dataRes.recommendedShape, countNumericSeries(data), data.labels.length);
  const type = eligible.indexOf(option.chartType) >= 0 ? option.chartType : (eligible[0] || 'table');
  dkRenderChartCard(datasetId, question, option, data, type, containerId);
}

// A one-sheet analysis payload holding a single visual card — the same shape
// the Analyses UI produces for "New analysis… + add this visual"
// (vizGallery.ts handleAddVisualToAnalysis: one Sheet, one visual card, the
// grid editor's own 6×6 default at nextFreeRow of an empty sheet, i.e. y:0).
// analysis:create sanitises this through saveAnalysis → sanitizePages, so a
// malformed card would be dropped rather than trusted; a UUID visualId is what
// keeps it. Kept as its own function so "what a turn-into-analysis writes" is
// one named, reviewable thing.
function dkAnalysisSheets(visualId: string): any[] {
  return [{
    id: dashUuid(),
    name: 'Sheet 1',
    cards: [{ id: dashUuid(), type: 'visual', visualId: String(visualId), layout: { x: 0, y: 0, w: 6, h: 6 } }],
  }];
}

// Turn a proposed chart into real, saved, editable work: save the visual, wrap
// it in a fresh one-sheet analysis named from the user's QUESTION (never model
// text — `name` is derived in dkRenderChartCard the same way xpVisualName is),
// then NAVIGATE there so the user SEES it. Reversible: it is a new record they
// can delete, which is the whole safety story. Grounded entirely in existing
// IPC (saveVisual + analysis:create) — no new channel. Returns true on success.
async function dkTurnIntoAnalysis(datasetId: string, name: string, chartType: string, encoding: any): Promise<boolean> {
  if (!currentProjectId) return false;
  // 1. saveVisual — exactly what "Save as visual" / "Add to dashboard" do.
  let vis: any;
  try {
    vis = await window.hub.saveVisual({
      projectId: currentProjectId, datasetId, name, chartType,
      encoding, overrides: {}, filters: [],
    });
  } catch (_) {
    vis = null;
  }
  if (!vis || vis.ok === false || !vis.id) return false;

  // 2. analysis:create with that one visual on one sheet. `analysis:create`
  //    accepts sheets straight in, so this is a single write, not create-then-
  //    update — the same record the Analyses UI would build by value.
  let an: any;
  try {
    an = await window.hub.createAnalysis({ projectId: currentProjectId, name, sheets: dkAnalysisSheets(String(vis.id)) });
  } catch (_) {
    an = null;
  }
  if (!an || an.ok === false || !an.id) return false;

  // 3. Navigate to the new analysis through the SAME router the Analyses
  //    section and the recent-item strip use (workspace.ts selectSection +
  //    anNew.ts openAnalysis) — so the user lands on the authoring surface with
  //    their chart already on it.
  if (typeof selectSection === 'function') selectSection('analyses');
  if (typeof openAnalysis === 'function') await openAnalysis(String(an.id));
  return true;
}

function dkRenderChartCard(datasetId: string, question: string, option: any, data: any, type: string, containerId = 'dk-messages'): void {
  const { card, actions } = dkProposalCard('Suggested chart');
  if (option.why) {
    const why = document.createElement('div');
    why.className = 'ai-interp-body';
    why.textContent = String(option.why);
    card.appendChild(why);
  }

  // .cv-viz-area (not just a bespoke class) so dock.ts's existing canvas
  // resize nudge — which already walks every .cv-viz-area on open/close —
  // picks this tile up for free; no new resize wiring needed for Task 3.
  const area = document.createElement('div');
  area.className = 'dk-proposal-chart cv-viz-area';
  card.appendChild(area);
  // entry: null opts the tile out of the ⋯ Customize menu — same as the
  // "✨ Suggest with the Assistant" preview in vizNew.ts. Every number came from
  // computeVisualData above; nothing here is drawn from what the model said.
  renderVizInArea(area, data, type, null, '');

  // The name is the user's QUESTION, bounded — never model text — with the
  // app's encoding-derived name as the fallback for an empty question. This is
  // xpVisualName's exact rule (exploreChart.ts, now retired), reused so the
  // saved visual and the analysis share one honest, user-derived title.
  const name = truncate(question.trim(), 60) || (typeof suggestVisualName === 'function' ? suggestVisualName(option.encoding, type) : 'Untitled visual');

  const finish = (msg: string): void => {
    actions.remove();
    showToast(msg);
    dkRemoveProposalCard(card);
  };

  const save = dkMkBtn('Save as visual', true, () => {
    void (async () => {
      if (!currentProjectId) return;
      save.disabled = true;
      let res: any;
      try {
        res = await window.hub.saveVisual({
          projectId: currentProjectId, datasetId, name, chartType: type,
          encoding: option.encoding, overrides: {}, filters: [],
        });
      } catch (_) {
        res = null;
      }
      if (!res || res.ok === false || !res.id) {
        save.disabled = false;
        showToast('Could not save the visual.');
        return;
      }
      finish('Saved as visual — find it in Visuals.');
    })();
  });
  actions.appendChild(save);

  // "Add to dashboard" is offered ONLY when a dashboard/analysis sheet is
  // actually open — pushCard (dashAdd.ts) appends to dashCurrentPage(), which
  // is null with nothing open, and this card can appear anywhere (the dock is
  // section-wide; Ask has no sheet at all). Calling pushCard with a null page
  // would throw into the smoke run's zero-console-error gate. Option (b) of the
  // brief: rather than grow a "create a dashboard first" flow, we OMIT the
  // button when there is no page and rely on "Turn into analysis" below, which
  // is always available and gives the chart a saved home either way.
  const page = typeof dashCurrentPage === 'function' ? dashCurrentPage() : null;
  if (page && !dashReadOnly) {
    const addBtn = dkMkBtn('Add to dashboard', false, () => {
      void (async () => {
        if (!currentProjectId) return;
        addBtn.disabled = true;
        let res: any;
        try {
          res = await window.hub.saveVisual({
            projectId: currentProjectId, datasetId, name, chartType: type,
            encoding: option.encoding, overrides: {}, filters: [],
          });
        } catch (_) {
          res = null;
        }
        if (!res || res.ok === false || !res.id) {
          addBtn.disabled = false;
          showToast('Could not add to the dashboard.');
          return;
        }
        pushCard({ id: dashUuid(), type: 'visual', visualId: String(res.id), layout: { x: 0, y: nextFreeRow(), w: 6, h: 6 } });
        finish('Added to the dashboard.');
      })();
    });
    actions.appendChild(addBtn);
  }

  // "Turn into analysis" — the always-available route from a chat answer to
  // real, saved, editable work. Offered on EVERY chart card (Part C: an
  // additional button, not a fourth mutually-exclusive proposal type), because
  // an analysis is a saved home for a chart no matter what section you asked
  // from. On success we navigate away, so there is nothing to finish() — the
  // card leaves with the section change; on failure we re-enable and toast,
  // matching the two buttons above (the answer itself still stands).
  const analyse = dkMkBtn('Turn into dashboard', false, () => {
    void (async () => {
      if (!currentProjectId) return;
      analyse.disabled = true;
      let done = false;
      try {
        done = await dkTurnIntoAnalysis(datasetId, name, type, option.encoding);
      } catch (_) {
        done = false;
      }
      if (!done) {
        analyse.disabled = false;
        showToast('Could not turn that into a dashboard.');
        return;
      }
      // Navigated to the new analysis — tear the card down so no leaked chart
      // instance survives the section change (dkRemoveProposalCard runs the
      // same teardown a dismiss would).
      dkRemoveProposalCard(card);
    })();
  });
  actions.appendChild(analyse);

  const dismiss = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  actions.appendChild(dismiss);
  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}
