'use strict';

// The PARAMETER dialog — define (or edit) one dashboard parameter and the
// control that moves it. RENDERER ONLY. Classic global-scope <script>: no
// import/export. Loads after dashParams.js and before dashAddControl.js, whose
// "+ Control → Parameter" tile opens it.
//
// Validation here is for the AUTHOR — a name that is not an identifier, a
// minimum above its maximum, a default outside its own bounds — and says so
// inline. Main re-validates everything (src/analysis/params.ts
// sanitizeParameters); this only keeps a person from saving something main
// would quietly correct.

const PD_KINDS: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'number', label: t('common.number'), hint: t('paramDialog.a_slider_with_bounds') },
  { kind: 'text', label: t('common.text'), hint: t('paramDialog.typed_or_picked') },
  { kind: 'date', label: t('common.date'), hint: t('paramDialog.a_date_picker') },
  { kind: 'list', label: t('common.list'), hint: t('paramDialog.several_values') },
];
const PD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

interface ParamDialogResult {
  param: any;
  label: string;
}

/**
 * Resolves with `{ param, label }` — `param` WITHOUT an id when adding (the
 * caller mints it) — or null when cancelled.
 */
function openParamDialog(existing?: { param: any; label: string }): Promise<ParamDialogResult | null> {
  return new Promise((resolve) => {
    const editing = !!(existing && existing.param);
    const ep = editing ? existing!.param : null;
    let kind = ep ? String(ep.kind) : 'number';
    let done = false;

    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-control-modal pd-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = editing ? t('paramDialog.edit_parameter') : t('paramDialog.add_a_parameter');
    box.appendChild(h);
    const lede = document.createElement('p');
    lede.className = 'pd-lede';
    lede.textContent = t('paramDialog.a_value_the_reader_moves_that');
    box.appendChild(lede);

    const field = (labelText: string, control: HTMLElement, hint?: HTMLElement): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'dm-field';
      const span = document.createElement('span');
      span.className = 'dm-field-label';
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(control);
      if (hint) row.appendChild(hint);
      return row;
    };
    const input = (type: string, value: any, placeholder = ''): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = type;
      i.className = 'ws-modal-input';
      i.value = value == null ? '' : String(value);
      i.placeholder = placeholder;
      return i;
    };

    // ── Name, and how it is referenced ─────────────────────────────────────
    const nameIn = input('text', ep ? ep.name : '', 'threshold');
    nameIn.spellcheck = false;
    const refs = document.createElement('div');
    refs.className = 'pd-refs';
    const paintRefs = (): void => {
      const n = nameIn.value.trim() || 'name';
      refs.innerHTML = '';
      const mk = (code: string, where: string): void => {
        const row = document.createElement('span');
        row.className = 'pd-ref';
        const c = document.createElement('code');
        c.textContent = code;
        row.appendChild(c);
        row.appendChild(document.createTextNode(' ' + where));
        refs.appendChild(row);
      };
      mk('[[' + n + ']]', t('paramDialog.in_filters_and_formulas'));
      mk('{{' + n + '}}', t('paramDialog.in_titles_and_text'));
    };
    box.appendChild(field(t('common.name'), nameIn, refs));

    // ── Kind ────────────────────────────────────────────────────────────────
    const kindRow = document.createElement('div');
    kindRow.className = 'dc-kind pd-kinds';
    kindRow.setAttribute('role', 'radiogroup');
    kindRow.setAttribute('aria-label', t('common.type'));
    PD_KINDS.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dc-kind-tile';
      b.dataset.kind = k.kind;
      b.setAttribute('role', 'radio');
      const t = document.createElement('span');
      t.className = 'dc-kind-tile-label';
      t.textContent = k.label;
      const s = document.createElement('span');
      s.className = 'dc-kind-tile-hint';
      s.textContent = k.hint;
      b.appendChild(t);
      b.appendChild(s);
      b.addEventListener('click', () => {
        if (kind === k.kind) return;
        kind = k.kind;
        paintKind();
        paintValue();
        validate();
      });
      kindRow.appendChild(b);
    });
    const paintKind = (): void => {
      kindRow.querySelectorAll('.dc-kind-tile').forEach((b) => {
        const on = (b as HTMLElement).dataset.kind === kind;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    box.appendChild(field(t('common.type'), kindRow));

    // ── Value / bounds / options, by kind ──────────────────────────────────
    const valueHost = document.createElement('div');
    valueHost.className = 'pd-value';
    box.appendChild(valueHost);
    let defIn: HTMLInputElement | null = null;
    let minIn: HTMLInputElement | null = null;
    let maxIn: HTMLInputElement | null = null;
    let stepIn: HTMLInputElement | null = null;
    let optsIn: HTMLTextAreaElement | null = null;

    function paintValue(): void {
      valueHost.innerHTML = '';
      defIn = minIn = maxIn = stepIn = null;
      optsIn = null;
      const same = ep && ep.kind === kind;
      if (kind === 'number') {
        defIn = input('number', same ? ep.value : 1000);
        valueHost.appendChild(field(t('common.default'), defIn));
        const grid = document.createElement('div');
        grid.className = 'pd-bounds';
        minIn = input('number', same ? ep.min : 0, 'none');
        maxIn = input('number', same ? ep.max : 10000, 'none');
        stepIn = input('number', same ? ep.step : 100, 'any');
        grid.appendChild(field(t('common.minimum'), minIn));
        grid.appendChild(field(t('common.maximum'), maxIn));
        grid.appendChild(field(t('common.step'), stepIn));
        valueHost.appendChild(grid);
        const hint = document.createElement('p');
        hint.className = 'pd-hint';
        hint.textContent = t('paramDialog.with_both_a_minimum_and_a');
        valueHost.appendChild(hint);
      } else if (kind === 'date') {
        defIn = input('date', same ? ep.value : '');
        valueHost.appendChild(field(t('common.default'), defIn));
      } else {
        defIn = input('text', same ? (Array.isArray(ep.value) ? ep.value.join(', ') : ep.value) : '',
          kind === 'list' ? t('paramDialog.west_east') : t('paramDialog.any_text'));
        valueHost.appendChild(field(kind === 'list' ? t('paramDialog.default_values_comma_separated') : t('common.default'), defIn));
        optsIn = document.createElement('textarea');
        optsIn.className = 'ws-modal-input pd-opts';
        optsIn.rows = 3;
        optsIn.placeholder = t('paramDialog.one_option_per_line_leave_empty');
        optsIn.value = same && Array.isArray(ep.list) ? ep.list.join('\n') : '';
        valueHost.appendChild(field(t('common.options'), optsIn));
      }
      [defIn, minIn, maxIn, stepIn, optsIn].forEach((el) => el && el.addEventListener('input', validate));
    }

    const labelIn = input('text', existing ? existing.label : '', t('paramDialog.shown_on_the_chip_defaults_to'));
    box.appendChild(field(t('common.label'), labelIn));

    const err = document.createElement('p');
    err.className = 'pd-err';
    err.setAttribute('role', 'alert');
    box.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('common.cancel');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = editing ? t('common.save') : t('paramDialog.add_parameter');
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);

    const num = (el: HTMLInputElement | null): number | undefined => {
      if (!el || el.value.trim() === '') return undefined;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : NaN;
    };

    /** The parameter as typed, or a message saying why it cannot be saved. */
    function build(): { param?: any; error?: string } {
      const name = nameIn.value.trim();
      if (!PD_NAME_RE.test(name)) return { error: t('paramDialog.a_name_starts_with_a_letter') };
      const clash = dashParams().some((p) => p && String(p.name).toLowerCase() === name.toLowerCase() && (!ep || p.id !== ep.id));
      if (clash) return { error: t('paramDialog.this_dashboard_already_has_a_parameter', { name }) };
      const param: any = { name, kind };
      if (kind === 'number') {
        const v = num(defIn);
        const min = num(minIn);
        const max = num(maxIn);
        const step = num(stepIn);
        if ([v, min, max, step].some((x) => Number.isNaN(x))) return { error: t('paramDialog.numbers_only_in_the_number_fields') };
        if (min !== undefined && max !== undefined && min > max) return { error: t('paramDialog.the_minimum_is_above_the_maximum') };
        if (v !== undefined && ((min !== undefined && v < min) || (max !== undefined && v > max))) {
          return { error: t('paramDialog.the_default_is_outside_the_bounds') };
        }
        if (step !== undefined && step <= 0) return { error: t('paramDialog.the_step_must_be_above_zero') };
        param.value = v === undefined ? null : v;
        if (min !== undefined) param.min = min;
        if (max !== undefined) param.max = max;
        if (step !== undefined) param.step = step;
      } else if (kind === 'date') {
        param.value = defIn && defIn.value ? defIn.value : null;
      } else {
        const opts = optsIn ? optsIn.value.split('\n').map((x) => x.trim()).filter(Boolean) : [];
        if (opts.length) param.list = opts;
        const raw = defIn ? defIn.value : '';
        param.value = kind === 'list' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw || null;
        if (opts.length && kind === 'text' && param.value && !opts.includes(param.value)) {
          return { error: t('paramDialog.the_default_is_not_one_of') };
        }
      }
      return { param };
    }
    function validate(): void {
      const r = build();
      err.textContent = r.error || '';
      ok.disabled = !!r.error;
      paintRefs();
    }
    nameIn.addEventListener('input', validate);

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: ParamDialogResult | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function submit(): void {
      const r = build();
      if (!r.param) { validate(); return; }
      if (ep) r.param.id = ep.id;
      close({ param: r.param, label: labelIn.value.trim() });
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') { e.preventDefault(); submit(); }
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintKind();
    paintValue();
    validate();
    a11y = makeModalAccessible(box, h.textContent, nameIn);
  });
}

// ── The three things a parameter control does to the record ─────────────────

/** + Control → Parameter: the parameter AND the chip that moves it. */
async function addParameterControl(): Promise<void> {
  const r = await openParamDialog();
  if (!r || !dashCurrent) return;
  const param = { ...r.param, id: dashUuid() };
  dashParams().push(param);
  pushCard({
    id: dashUuid(), type: 'control',
    control: { kind: 'parameter', label: r.label || '', datasetId: '', column: '', paramId: param.id },
    layout: { x: 0, y: 0, w: 0, h: 0 },
  });
}

async function editParameterControl(card: any): Promise<void> {
  const p = dashParamById(card.control.paramId);
  if (!p) return;
  const r = await openParamDialog({ param: p, label: card.control.label || '' });
  if (!r) return;
  const list = dashParams();
  list[list.indexOf(p)] = { ...r.param, id: p.id };
  card.control.label = r.label || '';
  // The live value was picked against the OLD definition (its bounds, its
  // options); the edited default is what the sheet should show now.
  paramState.delete(p.id);
  markDashDirty(t('paramDialog.edit_parameter'));
  renderDashGrid();
}

/** Remove the chip — and the parameter, once no other control moves it. */
function removeParameterControl(card: any): void {
  const id = card.control.paramId;
  removeCard(card);
  const stillUsed = allControlCards().some((c) => c.control.kind === 'parameter' && c.control.paramId === id);
  if (!stillUsed && dashCurrent) {
    dashCurrent.parameters = dashParams().filter((p) => p.id !== id);
    paramState.delete(id);
    markDashDirty(t('paramDialog.remove_parameter'));
    renderDashGrid();
  }
}

