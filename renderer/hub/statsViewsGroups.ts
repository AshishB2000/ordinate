'use strict';

// The workbench's Compare groups and Distribution results (statsPanel.ts calls
// these with main's computed result). Formatting only, as in statsViews.ts,
// whose swFmt / swP / swStars / swCount this file shares.

/** One test's card: a name, the app's verdict at p < 0.05, and its figures. */
function swTestCard(host: HTMLElement, title: string, p: number, rows: Array<[string, string]>, note?: string): void {
  const card = document.createElement('section');
  card.className = 'sw-card';
  card.setAttribute('aria-label', title);
  const head = document.createElement('div');
  head.className = 'sw-card-head';
  const h = document.createElement('h4');
  h.className = 'sw-card-title';
  h.textContent = title;
  const chip = document.createElement('span');
  chip.className = 'sw-verdict ' + (p < 0.05 ? 'is-sig' : 'is-ns');
  chip.textContent = p < 0.05 ? t('statsViewsGroups.significant') : t('statsViewsGroups.not_significant');
  head.append(h, chip);
  const dl = document.createElement('dl');
  dl.className = 'sw-dl';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = 'tnum';
    dd.textContent = v;
    dl.append(dt, dd);
  }
  card.append(head, dl);
  if (note) {
    const n = document.createElement('p');
    n.className = 'sw-card-note';
    n.textContent = note;
    card.appendChild(n);
  }
  host.appendChild(card);
}

function swSimpleTable(host: HTMLElement, caption: string, head: string[], rows: string[][], numericFrom = 1): void {
  const wrap = document.createElement('div');
  wrap.className = 'sw-table-wrap';
  const table = document.createElement('table');
  table.className = 'sw-table';
  const cap = document.createElement('caption');
  cap.className = 'sw-sr';
  cap.textContent = caption;
  table.appendChild(cap);
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  head.forEach((h, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    if (i >= numericFrom) th.className = 'num';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    r.forEach((v, i) => {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) (cell as HTMLTableCellElement).scope = 'row';
      else cell.className = i >= numericFrom ? t('statsViewsGroups.num_tnum') : '';
      cell.textContent = v;
      tr.appendChild(cell);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function swWarnings(host: HTMLElement, list: string[]): void {
  for (const w of list || []) {
    const p = document.createElement('p');
    p.className = 'sw-warn';
    p.appendChild(icon('alert', 16));
    const s = document.createElement('span');
    s.textContent = w;
    p.appendChild(s);
    host.appendChild(p);
  }
}

// ── Compare groups ───────────────────────────────────────────────────────────

function swViewGroups(host: HTMLElement, r: any, spec: any): void {
  const k = r.groups.length;
  const n = r.groups.reduce((s: number, g: any) => s + g.n, 0);
  const tests = r.mode === 'two' ? t('statsViewsGroups.welch_s_t_test_and_mann') : r.mode === 'many' ? t('statsViewsGroups.one_way_anova_and_kruskal_wallis') : r.prop ? t('statsViewsGroups.two_proportion_z_test_and_chi') : t('statsViewsGroups.chi_square_test_of_independence');
  swResultHead(host, `${r.outcome} by ${r.group}`, t('statsViewsGroups.groups_n', { tests, k, n: swCount(n) }), spec);
  swSentence(host, r.sentence);
  swWarnings(host, r.warnings);
  const cards = document.createElement('div');
  cards.className = 'sw-cards';
  host.appendChild(cards);

  if (r.mode === 'two') {
    const w = r.welch;
    const [a, b] = r.groups;
    swTestCard(cards, t('statsViewsGroups.welch_s_t_test'), w.p, [
      ['t', swFmt(w.t)], ['df', swFmt(w.df)], ['p', swP(w.p)],
      [t('statsViewsGroups.mean_difference', { label: a.label, label2: b.label }), swFmt(w.diff)], [t('statsViewsGroups.95_ci'), `${swFmt(w.ciLow)} to ${swFmt(w.ciHigh)}`],
      [t('statsViewsGroups.cohen_s_d'), swFmt(w.cohenD)], [t('statsViewsGroups.hedges_g'), swFmt(w.hedgesG)],
    ], t('statsViewsGroups.does_not_assume_equal_variances'));
    const m = r.mannWhitney;
    swTestCard(cards, t('statsViewsGroups.mann_whitney_u'), m.p, [
      ['U', swFmt(m.u)], ['z', swFmt(m.z)], ['p', swP(m.p)], [t('statsViewsGroups.rank_biserial_r'), swFmt(m.rankBiserial)],
    ], t('statsViewsGroups.rank_based_no_normality_assumption'));
  } else if (r.mode === 'many') {
    const a = r.anova;
    swTestCard(cards, t('statsViewsGroups.one_way_anova'), a.p, [
      ['F', swFmt(a.f)], ['df', `${a.df1}, ${swCount(a.df2)}`], ['p', swP(a.p)], ['η²', swFmt(a.etaSq)],
    ], t('statsViewsGroups.assumes_similar_spread_in_every_group'));
    const kw = r.kruskal;
    swTestCard(cards, 'Kruskal–Wallis', kw.p, [
      ['H', swFmt(kw.h)], ['df', String(kw.df)], ['p', swP(kw.p)], ['ε²', swFmt(kw.epsilonSq)],
    ], t('statsViewsGroups.rank_based_with_the_tie_correction'));
  } else {
    if (r.prop) {
      const p = r.prop;
      const [a, b] = r.table.rows;
      swTestCard(cards, t('statsViewsGroups.two_proportion_z_test'), p.p, [
        [t('statsViewsGroups.share', { a, success: p.success }), (p.p1 * 100).toFixed(1) + '%'], [t('statsViewsGroups.share_2', { b, success: p.success }), (p.p2 * 100).toFixed(1) + '%'],
        [t('statsViewsGroups.difference'), (p.diff * 100).toFixed(1) + ' points'], [t('statsViewsGroups.95_ci'), t('statsViewsGroups.to_points', { p0: (p.ciLow * 100).toFixed(1), p1: (p.ciHigh * 100).toFixed(1) })],
        ['z', swFmt(p.z)], ['p', swP(p.p)], [t('statsViewsGroups.cohen_s_h'), swFmt(p.cohenH)],
      ]);
    }
    const c = r.chi;
    swTestCard(cards, t('statsViewsGroups.chi_square_test_of_independence'), c.p, [
      ['χ²', swFmt(c.chi2)], ['df', String(c.df)], ['p', swP(c.p)], [t('statsViewsGroups.cramer_s_v'), swFmt(c.cramerV)], ['n', swCount(c.n)],
    ], t('statsViewsGroups.without_continuity_correction'));
  }

  if (r.mode === 'table') {
    const { rows, cols, counts } = r.table;
    swSimpleTable(host, t('statsViewsGroups.counts'), [r.group, ...cols, t('common.total')], rows.map((row: string, i: number) => {
      const total = counts[i].reduce((s: number, x: number) => s + x, 0);
      return [row, ...counts[i].map((x: number) => `${swCount(x)} (${total ? ((x / total) * 100).toFixed(0) : 0}%)`), swCount(total)];
    }));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'sw-split';
  host.appendChild(grid);
  swSimpleTable(grid, t('common.groups'), [r.group, 'n', t('statsViewsGroups.mean'), 'SD', t('common.median')],
    r.groups.map((g: any) => [g.label, swCount(g.n), swFmt(g.mean), swFmt(g.sd), swFmt(g.median)]));
  swMeansBar(grid, r.outcome, r.groups);
}

// ── Distribution ─────────────────────────────────────────────────────────────

function swViewDistribution(host: HTMLElement, r: any, spec: any): void {
  const m = r.moments;
  const tv = r.normality;
  const name = tv ? (tv.method === 'shapiro-wilk' ? 'Shapiro–Wilk' : t('statsViewsGroups.d_agostino_pearson_k2')) : t('statsViewsGroups.no_normality_test');
  swResultHead(host, t('common.distribution_of', { column: r.column }), t('statsViewsGroups.values', { n: swCount(m.n), name }), spec);
  swSentence(host, r.sentence);
  swStatRow(host, [
    ['n', swCount(m.n)], [t('statsViewsGroups.mean'), swFmt(m.mean)], ['SD', swFmt(m.sd)], [t('common.median'), swFmt(m.median)],
    [t('common.min'), swFmt(m.min)], [t('common.max'), swFmt(m.max)],
    [t('statsViewsGroups.skewness'), swFmt(m.skewness), t('statsViewsGroups.adjusted_g1')], [t('statsViewsGroups.excess_kurtosis'), swFmt(m.kurtosis), t('statsViewsGroups.g2_normal_0')],
  ]);
  const grid = document.createElement('div');
  grid.className = 'sw-split sw-split--wide';
  host.appendChild(grid);
  const figs = document.createElement('div');
  grid.appendChild(figs);
  swHistogram(figs, r.column, r.histogram);
  const side = document.createElement('div');
  side.className = 'sw-cards sw-cards--stack';
  grid.appendChild(side);
  if (tv) {
    swTestCard(side, tv.method === 'shapiro-wilk' ? t('statsViewsGroups.shapiro_wilk_test') : t('statsViewsGroups.d_agostino_pearson_test'), tv.p,
      tv.method === 'shapiro-wilk'
        ? [['W', tv.statistic.toFixed(4)], ['p', swP(tv.p)], ['n', swCount(m.n)]]
        : [['K²', swFmt(tv.statistic)], [t('statsViewsGroups.z_skewness'), swFmt(tv.zSkew)], [t('statsViewsGroups.z_kurtosis'), swFmt(tv.zKurt)], ['p', swP(tv.p)], ['n', swCount(m.n)]],
      tv.method === 'shapiro-wilk'
        ? t('statsViewsGroups.royston_1995_for_3_to_5')
        : t('statsViewsGroups.above_5_000_values_d_agostino'));
  }
}
