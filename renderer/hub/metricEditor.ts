'use strict';

// The metric editor — one dialog for the whole definition.
// Classic global-scope renderer <script>: no import/export.
//
// Name, dataset, definition (Simple or Formula), filters, format, description,
// direction — in one 640px modal with a live figure, because a definition you
// cannot see the result of is a definition you have to save to check.
//
// THE PREVIEW IS MAIN'S. `window.hub.previewMetric` runs the same resolver and
// the same formatter the saved record will use, so the number and the string in
// the preview are the number and the string the card will show. Nothing here
// computes or formats a figure — see src/analysis/metricFormat.ts's header.
//
// Modal shell, focus trap and Escape are `makeModalAccessible` + `.ws-modal`,
// the same as every other dialog in the hub (dashAdd.ts's is the closest
// relative). Filters open `openFilterDialog` (filterDialog.ts) rather than a
// second filter UI.

const ME_AGGS: string[] = ['sum', 'avg', 'count', 'min', 'max'];
const ME_AGG_LABELS: Record<string, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max',
};
const ME_FORMAT_KINDS: Array<[string, string]> = [
  ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent'], ['duration', 'Duration'],
];
const ME_DIRECTIONS: Array<[string, string]> = [
  ['', 'No opinion'], ['up_good', 'Up is good'], ['down_good', 'Down is good'],
];

/** Debounce for the live preview — long enough that typing a formula does not
 *  fire a query per keystroke, short enough to feel live. */
const ME_PREVIEW_MS = 300;

function meField(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = document.createElement('label');
  row.className = 'me-field';
  const span = document.createElement('span');
  span.className = 'me-field-label';
  span.textContent = labelText;
  row.appendChild(span);
  row.appendChild(control);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'me-field-hint';
    h.textContent = hint;
    row.appendChild(h);
  }
  return row;
}

/**
 * Open the editor. `existing` null → a new metric.
 *
 * A draft WITHOUT an `id` is a prefill, not a record: the dialog creates rather
 * than updates, with its boxes already filled. That is what "Save as metric…"
 * on a KPI card hands in (metricsPage.ts's `promoteToMetric`), and it is why
 * every update path below tests `existing.id` rather than `existing`.
 *
 * Resolves with the saved record, or null if cancelled. Saving goes through
 * main, which is also where a duplicate NAME is refused — the error comes back
 * as a string and is shown in the dialog rather than closing it, because the
 * user's work is still in the boxes.
 */
function openMetricEditor(existing: any, opts: { datasetId?: string } = {}): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    const editingId: string = existing && existing.id ? String(existing.id) : '';

    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal me-modal';

    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = editingId ? 'Edit metric' : 'New metric';
    box.appendChild(h);

    // ── State ────────────────────────────────────────────────────────────────
    const def = (existing && existing.definition) || {};
    let mode: 'simple' | 'formula' = typeof def.formula === 'string' && def.formula ? 'formula' : 'simple';
    let aggregation: string = ME_AGGS.includes(def.aggregation) ? def.aggregation : 'sum';
    let filters: any[] = Array.isArray(existing && existing.filters) ? existing.filters.slice() : [];
    let columns: any[] = [];

    // ── Name ─────────────────────────────────────────────────────────────────
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ws-modal-input';
    nameInput.placeholder = 'Revenue';
    nameInput.value = existing ? String(existing.name || '') : '';
    box.appendChild(meField('Name', nameInput, 'Formulas reference a metric by this name.'));

    // ── Dataset ──────────────────────────────────────────────────────────────
    const dsSel = document.createElement('select');
    dsSel.className = 'ws-modal-input';
    // Immutable once saved: every card and rule pointing here was written about
    // THIS dataset's numbers, so a re-target is a new metric.
    if (editingId) dsSel.disabled = true;
    box.appendChild(meField('Dataset', dsSel, editingId ? 'A metric cannot change dataset — duplicate it instead.' : ''));

    // ── Definition: two tabs ─────────────────────────────────────────────────
    const tabs = document.createElement('div');
    tabs.className = 'me-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Definition');
    const simpleTab = document.createElement('button');
    const formulaTab = document.createElement('button');
    [['Simple', simpleTab], ['Formula', formulaTab]].forEach(([label, btn]) => {
      const b = btn as HTMLButtonElement;
      b.type = 'button';
      b.className = 'me-tab';
      b.setAttribute('role', 'tab');
      b.textContent = label as string;
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    // Simple pane
    const simplePane = document.createElement('div');
    simplePane.className = 'me-pane';
    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';
    simplePane.appendChild(meField('Column', colSel));

    const aggRow = document.createElement('div');
    aggRow.className = 'dm-aggs';
    aggRow.setAttribute('role', 'radiogroup');
    aggRow.setAttribute('aria-label', 'Aggregation');
    const paintAggs = (): void => {
      aggRow.querySelectorAll('.dm-agg').forEach((b) => {
        const on = (b as HTMLElement).dataset.agg === aggregation;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    ME_AGGS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-agg';
      b.dataset.agg = a;
      b.setAttribute('role', 'radio');
      b.textContent = ME_AGG_LABELS[a];
      b.addEventListener('click', () => { aggregation = a; paintAggs(); schedulePreview(); });
      aggRow.appendChild(b);
    });
    simplePane.appendChild(meField('Aggregation', aggRow));
    box.appendChild(simplePane);

    // Formula pane
    const formulaPane = document.createElement('div');
    formulaPane.className = 'me-pane';
    const formulaInput = document.createElement('textarea');
    formulaInput.className = 'ws-modal-input me-formula';
    formulaInput.rows = 3;
    formulaInput.spellcheck = false;
    formulaInput.placeholder = '[Profit] / [Revenue]';
    formulaInput.value = typeof def.formula === 'string' ? def.formula : '';
    formulaPane.appendChild(meField(
      'Formula', formulaInput,
      'Other metrics by name in [brackets], or an aggregation of a column — sum(revenue) - sum(cost).',
    ));
    // The metric names available, so the reference does not have to be
    // remembered. A chip inserts it at the caret.
    const refRow = document.createElement('div');
    refRow.className = 'me-refs';
    formulaPane.appendChild(refRow);
    box.appendChild(formulaPane);

    // ── Filters ──────────────────────────────────────────────────────────────
    const filterWrap = document.createElement('div');
    filterWrap.className = 'me-filters';
    const filterList = document.createElement('div');
    filterList.className = 'me-filter-list';
    const addFilter = document.createElement('button');
    addFilter.type = 'button';
    addFilter.className = 'btn btn-sm';
    addFilter.textContent = 'Add filter';
    filterWrap.appendChild(filterList);
    filterWrap.appendChild(addFilter);
    box.appendChild(meField('Filters', filterWrap, 'Applied before the aggregation — part of what the metric means.'));

    const paintFilters = (): void => {
      filterList.innerHTML = '';
      filters.forEach((s, i) => {
        const chip = document.createElement('span');
        chip.className = 'me-filter-chip';
        chip.textContent = `${s.column} ${s.op} ${s.values ? s.values.join(', ') : (s.value == null ? '' : s.value)}`.trim();
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'me-filter-rm';
        rm.setAttribute('aria-label', 'Remove filter');
        rm.textContent = '×';
        rm.addEventListener('click', () => { filters.splice(i, 1); paintFilters(); schedulePreview(); });
        chip.appendChild(rm);
        filterList.appendChild(chip);
      });
    };
    addFilter.addEventListener('click', async () => {
      const col = columns.find((c) => c.name === colSel.value) || columns[0];
      if (!col) return;
      const steps = await openFilterDialog({
        projectId: currentProjectId, datasetId: dsSel.value, column: col.name, type: col.type,
      });
      if (!steps || !steps.length) return;
      filters = filters.concat(steps);
      paintFilters();
      schedulePreview();
    });

    // ── Format ───────────────────────────────────────────────────────────────
    const fmtRow = document.createElement('div');
    fmtRow.className = 'me-format';
    const kindSel = document.createElement('select');
    kindSel.className = 'ws-modal-input me-format-kind';
    ME_FORMAT_KINDS.forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      kindSel.appendChild(o);
    });
    const decInput = document.createElement('input');
    decInput.type = 'number';
    decInput.min = '0';
    decInput.max = '6';
    decInput.className = 'ws-modal-input me-format-dec';
    decInput.setAttribute('aria-label', 'Decimal places');
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.className = 'ws-modal-input me-format-affix';
    prefixInput.placeholder = 'Prefix';
    prefixInput.setAttribute('aria-label', 'Prefix');
    const suffixInput = document.createElement('input');
    suffixInput.type = 'text';
    suffixInput.className = 'ws-modal-input me-format-affix';
    suffixInput.placeholder = 'Suffix';
    suffixInput.setAttribute('aria-label', 'Suffix');
    const compactWrap = document.createElement('label');
    compactWrap.className = 'me-compact';
    const compactBox = document.createElement('input');
    compactBox.type = 'checkbox';
    const compactText = document.createElement('span');
    compactText.textContent = 'Compact';
    compactWrap.appendChild(compactBox);
    compactWrap.appendChild(compactText);
    [kindSel, decInput, prefixInput, suffixInput, compactWrap].forEach((el) => fmtRow.appendChild(el));
    box.appendChild(meField('Format', fmtRow));

    const fmt = (existing && existing.format) || {};
    kindSel.value = ME_FORMAT_KINDS.some(([k]) => k === fmt.kind) ? fmt.kind : 'number';
    decInput.value = String(typeof fmt.decimals === 'number' ? fmt.decimals : 0);
    prefixInput.value = fmt.prefix || '';
    suffixInput.value = fmt.suffix || '';
    compactBox.checked = fmt.compact === true;

    // ── Description + direction ──────────────────────────────────────────────
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'ws-modal-input';
    descInput.placeholder = 'What this number means, for whoever reads it next';
    descInput.value = existing && existing.description ? String(existing.description) : '';
    box.appendChild(meField('Description', descInput));

    const dirSel = document.createElement('select');
    dirSel.className = 'ws-modal-input';
    ME_DIRECTIONS.forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      dirSel.appendChild(o);
    });
    dirSel.value = existing && existing.direction ? existing.direction : '';
    box.appendChild(meField('Direction', dirSel, 'Which way is good news, for the surfaces that colour a change.'));
    // Tags and owner live in the catalog (catalogDetails.ts); the description above stays the metric's own.
    if (editingId) box.appendChild(ctMetricDetailsRow(editingId, String((existing && existing.name) || '')));

    // ── The live preview ─────────────────────────────────────────────────────
    const preview = document.createElement('div');
    preview.className = 'me-preview';
    const prevVal = document.createElement('div');
    prevVal.className = 'dash-metric-value tnum';
    prevVal.textContent = '—';
    const prevText = document.createElement('div');
    prevText.className = 'dash-metric-label me-preview-def';
    preview.appendChild(prevVal);
    preview.appendChild(prevText);
    box.appendChild(preview);

    const err = document.createElement('p');
    err.className = 'me-error';
    err.hidden = true;
    box.appendChild(err);

    // ── Current values ───────────────────────────────────────────────────────
    const readFormat = (): any => ({
      kind: kindSel.value,
      decimals: Number(decInput.value) || 0,
      prefix: prefixInput.value,
      suffix: suffixInput.value,
      compact: compactBox.checked,
    });
    const readDefinition = (): any => (mode === 'formula'
      ? { formula: formulaInput.value }
      : { column: colSel.value, aggregation });

    let previewTimer = 0;
    let previewSeq = 0;
    const runPreview = async (): Promise<void> => {
      const seq = ++previewSeq;
      if (!currentProjectId || !dsSel.value) { prevVal.textContent = '—'; return; }
      prevVal.textContent = '…';
      let r: any;
      try {
        r = await window.hub.previewMetric(
          currentProjectId, dsSel.value, readDefinition(), filters, readFormat(),
        );
      } catch (_) {
        r = null;
      }
      // Generation-counted: a slow reply for the previous definition must not
      // paint over the current one.
      if (seq !== previewSeq) return;
      prevVal.textContent = r && r.ok !== false ? (r.display || '—') : '—';
      prevText.textContent = r && r.ok !== false ? (r.definitionText || '') : '';
    };
    function schedulePreview(): void {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => void runPreview(), ME_PREVIEW_MS);
    }

    const paintMode = (): void => {
      const isFormula = mode === 'formula';
      simpleTab.setAttribute('aria-selected', String(!isFormula));
      formulaTab.setAttribute('aria-selected', String(isFormula));
      simpleTab.classList.toggle('is-on', !isFormula);
      formulaTab.classList.toggle('is-on', isFormula);
      simplePane.hidden = isFormula;
      formulaPane.hidden = !isFormula;
      schedulePreview();
    };
    simpleTab.addEventListener('click', () => { mode = 'simple'; paintMode(); });
    formulaTab.addEventListener('click', () => { mode = 'formula'; paintMode(); });

    // ── Column + metric-name population ──────────────────────────────────────
    const loadColumns = async (): Promise<void> => {
      columns = [];
      colSel.innerHTML = '';
      if (!currentProjectId || !dsSel.value) return;
      // Metadata only — the same call dashAdd.ts's metric dialog makes. Nothing
      // here reads a row, so nothing here hydrates a table.
      let meta: any;
      try {
        meta = await window.hub.getDatasetMeta(currentProjectId, dsSel.value);
      } catch (_) {
        meta = null;
      }
      columns = meta && Array.isArray(meta.columns) ? meta.columns : [];
      columns.forEach((c: any) => {
        const o = document.createElement('option');
        o.value = c.name;
        o.textContent = c.name;
        colSel.appendChild(o);
      });
      if (def.column && columns.some((c: any) => c.name === def.column)) colSel.value = def.column;
      schedulePreview();
    };

    const loadRefs = async (): Promise<void> => {
      refRow.innerHTML = '';
      const list = await mpkList(dsSel.value);
      list.filter((m: any) => m.id !== editingId).slice(0, 12).forEach((m: any) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'me-ref-chip';
        chip.textContent = m.name;
        chip.title = m.definitionText || '';
        chip.addEventListener('click', () => {
          const at = formulaInput.selectionStart ?? formulaInput.value.length;
          const ref = `[${m.name}]`;
          formulaInput.value = formulaInput.value.slice(0, at) + ref + formulaInput.value.slice(at);
          formulaInput.focus();
          formulaInput.selectionStart = formulaInput.selectionEnd = at + ref.length;
          schedulePreview();
        });
        refRow.appendChild(chip);
      });
    };

    // ── Buttons ──────────────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = editingId ? 'Save' : 'Create metric';
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(actions);

    const finish = (value: any): void => {
      if (done) return;
      done = true;
      window.clearTimeout(previewTimer);
      if (a11y) a11y.release();
      overlay.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); return; }
      if (a11y) a11y.onTabKey(e);
    });

    save.addEventListener('click', async () => {
      err.hidden = true;
      const name = nameInput.value.trim();
      if (!name) { err.textContent = 'A metric needs a name.'; err.hidden = false; nameInput.focus(); return; }
      const payload = {
        name,
        datasetId: dsSel.value,
        definition: readDefinition(),
        filters,
        format: readFormat(),
        description: descInput.value,
        direction: dirSel.value,
      };
      save.disabled = true;
      let res: any;
      try {
        res = editingId
          ? await window.hub.updateMetric(currentProjectId, editingId, payload)
          : await window.hub.saveMetric(currentProjectId, payload);
      } catch (e: any) {
        res = { ok: false, error: (e && e.message) || 'Could not save the metric' };
      }
      save.disabled = false;
      if (!res || res.ok === false) {
        // Shown IN the dialog, not as a toast: the user's work is still in
        // these boxes and closing over it to report a name clash would lose it.
        err.textContent = (res && res.error) || 'Could not save the metric.';
        err.hidden = false;
        return;
      }
      finish(res.metric);
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, editingId ? 'Edit metric' : 'New metric', nameInput);
    paintAggs();
    paintMode();
    paintFilters();

    // Datasets last: the dialog is on screen first, and the selects fill in.
    void (async () => {
      let list: any[] = [];
      try {
        list = await window.hub.listDatasets(currentProjectId);
      } catch (_) {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      list.forEach((d: any) => {
        const o = document.createElement('option');
        o.value = String(d.id);
        o.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
        dsSel.appendChild(o);
      });
      const want = (existing && existing.datasetId) || opts.datasetId;
      if (want && list.some((d: any) => d.id === want)) dsSel.value = want;
      await loadColumns();
      await loadRefs();
    })();

    dsSel.addEventListener('change', () => { filters = []; paintFilters(); void loadColumns(); void loadRefs(); });
    colSel.addEventListener('change', schedulePreview);
    formulaInput.addEventListener('input', schedulePreview);
    [kindSel, decInput, prefixInput, suffixInput, compactBox].forEach((el) =>
      el.addEventListener('input', schedulePreview));
  });
}
