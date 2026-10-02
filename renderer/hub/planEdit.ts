// The plan card's Edit mode — reorder, remove, or change a step's parameters
// inline, before the run starts. Classic global-scope renderer <script>: NO
// import/export. Loads after planCard.js (PlState, plRender, plEl).
//
// Every field is a plain input bound to the step object; "Done editing" sends
// the edited list back through plan:check, so an edit is judged by exactly the
// validators the Assistant's own steps were. Nothing here decides validity.

interface PlField { key: string; label: string; kind?: 'text' | 'number' | 'list' | 'select'; options?: string[]; wide?: boolean }

const PL_AGGS = ['sum', 'avg', 'count', 'min', 'max'];

/** The editable fields per step kind. Paths are dotted into the step object. */
const PL_FIELDS: Record<string, PlField[]> = {
  import: [{ key: 'file', label: t('planEdit.file') }, { key: 'name', label: t('common.dataset_name') }],
  calc: [{ key: 'dataset', label: t('common.dataset') }, { key: 'name', label: t('common.column') }, { key: 'expression', label: t('common.formula'), wide: true }],
  metric: [
    { key: 'dataset', label: t('common.dataset') }, { key: 'name', label: t('common.metric') },
    { key: 'column', label: t('common.column') }, { key: 'aggregation', label: t('common.aggregation'), kind: 'select', options: PL_AGGS },
  ],
  chart: [
    { key: 'dataset', label: t('common.dataset') }, { key: 'name', label: 'Visual' }, { key: 'chartType', label: t('common.chart_type') },
    { key: 'encoding.category', label: t('common.category') }, { key: 'encoding.values.0.column', label: t('common.measure') },
    { key: 'encoding.values.0.aggregation', label: t('common.aggregation'), kind: 'select', options: PL_AGGS },
  ],
  dashboard: [
    { key: 'name', label: t('common.dashboard') },
    { key: 'visuals', label: t('planEdit.visuals_comma_separated'), kind: 'list', wide: true },
    { key: 'metrics', label: t('planEdit.metrics_comma_separated'), kind: 'list', wide: true },
  ],
  style: [
    { key: 'dashboard', label: t('common.dashboard') },
    { key: 'preset', label: t('common.style_2'), kind: 'select', options: ['clean', 'executive', 'dense', 'dark'] },
  ],
  alert: [
    { key: 'metric', label: t('common.metric') }, { key: 'op', label: t('common.when'), kind: 'select', options: ['>', '<', '>=', '<='] },
    { key: 'value', label: t('common.value'), kind: 'number' }, { key: 'name', label: t('common.alert_name') },
  ],
};

/** A prepare step's own fields — whatever scalar/list keys it carries besides its type. */
function plPrepareFields(step: any): PlField[] {
  const inner = step && step.step && typeof step.step === 'object' ? step.step : {};
  const out: PlField[] = [{ key: 'dataset', label: t('common.dataset') }];
  Object.keys(inner).filter((k) => k !== 'type').forEach((k) => {
    const v = inner[k];
    if (Array.isArray(v)) out.push({ key: 'step.' + k, label: k, kind: 'list' });
    else if (v === null || ['string', 'number'].indexOf(typeof v) >= 0) out.push({ key: 'step.' + k, label: k });
  });
  return out;
}

function plGet(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function plSet(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys[keys.length - 1]] = value;
}

function plEditFields(st: PlState, i: number): HTMLElement {
  const step = st.steps[i];
  const grid = plEl('div', 'pl-edit');
  const fields = step.kind === 'step' ? plPrepareFields(step) : (PL_FIELDS[step.kind] || []);
  fields.forEach((f) => {
    const label = plEl('label', 'pl-field' + (f.wide ? ' is-wide' : ''));
    label.appendChild(plEl('span', 'pl-field-label', f.label));
    const cur = plGet(step, f.key);
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.kind === 'select') {
      const sel = document.createElement('select');
      (f.options || []).forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      });
      sel.value = cur == null ? '' : String(cur);
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.type = f.kind === 'number' ? 'number' : 'text';
      inp.value = cur == null ? '' : Array.isArray(cur) ? cur.join(', ') : String(cur);
      input = inp;
    }
    input.className = 'pl-input';
    input.setAttribute('aria-label', t('planEdit.step', { p0: (i + 1), label: f.label }));
    input.addEventListener('change', () => {
      const raw = input.value;
      const next = JSON.parse(JSON.stringify(st.steps[i]));
      const prior = plGet(next, f.key);
      let v: any = raw;
      if (f.kind === 'list') v = raw.split(',').map((x) => x.trim()).filter(Boolean);
      else if (f.kind === 'number' || typeof prior === 'number') v = raw.trim() === '' ? null : Number(raw);
      plSet(next, f.key, v);
      st.steps[i] = next;
    });
    label.appendChild(input);
    grid.appendChild(label);
  });
  return grid;
}

function plEditControls(st: PlState, i: number): HTMLElement {
  const box = plEl('div', 'pl-edit-ctl');
  const mk = (name: string, label: string, disabled: boolean, cb: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-icon pl-icon-btn';
    try { b.appendChild(icon(name, 14)); } catch (_) { b.textContent = label; }
    b.title = label;
    b.setAttribute('aria-label', t('planEdit.step_2', { label, p1: (i + 1) }));
    b.disabled = disabled;
    b.addEventListener('click', () => { cb(); plRender(st); });
    box.appendChild(b);
  };
  const swap = (a: number, b: number): void => {
    [st.steps[a], st.steps[b]] = [st.steps[b], st.steps[a]];
    [st.checks[a], st.checks[b]] = [st.checks[b], st.checks[a]];
    [st.lines[a], st.lines[b]] = [st.lines[b], st.lines[a]];
  };
  mk('arrow-up', t('common.move_up'), i === 0, () => swap(i, i - 1));
  mk('arrow-down', t('common.move_down'), i === st.steps.length - 1, () => swap(i, i + 1));
  mk('trash', t('common.remove'), st.steps.length <= 1, () => {
    st.steps.splice(i, 1);
    st.checks.splice(i, 1);
    st.lines.splice(i, 1);
  });
  return box;
}

/** Leave Edit: the edited list goes back through plan:check before anything can run. */
async function plRecheck(st: PlState): Promise<void> {
  if (!currentProjectId) return;
  let res: any;
  try { res = await window.hubPlan.check(currentProjectId, st.steps); } catch (_) { res = null; }
  if (!res || !res.ok) {
    st.note = (res && res.error) || t('planEdit.could_not_check_the_edited_plan');
    plRender(st);
    return;
  }
  st.steps = res.steps;
  st.checks = res.checks || [];
  st.lines = res.lines || [];
  st.editing = false;
  const bad = st.checks.filter((c: any) => c && c.ok === false).length;
  st.note = bad ? '' : t('planEdit.checked_every_step_passes');
  const head = st.card.querySelector('.ai-interp-label');
  if (head) head.textContent = t('common.plan', { stepsCount: st.steps.length });
  plRender(st);
}
