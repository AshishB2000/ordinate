// The cohort and event-funnel shelves in the Visuals builder.
//
// Like the pivot's (pivotBuilder.ts), they REPLACE the encoding form's chart
// fields while the chart type is `cohort` / `event_funnel`, and leave Filters
// where they are — a filter means the same thing here as on a column chart.
// Each shelf only offers columns that fit it: dates for the event date and the
// timestamp, numbers for a value, and the funnel's steps are picked from the
// event column's own distinct values (computed in main, never scanned here).
//
// The encoding written carries the engine block AND mirrored chart fields
// (category = the date / event column, values = a count of the entity), so
// every surface that reads an encoding without knowing these types — the
// drill panel, the dock, lineage, a switch back to a column chart — keeps
// working unchanged. That is the pivot's arrangement, for the same reasons.
//
// Loads after encodingForm.js (EncCol) and before visuals.js, which mounts it.
// Classic global-scope script — NO import/export.

type EngineKind = '' | 'cohort' | 'event_funnel';

interface EngineBuilderApi {
  el: HTMLElement;
  /** Load a dataset's columns; `preset` is a saved encoding (its blocks restore the shelves). */
  setColumns(cols: EncCol[], preset?: any): void;
  show(kind: EngineKind): void;
  /** The full encoding for `kind`: the engine block plus the mirrored chart fields. */
  encodingFor(kind: EngineKind): any;
  /** '' when `kind` can be saved; otherwise what is missing. */
  needs(kind: EngineKind): string;
  suggestName(kind: EngineKind): string;
}

/** The builder's instance — mounted by visuals.ts ensureVizForm, read by vizBuilder.ts. */
let vizEngineForm: EngineBuilderApi | null = null;

/** Which engine a chart type is, or ''. */
function engineKind(type: string): EngineKind {
  return type === 'cohort' || type === 'event_funnel' ? type : '';
}

const EB_ID_RE = /(^|[\s_-])(user|customer|client|account|member|visitor|player|patient|entity|id)([\s_-]|id$|$)/i;
const EB_EVENT_RE = /event|action|activity|step|stage|type|name/i;

function createEngineBuilder(host: HTMLElement, opts: { onChange: () => void; dataset: () => { projectId: string; datasetId: string } | null }): EngineBuilderApi {
  const root = document.createElement('div');
  root.className = 'eb-build';
  host.appendChild(root);
  let columns: EncCol[] = [];
  const cohort = { entity: '', date: '', value: '', grain: 'month', show: 'retention', curve: false };
  const funnel = { entity: '', event: '', time: '', steps: [] as string[], window: { n: 7, unit: 'days' }, breakdown: '' };

  const by = (pred: (c: EncCol) => boolean): EncCol[] => columns.filter(pred);
  const has = (name: string): boolean => columns.some((c) => c.name === name);
  const entityPool = (): EncCol[] => by((c) => c.type !== 'date');
  const guessEntity = (): string => {
    const pool = entityPool();
    const hit = pool.find((c) => EB_ID_RE.test(c.name)) || pool.find((c) => c.type === 'text') || pool[0];
    return hit ? hit.name : '';
  };
  const firstDate = (): string => { const d = by((c) => c.type === 'date')[0]; return d ? d.name : ''; };

  // ── widgets ───────────────────────────────────────────────────────────────

  function row(label: string, control: HTMLElement, forId?: string): HTMLElement {
    const r = document.createElement('div');
    r.className = 'viz-build-row eb-row';
    const l = document.createElement(forId ? 'label' : 'span');
    l.className = 'viz-field-label';
    l.textContent = label;
    if (forId) (l as HTMLLabelElement).htmlFor = forId;
    r.appendChild(l);
    r.appendChild(control);
    return r;
  }

  function select(id: string, aria: string, onPick: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select');
    s.className = 'viz-select';
    s.id = id;
    s.setAttribute('aria-label', aria);
    s.addEventListener('change', () => { onPick(s.value); opts.onChange(); });
    return s;
  }

  function fill(s: HTMLSelectElement, pool: EncCol[], value: string, empty: string): void {
    fillSelect(s, [{ value: '', label: empty }].concat(pool.map((c) => ({ value: c.name, label: c.label || c.name, title: c.title }))), value);
  }

  function segmented(aria: string, items: Array<[string, string]>, get: () => string, set: (v: string) => void): { el: HTMLElement; sync: () => void; btns: HTMLButtonElement[] } {
    const g = document.createElement('div');
    g.className = 'eng-seg eb-seg';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', aria);
    const btns = items.map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'eng-seg-btn';
      b.textContent = label;
      b.dataset.value = value;
      b.addEventListener('click', () => { if (b.disabled) return; set(value); sync(); opts.onChange(); });
      g.appendChild(b);
      return b;
    });
    function sync(): void {
      btns.forEach((b) => { const on = b.dataset.value === get(); b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
    }
    return { el: g, sync, btns };
  }

  // ── the cohort panel ──────────────────────────────────────────────────────

  const cPanel = document.createElement('div');
  cPanel.className = 'eb-panel';
  const cEntity = select('eb-c-entity', 'Cohort entity column', (v) => { cohort.entity = v; });
  const cDate = select('eb-c-date', 'Cohort event date column', (v) => { cohort.date = v; });
  const cValue = select('eb-c-value', 'Cohort value column', (v) => { cohort.value = v; if (!v) cohort.show = 'retention'; syncCohort(); });
  const cGrain = segmented('Cohort grain', [['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter']],
    () => cohort.grain, (v) => { cohort.grain = v; });
  const cShow = segmented('Cohort figure', [['retention', 'Retention %'], ['value', 'Cumulative value']],
    () => cohort.show, (v) => { cohort.show = v; });
  const curveLabel = document.createElement('label');
  curveLabel.className = 'eb-check';
  const cCurve = document.createElement('input');
  cCurve.type = 'checkbox';
  cCurve.addEventListener('change', () => { cohort.curve = cCurve.checked; opts.onChange(); });
  curveLabel.appendChild(cCurve);
  curveLabel.appendChild(document.createTextNode('Show as a line per cohort, plus the average'));
  cPanel.append(
    row('Entity', cEntity, 'eb-c-entity'), row('Event date', cDate, 'eb-c-date'), row('Value', cValue, 'eb-c-value'),
    row('Grain', cGrain.el), row('Show', cShow.el), row('Retention curve', curveLabel),
  );
  const cHint = document.createElement('p');
  cHint.className = 'viz-enc-note eb-hint';
  cHint.textContent = 'A member\'s cohort is the period of their first event. Weeks start on your workspace\'s first day of week.';
  cPanel.appendChild(cHint);

  function syncCohort(): void {
    fill(cEntity, entityPool(), cohort.entity, 'Pick a column…');
    fill(cDate, by((c) => c.type === 'date'), cohort.date, 'Pick a date column…');
    fill(cValue, by((c) => c.type === 'number'), cohort.value, 'None — retention only');
    cGrain.sync();
    const valueBtn = cShow.btns[1];
    valueBtn.disabled = !cohort.value;
    valueBtn.title = cohort.value ? '' : 'Pick a value column first';
    cShow.sync();
    cCurve.checked = cohort.curve;
  }

  // ── the funnel panel ──────────────────────────────────────────────────────

  const fPanel = document.createElement('div');
  fPanel.className = 'eb-panel';
  const fEntity = select('eb-f-entity', 'Funnel entity column', (v) => { funnel.entity = v; });
  const fEvent = select('eb-f-event', 'Funnel event-name column', (v) => { funnel.event = v; funnel.steps = []; renderSteps(); });
  const fTime = select('eb-f-time', 'Funnel timestamp column', (v) => { funnel.time = v; });
  const fBreak = select('eb-f-breakdown', 'Funnel breakdown column', (v) => { funnel.breakdown = v; });
  const stepBox = document.createElement('div');
  stepBox.className = 'eb-steps';
  const stepList = document.createElement('ol');
  stepList.className = 'eb-step-list';
  const addStep = document.createElement('button');
  addStep.type = 'button';
  addStep.className = 'btn btn-sm eb-add';
  addStep.textContent = '+ Add step';
  addStep.setAttribute('aria-haspopup', 'menu');
  addStep.addEventListener('click', (e) => { e.stopPropagation(); void pickStep(); });
  stepBox.append(stepList, addStep);

  const winBox = document.createElement('div');
  winBox.className = 'eb-window';
  const winN = document.createElement('input');
  winN.type = 'number';
  winN.min = '0.1';
  winN.step = 'any';
  winN.id = 'eb-f-window';
  winN.className = 'viz-select eb-window-n';
  winN.setAttribute('aria-label', 'Conversion window length');
  winN.addEventListener('change', () => {
    const n = Number(winN.value);
    funnel.window.n = Number.isFinite(n) && n > 0 ? n : 7;
    winN.value = String(funnel.window.n);
    opts.onChange();
  });
  const winUnit = select('eb-f-unit', 'Conversion window unit', (v) => { funnel.window.unit = v === 'hours' ? 'hours' : 'days'; });
  fillSelect(winUnit, [{ value: 'hours', label: 'hours' }, { value: 'days', label: 'days' }], 'days');
  winBox.append(winN, winUnit);
  fPanel.append(
    row('Entity', fEntity, 'eb-f-entity'), row('Event name', fEvent, 'eb-f-event'), row('Timestamp', fTime, 'eb-f-time'),
    row('Steps', stepBox), row('Window', winBox, 'eb-f-window'), row('Breakdown', fBreak, 'eb-f-breakdown'),
  );
  const fHint = document.createElement('p');
  fHint.className = 'viz-enc-note eb-hint';
  fHint.textContent = 'Strict order: each step counts only after the one before it, within the window of the first step.';
  fPanel.appendChild(fHint);

  function renderSteps(): void {
    stepList.innerHTML = '';
    if (!funnel.steps.length) {
      const ph = document.createElement('li');
      ph.className = 'enc-empty eb-step-empty';
      ph.textContent = funnel.event ? 'Add at least two steps, in the order they happen' : 'Pick the event-name column first';
      stepList.appendChild(ph);
    }
    funnel.steps.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = 'enc-pill eb-step';
      const n = document.createElement('span');
      n.className = 'eb-step-n';
      n.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'enc-pill-name';
      name.textContent = step;
      li.append(n, name);
      const btn = (text: string, aria: string, disabled: boolean, run: () => void): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = text === '×' ? 'viz-value-del' : 'eb-move';
        b.textContent = text;
        b.setAttribute('aria-label', aria);
        b.disabled = disabled;
        b.addEventListener('click', () => { run(); renderSteps(); opts.onChange(); });
        li.appendChild(b);
      };
      const swap = (a: number, b: number): void => { [funnel.steps[a], funnel.steps[b]] = [funnel.steps[b], funnel.steps[a]]; };
      btn('↑', `Move ${step} earlier`, i === 0, () => swap(i, i - 1));
      btn('↓', `Move ${step} later`, i === funnel.steps.length - 1, () => swap(i, i + 1));
      btn('×', `Remove step ${step}`, false, () => { funnel.steps.splice(i, 1); });
      stepList.appendChild(li);
    });
    addStep.disabled = !funnel.event || funnel.steps.length >= 8;
    addStep.title = funnel.steps.length >= 8 ? 'A funnel has at most eight steps' : '';
  }

  async function pickStep(): Promise<void> {
    const ds = opts.dataset();
    if (!ds || !funnel.event) return;
    let values: string[] = [];
    try {
      const r = await window.hub.datasetDistinct(ds.projectId, ds.datasetId, funnel.event, 200);
      values = r && Array.isArray(r.values) ? r.values.map(String) : [];
    } catch (_) { values = []; }
    const free = values.filter((v) => v !== '' && funnel.steps.indexOf(v) < 0);
    openRowMenu(addStep, free.length
      ? free.slice(0, 60).map((v) => ({ label: v, onClick: () => { funnel.steps.push(v); renderSteps(); opts.onChange(); } }))
      : [{ label: values.length ? 'Every value is already a step' : 'No values in this column', onClick: () => { /* informational */ } }]);
  }

  function syncFunnel(): void {
    fill(fEntity, entityPool(), funnel.entity, 'Pick a column…');
    fill(fEvent, by((c) => c.type === 'text'), funnel.event, 'Pick a column…');
    fill(fTime, by((c) => c.type === 'date'), funnel.time, 'Pick a timestamp column…');
    fill(fBreak, by((c) => c.type !== 'date' && c.name !== funnel.entity), funnel.breakdown, 'None');
    winN.value = String(funnel.window.n);
    winUnit.value = funnel.window.unit;
    renderSteps();
  }

  root.append(cPanel, fPanel);

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    el: root,
    setColumns(cols: EncCol[], preset?: any): void {
      columns = Array.isArray(cols) ? cols.slice() : [];
      const c = preset && preset.cohort ? preset.cohort : null;
      cohort.entity = c && has(str(c.entity)) ? str(c.entity) : guessEntity();
      cohort.date = c && has(str(c.date)) ? str(c.date) : firstDate();
      cohort.value = c && has(str(c.value)) ? str(c.value) : '';
      cohort.grain = c && ['week', 'month', 'quarter'].indexOf(c.grain) >= 0 ? c.grain : 'month';
      cohort.show = c && c.show === 'value' && cohort.value ? 'value' : 'retention';
      cohort.curve = !!(c && c.curve);
      const f = preset && preset.eventFunnel ? preset.eventFunnel : null;
      funnel.entity = f && has(str(f.entity)) ? str(f.entity) : guessEntity();
      const texts = by((x) => x.type === 'text' && x.name !== funnel.entity);
      funnel.event = f && has(str(f.event)) ? str(f.event)
        : (texts.find((x) => EB_EVENT_RE.test(x.name)) || texts[0] || { name: '' }).name;
      funnel.time = f && has(str(f.time)) ? str(f.time) : firstDate();
      funnel.steps = f && Array.isArray(f.steps) ? f.steps.filter((s: unknown) => typeof s === 'string').slice(0, 8) : [];
      funnel.window = f && f.window ? { n: Number(f.window.n) > 0 ? Number(f.window.n) : 7, unit: f.window.unit === 'hours' ? 'hours' : 'days' } : { n: 7, unit: 'days' };
      funnel.breakdown = f && has(str(f.breakdown)) ? str(f.breakdown) : '';
      syncCohort();
      syncFunnel();
    },
    show(kind: EngineKind): void {
      root.hidden = !kind;
      cPanel.hidden = kind !== 'cohort';
      fPanel.hidden = kind !== 'event_funnel';
    },
    encodingFor(kind: EngineKind): any {
      if (kind === 'cohort') {
        const block: any = { entity: cohort.entity, date: cohort.date, grain: cohort.grain, show: cohort.show, curve: cohort.curve };
        if (cohort.value) block.value = cohort.value;
        return { category: cohort.date, values: cohort.entity || cohort.value
          ? [{ column: cohort.value || cohort.entity, aggregation: cohort.value ? 'sum' : 'count' }] : [], cohort: block };
      }
      if (kind === 'event_funnel') {
        const block: any = { entity: funnel.entity, event: funnel.event, time: funnel.time, steps: funnel.steps.slice(), window: { ...funnel.window } };
        if (funnel.breakdown) block.breakdown = funnel.breakdown;
        return { category: funnel.event, values: funnel.entity ? [{ column: funnel.entity, aggregation: 'count' }] : [], eventFunnel: block };
      }
      return {};
    },
    needs(kind: EngineKind): string {
      if (kind === 'cohort') {
        if (!cohort.entity || !cohort.date) return 'Pick an entity and an event date before saving.';
        if (cohort.show === 'value' && !cohort.value) return 'Pick a value column, or show retention.';
      }
      if (kind === 'event_funnel') {
        if (!funnel.entity || !funnel.event || !funnel.time) return 'Pick an entity, an event-name column and a timestamp before saving.';
        if (funnel.steps.length < 2) return 'Add at least two steps before saving.';
      }
      return '';
    },
    suggestName(kind: EngineKind): string {
      const grain = cohort.grain === 'week' ? 'weekly' : cohort.grain === 'quarter' ? 'quarterly' : 'monthly';
      if (kind === 'cohort') return cohort.show === 'value' ? `${cohort.value} per ${cohort.entity}, ${grain} cohorts` : `${cohort.entity} retention, ${grain} cohorts`;
      if (kind === 'event_funnel' && funnel.steps.length) return `${funnel.steps[0]} → ${funnel.steps[funnel.steps.length - 1]} funnel`;
      return '';
    },
  };
}
