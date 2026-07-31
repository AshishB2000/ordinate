// Capture → dataset review UI (Week 13). Classic global-scope renderer <script> —
// NO import/export; symbols are shared with the other hub scripts. Turns a
// capture's extractedTable into a REVIEW-AND-CORRECT grid (edit a mis-read cell,
// rename a column, set a type, drop a column) and only saves when the user
// confirms. All edits live in renderer memory between one captureDataset:draft
// invoke (on open) and one captureDataset:save invoke (on confirm). NOTHING is
// coerced/computed here — the model EXTRACTS, main COMPUTES.
//
// Consumes: window.hub (bridge), currentProjectId (workspace.ts), showToast
// (hub.ts), refreshDatasetList (datasets.ts), selectSection (workspace.ts). No fs/
// Node. No inline style= (CSP); classes come from hub.css.

// Module-local recapture handoff. startRecapture() sets this, fires the ordinary
// capture path, and maybeResumeRecapture() (called from hub.ts onEntryResult)
// re-opens the review modal pre-set to the target once the new result arrives.
let pendingCaptureTarget: { datasetId: string; mode: 'replace' | 'append' } | null = null;

// Build the review modal for a capture entry. `target` (optional) pre-selects a
// replace/append radio on an existing capture-dataset (recapture flow).
async function openCaptureDatasetModal(
  entry: any,
  target?: { datasetId: string; mode: 'replace' | 'append' } | null,
): Promise<void> {
  if (!entry || !entry.result) return;
  const extractedTable = entry.result.extractedTable;
  if (!currentProjectId) {
    if (typeof showToast === 'function') showToast('Open a project first.');
    return;
  }

  // Fetch the strictly-typed, rectangular draft (main runs the same finalize path
  // as every file parser — the model's type hints are re-decided there).
  let draft: any;
  try {
    draft = await window.hub.captureToDatasetDraft(extractedTable);
  } catch (_) {
    if (typeof showToast === 'function') showToast('Could not read the extracted table.');
    return;
  }
  if (!draft || draft.ok === false) {
    if (typeof showToast === 'function') showToast((draft && draft.error) || 'Could not read the extracted table.');
    return;
  }
  const draftCols: Array<{ name: string; type: string }> = Array.isArray(draft.columns) ? draft.columns : [];
  const draftRows: any[][] = Array.isArray(draft.rows) ? draft.rows : [];
  const draftWarnings: string[] = Array.isArray(draft.warnings) ? draft.warnings : [];

  // Capture-sourced datasets are the only valid replace/append targets.
  let captureTargets: any[] = [];
  try {
    const all = await window.hub.listDatasets(currentProjectId);
    captureTargets = (Array.isArray(all) ? all : []).filter((d) => d && d.sourceKind === 'capture');
  } catch (_) {
    captureTargets = [];
  }

  // ── Shell (reuse the promptModal .ws-modal* shell, widened via .cd-modal) ──
  let done = false;
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal cd-modal';

  const h = document.createElement('div');
  h.className = 'ws-modal-title';
  h.textContent = 'Review extracted data';
  box.appendChild(h);

  // Confidence caution — reinforce the review when the model was unsure.
  const conf = entry.result.extractionConfidence;
  const notes = entry.result.extractionNotes;
  if (conf === 'low' || conf === 'medium' || (typeof notes === 'string' && notes.trim())) {
    const caution = document.createElement('div');
    caution.className = 'cd-caution';
    caution.textContent = (typeof notes === 'string' && notes.trim())
      ? 'The model was unsure about some values — check them against the screenshot. ' + notes.trim()
      : 'The model was unsure about some values — check them against the screenshot.';
    box.appendChild(caution);
  }

  // Draft warnings (ragged / empty).
  const warnBox = document.createElement('div');
  warnBox.className = 'cd-warnings';
  draftWarnings.forEach((w) => {
    const line = document.createElement('div');
    line.className = 'ds-warning';
    line.textContent = String(w);
    warnBox.appendChild(line);
  });
  warnBox.hidden = draftWarnings.length === 0;
  box.appendChild(warnBox);

  // ── Editable grid ──
  const nameInputs: HTMLInputElement[] = [];
  const typeSelects: HTMLSelectElement[] = [];
  const keepChecks: HTMLInputElement[] = [];
  const cellInputs: HTMLInputElement[][] = [];

  const gridScroll = document.createElement('div');
  gridScroll.className = 'cd-grid-scroll';
  const table = document.createElement('table');
  table.className = 'ds-table cd-grid';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  draftCols.forEach((col, c) => {
    const th = document.createElement('th');
    th.className = 'ds-th cd-col';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'cd-col-name';
    nameInput.value = col && col.name != null ? String(col.name) : '';
    nameInput.setAttribute('aria-label', 'Column name');
    th.appendChild(nameInput);
    nameInputs[c] = nameInput;

    const typeSel = document.createElement('select');
    typeSel.className = 'cd-col-type ds-type';
    typeSel.setAttribute('aria-label', 'Column type');
    ['text', 'number', 'date'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (t === (col && col.type)) opt.selected = true;
      typeSel.appendChild(opt);
    });
    th.appendChild(typeSel);
    typeSelects[c] = typeSel;

    const keepLabel = document.createElement('label');
    keepLabel.className = 'cd-col-keep';
    const keep = document.createElement('input');
    keep.type = 'checkbox';
    keep.checked = true;
    const keepText = document.createElement('span');
    keepText.textContent = 'include';
    keepLabel.appendChild(keep);
    keepLabel.appendChild(keepText);
    th.appendChild(keepLabel);
    keepChecks[c] = keep;

    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  draftRows.forEach((row) => {
    const tr = document.createElement('tr');
    const rowInputs: HTMLInputElement[] = [];
    for (let c = 0; c < draftCols.length; c += 1) {
      const td = document.createElement('td');
      td.className = 'ds-td';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cd-cell';
      const v = Array.isArray(row) ? row[c] : undefined;
      input.value = v == null ? '' : String(v);
      td.appendChild(input);
      tr.appendChild(td);
      rowInputs[c] = input;
    }
    cellInputs.push(rowInputs);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  gridScroll.appendChild(table);
  box.appendChild(gridScroll);

  // ── Dataset name ──
  const nameRow = document.createElement('div');
  nameRow.className = 'cd-name-row';
  const nameLbl = document.createElement('label');
  nameLbl.textContent = 'Dataset name';
  nameLbl.setAttribute('for', 'cd-ds-name');
  const dsName = document.createElement('input');
  dsName.type = 'text';
  dsName.id = 'cd-ds-name';
  dsName.className = 'ws-modal-input';
  dsName.value = (entry.result && entry.result.title) ? String(entry.result.title) : (entry.title ? String(entry.title) : 'Captured data');
  nameRow.appendChild(nameLbl);
  nameRow.appendChild(dsName);
  box.appendChild(nameRow);

  // ── Target selector (New / Replace / Append per capture-dataset) ──
  const targetRow = document.createElement('div');
  targetRow.className = 'cd-target-row';
  const radioName = 'cd-target-' + Date.now();

  function addTargetRadio(value: string, labelText: string, checked: boolean): void {
    const label = document.createElement('label');
    label.className = 'cd-target';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioName;
    radio.value = value;
    radio.checked = checked;
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(radio);
    label.appendChild(span);
    targetRow.appendChild(label);
  }

  const preNew = !target;
  addTargetRadio('new', 'New dataset', preNew);
  captureTargets.forEach((d) => {
    const id = String(d.id);
    const nm = d.name ? String(d.name) : 'Untitled dataset';
    const isReplace = !!target && target.datasetId === id && target.mode === 'replace';
    const isAppend = !!target && target.datasetId === id && target.mode === 'append';
    addTargetRadio('replace:' + id, 'Replace “' + nm + '”', isReplace);
    addTargetRadio('append:' + id, 'Append to “' + nm + '”', isAppend);
  });
  box.appendChild(targetRow);

  // ── Actions ──
  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.id = 'cd-save';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save dataset';
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
  function close(): void {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (a11y) a11y.release(); // return focus to the trigger
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (a11y) a11y.onTabKey(e); // trap Tab within the dialog
  }
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);

  saveBtn.addEventListener('click', async () => {
    // Gather kept columns + a body of the kept-cell strings (raw — main coerces).
    const kept: number[] = [];
    draftCols.forEach((_, c) => { if (keepChecks[c] && keepChecks[c].checked) kept.push(c); });
    if (kept.length === 0) {
      if (typeof showToast === 'function') showToast('Keep at least one column.');
      return;
    }
    const columns = kept.map((c) => ({
      name: (nameInputs[c] && nameInputs[c].value.trim()) || 'Column ' + (c + 1),
      type: typeSelects[c] ? typeSelects[c].value : 'text',
    }));
    const rows = cellInputs.map((rowInputs) => kept.map((c) => (rowInputs[c] ? rowInputs[c].value : '')));

    const sel = overlay.querySelector('input[name="' + radioName + '"]:checked') as HTMLInputElement | null;
    const targetVal = sel ? sel.value : 'new';
    let targetArg: { datasetId: string; mode: 'replace' | 'append' } | undefined;
    if (targetVal !== 'new') {
      const colon = targetVal.indexOf(':');
      const mode = targetVal.slice(0, colon) as 'replace' | 'append';
      const datasetId = targetVal.slice(colon + 1);
      targetArg = { datasetId, mode };
    }

    saveBtn.disabled = true;
    let res: any;
    try {
      res = await window.hub.saveCaptureDataset({
        projectId: currentProjectId as string,
        name: dsName.value.trim(),
        entryId: entry.id,
        columns,
        rows,
        target: targetArg,
      });
    } catch (_) {
      res = { ok: false, error: 'Failed to save the dataset.' };
    }
    if (!res || res.ok === false) {
      saveBtn.disabled = false;
      if (typeof showToast === 'function') showToast((res && res.error) || 'Failed to save the dataset.');
      return;
    }
    close();
    const saveWarnings: string[] = Array.isArray(res.warnings) ? res.warnings : [];
    if (typeof showToast === 'function') {
      showToast(saveWarnings.length > 0 ? 'Saved as dataset (' + saveWarnings[0] + ')' : 'Saved as dataset');
    }
    if (typeof refreshDatasetList === 'function') { try { await refreshDatasetList(); } catch (_) { /* noop */ } }
    if (typeof selectSection === 'function') { try { selectSection('datasets'); } catch (_) { /* noop */ } }
  });

  a11y = makeModalAccessible(box, 'Review extracted data', dsName); // role/aria-modal + focus in/trap/return
  dsName.select();
}

// Kick off a recapture into an existing capture-dataset: remember the target, then
// run the ORDINARY capture path (no change to analyze/dispatch or the capture loop).
function startRecapture(datasetId: string, mode: 'replace' | 'append'): void {
  pendingCaptureTarget = { datasetId, mode };
  if (window.hub && typeof window.hub.takeScreenshot === 'function') {
    window.hub.takeScreenshot();
  } else {
    pendingCaptureTarget = null;
  }
}

// Called from hub.ts onEntryResult after the result renders. If a recapture is
// pending and the new result carries usable extracted data, auto-open the review
// modal pre-set to that target, then clear the pending handoff.
function maybeResumeRecapture(entry: any): void {
  if (!pendingCaptureTarget) return;
  const target = pendingCaptureTarget;
  pendingCaptureTarget = null;
  if (!entry || !entry.result || !entry.result.ok && entry.state !== 'result') { /* fall through to shape check */ }
  const et = entry && entry.result ? entry.result.extractedTable : null;
  const hasData = et && Array.isArray(et.columns) && et.columns.length > 0 && Array.isArray(et.rows) && et.rows.length > 0;
  if (!hasData) {
    if (typeof showToast === 'function') showToast('That capture had no table to add.');
    return;
  }
  openCaptureDatasetModal(entry, target);
}

// True when an entry's result carries a non-empty extracted table (gates the
// "Save as dataset" affordance in hub.ts).
function captureHasExtractedTable(entry: any): boolean {
  const et = entry && entry.result ? entry.result.extractedTable : null;
  return !!(et && Array.isArray(et.columns) && et.columns.length > 0 && Array.isArray(et.rows) && et.rows.length > 0);
}
