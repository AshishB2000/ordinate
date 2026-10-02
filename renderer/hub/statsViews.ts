'use strict';

// The workbench's Correlation and Regression results (statsPanel.ts calls
// these with main's computed result). Formatting only — every figure, p-value
// and interval arrived computed. Compare groups and Distribution are
// statsViewsGroups.ts.

const SW_GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A statistic for reading — the same magnitude rule as main's sentences.fmtStat. */
function swFmt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a >= 1e15 || (a > 0 && a < 1e-4)) return v.toExponential(2);
  if (a >= 1000) return SW_GROUPED.format(v);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

function swP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '< 0.001';
  if (p > 0.999) return '> 0.999';
  return p.toFixed(3);
}

function swStars(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '';
  return p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : p < 0.1 ? '·' : '';
}

function swCount(n: number): string {
  return SW_GROUPED.format(n);
}

function swSigKey(host: HTMLElement): void {
  const p = document.createElement('p');
  p.className = 'sw-footnote';
  p.textContent = t('statsViews.significance_p_0_001_p_0');
  host.appendChild(p);
}

// ── Correlation ──────────────────────────────────────────────────────────────

function swViewCorrelation(host: HTMLElement, r: any, spec: any): void {
  const { columns, cells, method } = r.matrix;
  const sym = method === 'spearman' ? 'ρ' : 'r';
  swResultHead(host, t('statsViews.correlation_columns', { p0: !!(method === 'spearman'), columnsCount: columns.length }),
    t('statsViews.rows_each_pair_on_the_rows', { rows: swCount(r.rows) }), spec);

  const wrap = document.createElement('div');
  wrap.className = 'sw-heat-wrap';
  const table = document.createElement('table');
  table.className = 'sw-heat';
  const caption = document.createElement('caption');
  caption.className = 'sw-sr';
  caption.textContent = t('statsViews.correlation_matrix', { p0: !!(method === 'spearman') });
  table.appendChild(caption);
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(document.createElement('td'));
  for (const c of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c;
    th.title = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const tip = document.createElement('div');
  tip.className = 'tip sw-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  tip.id = 'sw-heat-tip';
  columns.forEach((rowName: string, i: number) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = rowName;
    th.title = rowName;
    tr.appendChild(th);
    columns.forEach((colName: string, j: number) => {
      const td = document.createElement('td');
      const c = cells[i][j];
      const live = i !== j && c.r !== null;
      // A pair with an r is a button (it opens the scatter); the diagonal and
      // an empty pair are plain cells that still say what they are.
      const b = document.createElement(live ? 'button' : 'span') as HTMLButtonElement;
      if (live) b.type = 'button';
      else b.setAttribute('role', 'img');
      b.className = 'sw-cell';
      b.dataset.i = String(i);
      b.dataset.j = String(j);
      const rv = c.r;
      b.textContent = i === j ? '1' : rv === null ? '—' : rv.toFixed(2) + swStars(c.p);
      const text = i === j ? t('statsViews.values', { rowName, n: swCount(c.n) }) : rv === null
        ? t('statsViews.not_enough_rows_with_both', { rowName, colName, n: swCount(c.n) })
        : `${rowName} × ${colName}: ${sym} = ${rv.toFixed(3)}, p ${swP(c.p)}, n = ${swCount(c.n)}`;
      b.setAttribute('aria-label', text + (i !== j && rv !== null ? t('statsViews.open_the_scatter') : ''));
      b.dataset.tip = text;
      if (typeof rv === 'number') {
        const k = Math.round(Math.min(1, Math.abs(rv)) * 55);
        b.style.background = `color-mix(in srgb, var(${rv >= 0 ? '--sw-pos' : '--sw-neg'}) ${k}%, var(--surface))`;
        if (Math.abs(rv) >= 0.7 && i !== j) b.classList.add('is-strong');
      }
      if (i === j) b.classList.add('is-diag');
      const show = (): void => {
        tip.textContent = b.dataset.tip || '';
        tip.hidden = false;
        const wr = wrap.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        tip.style.left = Math.max(0, br.left - wr.left + br.width / 2 - 110 + wrap.scrollLeft) + 'px';
        tip.style.top = br.bottom - wr.top + 6 + wrap.scrollTop + 'px';
      };
      b.addEventListener('mouseenter', show);
      b.addEventListener('focus', show);
      b.addEventListener('mouseleave', () => { tip.hidden = true; });
      b.addEventListener('blur', () => { tip.hidden = true; });
      if (live) b.addEventListener('click', () => { void swShowPair(columns[i], columns[j], spec); });
      td.appendChild(b);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.append(table, tip);
  host.appendChild(wrap);

  const legend = document.createElement('div');
  legend.className = 'sw-heat-legend';
  legend.setAttribute('aria-hidden', 'true');
  for (const [cls, text] of [['sw-leg-neg', t('statsViews.1_negative')], ['sw-leg-bar', ''], ['sw-leg-pos', t('statsViews.1_positive')]]) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    legend.appendChild(s);
  }
  host.appendChild(legend);
  swSigKey(host);

  const pair = document.createElement('section');
  pair.className = 'sw-pair';
  pair.id = 'sw-pair';
  pair.setAttribute('aria-label', t('statsViews.selected_pair'));
  const hint = document.createElement('p');
  hint.className = 'sw-pair-hint';
  hint.textContent = t('statsViews.select_a_cell_to_see_that');
  pair.appendChild(hint);
  host.appendChild(pair);
  const want = swState.pair;
  swState.pair = null;
  if (want && columns.includes(want[0]) && columns.includes(want[1])) void swShowPair(want[0], want[1], spec);
}

async function swShowPair(x: string, y: string, spec: any): Promise<void> {
  const host = document.getElementById('sw-pair');
  if (!host || !currentProjectId) return;
  host.textContent = '';
  host.setAttribute('aria-busy', 'true');
  let res: any;
  try { res = await window.hubStats.pair(currentProjectId, spec, x, y); } catch (_) { res = { ok: false, error: t('statsViews.could_not_draw_that_pair') }; }
  if (!document.contains(host)) return;
  host.removeAttribute('aria-busy');
  host.textContent = '';
  if (!res || !res.ok) { swPaintProblem(host, (res && res.error) || t('statsViews.could_not_draw_that_pair')); return; }
  const p = res.pair;
  const head = document.createElement('div');
  head.className = 'sw-pair-head';
  const h = document.createElement('h4');
  h.className = 'sw-pair-title';
  h.textContent = `${x} × ${y}`;
  const model = document.createElement('button');
  model.type = 'button';
  model.className = 'btn btn-sm';
  iconLabel(model, 'trending-up', t('statsViews.model_on', { y, x }));
  model.addEventListener('click', () => {
    swState.specs.regression = { kind: 'regression', target: y, predictors: [x] };
    swState.replies.regression = null;
    swSelectTab('regression', true);
  });
  head.append(h, model);
  host.appendChild(head);
  swSentence(host, p.sentence);
  const c = p.cell;
  const items: Array<[string, string, string?]> = [
    [spec.method === 'spearman' ? 'ρ' : 'r', c.r === null ? '—' : c.r.toFixed(3)], ['p', swP(c.p)], ['n', swCount(c.n)],
  ];
  if (p.fit) items.push([t('statsViews.slope'), swFmt(p.fit.slope), t('statsViews.per_unit_of', { y, x })], [t('statsViews.intercept'), swFmt(p.fit.intercept)]);
  swStatRow(host, items);
  swScatterFit(host, p);
}

// ── Regression ───────────────────────────────────────────────────────────────

function swViewRegression(host: HTMLElement, r: any, spec: any): void {
  const f = r.fit;
  const refs = f.references.map((x: any) => `${x.column} = ${x.level}`).join(', ');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm btn-primary sw-save-calc';
  iconLabel(save, 'function', t('statsViews.save_as_predicted', { target: f.target }));
  save.title = t('statsViews.add_predicted_to_this_dataset_as', { target: f.target });
  save.addEventListener('click', () => { void swSaveFormula(spec, save); });
  swResultHead(host, t('statsViews.regression_of_on_term', { target: f.target, p1: f.terms.length - 1, p2: !!(f.terms.length === 2) }),
    t('statsViews.rows_used', { n: swCount(f.n), p1: f.dropped ? t('statsViews.dropped_for_a_missing_value', { dropped: swCount(f.dropped) }) : '', p2: refs ? t('statsViews.reference', { refs }) : '' }), spec, [save]);
  swSentence(host, r.sentence);
  swStatRow(host, [
    ['R²', f.r2.toFixed(3)], [t('statsViews.adjusted_r2'), f.adjR2.toFixed(3)],
    ['F', swFmt(f.f), t('statsViews.on_and_df', { fDf1: f.fDf1, fDf2: swCount(f.fDf2) })], [t('statsViews.model_p'), swP(f.fP)],
    [t('statsViews.residual_se'), swFmt(f.sigma)], ['n', swCount(f.n)],
  ]);

  // The coefficient table, with each 95% interval drawn against zero.
  let lo = 0;
  let hi = 0;
  for (const t of f.terms.slice(1)) { lo = Math.min(lo, t.ciLow); hi = Math.max(hi, t.ciHigh); }
  const span = hi - lo || 1;
  const pos = (v: number): number => ((v - lo) / span) * 100;
  const wrap = document.createElement('div');
  wrap.className = 'sw-table-wrap';
  const table = document.createElement('table');
  table.className = 'sw-table sw-coef';
  const caption = document.createElement('caption');
  caption.className = 'sw-sr';
  caption.textContent = t('statsViews.coefficients');
  table.appendChild(caption);
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const [text, cls] of [[t('statsViews.term'), ''], [t('statsViews.estimate'), 'num'], [t('statsViews.std_error'), 'num'], ['t', 'num'], ['p', 'num'], ['', 'sig'], [t('statsViews.95_confidence_interval'), 'ci']]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = text;
    if (!text) th.setAttribute('aria-label', t('statsViews.significance'));
    if (cls) th.className = cls;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  f.terms.forEach((t: any, i: number) => {
    const tr = document.createElement('tr');
    if (t.p < 0.05) tr.classList.add('is-sig');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = t.name;
    tr.appendChild(name);
    for (const v of [swFmt(t.estimate), swFmt(t.se), swFmt(t.t), swP(t.p)]) {
      const td = document.createElement('td');
      td.className = 'num tnum';
      td.textContent = v;
      tr.appendChild(td);
    }
    const sig = document.createElement('td');
    sig.className = 'sig';
    sig.textContent = swStars(t.p);
    tr.appendChild(sig);
    const ci = document.createElement('td');
    ci.className = 'ci';
    const txt = document.createElement('span');
    txt.className = 'sw-ci-text tnum';
    txt.textContent = `${swFmt(t.ciLow)} to ${swFmt(t.ciHigh)}`;
    ci.appendChild(txt);
    if (i > 0) {
      const bar = document.createElement('span');
      bar.className = 'sw-ci-bar';
      bar.setAttribute('aria-hidden', 'true');
      const zero = document.createElement('span');
      zero.className = 'sw-ci-zero';
      zero.style.left = pos(0) + '%';
      const range = document.createElement('span');
      range.className = 'sw-ci-range' + (t.ciLow > 0 || t.ciHigh < 0 ? ' is-sig' : '');
      range.style.left = pos(t.ciLow) + '%';
      range.style.width = Math.max(0.8, pos(t.ciHigh) - pos(t.ciLow)) + '%';
      const dot = document.createElement('span');
      dot.className = 'sw-ci-dot';
      dot.style.left = pos(t.estimate) + '%';
      bar.append(zero, range, dot);
      ci.appendChild(bar);
    }
    tr.appendChild(ci);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
  swSigKey(host);

  const grid = document.createElement('div');
  grid.className = 'sw-fig-grid';
  host.appendChild(grid);
  swResidualPlot(grid, f.residuals.fitted, f.residuals.residual);
  swQQPlot(grid, f.qq.theoretical, f.qq.sample);
}

async function swSaveFormula(spec: any, btn: HTMLButtonElement): Promise<void> {
  if (!currentProjectId) return;
  btn.disabled = true;
  let res: any;
  try { res = await window.hubStats.saveFormula(currentProjectId, spec); } catch (_) { res = { ok: false, error: t('statsViews.could_not_save_the_calculated_field') }; }
  btn.disabled = false;
  if (!res || !res.ok) { showToast((res && res.error) || t('statsViews.could_not_save_the_calculated_field')); return; }
  showToast(t('statsViews.it_is_a_calculated_field_in', { p0: !!(res.replaced), name: res.name }));
  // The new column joins the pickers here, and the dataset page behind the
  // panel repaints with it.
  let meta: any = null;
  try { meta = await window.hub.getDatasetMeta(currentProjectId, spec.datasetId); } catch (_) { meta = null; }
  if (meta && Array.isArray(meta.columns) && swState.datasetId === spec.datasetId) {
    swState.columns = meta.columns.map((c: any) => ({ name: String(c.name), type: String(c.type) }));
    swPaintControls();
  }
  if (currentSection === 'datasets' && expId === spec.datasetId) void openSavedDataset(expId);
}
