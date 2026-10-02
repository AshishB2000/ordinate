// Step FORMS — the per-type editor bodies of the Prepare panel, split out of
// prepare.ts by step family (.claude/rules/file-size.md): this file holds the
// original eight steps' forms and the small control builders every form uses;
// prepareReshape / prepareClean / prepareCombine hold the power steps'. Classic
// global-scope script (NO import/export), loaded after prepare.js. The code
// below the builders moved verbatim; the one change is buildStepForm's default,
// which now hands the new types to buildPowerStepForm (prepareCombine.ts).

// ── Small control builders ───────────────────────────────────────────────────
function textInput(val: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'ds-step-input';
  i.value = val;
  return i;
}

function selectFrom(vals: string[], selected: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  vals.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (v === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

// A column <select> from the CURRENT (derived) columns. includeAll adds a blank
// "(all …)" option whose empty value means "omit the column" (trim/dedupe).
function makeColSelect(selected?: string, includeAll?: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  if (includeAll != null) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = includeAll;
    sel.appendChild(opt);
  }
  expColumns.forEach((col) => {
    const opt = document.createElement('option');
    opt.value = col.name;
    opt.textContent = col.name;
    if (col.name === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function fieldRow(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'ds-step-field';
  const span = document.createElement('span');
  span.className = 'ds-step-field-label';
  span.textContent = labelText;
  row.appendChild(span);
  row.appendChild(control);
  return row;
}

// Returns a getter that reads the form and yields a step object (or null if the
// input is invalid — the getter shows the alert itself).
function buildStepForm(type: string, body: HTMLElement, existing: any): () => any {
  switch (type) {
    case 'filter': {
      // The column stays a select (that is how a filter is retargeted); the
      // CONDITION is one button opening the shared type-aware dialog, so this
      // surface offers exactly what the visual wells and the sheet filter bar
      // do — one dialog, three call sites.
      const colSel = makeColSelect(existing ? existing.column : undefined);
      // `pending` holds what the dialog returned. Seeded from the step being
      // edited so re-opening the editor and pressing Save is a no-op rather
      // than a silent reset to `=`.
      let pending: any[] = existing && existing.op ? [{ ...existing, type: 'filter' }] : [];

      const condBtn = document.createElement('button');
      condBtn.type = 'button';
      condBtn.className = 'ds-step-cond';
      const paintCond = (): void => {
        condBtn.textContent = pending.length
          ? pending.map((s) => filterStepSummary(s)).join(' and ')
          : t('common.set_a_condition');
      };
      paintCond();
      condBtn.addEventListener('click', async () => {
        const column = colSel.value;
        if (!column) {
          window.alert(t('prepareForms.pick_a_column_to_filter_on'));
          return;
        }
        const col = expColumns.find((c) => c.name === column);
        const steps = await openFilterDialog({
          projectId: currentProjectId || '',
          datasetId: expId || '',
          column,
          type: col && col.type ? String(col.type) : 'text',
          existing: pending[0],
        });
        if (steps === null) return;
        pending = steps;
        paintCond();
      });

      body.appendChild(fieldRow(t('common.column'), colSel));
      body.appendChild(fieldRow(t('common.condition'), condBtn));
      // Retargeting to another column invalidates the operand — an `in` list of
      // city names means nothing on a price column.
      colSel.addEventListener('change', () => { pending = []; paintCond(); });

      return () => {
        const column = colSel.value;
        if (!column) {
          window.alert(t('prepareForms.pick_a_column_to_filter_on'));
          return null;
        }
        if (pending.length === 0) {
          window.alert(t('prepareForms.set_a_condition_for_this_filter'));
          return null;
        }
        // A min/max range is two steps. Returning the ARRAY lets the caller add
        // both — safe because every filter is a pure row predicate, so the order
        // they land in the pipeline cannot change the result.
        return pending.map((s) => ({ ...s, type, column }));
      };
    }
    case 'group_aggregate': {
      const groupWrap = document.createElement('div');
      groupWrap.className = 'ds-step-checks';
      const groupBoxes: HTMLInputElement[] = [];
      expColumns.forEach((col) => {
        const lbl = document.createElement('label');
        lbl.className = 'ds-step-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = col.name;
        if (existing && Array.isArray(existing.groupBy) && existing.groupBy.indexOf(col.name) >= 0) cb.checked = true;
        groupBoxes.push(cb);
        const s = document.createElement('span');
        s.textContent = col.name;
        lbl.appendChild(cb);
        lbl.appendChild(s);
        groupWrap.appendChild(lbl);
      });
      body.appendChild(fieldRow(t('common.group_by'), groupWrap));

      const aggList = document.createElement('div');
      aggList.className = 'ds-agg-list';
      body.appendChild(aggList);
      const addAgg = (agg?: any) => aggList.appendChild(makeAggRow(agg));
      if (existing && Array.isArray(existing.aggregations) && existing.aggregations.length) {
        existing.aggregations.forEach((a: any) => addAgg(a));
      } else {
        addAgg();
      }
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn';
      addBtn.textContent = t('prepareForms.add_aggregation');
      addBtn.addEventListener('click', () => addAgg());
      body.appendChild(addBtn);

      return () => {
        const groupBy = groupBoxes.filter((b) => b.checked).map((b) => b.value);
        if (!groupBy.length) {
          window.alert(t('prepareForms.pick_at_least_one_column_to'));
          return null;
        }
        const aggregations: any[] = [];
        aggList.querySelectorAll('.ds-agg-row').forEach((r) => {
          const fn = (r.querySelector('.ds-agg-fn') as HTMLSelectElement).value;
          const column = (r.querySelector('.ds-agg-col') as HTMLSelectElement).value;
          const asVal = (r.querySelector('.ds-agg-as') as HTMLInputElement).value.trim();
          if (column && fn) aggregations.push({ column, fn, as: asVal || fn + '_' + column });
        });
        if (!aggregations.length) {
          window.alert(t('prepareForms.add_at_least_one_aggregation'));
          return null;
        }
        return { type, groupBy, aggregations };
      };
    }
    case 'dedupe': {
      const wrap = document.createElement('div');
      wrap.className = 'ds-step-checks';
      const boxes: HTMLInputElement[] = [];
      expColumns.forEach((col) => {
        const lbl = document.createElement('label');
        lbl.className = 'ds-step-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = col.name;
        if (existing && Array.isArray(existing.columns) && existing.columns.indexOf(col.name) >= 0) cb.checked = true;
        boxes.push(cb);
        const s = document.createElement('span');
        s.textContent = col.name;
        lbl.appendChild(cb);
        lbl.appendChild(s);
        wrap.appendChild(lbl);
      });
      body.appendChild(fieldRow(t('prepareForms.key_columns_none_checked_all_columns'), wrap));
      return () => {
        const columns = boxes.filter((b) => b.checked).map((b) => b.value);
        const step: any = { type };
        if (columns.length) step.columns = columns;
        return step;
      };
    }
    case 'fill_empty': {
      const colSel = makeColSelect(existing ? existing.column : undefined);
      const valIn = textInput(existing && existing.value != null ? String(existing.value) : '');
      body.appendChild(fieldRow(t('common.column'), colSel));
      body.appendChild(fieldRow(t('prepareForms.fill_empty_cells_with'), valIn));
      return () => {
        if (!colSel.value) {
          window.alert(t('common.pick_a_column'));
          return null;
        }
        return { type, column: colSel.value, value: valIn.value };
      };
    }
    case 'trim': {
      const colSel = makeColSelect(existing ? existing.column : undefined, t('prepareForms.all_text_columns'));
      body.appendChild(fieldRow(t('common.column'), colSel));
      return () => {
        const step: any = { type };
        if (colSel.value) step.column = colSel.value;
        return step;
      };
    }
    case 'drop_column': {
      const colSel = makeColSelect(existing ? existing.column : undefined);
      body.appendChild(fieldRow(t('common.column'), colSel));
      return () => {
        if (!colSel.value) {
          window.alert(t('common.pick_a_column'));
          return null;
        }
        return { type, column: colSel.value };
      };
    }
    case 'rename_column': {
      const fromSel = makeColSelect(existing ? existing.from : undefined);
      const toIn = textInput(existing && existing.to ? String(existing.to) : '');
      body.appendChild(fieldRow(t('common.rename'), fromSel));
      body.appendChild(fieldRow(t('common.to'), toIn));
      return () => {
        const from = fromSel.value;
        const to = toIn.value.trim();
        if (!from || !to) {
          window.alert(t('prepareForms.pick_a_column_and_enter_a'));
          return null;
        }
        return { type, from, to };
      };
    }
    default:
      return pvBuildMaskForm(type, body, existing) || sgBuildStepForm(type, body, existing) // prepareMask / segments
        || txBuildStepForm(type, body, existing) || buildPowerStepForm(type, body, existing); // textSteps / prepareCombine
  }
}

function makeAggRow(agg?: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-agg-row';
  const fnSel = selectFrom(AGG_FNS, agg && agg.fn ? String(agg.fn) : 'sum');
  fnSel.classList.add('ds-agg-fn');
  const colSel = makeColSelect(agg ? agg.column : undefined);
  colSel.classList.add('ds-agg-col');
  const asIn = textInput(agg && agg.as ? String(agg.as) : '');
  asIn.classList.add('ds-agg-as');
  asIn.placeholder = t('prepareForms.output_name');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-step-btn';
  iconOnly(del, 'x', t('prepareForms.remove_aggregation'));
  del.addEventListener('click', () => row.remove());
  row.appendChild(fnSel);
  row.appendChild(colSel);
  row.appendChild(asIn);
  row.appendChild(del);
  return row;
}

// ── Shared by the power-step forms ───────────────────────────────────────────

/** A checkbox per name (default: the current columns); `values()` is the checked ones, in order. */
function makeColChecks(selected: string[], names?: string[]): { el: HTMLElement; values: () => string[] } {
  const wrap = document.createElement('div');
  wrap.className = 'ds-step-checks';
  const boxes: HTMLInputElement[] = [];
  (names || expColumns.map((c) => c.name)).forEach((name) => {
    const lbl = document.createElement('label');
    lbl.className = 'ds-step-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = selected.indexOf(name) >= 0;
    boxes.push(cb);
    const s = document.createElement('span');
    s.textContent = name;
    lbl.appendChild(cb);
    lbl.appendChild(s);
    wrap.appendChild(lbl);
  });
  return { el: wrap, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

/** A <select> over any list of names, with an optional blank first option. */
function makeNameSelect(names: string[], selected?: string, blank?: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  const opts = blank != null ? [''].concat(names) : names;
  opts.forEach((n, i) => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = i === 0 && blank != null ? blank : n;
    if (n === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

/** The live preview under a power-step form: main counts, this only prints. */
function makePreviewBox(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'pp-preview';
  box.setAttribute('aria-live', 'polite');
  box.hidden = true;
  return box;
}

function setPreview(box: HTMLElement, lines: string[], warn?: boolean): void {
  box.innerHTML = '';
  lines.forEach((t) => {
    const line = document.createElement('div');
    line.textContent = t;
    box.appendChild(line);
  });
  box.classList.toggle('is-warn', !!warn);
  box.hidden = lines.length === 0;
}

/** Ask main to count what this (unsaved) step would do to its real input. */
async function previewPowerStep(step: any): Promise<any> {
  if (!currentProjectId || !expId || !window.hubPower) return null;
  try {
    return await window.hubPower.previewStep(currentProjectId, expId, dsStepEditIndex, step);
  } catch (_) {
    return null;
  }
}

/** A count as the step list and the previews print it: 1,250. */
function fmtN(n: any): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

/** The "Rows: 1,250 → 1,180" line every preview starts with. */
function rowsLine(res: any): string {
  return t('prepareForms.rows', { before: fmtN(res.before), after: fmtN(res.after) });
}
