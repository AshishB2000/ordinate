// The AI draft: a REVIEWED plan that lands on an analysis. The model proposes
// structure and captions; src/analysisPlan.ts validates the envelope and the
// app computes every figure. You review before anything is built.
//
// Split verbatim out of analyses.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

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
    res = { ok: false, error: 'Could not draft a dashboard.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = label || '✨ AI draft dashboard'; }

  if (res && res.notReady) {
    window.alert('Connect a model in Execution settings to draft a dashboard.');
    return;
  }
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Could not draft a dashboard.');
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
  await anBuildDraft(res, preferredName);
}

/**
 * Build an already-APPROVED draft and open it. Split out of anMaterialiseDraft
 * so a caller that has already shown the user the plan does not show it twice:
 * the dock's dashboard proposal card IS the review (dockPropose.ts), so it
 * calls this directly and skips the modal above.
 *
 * The plan-vs-sheets decision below is the reason this is one function and not
 * two copies — that decision is exactly what the original comment warned would
 * drift.
 */
async function anBuildDraft(res: any, preferredName?: string): Promise<void> {
  if (!currentProjectId) return;

  // Two ways to materialise, decided by what main actually sent — never by a
  // version flag. A `plan` means the Phase E pipeline owns the write (it has to:
  // calculated fields and visuals are records this renderer cannot mint).
  // Otherwise the draft is already a sheet array and createAnalysis takes it.
  const name = (preferredName || '').trim() || res.name || 'AI dashboard';
  let saved: any = null;
  try {
    if (res.plan && typeof window.hub.buildAnalysisPlan === 'function') {
      // The plan carries the model's own name. If the user typed one in the
      // wizard first, that is the one they expect to see in the list.
      const planToBuild =
        (preferredName || '').trim() ? { ...res.plan, name } : res.plan;
      const built = await window.hub.buildAnalysisPlan(currentProjectId, planToBuild);
      if (built && built.ok === false) {
        window.alert(built.error || 'Failed to build the dashboard.');
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
  if (saved && saved.ok !== false && saved.id) {
    openAnalysisFrom(saved);
    return;
  }
  // The write may well have succeeded even if we cannot recognise what came
  // back — the refreshed list above is the honest fallback, and it is visible.
  window.alert((saved && saved.error) || 'The dashboard was not opened. Check the list below.');
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
    name.textContent = draft && draft.name ? String(draft.name) : 'AI dashboard';
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
    anDraftAppendDropped(scroll, draft && draft.dropped);

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
    foot.textContent = 'Every figure here was computed by the app, not written by the model. You can edit everything after it is created.';
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
    ok.textContent = 'Create dashboard';

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

// WHAT THE APP REFUSED, rendered wherever a plan is shown — the review modal and
// the dock's proposal card both call this, so neither can quietly stop showing
// it. `dropped` is never collapsed and never behind a toggle: a draft that hides
// its own mistakes flatters the model, and the user approves having seen only
// the parts that worked.
function anDraftAppendDropped(host: HTMLElement, raw: unknown): void {
  const dropped: any[] = Array.isArray(raw) ? raw : [];
  if (!dropped.length) return;
  host.appendChild(anDraftSectionLabel(
    dropped.length + (dropped.length === 1 ? ' thing was dropped' : ' things were dropped'),
  ));
  const why = document.createElement('div');
  why.className = 'an-draft-note';
  why.textContent = 'The app refused these because it could not verify them. They are listed so the draft is not flattered by hiding its own mistakes.';
  host.appendChild(why);
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
    host.appendChild(row);
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

