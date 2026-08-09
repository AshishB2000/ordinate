// Dock proposals — the reason the dock exists (Task 3,
// docs/superpowers/plans/2026-08-09-ai-dock.md). Classic global-scope
// renderer <script>: NO import/export. Loads AFTER dock.js (calls
// dkClearProposal/dkOfferProposal from dkSend), prepare.js (stepSummaryText,
// applyStepResult, prefillCalcFieldEditor), renderResult.js (renderVizInArea,
// eligibleChartTypes, countNumericSeries), dashGrid.js (dashCurrentPage,
// dashUuid, nextFreeRow), dashAdd.js (pushCard), dsExplorer.js
// (openSavedDataset) and dataSection.js (dxSelectTab) — see the load-order
// comment in index.html.
//
// Three fixed proposal types, each grounded in an existing IPC channel, each
// reversible, each requiring a click. ONE proposal per turn, decided by a
// cheap heuristic on the question/answer text — never a gallery, never more
// than one extra model call per turn.
//
// ⚠️ The one rule that matters most: a prepare-step proposal calls
// `addDatasetStep` (APPENDS one step) and NEVER `setDatasetSteps` (which
// REPLACES the whole pipeline — see applySuggestedSteps() in prepare.ts,
// correct for its own confirmed-batch flow, catastrophic here).

// ── Which type, if any, this turn offers ────────────────────────────────────
// ponytail: a keyword heuristic standing in for real intent detection — good
// enough to keep the dock to ONE proposal per turn without a second model call
// deciding what to ask the first model. Upgrade path: have copilot:ask itself
// return a `suggestedAction` alongside the answer once a miss rate is actually
// measured; guessing at that today would be speculative.
const DK_STEP_HINT_RE = /\b\d[\d,]*\s+rows?\b|\bblank\b|missing (value|data)|\bduplicate|empty (cell|value|row)|null value|inconsisten/i;
const DK_CALC_HINT_RE = /\bcalculat|\bformula|\bratio\b|\bmargin\b|per (unit|item|customer|order)|percentage|% of|difference between|\bdivide|\bmultiply|\bderive/i;
const DK_CHART_HINT_RE = /\bchart|\bgraph|\bplot\b|\btrend\b|over time|by (region|month|category|product|day|year|week)|\bbreakdown|\bdistribution|\bcompare|visuali[sz]e|top \d+/i;

function dkDecideProposalType(question: string, answerText: string): 'step' | 'calc' | 'chart' | null {
  const q = String(question || '');
  const a = String(answerText || '');
  // The step signal comes from the ANSWER (the app's own computed facts, e.g.
  // "412 rows have a blank region" — the brief's own example) — it is the most
  // concrete of the three. The other two come from the QUESTION, since nothing
  // in a text answer implies "draw this" or "add a formula".
  if (DK_STEP_HINT_RE.test(a)) return 'step';
  if (DK_CALC_HINT_RE.test(q)) return 'calc';
  if (DK_CHART_HINT_RE.test(q)) return 'chart';
  return null;
}

// Tear down any chart/map a proposal card drew BEFORE detaching it. A chart
// proposal renders through the shared renderVizInArea, which registers the
// instance in the chartInstances WeakMap keyed on the container — and for a
// map_bubble/map_choropleth encoding it spins up a real MapLibre map. A bare
// .remove() detaches the canvas but leaves the instance in the registry, and
// (chartRender.ts) "a leaked map holds a live WebGL context", of which a
// browser grants only a handful. Same idiom as renderResult.ts's own reset and
// dashGrid.ts's destroyDashCharts — the dock was the one .cv-viz-area host
// without it.
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

// Remove any proposal left over from a previous turn. Called before a new
// question is asked and whenever the transcript is rebuilt from disk truth —
// a proposal is never persisted (dismiss, or a new turn, leaves no trace).
function dkClearProposal(): void {
  document.querySelectorAll('#dk-messages .dk-proposal').forEach((el) => dkRemoveProposalCard(el as HTMLElement));
}

// Entry point — called by dkSend() (dock.ts) after a successful answer. Silent
// on anything that doesn't pan out: no dataset in scope, no heuristic match,
// notReady, a failed suggestion, or an encoding that can't be drawn. The text
// answer already stands; a proposal is a bonus, never an error.
async function dkOfferProposal(ref: { kind: string; id: string }, question: string, answerText: string): Promise<void> {
  if (!currentProjectId || !ref || ref.kind !== 'dataset' || !ref.id) return;
  const kind = dkDecideProposalType(question, answerText);
  if (!kind) return;
  try {
    if (kind === 'step') await dkOfferStepProposal(ref.id);
    else if (kind === 'calc') await dkOfferCalcFieldProposal(ref.id);
    else await dkOfferChartProposal(ref.id, question);
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

function dkAppendProposal(card: HTMLElement): void {
  const list = document.getElementById('dk-messages');
  if (!list) return;
  list.appendChild(card);
  xpScrollToBottom('dk-messages');
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
async function dkOfferStepProposal(datasetId: string): Promise<void> {
  let res: any;
  try {
    res = await window.hub.suggestDatasetSteps(currentProjectId, datasetId);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady || !Array.isArray(res.steps) || !res.steps.length) return;
  dkRenderStepCard(datasetId, res.steps[0]); // first of possibly several — one proposal per turn
}

function dkRenderStepCard(datasetId: string, step: any): void {
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
  dkAppendProposal(card);
}

// ── 2. Calculated field — Apply opens the editor prefilled; it never appends ─
async function dkOfferCalcFieldProposal(datasetId: string): Promise<void> {
  let res: any;
  try {
    res = await window.hub.suggestCalcField(currentProjectId, datasetId);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady || !res.expression) return;
  dkRenderCalcFieldCard(datasetId, res);
}

function dkRenderCalcFieldCard(datasetId: string, res: any): void {
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
  dkAppendProposal(card);
}

// ── 3. A chart — computed by main, drawn with the same path visual cards use ─
async function dkOfferChartProposal(datasetId: string, question: string): Promise<void> {
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
  dkRenderChartCard(datasetId, question, option, data, type);
}

function dkRenderChartCard(datasetId: string, question: string, option: any, data: any, type: string): void {
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
  // "✨ Suggest with AI" preview in vizNew.ts. Every number came from
  // computeVisualData above; nothing here is drawn from what the model said.
  renderVizInArea(area, data, type, null, '');

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

  // Only offered when a dashboard/analysis sheet is actually open — pushCard
  // (dashAdd.ts) appends to dashCurrentPage(), which is null with nothing
  // open, and the dock can be open anywhere, including nowhere. Omitting an
  // inapplicable action matches "a proposal only appears when its context
  // supports it".
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

  const dismiss = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  actions.appendChild(dismiss);
  card.appendChild(actions);
  dkAppendProposal(card);
}
