'use strict';

// DASHBOARD PARAMETERS in the renderer — the live values, `{{name}}` in text,
// and the filter-bar widget that moves one. RENDERER ONLY. Classic global-scope
// <script>: no import/export. Loads after dashControls.js (shares
// openControlPopover, controlState's neighbour paramState, renderDashGrid) and
// before dashControlBar.js, which draws a parameter chip through
// renderParamControl below.
//
// A parameter's DEFINITION and default live on the dashboard record
// (`dashCurrent.parameters`); what a reader has moved it to is `paramState`
// (dashboards.ts), view state that is never saved unless "Save as default" is
// clicked. Every query the sheet makes carries `dashParamPayload()` — the
// parameters at their current values — and MAIN resolves `[[name]]` in filters
// and formulas (src/analysis/params.ts). The renderer resolves only `{{name}}`
// in titles and text, because that is text it draws itself; `dashSubst` below
// mirrors params.substituteText and is pinned to it by
// scripts/test-paramsParity.ts.

const PARAM_TEXT_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;

function dashParams(): any[] {
  if (!dashCurrent) return [];
  if (!Array.isArray(dashCurrent.parameters)) dashCurrent.parameters = [];
  return dashCurrent.parameters;
}

function dashParamById(id: string): any {
  return dashParams().find((p) => p && p.id === id) || null;
}

/** A parameter's value right now: what the reader picked, else its default. */
function dashParamValue(p: any): any {
  if (!p) return null;
  return paramState.has(p.id) ? paramState.get(p.id) : p.value;
}

/** What every query carries: `[{ name, kind, value, min, max }]`. */
function dashParamPayload(): any[] {
  return dashParams().map((p) => ({ name: p.name, kind: p.kind, value: dashParamValue(p), min: p.min, max: p.max }));
}

/** A value as a title shows it — the mirror of params.paramDisplay. */
function dashParamDisplay(kind: string, value: any): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (kind === 'number' && typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return String(value);
}

/**
 * `{{name}}` → the parameter's current value, as text. A name no parameter has
 * stays as typed, so a broken reference is visible rather than blank.
 */
function dashSubst(text: any): string {
  return paramSubst(text, dashParamPayload());
}

/** `dashSubst` against an explicit `[{ name, kind, value }]` — a report of a
 *  dashboard that is not the one open reads its SAVED defaults this way. */
function paramSubst(text: any, entries: any[]): string {
  const s = text == null ? '' : String(text);
  if (s.indexOf('{{') < 0) return s;
  const byName = new Map<string, any>();
  (Array.isArray(entries) ? entries : []).forEach((p) => p && byName.set(String(p.name).toLowerCase(), p));
  return s.replace(PARAM_TEXT_RE, (whole: string, name: string) => {
    const p = byName.get(name.toLowerCase());
    return p ? dashParamDisplay(p.kind, p.value) : whole;
  });
}

/**
 * A filter chip's `[[threshold]]` read aloud — "threshold (2,000)" — so the
 * chip says both what it follows and what that is right now.
 */
function dashParamRefLabel(text: string): string {
  if (text.indexOf('[[') < 0) return text;
  return text.replace(/\[\[\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\]\]/g, (whole: string, name: string) => {
    const p = dashParams().find((x) => String(x.name).toLowerCase() === name.toLowerCase());
    return p ? name + ' (' + dashParamDisplay(p.kind, dashParamValue(p)) + ')' : whole;
  });
}

/** Whether a parameter control is at its saved default. */
function paramIsAtDefault(card: any): boolean {
  const p = card && card.control ? dashParamById(card.control.paramId) : null;
  return !p || !paramState.has(p.id) || JSON.stringify(paramState.get(p.id)) === JSON.stringify(p.value);
}

/** Move a parameter and redraw everything that reads it. */
function setDashParam(id: string, value: any): void {
  paramState.set(id, value);
  renderDashGrid();
}

/** "Save as default": the reader's value becomes the one the record opens on. */
function saveParamDefault(card: any): void {
  const p = card && card.control ? dashParamById(card.control.paramId) : null;
  if (!p) return;
  p.value = dashParamValue(p);
  paramState.delete(p.id);
  markDashDirty('Save parameter default');
  renderDashGrid();
}

/** The validation messages a query answered with — shown on the card it spoiled. */
function paintParamErrors(body: HTMLElement, errors: any): void {
  if (!Array.isArray(errors) || errors.length === 0) return;
  const p = document.createElement('p');
  p.className = 'dash-param-warn';
  p.appendChild(icon('alert', 12));
  const t = document.createElement('span');
  t.textContent = String(errors[0]);
  p.appendChild(t);
  if (errors.length > 1) p.title = errors.join('\n');
  body.appendChild(p);
}

// ── The widget ───────────────────────────────────────────────────────────────

function paramNum(v: any): string {
  return typeof v === 'number' && Number.isFinite(v) ? dashParamDisplay('number', v) : '—';
}

/**
 * The control for one parameter, by kind: a slider for a number with both
 * bounds, a number box without them, a date picker, a text box, or a select
 * over its options. A slider re-queries as it moves (debounced), so the sheet
 * follows the thumb rather than waiting for the release.
 */
function renderParamControl(card: any, wrap: HTMLElement): void {
  const p = dashParamById(card.control.paramId);
  if (!p) {
    dashCardMissing(wrap, 'Parameter removed.');
    return;
  }
  const cur = dashParamValue(p);
  const label = card.control.label || p.name;
  let timer: number | null = null;
  const later = (fn: () => void, ms: number): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };

  if (p.kind === 'number' && typeof p.min === 'number' && typeof p.max === 'number') {
    const box = document.createElement('div');
    box.className = 'dash-param-slider';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(p.min);
    range.max = String(p.max);
    range.step = typeof p.step === 'number' ? String(p.step) : 'any';
    range.value = String(typeof cur === 'number' ? cur : p.min);
    range.setAttribute('aria-label', label);
    const out = document.createElement('output');
    out.className = 'dash-param-out tnum';
    out.textContent = paramNum(typeof cur === 'number' ? cur : null);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      out.textContent = paramNum(v);
      later(() => setDashParam(p.id, v), 180);
    });
    box.appendChild(range);
    box.appendChild(out);
    wrap.appendChild(box);
    return;
  }

  const hasOptions = (Array.isArray(p.list) && p.list.length > 0) || !!(p.list && p.list.datasetId);
  if ((p.kind === 'text' || p.kind === 'list') && hasOptions) {
    const sel = document.createElement('select');
    sel.className = 'dash-ctrl-select dash-param-select';
    sel.setAttribute('aria-label', label);
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All';
    sel.appendChild(all);
    const chosen = Array.isArray(cur) ? String(cur[0] || '') : String(cur == null ? '' : cur);
    const fill = (values: string[]): void => {
      values.forEach((v) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });
      sel.value = chosen;
    };
    if (Array.isArray(p.list)) fill(p.list.map((v: any) => String(v)));
    else if (currentProjectId) {
      void window.hub.datasetDistinct(currentProjectId, p.list.datasetId, p.list.column, 200)
        .then((res: any) => fill(res && Array.isArray(res.values) ? res.values : []))
        .catch(() => fill([]));
    }
    sel.addEventListener('change', () => {
      const v = sel.value;
      setDashParam(p.id, p.kind === 'list' ? (v ? [v] : []) : v || null);
    });
    wrap.appendChild(sel);
    return;
  }

  const input = document.createElement('input');
  input.className = 'dash-ctrl-date dash-param-input';
  input.setAttribute('aria-label', label);
  if (p.kind === 'date') {
    input.type = 'date';
    input.value = typeof cur === 'string' ? cur : '';
    input.addEventListener('change', () => setDashParam(p.id, input.value || null));
  } else if (p.kind === 'number') {
    input.type = 'number';
    if (typeof p.step === 'number') input.step = String(p.step);
    input.value = typeof cur === 'number' ? String(cur) : '';
    input.addEventListener('input', () => later(() => {
      const n = input.value === '' ? null : Number(input.value);
      setDashParam(p.id, n != null && Number.isFinite(n) ? n : null);
    }, 350));
  } else {
    input.type = 'text';
    input.placeholder = 'Type a value';
    input.value = Array.isArray(cur) ? cur.join(', ') : cur == null ? '' : String(cur);
    input.addEventListener('input', () => later(() => {
      const v = input.value;
      setDashParam(p.id, p.kind === 'list' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v);
    }, 350));
  }
  wrap.appendChild(input);
}
