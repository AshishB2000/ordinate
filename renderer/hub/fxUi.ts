'use strict';

// Multi-currency in the hub: the project's currency state, the DISPLAY
// currency the formatter shows, a dashboard's own target (its header picker and
// the reads that carry it), the note a converted tile wears, and the Currency
// section of a number column's profile. Settings → General → Currency lives in
// fxSettings.ts. Classic global-scope renderer <script>: no import/export.
//
// Main does every conversion (src/ipc/fxQuery.ts). This file never computes a
// figure: it says which currency to convert to, and draws what comes back.

/** `fx:get` for the open project, or null before it has loaded. */
let fxState: any = null;
let fxStateProject = '';

function fxEl<T extends HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fxSelect(options: Array<[string, string]>, value: string, label: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = fxEl<HTMLSelectElement>('select', 'fx-select');
  sel.setAttribute('aria-label', label);
  for (const [v, t] of options) {
    const o = fxEl<HTMLOptionElement>('option', '', t);
    o.value = v;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/** Load the project's currency state, then repaint everything that shows it. */
async function fxAdopt(projectId: string): Promise<void> {
  let r: any = null;
  try { r = window.hubFx ? await window.hubFx.get(projectId) : null; } catch (_) { r = null; }
  if (projectId !== currentProjectId) return;
  fxState = r && r.ok ? r : null;
  fxStateProject = projectId;
  fxRefresh();
}

/** Adopt a reply from any fx:* write, and repaint. */
function fxTake(r: any): void {
  if (r && r.ok && currentProjectId) { fxState = r; fxStateProject = currentProjectId; }
  fxRefresh();
}

function fxRefresh(): void {
  fxApplyDisplay();
  fxPaintDashPicker();
  if (typeof fxPaintSettings === 'function') void fxPaintSettings();
}

function fxSettingsNow(): any {
  return fxState && fxStateProject === currentProjectId ? fxState.settings : null;
}

/** True when anything in the project declares a currency. */
function fxAnyDeclared(): boolean {
  const s = fxSettingsNow();
  return !!s && Object.keys(s.columns || {}).length > 0;
}

/** The open dashboard's own target, or ''. */
function fxDashCode(): string {
  const s = fxSettingsNow();
  const ed = document.getElementById('dash-editor');
  if (!s || !dashCurrent || !dashCurrent.id || !ed || ed.hidden) return '';
  return (s.dashboards && s.dashboards[dashCurrent.id]) || '';
}

/** The currency money is SHOWN in: the open dashboard's, the project's, else the workspace's. */
function fxApplyDisplay(): void {
  const s = fxSettingsNow();
  OrdFormat.setCurrencyOverride(fxDashCode() || (s && s.target) || null);
}

/**
 * A dashboard tile's read, carrying the dashboard's own target — or null when
 * it has none, and the ordinary read (snapshotAsOf.ts) goes ahead.
 */
function fxDashRead(kind: 'visualData' | 'metricValue' | 'computeMetric', req: any): Promise<any> | null {
  const code = fxDashCode();
  if (!code || !window.hubFx) return null;
  return window.hubFx[kind]({ ...req, currency: code });
}

// ── A converted tile ─────────────────────────────────────────────────────────

/** The chips under a converted figure: rows with no rate, and the sample label. */
function fxPaintTileNote(body: HTMLElement, fx: any): void {
  body.querySelectorAll(':scope > .fx-tile-note').forEach((n) => n.remove());
  if (!fx || (!fx.warning && !fx.sample)) return;
  const note = fxEl('div', 'fx-tile-note');
  if (fx.warning) {
    const w = fxEl('span', 'fx-chip fx-chip-warn');
    w.appendChild(icon('alert', 12));
    w.appendChild(fxEl('span', '', fx.warning));
    w.title = t('fxUi.these_rows_are_left_out_of');
    note.appendChild(w);
  }
  if (fx.sample) {
    const s = fxEl('span', 'fx-chip fx-chip-sample', t('fxUi.sample_rates_not_live'));
    s.title = t('fxUi.converted_to_with_the_bundled', { target: fx.target });
    note.appendChild(s);
  }
  body.appendChild(note);
}

/** A converted chart's number format: money, unless the chart already chose one. */
function fxOverrides(overrides: any, fx: any): any {
  if (!fx || (overrides && overrides.numberFormat)) return overrides;
  return Object.assign({}, overrides || {}, { numberFormat: 'currency' });
}

// ── The dashboard's own currency ─────────────────────────────────────────────

const fxDash = (() => {
  const wrap = fxEl<HTMLLabelElement>('label', 'fx-dash');
  wrap.id = 'fx-dash-wrap';
  wrap.hidden = true;
  wrap.appendChild(fxEl('span', 'fx-dash-label', t('common.currency')));
  const sel = fxEl<HTMLSelectElement>('select', 'fx-select');
  sel.id = 'fx-dash-currency';
  sel.setAttribute('aria-label', t('fxUi.this_dashboard_s_currency'));
  wrap.appendChild(sel);
  sel.addEventListener('change', async () => {
    if (!currentProjectId || !dashCurrent || !window.hubFx) return;
    fxTake(await window.hubFx.dashboard(currentProjectId, dashCurrent.id, sel.value || null));
    renderDashGrid();
  });
  return { wrap, sel };
})();

function fxPaintDashPicker(): void {
  const { wrap, sel } = fxDash;
  wrap.hidden = !fxAnyDeclared() || !dashCurrent;
  if (wrap.hidden || !fxState) return;
  const proj = fxState.settings.target || fxState.workspaceCurrency;
  sel.innerHTML = '';
  const opts: Array<[string, string]> = [['', t('fxUi.project', { proj })]];
  (fxState.codes || []).forEach((c: string) => opts.push([c, c + ' — ' + OrdFormat.currencySymbol(c)]));
  for (const [v, t] of opts) {
    const o = fxEl<HTMLOptionElement>('option', '', t);
    o.value = v;
    sel.appendChild(o);
  }
  sel.value = fxDashCode();
  wrap.classList.toggle('is-on', !!fxDashCode());
}

(function fxMountDash(): void {
  const editor = document.getElementById('dash-editor');
  const anchor = document.getElementById('dash-refresh-data');
  if (!editor || !anchor) return;
  anchor.after(fxDash.wrap);
  // Opening or closing a dashboard moves the display currency to its own and back.
  new MutationObserver(() => { fxApplyDisplay(); fxPaintDashPicker(); })
    .observe(editor, { attributes: true, attributeFilter: ['hidden'] });
})();

// ── A number column's profile: its currency ──────────────────────────────────

let fxProfileSeq = 0;

function fxProfileSection(): HTMLElement | null {
  const host = dsEl('ds-profile');
  const body = host ? (host.querySelector('.dsp-body') as HTMLElement | null) : null;
  if (!body) return null;
  let sec = body.querySelector('.fx-dsp') as HTMLElement | null;
  if (!sec) {
    sec = fxEl('section', 'fx-dsp');
    sec.setAttribute('aria-label', t('common.currency'));
    // After the histogram, never above it: the distribution keeps the body's
    // full height (index.html, #ds-profile) and the currency is a setting.
    body.appendChild(sec);
  }
  return sec;
}

async function fxPaintProfile(col: any): Promise<void> {
  const sec = fxProfileSection();
  if (!sec) return;
  const seq = ++fxProfileSeq;
  sec.innerHTML = '';
  sec.hidden = !col || col.type !== 'number' || !currentProjectId || !expId || !window.hubFx;
  if (sec.hidden) return;
  if (fxStateProject !== currentProjectId || !fxState) await fxAdopt(currentProjectId as string);
  if (seq !== fxProfileSeq || !fxState) return;
  const datasetId = expId as string;
  const column = String(col.name);
  const decl = ((fxState.settings.columns || {})[datasetId] || {})[column] || null;
  const target = fxState.target;

  sec.appendChild(fxEl('p', 'dsp-head', t('common.currency')));
  const save = async (next: any): Promise<void> => {
    fxTake(await window.hubFx.column(currentProjectId as string, datasetId, column, next));
    if (seq === fxProfileSeq) void fxPaintProfile(col);
  };

  const kind = decl ? decl.kind : '';
  const grid = fxEl('div', 'fx-dsp-grid');
  const row = (label: string, ctl: HTMLElement): void => {
    const l = fxEl('label', 'fx-dsp-row');
    l.appendChild(fxEl('span', 'fx-dsp-k', label));
    l.appendChild(ctl);
    grid.appendChild(l);
  };
  const codes: Array<[string, string]> = (fxState.codes || []).map((c: string) => [c, c + ' — ' + OrdFormat.currencySymbol(c)]);
  const textCols = expColumns.filter((c: any) => c.type === 'text').map((c: any) => [c.name, c.name] as [string, string]);
  const dateCols = expColumns.filter((c: any) => c.type === 'date').map((c: any) => c.name as string);

  row(t('fxUi.money_in'), fxSelect([['', t('fxUi.not_money')], ['fixed', t('fxUi.one_currency')], ['column', t('fxUi.a_currency_per_row')]], kind, t('fxUi.currency_of_this_column'), (v) => {
    if (!v) void save(null);
    else if (v === 'fixed') void save({ kind: 'fixed', code: (decl && decl.code) || target });
    else if (textCols.length) void save({ kind: 'column', column: textCols[0][0] });
    else { showToast(t('fxUi.a_currency_per_row_needs_a')); void fxPaintProfile(col); }
  }));
  if (decl && decl.kind === 'fixed') {
    row(t('common.currency'), fxSelect(codes, decl.code, t('fxUi.the_column_s_currency'), (v) => void save({ ...decl, code: v })));
  } else if (decl && decl.kind === 'column') {
    row(t('fxUi.codes_in'), fxSelect(textCols, decl.column, t('fxUi.the_column_holding_each_row_s'), (v) => void save({ ...decl, column: v })));
  }
  if (decl && dateCols.length) {
    const auto: [string, string] = ['', t('fxUi.auto', { p0: dateCols[0] })];
    row(t('fxUi.rate_on'), fxSelect([auto].concat(dateCols.map((d) => [d, d] as [string, string])), decl.date || '', t('fxUi.the_date_that_picks_the_rate'), (v) => {
      const next = { ...decl };
      if (v) next.date = v;
      else delete next.date;
      void save(next);
    }));
  }
  sec.appendChild(grid);

  if (!decl) {
    sec.appendChild(fxEl('p', 'dsp-note', t('fxUi.declare_a_currency_and_every_metric', { target })));
    return;
  }
  if (!dateCols.length) sec.appendChild(fxEl('p', 'dsp-note', t('fxUi.no_date_column_every_row_converts')));
  const status = fxEl('div', 'fx-dsp-status');
  status.appendChild(fxEl('span', 'dsp-note', t('fxUi.checking_rates')));
  sec.appendChild(status);
  let cov: any = null;
  try { cov = await window.hubFx.coverage(currentProjectId as string, datasetId, column); } catch (_) { cov = null; }
  if (seq !== fxProfileSeq) return;
  status.innerHTML = '';
  if (!cov || !cov.ok || !cov.fx) {
    status.appendChild(fxEl('span', 'dsp-note', t('fxUi.the_conversion_could_not_be_checked')));
    return;
  }
  const line = fxEl('p', 'dsp-note fx-dsp-total');
  line.textContent = t('fxUi.converts_to_total', { target: cov.fx.target, p1: (cov.value == null ? '—' : OrdFormat.formatCurrency(cov.value, { compact: true })), p2: !!(cov.fx.missing) });
  status.appendChild(line);
  fxPaintTileNote(status, cov.fx);
}
