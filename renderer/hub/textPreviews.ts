// The text steps' live PREVIEWS — what main computed for an unsaved step,
// laid out: the first rows of a terms table, the sentiment spread with the most
// positive and most negative row, the rows each keyword category gets. Split
// from textSteps.ts (one job per file): that file builds the forms and saves,
// this one only paints the replies of window.hubText.preview. txSentimentBar is
// shared with the column profile's Text section (textProfile.ts).
// Classic global-scope script (NO import/export), loaded after textSteps.js.

function txSampleLine(res: any): string {
  return res && res.sampled ? t('textPreviews.preview_of_the_first_of_rows', { sampleRows: fmtN(res.sampleRows), total: fmtN(res.total) }) : '';
}

/** The first rows of the terms table main computed, as a compact table. */
function txPaintTermsPreview(box: HTMLElement, res: any): void {
  box.innerHTML = '';
  box.classList.remove('is-warn');
  box.hidden = false;
  const head = document.createElement('div');
  head.textContent = t('textPreviews.rows_terms', { before: fmtN(res.before), after: fmtN(res.after) });
  box.appendChild(head);
  const cols: string[] = Array.isArray(res.columns) ? res.columns : [];
  const rows: any[][] = Array.isArray(res.rows) ? res.rows : [];
  if (rows.length) {
    const table = document.createElement('table');
    table.className = 'tx-table';
    const tr = document.createElement('tr');
    cols.forEach((c) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      tr.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(tr);
    const tbody = document.createElement('tbody');
    rows.forEach((r) => {
      const row = document.createElement('tr');
      r.forEach((v, k) => {
        const td = document.createElement('td');
        td.textContent = typeof v === 'number' ? (cols[k] === 'tfidf' || cols[k] === 'sentiment' ? v.toFixed(4) : fmtN(v)) : String(v ?? '');
        if (typeof v === 'number') td.className = 'is-num';
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.append(thead, tbody);
    box.appendChild(table);
  }
  (Array.isArray(res.warnings) ? res.warnings : []).forEach((w: string) => {
    const d = document.createElement('div');
    d.textContent = w;
    box.appendChild(d);
  });
  const s = txSampleLine(res);
  if (s) {
    const d = document.createElement('div');
    d.className = 'tx-muted';
    d.textContent = s;
    box.appendChild(d);
  }
}

function txPaintSentimentPreview(box: HTMLElement, res: any): void {
  box.innerHTML = '';
  box.classList.remove('is-warn');
  box.hidden = false;
  const s = res.sentiment;
  if (!s) {
    setPreview(box, (res.warnings && res.warnings.length ? res.warnings : [t('textPreviews.nothing_to_score')]), true);
    return;
  }
  const line = document.createElement('div');
  line.textContent = t('textPreviews.rows_scored', { scored: fmtN(s.scored), p1: (s.empty ? ' · ' + fmtN(s.empty) + ' empty' : ''), p2: (typeof s.mean === 'number' ? t('textPreviews.average', { p0: (s.mean > 0 ? '+' : s.mean < 0 ? '−' : ''), p1: Math.abs(s.mean).toFixed(3) }) : '') });
  box.appendChild(line);
  box.appendChild(txSentimentBar([
    { label: t('textPreviews.negative'), count: s.negative, cls: 'is-neg' },
    { label: t('textPreviews.neutral'), count: s.neutral, cls: 'is-neu' },
    { label: t('textPreviews.positive'), count: s.positive, cls: 'is-pos' },
  ]));
  (Array.isArray(s.examples) ? s.examples : []).forEach((ex: any) => {
    const d = document.createElement('div');
    d.className = 'tx-example';
    const score = document.createElement('span');
    score.className = 'tx-score';
    score.textContent = (ex.score > 0 ? '+' : ex.score < 0 ? '−' : '') + Math.abs(Number(ex.score)).toFixed(4);
    const text = document.createElement('span');
    text.textContent = ex.text;
    d.append(score, text);
    box.appendChild(d);
  });
  const sl = txSampleLine(res);
  if (sl) {
    const d = document.createElement('div');
    d.className = 'tx-muted';
    d.textContent = sl;
    box.appendChild(d);
  }
}

/** A stacked bar of counts with a legend under it — the profile and the preview share it. */
function txSentimentBar(parts: Array<{ label: string; count: number; cls: string }>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tx-senti';
  const bar = document.createElement('div');
  bar.className = 'tx-senti-bar';
  bar.setAttribute('role', 'img');
  const total = parts.reduce((a, p) => a + (p.count || 0), 0);
  bar.setAttribute('aria-label', parts.map((p) => p.label + ' ' + fmtN(p.count || 0)).join(', '));
  const legend = document.createElement('div');
  legend.className = 'tx-senti-legend';
  parts.forEach((p) => {
    if (total && p.count) {
      const seg = document.createElement('span');
      seg.className = 'tx-senti-seg ' + p.cls;
      seg.style.flexGrow = String(p.count); // CSP: style= is banned in HTML, not here
      seg.title = p.label + ' · ' + fmtN(p.count);
      bar.appendChild(seg);
    }
    const key = document.createElement('span');
    key.className = 'tx-senti-key ' + p.cls;
    key.textContent = p.label + ' ' + fmtN(p.count || 0);
    legend.appendChild(key);
  });
  wrap.append(bar, legend);
  return wrap;
}

function txPaintCategoryPreview(box: HTMLElement, res: any): void {
  box.innerHTML = '';
  box.hidden = false;
  const cats: any[] = Array.isArray(res.categories) ? res.categories : [];
  const total = cats.reduce((a, c) => a + (c.count || 0), 0);
  box.classList.toggle('is-warn', !cats.length);
  const max = cats.reduce((m, c) => Math.max(m, c.count || 0), 0);
  const bars = document.createElement('div');
  bars.className = 'dsp-bars';
  cats.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'dsp-bar-row';
    const label = document.createElement('span');
    label.className = 'dsp-bar-label';
    label.textContent = c.category === '' ? '(empty)' : c.category + (c.isDefault ? ' (otherwise)' : '');
    label.title = label.textContent;
    const track = document.createElement('span');
    track.className = 'dsp-bar-track';
    const fill = document.createElement('span');
    fill.className = 'dsp-bar-fill' + (c.isDefault ? ' is-default' : '');
    fill.style.width = (max > 0 ? Math.max(c.count ? 2 : 0, Math.round((c.count / max) * 100)) : 0) + '%';
    track.appendChild(fill);
    const n = document.createElement('span');
    n.className = 'dsp-bar-n';
    n.textContent = fmtN(c.count) + (total ? ' · ' + Math.round((c.count / total) * 100) + '%' : '');
    row.append(label, track, n);
    bars.appendChild(row);
  });
  box.appendChild(bars);
  (Array.isArray(res.warnings) ? res.warnings : []).forEach((w: string) => {
    const d = document.createElement('div');
    d.textContent = w;
    box.appendChild(d);
  });
  const s = txSampleLine(res);
  if (s) {
    const d = document.createElement('div');
    d.className = 'tx-muted';
    d.textContent = s;
    box.appendChild(d);
  }
}
