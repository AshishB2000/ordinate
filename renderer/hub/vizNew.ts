// "+ New visual": which dataset, then whether to describe what you want or open
// the builder yourself. When the AI proposes charts it DRAWS them, so you pick
// from real charts rather than accepting one sight-unseen — and every figure on
// screen is computed by the app, never by the model.
//
// Nothing is saved for you: picking one opens the builder.
//
// Split verbatim out of visuals.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── "+ New visual" popup ─────────────────────────────────────────────────────
// Step 1 asks WHICH dataset, step 2 asks HOW to build it, step 3 shows what the
// model proposed. The modal only RESOLVES a choice — it never creates, saves or
// navigates anything itself, so Escape / the backdrop / Cancel all resolve null
// and leave the project exactly as it was. Cloned from #viz-new-tpl per open, so
// the markup lives with the rest of the hub's HTML and every hook inside it is a
// `js-` class scoped to the clone.
//
// The builder's ✨ Suggest chart button opens this SAME modal straight at step 3
// (`opts.startAtSuggest`). One picker, one code path — not a second flow that
// could disagree with this one about what a proposal looks like.
interface VizNewChoice {
  kind: 'manual' | 'suggested';
  datasetId: string;
  encoding?: any; // 'suggested' only — already sanitized in main
  chartType?: string; // 'suggested' only
}

interface VizNewOpts {
  datasetId?: string; // preselect (the builder already knows its dataset)
  startAtSuggest?: boolean; // open straight at step 3 and ask immediately
  /**
   * Hide the "Build it myself" half of step 2, so the dialog is the AI door
   * only. Used by the analysis add-visual picker's ✨ action: the same flow,
   * the same handlers, just without the manual detour it has its own button
   * for. The step-3 fallback ("Build it myself instead") deliberately stays —
   * a failed suggestion still needs a way out.
   */
  aiOnly?: boolean;
}

async function openNewVisualModal(opts: VizNewOpts = {}): Promise<VizNewChoice | null> {
  let sets: any[] = [];
  try {
    sets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    sets = [];
  }
  if (!Array.isArray(sets)) sets = [];

  // Readiness comes from the ONE source main already exposes (publicConfig
  // .isReady = Local CLI OR BYOK) — the same gate analyses.ts asks. No new IPC
  // and no second definition of "ready" that could disagree with it.
  let aiReady = false;
  try {
    const st: any = await window.hub.getKeyStatus();
    aiReady = !!(st && st.isReady);
  } catch (_) {
    aiReady = false;
  }

  const tpl = document.getElementById('viz-new-tpl') as HTMLTemplateElement | null;
  if (!tpl || !tpl.content.firstElementChild) return null;
  const overlay = tpl.content.firstElementChild.cloneNode(true) as HTMLElement;
  const q = (sel: string): any => overlay.querySelector(sel);

  const box = q('.vn-modal');
  const step1 = q('.js-vn-step1');
  const step2 = q('.js-vn-step2');
  const step3 = q('.js-vn-step3');
  const rowsHost = q('.js-vn-rows');
  const noneEl = q('.js-vn-none');
  const backBtn = q('.js-vn-back');
  const intentEl = q('.js-vn-intent') as HTMLTextAreaElement;
  const askBtn = q('.js-vn-ask') as HTMLButtonElement;
  const noteEl = q('.js-vn-note');
  const optionsHost = q('.js-vn-options');
  const statusEl = q('.js-vn-status');
  const regenBtn = q('.js-vn-regen') as HTMLButtonElement;

  return new Promise<VizNewChoice | null>((resolve) => {
    let done = false;
    let selectedId = String(opts.datasetId || '');
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;

    function close(val: VizNewChoice | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release(); // hand focus back to the trigger
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (a11y) {
        a11y.onTabKey(e); // trap Tab inside the dialog
      }
    }

    // Step 1 is re-enterable: step 2's ← Back comes straight back here. When the
    // builder opened us at step 3 there is no step 1 to return to, so ← Back
    // goes to step 2 instead of stranding the user on a dataset list they were
    // never shown.
    function showStep(n: number): void {
      step1.hidden = n !== 1;
      step2.hidden = n !== 2;
      step3.hidden = n !== 3;
      backBtn.hidden = n === 1 || (n === 2 && !!opts.startAtSuggest);
      let first: HTMLElement | null = null;
      if (n === 1) {
        first = (rowsHost.querySelector('.vn-row') as HTMLElement | null) || (q('.js-vn-import') as HTMLElement);
      } else if (n === 2) {
        first = aiReady ? intentEl : (q('.js-vn-manual') as HTMLElement);
      } else {
        // Regenerate is disabled while the model is thinking, and focusing a
        // disabled button is a no-op that would strand focus outside the dialog.
        first = regenBtn.disabled ? (q('.js-vn-manual2') as HTMLElement) : regenBtn;
      }
      if (first) first.focus();
    }

    // ── Step 3: ask, then DRAW each proposal ────────────────────────────────
    // Every figure on screen here comes from window.hub.computeVisualData —
    // app-computed in main, off the stored Parquet. The model contributed the
    // encoding, the chart type and the caption, and no number at all.
    async function runSuggest(): Promise<void> {
      if (!selectedId) return;
      showStep(3);
      regenBtn.disabled = true;
      optionsHost.innerHTML = '';
      statusEl.textContent = 'Thinking…';

      let res: any;
      try {
        res = await window.hub.suggestVisual(currentProjectId, selectedId, intentEl.value.trim());
      } catch (_) {
        res = { ok: false };
      }
      if (done) return; // the user closed the modal while the model was thinking
      regenBtn.disabled = false;

      if (res && res.notReady) {
        statusEl.textContent = AI_NOT_CONFIGURED;
        return;
      }
      const options = res && res.ok && Array.isArray(res.options) ? res.options : [];
      if (!options.length) {
        statusEl.textContent = (res && res.error) || 'Could not suggest a chart.';
        return;
      }
      statusEl.textContent = 'Pick one to open it in the builder. Nothing is saved until you save it.';
      // Draw them concurrently: each is a resident query of a few ms, and a
      // serial loop would make three of them feel like one slow one.
      await Promise.all(options.map((o: any) => renderOption(o)));
    }

    async function renderOption(option: any): Promise<void> {
      const card = document.createElement('div');
      card.className = 'vn-option';
      const art = document.createElement('div');
      art.className = 'vn-option-art';
      const why = document.createElement('p');
      why.className = 'vn-option-why';
      why.textContent = String(option.why || '') || 'Suggested chart';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn btn-sm';
      use.textContent = 'Use this chart';
      use.disabled = true; // until it provably draws
      card.appendChild(art);
      card.appendChild(why);
      card.appendChild(use);
      optionsHost.appendChild(card);

      let data: any = null;
      let res: any;
      try {
        res = await window.hub.computeVisualData(currentProjectId, selectedId, option.encoding, []);
        if (res && res.ok !== false) data = res.data;
      } catch (_) {
        data = null;
      }
      if (done) return;

      // An option that cannot be drawn says so and stays unpickable — offering a
      // blank tile the user can pick would put a broken encoding in the builder.
      if (!data || !Array.isArray(data.labels) || !data.labels.length) {
        card.classList.add('is-broken');
        const note = document.createElement('span');
        note.className = 'vn-option-note';
        note.textContent = "Couldn't draw this one";
        art.appendChild(note);
        return;
      }

      // Which type actually gets drawn is CODE's decision, not the model's: if
      // the proposed type does not fit the data the app produced, the first
      // eligible one is used instead. Same eligibility the builder's picker runs.
      const eligible = eligibleChartTypes(res.recommendedShape, countNumericSeries(data), data.labels.length);
      const type = eligible.indexOf(option.chartType) >= 0 ? option.chartType : (eligible[0] || 'table');
      // A null entry is what turns the ⋯ Customize menu off (renderResult.ts):
      // a preview owns no overrides, so it needs no override key either.
      renderVizInArea(art, data, type, null, '');

      use.disabled = false;
      use.addEventListener('click', () =>
        close({ kind: 'suggested', datasetId: selectedId, encoding: option.encoding, chartType: type }));
    }

    sets.forEach((d) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'vn-row';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', 'false');
      const nm = document.createElement('span');
      nm.className = 'vn-row-name';
      nm.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      const meta = document.createElement('span');
      meta.className = 'vn-row-meta';
      const rows = typeof d.rowCount === 'number' ? d.rowCount.toLocaleString() : '—';
      const cols = typeof d.columnCount === 'number' ? String(d.columnCount) : '—';
      meta.textContent = rows + ' rows × ' + cols + ' columns';
      row.appendChild(nm);
      row.appendChild(meta);
      row.addEventListener('click', () => {
        selectedId = String(d.id);
        rowsHost.querySelectorAll('.vn-row').forEach((r: any) => r.setAttribute('aria-checked', 'false'));
        row.setAttribute('aria-checked', 'true');
        // "Start with AI" opened this with no dataset, so the choice made here
        // IS the missing input — go straight to asking rather than back to the
        // two doors the user already picked between.
        if (opts.startAtSuggest) runSuggest();
        else showStep(2);
      });
      rowsHost.appendChild(row);
    });
    rowsHost.hidden = sets.length === 0;
    noneEl.hidden = sets.length > 0;

    // No datasets: the one useful action is to go and import some. Leaves for
    // the existing Data section rather than re-hosting the import flow here.
    q('.js-vn-import').addEventListener('click', () => {
      close(null);
      if (typeof selectSection === 'function') selectSection('datasets');
    });

    if (opts.aiOnly) {
      const manualHalf = q('.js-vn-manual')?.closest('.vn-choice') as HTMLElement | null;
      if (manualHalf) manualHalf.hidden = true;
    }

    // Without a model the AI route is inert, and says why in the standard line.
    if (!aiReady) {
      askBtn.disabled = true;
      intentEl.disabled = true;
      noteEl.hidden = false;
      q('.js-vn-ai').classList.add('is-disabled');
    }

    askBtn.addEventListener('click', () => { runSuggest(); });
    regenBtn.addEventListener('click', () => { runSuggest(); });
    const goManual = (): void => {
      if (!selectedId) return;
      close({ kind: 'manual', datasetId: selectedId });
    };
    q('.js-vn-manual').addEventListener('click', goManual);
    q('.js-vn-manual2').addEventListener('click', goManual);

    backBtn.addEventListener('click', () => showStep(step3.hidden ? 1 : 2));
    q('.js-vn-cancel').addEventListener('click', () => close(null));
    q('.js-vn-x').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'New visual', null);
    // The builder already knows its dataset, so it skips straight to asking.
    if (opts.startAtSuggest && selectedId) runSuggest();
    else showStep(selectedId ? 2 : 1);
  });
}

// "+ New visual": ask first, then open the builder on the chosen dataset. A
// suggestion is applied to the form and NEVER saved — the user still reviews it.
async function handleNewVisual(opts: VizNewOpts = {}): Promise<void> {
  // Projects are demoted BY DESIGN: created implicitly, never picked, and there
  // is no project picker in the nav. So "Open a project first" was a dead end —
  // on a fresh install there are no projects and nothing on screen can make one.
  // Resolve (or create) one the same way the Home "+ New" entries do.
  if (!currentProjectId && !(await resolveProjectId())) {
    showToast('Could not create a workspace to save this in.');
    return;
  }
  const choice = await openNewVisualModal(opts);
  if (!choice) return; // cancelled — nothing was created
  await openVisualBuilder(choice.datasetId);
  if (choice.kind === 'suggested') applySuggestedEncoding(choice.encoding, choice.chartType || '');
}

