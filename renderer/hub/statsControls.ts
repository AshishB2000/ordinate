'use strict';

// The workbench's settings column — one set of pickers per tab, each writing
// the tab's spec in swState.specs (statsPanel.ts) and re-running. Numeric-only
// pickers list only columns DECLARED number: the maths reads the declared
// type, so offering a text column there would only produce an error.

function swCtlSection(host: HTMLElement, label: string, hint?: string, forId?: string): HTMLElement {
  const sec = document.createElement('div');
  sec.className = 'sw-ctl';
  const l = document.createElement(forId ? 'label' : 'div');
  l.className = 'sw-ctl-label';
  l.textContent = label;
  if (forId) (l as HTMLLabelElement).htmlFor = forId;
  sec.appendChild(l);
  if (hint) {
    const h = document.createElement('p');
    h.className = 'sw-ctl-hint';
    h.textContent = hint;
    sec.appendChild(h);
  }
  host.appendChild(sec);
  return sec;
}

function swSelect(id: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void, placeholder?: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.id = id;
  sel.className = 'sw-select sw-select--block';
  if (placeholder !== undefined) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = options.some((o) => o[0] === value) ? value : placeholder !== undefined ? '' : (options[0] ? options[0][0] : '');
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/** A checkbox list with All / None. `tag` labels each row's kind. */
function swChecks(sec: HTMLElement, name: string, items: Array<{ value: string; label: string; tag?: string }>, chosen: string[], onChange: (v: string[]) => void): void {
  const bar = document.createElement('div');
  bar.className = 'sw-check-bar';
  const count = document.createElement('span');
  count.className = 'sw-check-count';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'sw-link';
  all.textContent = t('common.all');
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'sw-link';
  none.textContent = t('common.none');
  bar.append(count, all, none);
  const list = document.createElement('div');
  list.className = 'sw-checks';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', name);
  const boxes: HTMLInputElement[] = [];
  const emit = (): void => {
    const v = boxes.filter((b) => b.checked).map((b) => b.value);
    count.textContent = `${v.length} of ${items.length}`;
    onChange(v);
  };
  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'sw-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.value;
    cb.checked = chosen.includes(it.value);
    cb.addEventListener('change', emit);
    const t = document.createElement('span');
    t.className = 'sw-check-name';
    t.textContent = it.label;
    row.append(cb, t);
    if (it.tag) {
      const tag = document.createElement('span');
      tag.className = 'sw-tag';
      tag.textContent = it.tag;
      row.appendChild(tag);
    }
    boxes.push(cb);
    list.appendChild(row);
  }
  all.addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); emit(); });
  none.addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); emit(); });
  count.textContent = `${boxes.filter((b) => b.checked).length} of ${items.length}`;
  sec.append(bar, list);
}

function swSeg(label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLElement {
  const seg = document.createElement('div');
  seg.className = 'seg sw-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-opt';
    b.textContent = text;
    b.setAttribute('aria-pressed', v === value ? 'true' : 'false');
    b.addEventListener('click', () => {
      for (const o of seg.querySelectorAll('.seg-opt')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      onChange(v);
    });
    seg.appendChild(b);
  }
  return seg;
}

function swNone(sec: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'sw-ctl-none';
  p.textContent = text;
  sec.appendChild(p);
}

function swPaintControls(): void {
  const host = document.getElementById('sw-controls');
  if (!host) return;
  host.textContent = '';
  const tab = swState.tab as SwTab;
  const spec = swState.specs[tab];
  if (!spec) return;
  const num = swNumeric();
  const all = swState.columns.map((c: any) => c.name as string);
  const typeTag = (c: string): string => (swState.columns.find((x: any) => x.name === c)?.type === 'number' ? t('common.number') : t('common.category'));
  const set = (patch: any): void => { Object.assign(spec, patch); swSchedule(); };

  if (tab === 'correlation') {
    const sec = swCtlSection(host, t('common.columns'), t('statsControls.numeric_columns_pick_2_to_12'));
    if (!num.length) swNone(sec, t('statsControls.this_dataset_has_no_number_columns'));
    else swChecks(sec, t('statsControls.columns_to_correlate'), num.map((c) => ({ value: c, label: c })), spec.columns, (v) => set({ columns: v.slice(0, 12) }));
    const m = swCtlSection(host, t('common.method'), t('statsControls.spearman_ranks_the_values_first_robust'));
    m.appendChild(swSeg(t('statsControls.correlation_method'), [['pearson', t('statsControls.pearson')], ['spearman', t('statsControls.spearman')]], spec.method, (v) => set({ method: v })));
  } else if (tab === 'regression') {
    const tv = swCtlSection(host, t('common.target'), t('statsControls.the_number_the_model_predicts'), 'sw-target');
    if (!num.length) swNone(tv, t('statsControls.this_dataset_has_no_number_columns'));
    else tv.appendChild(swSelect('sw-target', num.map((c) => [c, c]), spec.target, (v) => {
      set({ target: v, predictors: spec.predictors.filter((p: string) => p !== v) });
      swPaintControls();
    }));
    const p = swCtlSection(host, t('statsControls.predictors'), t('statsControls.categories_are_one_hot_encoded_against'));
    swChecks(p, t('statsControls.predictors'), all.filter((c: string) => c !== spec.target).map((c: string) => ({ value: c, label: c, tag: typeTag(c) })), spec.predictors, (v) => set({ predictors: v }));
  } else if (tab === 'groups') {
    const g = swCtlSection(host, t('common.group_by'), t('statsControls.the_column_whose_values_form_the'), 'sw-group');
    g.appendChild(swSelect('sw-group', all.map((c: string) => [c, c]), spec.group, (v) => {
      set({ group: v, levels: [], success: undefined, outcome: spec.outcome === v ? '' : spec.outcome });
      swPaintControls();
    }, t('statsControls.choose_a_column')));
    const o = swCtlSection(host, t('statsControls.outcome'), t('statsControls.a_number_compares_averages_a_category'), 'sw-outcome');
    o.appendChild(swSelect('sw-outcome', all.filter((c: string) => c !== spec.group).map((c: string) => [c, `${c} · ${typeTag(c).toLowerCase()}`]), spec.outcome, (v) => {
      set({ outcome: v, success: undefined });
      swPaintControls();
    }, t('statsControls.choose_a_column')));
    const reply = swState.replies.groups;
    const r = reply && reply.ok && reply.result && reply.result.ok ? reply.result : null;
    const lv = swCtlSection(host, t('common.groups'), t('statsControls.two_groups_get_a_t_test'));
    if (r && r.group === spec.group && Array.isArray(r.available) && r.available.length) {
      const chosen = spec.levels && spec.levels.length ? spec.levels : r.groups.map((x: any) => x.label);
      swChecks(lv, t('statsControls.groups_to_compare'), r.available.map((a: any) => ({ value: a.level, label: a.level, tag: a.n.toLocaleString('en-US') })), chosen, (v) => set({ levels: v }));
    } else {
      swNone(lv, t('statsControls.run_once_to_list_this_column'));
    }
    if (r && r.prop && r.table) {
      const s = swCtlSection(host, t('statsControls.counts_as_success'), t('statsControls.the_outcome_value_whose_share_is'), 'sw-success');
      s.appendChild(swSelect('sw-success', r.table.cols.map((c: string) => [c, c]), r.prop.success, (v) => set({ success: v })));
    }
  } else {
    const c = swCtlSection(host, t('common.column'), t('statsControls.a_number_column'), 'sw-dist-col');
    if (!num.length) swNone(c, t('statsControls.this_dataset_has_no_number_columns'));
    else c.appendChild(swSelect('sw-dist-col', num.map((x) => [x, x]), spec.columns[0] || '', (v) => set({ columns: [v] })));
  }

  const foot = document.createElement('div');
  foot.className = 'sw-ctl-foot';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'btn btn-primary sw-run';
  run.id = 'sw-run';
  iconLabel(run, 'play', t('common.run_analysis'));
  run.addEventListener('click', () => { void swRun(); });
  const note = document.createElement('p');
  note.className = 'sw-ctl-hint';
  note.textContent = swState.rowCount > SW_AUTO_MAX_ROWS
    ? t('statsControls.a_large_dataset_the_run_goes')
    : t('statsControls.re_runs_as_you_change_the');
  foot.append(run, note);
  host.appendChild(foot);
}
