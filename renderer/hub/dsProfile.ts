// What ONE column contains, and what to do about it: the profile panel that
// opens beside the grid when you click a column name, plus the completeness
// table the Quality tab shows when it has no issues to report.
//
// Both render the same facts, so they live together: a column's type, how much
// of it is filled, how many distinct values it holds, and what those values
// look like. The panel goes deep on one column; the table goes wide on all of
// them.
//
// EVERY NUMBER HERE IS COMPUTED BY THE APP. Nothing on this surface is narrated
// by a model, and this file computes nothing of its own either — it asks main
// for figures and draws them. Four sources, all of them already shipped:
//
//   type / min / max / distinct / filled   `expSummaries[c]`, the per-column
//                                          ColumnSummary the explorer already
//                                          fetched from `dataset:stats` on open
//   distinct on a NUMBER column            `datasetDistinct(…, limit 0)` — the
//                                          pre-cap total, no values fetched.
//                                          ColumnSummary only carries `distinct`
//                                          for text/date columns
//   histogram / top values / by-month      `computeVisualData` — the SAME
//                                          `visual:data` a real chart uses, so
//                                          the panel and the chart you build
//                                          from it cannot disagree about how a
//                                          column buckets
//   median                                 `datasetMedian` (src/ipc/datasets.ts)
//
// TWENTY BINS, THROUGH THE ENCODING. `bins` is a real encoding key (the numeric
// twin of `grain`), whitelisted by `visuals.sanitizeEncoding` and honoured by
// `categoryKey.binPlan` — the ONE function both the JS and the resident path
// call — so a profile histogram and a chart of the same column with the same
// `bins` cannot land a bucket edge in a different place. A profile is read at a
// glance in a narrow panel and wants more resolution than a chart axis, which
// is why it names a count instead of taking `NUM_BINS`.
//
// Classic global-scope renderer <script>: no import/export.

/** Which column the panel is open on, or -1. Paired with #ds-profile's hidden. */
let dsProfileCol = -1;
/** Request generation — a late reply for a column you have since left is dropped. */
let dsProfileSeq = 0;
/** Bars drawn for a TEXT distribution. The panel is ~300px wide; more is a smear. */
const DS_PROFILE_TOP = 10;
/**
 * Buckets a NUMBER column's histogram asks for.
 *
 * More than the chart default (`categoryKey.NUM_BINS`, 10) because a profile is
 * about the shape of the column: ten buckets hide a bimodal distribution that
 * twenty show. Passed as an encoding key, so the app's own binning does the
 * work rather than this file computing edges of its own.
 */
const DS_PROFILE_BINS = 20;

function dsProfileEl(cls: string): HTMLElement | null {
  const host = dsEl('ds-profile');
  return host ? (host.querySelector(cls) as HTMLElement | null) : null;
}

/** Close the panel and drop the header's selected state. */
function dsCloseProfile(): void {
  dsProfileCol = -1;
  dsProfileSeq += 1; // any reply still in flight now belongs to nobody
  const host = dsEl('ds-profile');
  if (host) host.hidden = true;
  document.querySelectorAll('#ds-explorer-scroll .ds-th.is-profiled')
    .forEach((th) => th.classList.remove('is-profiled'));
}

/**
 * Open (or re-point) the panel on column `c`.
 *
 * Clicking the SAME column again closes it — the header name is a toggle, which
 * is what makes the panel dismissable without hunting for the ✕.
 */
async function dsOpenProfile(c: number): Promise<void> {
  if (dsProfileCol === c) {
    dsCloseProfile();
    return;
  }
  const col = expColumns[c];
  const host = dsEl('ds-profile');
  if (!col || !host) return;

  dsProfileCol = c;
  const seq = ++dsProfileSeq;
  const wantId = expId;
  host.hidden = false;
  paintExplorerTable(); // repaint so the clicked header carries .is-profiled

  const title = dsProfileEl('.js-dsp-name');
  if (title) title.textContent = col.name || 'Column ' + (c + 1);
  const kind = dsProfileEl('.js-dsp-kind');
  if (kind) kind.textContent = col.type;
  ctPaintProfileDoc(); // catalogDetails.ts — the column's description, when it has one
  void pvPaintProfile(col.name); // privacyReview.ts — a sensitivity proposal, or what exports do with it

  // The facts that need no round trip: they came back with `dataset:stats` when
  // the dataset was opened. Painted FIRST so the panel is never empty while the
  // two queries below are in flight.
  dsPaintProfileFacts(c);

  const chart = dsProfileEl('.js-dsp-chart');
  if (chart) {
    chart.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'dsp-note';
    loading.textContent = 'Reading the column…';
    chart.appendChild(loading);
  }

  // Both queries in flight together — they are independent reads of the same
  // stored table, and serialising them would double the wait for no gain.
  const [extra, dist] = await Promise.all([
    dsProfileExtra(col),
    dsProfileDistribution(col),
  ]);
  // A newer click (or a closed dataset) already owns the panel.
  if (seq !== dsProfileSeq || wantId !== expId) return;

  dsPaintProfileFacts(c, extra);
  dsPaintProfileChart(col, dist);
}

/**
 * The median (numbers) and the distinct count on a number column.
 *
 * `ColumnSummary` carries `distinct` for text and date columns only — a number
 * column gets min/max/mean/count instead — so the one missing figure comes from
 * `dataset:distinct` with a limit of 0, which returns the pre-cap total and no
 * values at all.
 */
async function dsProfileExtra(col: ExpCol): Promise<{ median?: number | null; distinct?: number }> {
  if (col.type !== 'number' || !currentProjectId || !expId) return {};
  const out: { median?: number | null; distinct?: number } = {};
  try {
    const res: any = await window.hub.datasetMedian(currentProjectId, expId, col.name);
    out.median = res && res.ok ? res.median : null;
  } catch (_) {
    out.median = null;
  }
  try {
    const res: any = await window.hub.datasetDistinct(currentProjectId, expId, col.name, 0);
    if (res && typeof res.total === 'number') out.distinct = res.total;
  } catch (_) {
    /* leave it absent — the row renders "—" rather than a guess */
  }
  return out;
}

/**
 * The distribution, through `visual:data` — the same call a real chart makes.
 *
 * One encoding per column type, each naming its own bucketing rather than
 * letting the chart layer choose from the data: a number column asks for
 * `DS_PROFILE_BINS` buckets, a date column for a MONTH grain, and a text column
 * groups raw. The measure is always `count` of the column itself, which is what
 * makes every bar a row count rather than a sum of something else.
 */
async function dsProfileDistribution(col: ExpCol): Promise<{ label: string; value: number }[] | null> {
  if (!currentProjectId || !expId) return null;
  const encoding: any = {
    category: col.name,
    values: [{ column: col.name, aggregation: 'count' }],
  };
  if (col.type === 'date') encoding.grain = 'month';
  if (col.type === 'number') encoding.bins = DS_PROFILE_BINS;

  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, expId, encoding);
  } catch (_) {
    return null;
  }
  const labels = res && res.ok && res.data ? res.data.labels : null;
  const series = res && res.ok && res.data ? res.data.series : null;
  if (!Array.isArray(labels) || !Array.isArray(series) || !series[0]) return null;
  const values = Array.isArray(series[0].values) ? series[0].values : [];
  return labels.map((l: any, i: number) => ({
    label: l == null ? '' : String(l),
    value: typeof values[i] === 'number' ? values[i] : 0,
  }));
}

/** The definition list at the top of the panel. */
function dsPaintProfileFacts(c: number, extra?: { median?: number | null; distinct?: number }): void {
  const host = dsProfileEl('.js-dsp-facts');
  const col = expColumns[c];
  if (!host || !col) return;
  const sum: any = expSummaries[c];
  host.innerHTML = '';

  // "Alert me…" is a number's action. Toggled here rather than in
  // dsWireProfileActions because that runs once at boot and this runs on every
  // column, which is when the answer can actually change.
  const alertBtn = dsProfileEl('.js-dsp-alert-btn') as HTMLElement | null;
  if (alertBtn) alertBtn.hidden = col.type !== 'number';

  const add = (label: string, value: string): void => {
    const k = document.createElement('dt');
    k.textContent = label;
    const v = document.createElement('dd');
    v.textContent = value;
    host.appendChild(k);
    host.appendChild(v);
  };

  // `nonEmpty` counts cells that are neither null nor blank — the same rule the
  // Quality tab's "% empty" uses, so the two never disagree on the same column.
  const filled = sum && typeof sum.nonEmpty === 'number' ? sum.nonEmpty : null;
  const total = expRowCount;
  add('Filled', filled === null ? '—'
    : filled.toLocaleString() + ' of ' + total.toLocaleString() + dsPctSuffix(filled, total));
  add('Empty', filled === null ? '—' : Math.max(0, total - filled).toLocaleString());

  const distinct = sum && typeof sum.distinct === 'number' ? sum.distinct
    : extra && typeof extra.distinct === 'number' ? extra.distinct : null;
  add('Distinct', distinct === null ? '—' : distinct.toLocaleString());

  if (col.type === 'number') {
    add('Min', sum && typeof sum.min === 'number' ? fmtNum(sum.min) : '—');
    // Absent until the query lands, then either a number or "—". Never a
    // placeholder that could be mistaken for a computed zero.
    add('Median', extra && typeof extra.median === 'number' ? fmtNum(extra.median)
      : extra ? '—' : '…');
    add('Max', sum && typeof sum.max === 'number' ? fmtNum(sum.max) : '—');
  }
}

/** " (94%)" — or nothing at all when there is no denominator to divide by. */
function dsPctSuffix(part: number, total: number): string {
  if (!total) return '';
  return ' (' + Math.round((part / total) * 100) + '%)';
}

/**
 * The distribution.
 *
 * TWO FORMS, because two different questions are being asked. A number column
 * gets a real histogram — twenty thin vertical bars — because what you want
 * from it is the SHAPE, and a shape is not readable as a list you scroll. A
 * text or date column gets labelled horizontal rows, because there the labels
 * ARE the answer ("which value is biggest", "which month") and a bar you cannot
 * name tells you nothing.
 *
 * The horizontal form was used for all three first. At ten bins that was merely
 * unremarkable; at twenty it needed a 740px panel hanging 380px below the grid
 * to avoid scrolling, which is how it became clear the form was wrong rather
 * than the height.
 */
function dsPaintProfileChart(col: ExpCol, dist: { label: string; value: number }[] | null): void {
  const host = dsProfileEl('.js-dsp-chart');
  if (!host) return;
  host.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'dsp-head';
  heading.textContent =
    col.type === 'number' ? 'Distribution'
    : col.type === 'date' ? 'Rows by month'
    : 'Top values';
  host.appendChild(heading);

  if (!dist || dist.length === 0) {
    const none = document.createElement('p');
    none.className = 'dsp-note';
    none.textContent = 'No values to chart in this column.';
    host.appendChild(none);
    return;
  }

  if (col.type === 'number') {
    dsPaintHistogram(host, dist);
    return;
  }

  // A text column is ordered by COUNT — "top values" has to mean the biggest,
  // not the first-seen. A grained date is ordered by the axis, because months
  // out of order are not a timeline.
  let rows = dist;
  if (col.type === 'text') {
    rows = dist.slice().sort((a, b) => b.value - a.value).slice(0, DS_PROFILE_TOP);
    const kept = rows.length;
    if (dist.length > kept) {
      const note = document.createElement('p');
      note.className = 'dsp-note';
      note.textContent = 'Top ' + kept + ' of ' + dist.length + ' values shown.';
      host.appendChild(note);
    }
  }

  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);
  const list = document.createElement('div');
  list.className = 'dsp-bars';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'dsp-bar-row';

    const label = document.createElement('span');
    label.className = 'dsp-bar-label';
    label.textContent = r.label === '' ? '(empty)' : r.label;
    label.title = label.textContent;

    const track = document.createElement('span');
    track.className = 'dsp-bar-track';
    const fill = document.createElement('span');
    fill.className = 'dsp-bar-fill';
    // No inline style= in hub HTML (CSP) — element.style from JS is fine, and
    // this is the one geometry CSS cannot derive on its own.
    fill.style.width = (max > 0 ? Math.max(2, Math.round((r.value / max) * 100)) : 0) + '%';
    track.appendChild(fill);

    const n = document.createElement('span');
    n.className = 'dsp-bar-n';
    n.textContent = r.value.toLocaleString();

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(n);
    list.appendChild(row);
  });
  host.appendChild(list);
}

/**
 * Twenty bars side by side, plus the two axis edges.
 *
 * Heights are a percentage of the tallest bucket, so the y axis is implicitly
 * "0 to the modal count" — a histogram is read by comparing bars to each other,
 * and a labelled y axis would cost a third of the panel's width to say what the
 * tallest bar already says. The count and the bucket's real range live in each
 * bar's `title`, which is where a specific number is wanted and nowhere else.
 *
 * An EMPTY bucket keeps its slot at zero height rather than being dropped: a
 * gap in a distribution is a fact about the data, and a histogram that silently
 * closed its gaps would draw a different shape from the one in the column.
 */
function dsPaintHistogram(host: HTMLElement, dist: { label: string; value: number }[]): void {
  const max = dist.reduce((m, r) => (r.value > m ? r.value : m), 0);
  const total = dist.reduce((sum, r) => sum + r.value, 0);

  const chart = document.createElement('div');
  chart.className = 'dsp-hist';
  dist.forEach((r) => {
    const bar = document.createElement('span');
    bar.className = 'dsp-hist-bar';
    // A non-zero count always draws at least a sliver: a bucket with one row in
    // it must not be indistinguishable from one with none.
    const pct = max > 0 && r.value > 0 ? Math.max(3, Math.round((r.value / max) * 100)) : 0;
    bar.style.height = pct + '%'; // CSP: style= is banned in HTML, not here
    if (r.value === 0) bar.classList.add('is-empty');
    bar.title = (r.label || '—') + ' · ' + r.value.toLocaleString()
      + (r.value === 1 ? ' row' : ' rows');
    chart.appendChild(bar);
  });
  host.appendChild(chart);

  // The two edges, under the bars. `binLabel` already formats each bucket as
  // "lo–hi", so the axis is the first bucket's lower edge and the last one's
  // upper edge — taken from the labels rather than recomputed, so the axis
  // cannot disagree with the bars above it.
  const axis = document.createElement('div');
  axis.className = 'dsp-hist-axis';
  const lo = document.createElement('span');
  lo.textContent = dsEdgeOf(dist[0].label, 0);
  const hi = document.createElement('span');
  hi.textContent = dsEdgeOf(dist[dist.length - 1].label, 1);
  axis.appendChild(lo);
  axis.appendChild(hi);
  host.appendChild(axis);

  const note = document.createElement('p');
  note.className = 'dsp-note dsp-hist-note';
  note.textContent = dist.length + ' buckets · ' + total.toLocaleString() + ' rows';
  host.appendChild(note);
}

/**
 * One side of a `binLabel` string ("1.2K–2.4K" → "1.2K" or "2.4K").
 *
 * Split on the EN DASH `binLabel` joins with, not on a hyphen: a negative
 * bucket is "-10–-5.2", and splitting that on '-' would produce nonsense.
 */
function dsEdgeOf(label: string, side: 0 | 1): string {
  const parts = String(label).split('\u2013');
  return parts.length === 2 ? parts[side] : String(label);
}

/**
 * The three scoped actions at the foot of the panel.
 *
 * Each one is the whole-dataset action narrowed to this column, and each one
 * reuses the flow that already exists rather than opening a second door to it:
 * the visual builder, the grid's own search box, and the rename the ✎ in the
 * header runs.
 */
function dsWireProfileActions(): void {
  const chart = dsProfileEl('.js-dsp-chart-btn');
  if (chart) {
    chart.addEventListener('click', () => {
      const col = expColumns[dsProfileCol];
      if (!col || !expId) return;
      // Same entry as the header's New visual, so there is one way into the
      // builder. The column is not pushed into the encoding: the builder picks
      // its own sensible default and the user is one dropdown from this column,
      // where forcing it would fight whatever the chart type needs.
      void dsNewVisualFromDataset();
    });
  }

  const filter = dsProfileEl('.js-dsp-filter-btn');
  if (filter) {
    filter.addEventListener('click', () => {
      // "Filter rows on this" is the grid's own row search, pointed at this
      // column's most common value — a real, present value, so the result is
      // never an empty grid. The search box is the filter this page already
      // has; a second filtering mechanism beside it would be two states to
      // reconcile on every paint.
      const sum: any = expSummaries[dsProfileCol];
      const value = sum && sum.mostCommon ? String(sum.mostCommon.value) : '';
      if (!value) {
        showToast('This column has no repeated value to filter on.');
        return;
      }
      const input = dsEl('ds-search') as HTMLInputElement | null;
      if (!input) return;
      input.value = value;
      expSearch = value;
      expOffset = 0;
      renderExplorerTable();
      input.focus();
    });
  }

  // "Alert me…" — the whole-dataset alert narrowed to this column, like the two
  // above. Shown only for a `number` column (dsPaintProfileFacts toggles it),
  // because sum/avg/min/max over text is exactly the wrong figure this codebase
  // refuses to produce.
  const alert = dsProfileEl('.js-dsp-alert-btn');
  if (alert) alert.addEventListener('click', () => { void alertMeFromColumn(); });

  const rename = dsProfileEl('.js-dsp-rename-btn');
  if (rename) {
    rename.addEventListener('click', () => {
      if (dsProfileCol >= 0) void handleRenameColumn(dsProfileCol);
    });
  }

  const close = dsProfileEl('.js-dsp-x');
  if (close) close.addEventListener('click', () => dsCloseProfile());
}

// ── The Quality tab's completeness table ────────────────────────────────────

/**
 * Every column, how full it is, and what is in it — rendered whether or not the
 * dataset has issues.
 *
 * A Quality tab that says one sentence and nothing else reads as broken even
 * when "no issues" is the truth, so the finding badges (which stay above this)
 * are the EXCEPTION report and this is the baseline: the same per-column facts
 * the profile panel opens with, for all of them at once.
 *
 * Sample values come from the page the grid is already holding — no query. That
 * means they are a sample of the CURRENT window (whatever search, sort and page
 * you are on), which is honest for "what does this look like" and is why the
 * column is headed "Sample values" rather than "First values".
 */
function dsRenderQualityTable(): void {
  const host = dsEl('ds-quality-table');
  if (!host) return;
  host.innerHTML = '';
  if (expColumns.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const table = document.createElement('table');
  table.className = 'ds-quality-grid';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  ['Column', 'Type', 'Filled', 'Distinct', 'Sample values'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  expColumns.forEach((col, c) => {
    const sum: any = expSummaries[c];
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'dsq-name';
    name.textContent = col.name || 'Column ' + (c + 1);
    tr.appendChild(name);

    const type = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'dsq-type';
    chip.textContent = col.type;
    type.appendChild(chip);
    tr.appendChild(type);

    const filled = sum && typeof sum.nonEmpty === 'number' ? sum.nonEmpty : null;
    const fill = document.createElement('td');
    if (filled === null) fill.textContent = '—';
    else {
      const pct = expRowCount ? Math.round((filled / expRowCount) * 100) : 100;
      const bar = document.createElement('span');
      bar.className = 'dsq-fill';
      // A partly-empty column should be visible at a glance down the list, not
      // read percentage by percentage. Below half full it goes warm, matching
      // the empty_heavy threshold main flags at.
      bar.classList.toggle('is-low', pct < 50);
      const inner = document.createElement('span');
      inner.className = 'dsq-fill-bar';
      inner.style.width = pct + '%'; // CSP: style= is banned in HTML, not here
      bar.appendChild(inner);
      const text = document.createElement('span');
      text.className = 'dsq-fill-pct';
      text.textContent = pct + '%';
      fill.appendChild(bar);
      fill.appendChild(text);
    }
    tr.appendChild(fill);

    // `ColumnSummary` carries `distinct` for text and date columns only — a
    // number column gets min/max/mean instead. Rather than fire one
    // `dataset:distinct` per numeric column every time this tab opens (forty
    // round trips on a wide table, to fill a column nobody may read), the cell
    // says where the number is: one click, in the profile panel, per column.
    const distinct = document.createElement('td');
    if (sum && typeof sum.distinct === 'number') {
      distinct.textContent = sum.distinct.toLocaleString();
    } else {
      distinct.textContent = '—';
      distinct.className = 'dsq-muted';
      distinct.title = 'Counted on demand — click this column\u2019s name in the Data tab to profile it';
    }
    tr.appendChild(distinct);

    const sample = document.createElement('td');
    sample.className = 'dsq-sample';
    sample.textContent = dsSampleValues(c);
    tr.appendChild(sample);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(table);
}

/** Up to three distinct non-empty cells of column `c` from the drawn window. */
function dsSampleValues(c: number): string {
  const seen: string[] = [];
  for (const row of expPageRows) {
    const v = Array.isArray(row) ? row[c] : null;
    if (v == null || String(v).trim() === '') continue;
    const s = truncate(String(v), 18);
    if (seen.indexOf(s) >= 0) continue;
    seen.push(s);
    if (seen.length === 3) break;
  }
  return seen.length ? seen.join(', ') : '—';
}
