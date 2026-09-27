// Power-step forms, COMBINE family — look up from another dataset, append
// another dataset — plus the two dispatchers prepare.ts / prepareForms.ts call
// for every power step (buildPowerStepForm, powerStepSummary). Classic
// global-scope script (NO import/export), loaded after prepareReshape.js and
// prepareClean.js, whose forms it routes to.
//
// The other dataset's columns come from its metadata (dataset:meta); the
// matched rate and the column match are counted in main over the step's real
// input (window.hubPower.previewStep). A relationship in the project's data
// model (#178) between the two datasets prefills the lookup keys.

// id → name, remembered from the last dataset list, for the step summaries.
const ppNames = new Map<string, string>();

/** The project's datasets (and their names remembered for summaries). */
async function ppListDatasets(): Promise<Array<{ id: string; name: string }>> {
  if (!currentProjectId) return [];
  try {
    const list = await window.hub.listDatasets(currentProjectId);
    const out = (Array.isArray(list) ? list : []).filter((d: any) => d && d.id).map((d: any) => ({ id: String(d.id), name: String(d.name) }));
    out.forEach((d) => ppNames.set(d.id, d.name));
    return out;
  } catch (_) {
    return [];
  }
}

/** Other datasets of the project, for the picker (the open one excluded). */
async function ppOtherDatasets(): Promise<Array<{ id: string; name: string }>> {
  return (await ppListDatasets()).filter((d) => d.id !== expId);
}

async function ppColumnsOf(datasetId: string): Promise<string[]> {
  if (!currentProjectId || !datasetId) return [];
  try {
    const meta = await window.hub.getDatasetMeta(currentProjectId, datasetId);
    return meta && Array.isArray(meta.columns) ? meta.columns.map((c: any) => String(c.name)) : [];
  } catch (_) {
    return [];
  }
}

/** A dataset <select>, filled once the list arrives; `onPick` runs for the initial value too. */
function makeDatasetPicker(selected: string, onPick: (id: string) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select pp-dataset';
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = 'Loading datasets…';
  sel.appendChild(loading);
  void ppOtherDatasets().then((list) => {
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length ? 'Choose a dataset…' : 'No other dataset in this project';
    sel.appendChild(blank);
    list.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      if (d.id === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    if (sel.value) onPick(sel.value);
  });
  sel.addEventListener('change', () => onPick(sel.value));
  return sel;
}

function buildLookupForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  let otherCols: string[] = [];
  const leftSel = makeColSelect(e.leftKey);
  const rightHost = document.createElement('div');
  let rightSel = makeNameSelect([], '');
  rightHost.appendChild(rightSel);
  const colsHost = document.createElement('div');
  let checks = makeColChecks([], []);
  colsHost.appendChild(checks.el);
  const prefixIn = textInput(e.prefix || '');
  prefixIn.placeholder = '(optional) e.g. product_';
  const note = document.createElement('div');
  note.className = 'ds-step-hint';
  const preview = makePreviewBox();
  let dsSel: HTMLSelectElement;
  let seq = 0;

  const read = (): any => ({
    type: 'lookup_join', datasetId: dsSel.value, leftKey: leftSel.value, rightKey: rightSel.value,
    columns: checks.values(), prefix: prefixIn.value,
  });
  const refresh = async (): Promise<void> => {
    if (!dsSel.value || !leftSel.value || !rightSel.value) return setPreview(preview, []);
    const mine = ++seq;
    const res = await previewPowerStep(read());
    if (mine !== seq || !res) return;
    if (!res.ok || !res.lookup) return setPreview(preview, [(res && res.error) || 'Could not preview.'], true);
    const l = res.lookup;
    const lines = [fmtN(l.matched) + ' of ' + fmtN(l.total) + ' rows matched · ' + l.ratePct + '%'];
    if (l.dupes > 0) lines.push(fmtN(l.dupes) + ' key value(s) repeat in the other dataset — the first match in stored order is used.');
    (res.warnings || []).filter((w: string) => /skipped|already exists/.test(w)).forEach((w: string) => lines.push(w));
    setPreview(preview, lines, l.dupes > 0 || l.matched < l.total);
  };
  const onPick = async (id: string): Promise<void> => {
    otherCols = await ppColumnsOf(id);
    let left = e.datasetId === id ? e.leftKey : leftSel.value;
    let right = e.datasetId === id ? e.rightKey : '';
    note.textContent = '';
    if (e.datasetId !== id && currentProjectId && window.hubAuthoring) {
      // A relationship between the two datasets (either direction) names the keys.
      try {
        const res = await window.hubAuthoring.listRelationships(currentProjectId);
        const rel = (res && Array.isArray(res.relationships) ? res.relationships : []).find((r: any) =>
          (r.from.datasetId === expId && r.to.datasetId === id) || (r.to.datasetId === expId && r.from.datasetId === id));
        if (rel) {
          const mineEnd = rel.from.datasetId === expId ? rel.from : rel.to;
          const theirs = rel.from.datasetId === expId ? rel.to : rel.from;
          left = mineEnd.column;
          right = theirs.column;
          note.textContent = 'Keys taken from the relationship in the data model.';
        }
      } catch (_) { /* no model: pick the keys by hand */ }
    }
    if (!right) right = otherCols.indexOf(left) >= 0 ? left : '';
    if (left) leftSel.value = left;
    const r2 = makeNameSelect(otherCols, right, 'Choose the matching column…');
    rightHost.replaceChild(r2, rightSel);
    rightSel = r2;
    rightSel.addEventListener('change', () => void refresh());
    const picked = e.datasetId === id && Array.isArray(e.columns) ? e.columns : otherCols.filter((c) => c !== right);
    const c2 = makeColChecks(picked, otherCols);
    colsHost.replaceChild(c2.el, checks.el);
    checks = c2;
    void refresh();
  };
  dsSel = makeDatasetPicker(e.datasetId || '', (id) => void onPick(id));
  leftSel.addEventListener('change', () => void refresh());
  body.appendChild(fieldRow('Look up in', dsSel));
  body.appendChild(fieldRow('Key in this dataset', leftSel));
  body.appendChild(fieldRow('Matching key in the other dataset (one row per key)', rightHost));
  body.appendChild(note);
  body.appendChild(fieldRow('Columns to bring across', colsHost));
  body.appendChild(fieldRow('Prefix for the new columns', prefixIn));
  body.appendChild(preview);
  return () => {
    const step = read();
    if (!step.datasetId || !step.leftKey || !step.rightKey) { window.alert('Pick the other dataset and a key on each side.'); return null; }
    if (!step.columns.length) { window.alert('Pick at least one column to bring across.'); return null; }
    if (!step.prefix) delete step.prefix;
    return step;
  };
}

function buildUnionForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const mapHost = document.createElement('div');
  mapHost.className = 'ds-agg-list';
  const preview = makePreviewBox();
  let dsSel: HTMLSelectElement;
  let seq = 0;
  const mapping = (): Array<{ from: string; to: string }> => {
    const out: Array<{ from: string; to: string }> = [];
    mapHost.querySelectorAll('.pp-map').forEach((row) => {
      const from = (row.querySelector('select') as HTMLSelectElement).value;
      if (from) out.push({ from, to: (row as HTMLElement).dataset.to || '' });
    });
    return out;
  };
  const read = (): any => {
    const step: any = { type: 'union', datasetId: dsSel.value };
    const m = mapping();
    if (m.length) step.mapping = m;
    return step;
  };
  const refresh = async (): Promise<void> => {
    if (!dsSel.value) return setPreview(preview, []);
    const mine = ++seq;
    const res = await previewPowerStep(read());
    if (mine !== seq || !res) return;
    if (!res.ok || !res.union) return setPreview(preview, [(res && res.error) || 'Could not preview.'], true);
    const u = res.union;
    const lines = [rowsLine(res) + ' (' + fmtN(u.otherRows) + ' appended)'];
    if (u.unmatched.length) lines.push('Dropped — no matching column here: ' + u.unmatched.join(', '));
    if (u.missing.length) lines.push('Empty for the appended rows: ' + u.missing.join(', '));
    setPreview(preview, lines, u.unmatched.length > 0);
  };
  const onPick = async (id: string): Promise<void> => {
    const otherCols = await ppColumnsOf(id);
    mapHost.innerHTML = '';
    const mine = expColumns.map((c) => c.name);
    const spare = otherCols.filter((c) => mine.indexOf(c) < 0);
    const prior = e.datasetId === id && Array.isArray(e.mapping) ? e.mapping : [];
    // One row per column of this dataset the other has no same-named column for.
    mine.filter((c) => otherCols.indexOf(c) < 0).forEach((to) => {
      const row = document.createElement('div');
      row.className = 'ds-agg-row pp-map';
      row.dataset.to = to;
      const lbl = document.createElement('span');
      lbl.className = 'pp-arrow';
      lbl.textContent = to + ' ←';
      const hit = prior.find((m: any) => m.to === to);
      const sel = makeNameSelect(spare, hit ? hit.from : '', '(leave empty)');
      sel.addEventListener('change', () => void refresh());
      row.append(lbl, sel);
      mapHost.appendChild(row);
    });
    if (!mapHost.children.length) {
      const ok = document.createElement('div');
      ok.className = 'ds-step-hint';
      ok.textContent = 'Every column here has a same-named column there.';
      mapHost.appendChild(ok);
    }
    void refresh();
  };
  dsSel = makeDatasetPicker(e.datasetId || '', (id) => void onPick(id));
  body.appendChild(fieldRow('Append the rows of', dsSel));
  body.appendChild(fieldRow('Columns are matched by name; fill the rest from', mapHost));
  body.appendChild(preview);
  return () => {
    if (!dsSel.value) { window.alert('Pick the dataset to append.'); return null; }
    return read();
  };
}

// ── Dispatchers ──────────────────────────────────────────────────────────────

/** prepareForms.buildStepForm's default: the power step forms. */
function buildPowerStepForm(type: string, body: HTMLElement, existing: any): () => any {
  switch (type) {
    case 'split_column': return buildSplitForm(body, existing);
    case 'unpivot': return buildUnpivotForm(body, existing);
    case 'pivot': return buildPivotForm(body, existing);
    case 'window': return buildWindowForm(body, existing);
    case 'parse_date': return buildParseDateForm(body, existing);
    case 'dedupe_key': return buildDedupeKeyForm(body, existing);
    case 'replace_values': return buildReplaceForm(body, existing);
    case 'conditional_column': return buildConditionalForm(body, existing);
    case 'lookup_join': return buildLookupForm(body, existing);
    case 'union': return buildUnionForm(body, existing);
    default: return () => null;
  }
}

/** prepare.stepSummaryText's default: one line per power step. */
function powerStepSummary(step: any): string {
  if (step.type === 'lookup_join') {
    return 'Look up ' + (step.columns || []).join(', ') + ' by ' + step.leftKey + ' = ' + step.rightKey + ppDatasetName(step.datasetId);
  }
  if (step.type === 'union') return 'Append the rows of' + ppDatasetName(step.datasetId);
  return reshapeStepSummary(step) || cleanStepSummary(step) || 'Unknown step';
}

/** ' "Products"' — the name from the last dataset list, when there is one. */
function ppDatasetName(id: string): string {
  const name = ppNames.get(id);
  return name ? ' "' + name + '"' : ' another dataset';
}
