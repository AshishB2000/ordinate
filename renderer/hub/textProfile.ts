// The column profile's TEXT section: for a text column whose values average 20
// characters or more — reviews, tickets, notes, not "West" — its lengths, its
// language, its top terms and word pairs, and how positive it reads, with the
// three text steps one click away, prefilled.
//
// Every figure is computed in MAIN (src/ipc/text.ts `text:profile`) over the
// first 5,000 filled values in stored row order, read resident off the Parquet —
// the panel says so. This file draws what comes back and nothing else.
//
// Called by dsProfile.dsOpenProfile beside the other sections.
// Classic global-scope renderer <script>: no import/export.

let txProfileSeq = 0;

function txSigned(v: number, digits: number): string {
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
}

function txMood(v: number): string {
  return v >= 0.05 ? 'positive' : v <= -0.05 ? 'negative' : 'neutral';
}

/**
 * The section element, created once in the panel body just ABOVE the value
 * distribution: for long text every value is its own "top value" (a column of
 * ones), so the terms and the sentiment are what the panel should lead with.
 */
function txProfileSection(): HTMLElement | null {
  const host = dsEl('ds-profile');
  const body = host ? (host.querySelector('.dsp-body') as HTMLElement | null) : null;
  if (!body) return null;
  let sec = body.querySelector('.tx-dsp') as HTMLElement | null;
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'tx-dsp';
    sec.setAttribute('aria-label', t('common.text'));
    const chart = body.querySelector('.js-dsp-chart');
    if (chart) body.insertBefore(sec, chart);
    else body.appendChild(sec);
  }
  return sec;
}

async function txPaintProfile(col: any, lang?: string): Promise<void> {
  const sec = txProfileSection();
  if (!sec) return;
  const seq = ++txProfileSeq;
  // Only a text column can be one; a number or a date never shows the section.
  if (!col || col.type !== 'text' || !currentProjectId || !expId || !window.hubText) {
    sec.hidden = true;
    sec.innerHTML = '';
    return;
  }
  const want = expId;
  const column = String(col.name);
  if (lang) sec.classList.add('is-busy');
  let res: any = null;
  try {
    res = await window.hubText.profile(currentProjectId, want, column, lang);
  } catch (_) {
    res = null;
  }
  const stillHere = seq === txProfileSeq && want === expId && dsProfileCol >= 0
    && !!expColumns[dsProfileCol] && expColumns[dsProfileCol].name === column;
  if (!stillHere) return;
  sec.classList.remove('is-busy');
  sec.innerHTML = '';
  const p = res && res.ok ? res.profile : null;
  if (res && !res.ok) {
    sec.hidden = false;
    const head = document.createElement('p');
    head.className = 'dsp-head';
    head.textContent = t('common.text');
    const err = document.createElement('p');
    err.className = 'dsp-note tx-error';
    err.textContent = res.error || t('textProfile.could_not_read_this_column_s');
    sec.append(head, err);
    return;
  }
  // Short labels ("West", "SKU-104") are categories, not text: no section at all.
  if (!p || !p.eligible) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  txPaintProfileBody(sec, col, p);
}

function txPaintProfileBody(sec: HTMLElement, col: any, p: any): void {
  const headRow = document.createElement('div');
  headRow.className = 'tx-dsp-head';
  const head = document.createElement('p');
  head.className = 'dsp-head';
  head.textContent = t('common.text');
  const langSel = document.createElement('select');
  langSel.className = 'tx-lang';
  langSel.setAttribute('aria-label', t('textProfile.language_for_stop_words'));
  TX_LANGS.forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label + (v === p.detected ? ' (detected)' : '');
    if (v === p.lang) opt.selected = true;
    langSel.appendChild(opt);
  });
  langSel.addEventListener('change', () => { void txPaintProfile(col, langSel.value); });
  headRow.append(head, langSel);
  sec.appendChild(headRow);

  const note = document.createElement('p');
  note.className = 'dsp-note';
  note.textContent = p.sampled < p.cap
    ? t('textProfile.all_filled_values', { sampled: fmtN(p.sampled) })
    : t('textProfile.the_first_filled_values_in_row', { sampled: fmtN(p.sampled) });
  sec.appendChild(note);

  const facts = document.createElement('dl');
  facts.className = 'dsp-facts';
  const add = (k: string, v: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  };
  add(t('textProfile.average_length'), Math.round(p.avgLength).toLocaleString() + ' characters');
  add(t('textProfile.median_length'), Math.round(p.medianLength).toLocaleString() + ' characters');
  sec.appendChild(facts);

  if (p.sentiment) {
    const s = p.sentiment;
    const sh = document.createElement('p');
    sh.className = 'dsp-head';
    sh.textContent = t('textProfile.sentiment');
    const big = document.createElement('div');
    big.className = 'tx-senti-head';
    const num = document.createElement('span');
    num.className = 'tx-senti-num is-' + txMood(s.mean).slice(0, 3);
    num.textContent = txSigned(s.mean, 2);
    const cap = document.createElement('span');
    cap.className = 'tx-muted';
    cap.textContent = t('textProfile.average_vader_1_to_1', { mean: txMood(s.mean) });
    big.append(num, cap);
    const bands = Array.isArray(s.bands) ? s.bands : [];
    const cls = ['is-neg2', 'is-neg', 'is-neu', 'is-pos', 'is-pos2'];
    sec.append(sh, big, txSentimentBar(bands.map((b: any, k: number) => ({ label: b.label, count: b.count, cls: cls[k] || 'is-neu' }))));
    if (p.lang !== 'en') {
      const warn = document.createElement('p');
      warn.className = 'dsp-note';
      warn.textContent = t('textProfile.vader_s_lexicon_is_english_scores');
      sec.appendChild(warn);
    }
  }

  txTermBars(sec, t('textProfile.top_terms'), p.topTerms, t('textProfile.no_terms_left_after_removing_stop'));
  txTermBars(sec, t('textProfile.top_word_pairs'), p.topBigrams, t('textProfile.no_word_pairs_repeat_in_these'));

  const actions = document.createElement('div');
  actions.className = 'tx-dsp-actions';
  const btn = (text: string, title: string, type: string, prefill: any): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', () => txOpenStep(type, prefill));
    actions.appendChild(b);
  };
  const column = String(col.name);
  const terms = (p.topTerms || []).map((t: any) => t.term);
  btn(t('textProfile.count_terms'), t('textProfile.a_prepare_step_this_column_s'), 'text_terms',
    { column, lang: p.lang, minN: 1, maxN: 2, top: 25 });
  btn(t('textProfile.add_sentiment'), t('textProfile.a_prepare_step_a_sentiment_score'), 'text_sentiment', { column });
  btn(t('textProfile.tag_with_rules'), t('textProfile.a_prepare_step_a_category_per'), 'keyword_rules', { column, terms });
  sec.appendChild(actions);
}

function txTermBars(sec: HTMLElement, title: string, list: any[], empty: string): void {
  const h = document.createElement('p');
  h.className = 'dsp-head';
  h.textContent = title;
  sec.appendChild(h);
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'dsp-note';
    none.textContent = empty;
    sec.appendChild(none);
    return;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.count || 0), 0);
  const bars = document.createElement('div');
  bars.className = 'dsp-bars';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'dsp-bar-row tx-term-row';
    const label = document.createElement('span');
    label.className = 'dsp-bar-label';
    label.textContent = r.term;
    label.title = r.term;
    const track = document.createElement('span');
    track.className = 'dsp-bar-track';
    const fill = document.createElement('span');
    fill.className = 'dsp-bar-fill';
    fill.style.width = (max > 0 ? Math.max(2, Math.round((r.count / max) * 100)) : 0) + '%';
    track.appendChild(fill);
    const n = document.createElement('span');
    n.className = 'dsp-bar-n';
    n.textContent = fmtN(r.count);
    row.append(label, track, n);
    bars.appendChild(row);
  });
  sec.appendChild(bars);
}
