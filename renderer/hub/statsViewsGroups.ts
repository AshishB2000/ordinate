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
  chip.textContent = p < 0.05 ? 'Significant' : 'Not significant';
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
      else cell.className = i >= numericFrom ? 'num tnum' : '';
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
  const tests = r.mode === 'two' ? "Welch's t-test and Mann–Whitney U" : r.mode === 'many' ? 'One-way ANOVA and Kruskal–Wallis' : r.prop ? 'Two-proportion z-test and chi-square' : 'Chi-square test of independence';
  swResultHead(host, `${r.outcome} by ${r.group}`, `${tests} · ${k} groups · n = ${swCount(n)}`, spec);
  swSentence(host, r.sentence);
  swWarnings(host, r.warnings);
  const cards = document.createElement('div');
  cards.className = 'sw-cards';
  host.appendChild(cards);

  if (r.mode === 'two') {
    const w = r.welch;
    const [a, b] = r.groups;
    swTestCard(cards, "Welch's t-test", w.p, [
      ['t', swFmt(w.t)], ['df', swFmt(w.df)], ['p', swP(w.p)],
      [`Mean difference (${a.label} − ${b.label})`, swFmt(w.diff)], ['95% CI', `${swFmt(w.ciLow)} to ${swFmt(w.ciHigh)}`],
      ["Cohen's d", swFmt(w.cohenD)], ["Hedges' g", swFmt(w.hedgesG)],
    ], 'Does not assume equal variances.');
    const m = r.mannWhitney;
    swTestCard(cards, 'Mann–Whitney U', m.p, [
      ['U', swFmt(m.u)], ['z', swFmt(m.z)], ['p', swP(m.p)], ['Rank-biserial r', swFmt(m.rankBiserial)],
    ], 'Rank-based: no normality assumption. Normal approximation with tie and continuity corrections.');
  } else if (r.mode === 'many') {
    const a = r.anova;
    swTestCard(cards, 'One-way ANOVA', a.p, [
      ['F', swFmt(a.f)], ['df', `${a.df1}, ${swCount(a.df2)}`], ['p', swP(a.p)], ['η²', swFmt(a.etaSq)],
    ], 'Assumes similar spread in every group.');
    const kw = r.kruskal;
    swTestCard(cards, 'Kruskal–Wallis', kw.p, [
      ['H', swFmt(kw.h)], ['df', String(kw.df)], ['p', swP(kw.p)], ['ε²', swFmt(kw.epsilonSq)],
    ], 'Rank-based, with the tie correction.');
  } else {
    if (r.prop) {
      const p = r.prop;
      const [a, b] = r.table.rows;
      swTestCard(cards, 'Two-proportion z-test', p.p, [
        [`${a}: share ${p.success}`, (p.p1 * 100).toFixed(1) + '%'], [`${b}: share ${p.success}`, (p.p2 * 100).toFixed(1) + '%'],
        ['Difference', (p.diff * 100).toFixed(1) + ' points'], ['95% CI', `${(p.ciLow * 100).toFixed(1)} to ${(p.ciHigh * 100).toFixed(1)} points`],
        ['z', swFmt(p.z)], ['p', swP(p.p)], ["Cohen's h", swFmt(p.cohenH)],
      ]);
    }
    const c = r.chi;
    swTestCard(cards, 'Chi-square test of independence', c.p, [
      ['χ²', swFmt(c.chi2)], ['df', String(c.df)], ['p', swP(c.p)], ["Cramér's V", swFmt(c.cramerV)], ['n', swCount(c.n)],
    ], 'Without continuity correction.');
  }

  if (r.mode === 'table') {
    const { rows, cols, counts } = r.table;
    swSimpleTable(host, 'Counts', [r.group, ...cols, 'Total'], rows.map((row: string, i: number) => {
      const total = counts[i].reduce((s: number, x: number) => s + x, 0);
      return [row, ...counts[i].map((x: number) => `${swCount(x)} (${total ? ((x / total) * 100).toFixed(0) : 0}%)`), swCount(total)];
    }));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'sw-split';
  host.appendChild(grid);
  swSimpleTable(grid, 'Groups', [r.group, 'n', 'Mean', 'SD', 'Median'],
    r.groups.map((g: any) => [g.label, swCount(g.n), swFmt(g.mean), swFmt(g.sd), swFmt(g.median)]));
  swMeansBar(grid, r.outcome, r.groups);
}

// ── Distribution ─────────────────────────────────────────────────────────────

function swViewDistribution(host: HTMLElement, r: any, spec: any): void {
  const m = r.moments;
  const t = r.normality;
  const name = t ? (t.method === 'shapiro-wilk' ? 'Shapiro–Wilk' : "D'Agostino–Pearson K²") : 'no normality test';
  swResultHead(host, `Distribution of ${r.column}`, `${swCount(m.n)} values · ${name}`, spec);
  swSentence(host, r.sentence);
  swStatRow(host, [
    ['n', swCount(m.n)], ['Mean', swFmt(m.mean)], ['SD', swFmt(m.sd)], ['Median', swFmt(m.median)],
    ['Min', swFmt(m.min)], ['Max', swFmt(m.max)],
    ['Skewness', swFmt(m.skewness), 'adjusted G1'], ['Excess kurtosis', swFmt(m.kurtosis), 'G2, normal = 0'],
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
  if (t) {
    swTestCard(side, t.method === 'shapiro-wilk' ? 'Shapiro–Wilk test' : "D'Agostino–Pearson test", t.p,
      t.method === 'shapiro-wilk'
        ? [['W', t.statistic.toFixed(4)], ['p', swP(t.p)], ['n', swCount(m.n)]]
        : [['K²', swFmt(t.statistic)], ['z (skewness)', swFmt(t.zSkew)], ['z (kurtosis)', swFmt(t.zKurt)], ['p', swP(t.p)], ['n', swCount(m.n)]],
      t.method === 'shapiro-wilk'
        ? 'Royston (1995), for 3 to 5,000 values. A small p means the data are unlikely to be normal.'
        : "Above 5,000 values: D'Agostino's skewness and Anscombe–Glynn's kurtosis tests combined.");
  }
}
