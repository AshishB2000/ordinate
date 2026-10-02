// The TEXT family of Prepare steps — count terms, sentiment score, tag with
// keyword rules: their editors, their one-line summaries and their save path
// (the previews they paint are textPreviews.ts). Classic global-scope script
// (NO import/export), loaded after prepareCombine.js.
//
// Main re-validates every step on save (src/data/textStepTypes.ts), and every
// figure a preview shows — the top terms, the score spread, the rows per
// category — is computed in main over the step's real input
// (window.hubText.preview). Saving goes through window.hubText.commitStep,
// which on a big table runs the text work as a job in the Jobs popover (with
// progress and Cancel) before the ordinary save.

const TX_STEP_TYPES = new Set(['text_terms', 'text_sentiment', 'keyword_rules']);
const TX_LANGS: Array<[string, string]> = [['en', t('textSteps.english')], ['es', t('textSteps.spanish')], ['fr', t('textSteps.french')], ['de', t('textSteps.german')]];
const TX_RANGES: Array<[string, string]> = [
  ['1-1', t('textSteps.single_words')], ['1-2', t('textSteps.words_and_pairs')], ['2-2', t('textSteps.pairs_only')],
  ['1-3', t('textSteps.words_pairs_and_triples')], ['2-3', t('textSteps.pairs_and_triples')], ['3-3', t('textSteps.triples_only')],
];
const TX_MATCHES: Array<[string, string]> = [['contains', 'contains'], ['word', t('textSteps.has_the_word')], ['regex', t('textSteps.matches_regex')]];

/** A prefill for the NEXT text editor opened (the profile's buttons) — read once. */
let txPrefill: any = null;

/** The current columns declared text — the only ones a text step reads. */
function txTextColumns(): string[] {
  return expColumns.filter((c: any) => c && c.type === 'text').map((c: any) => String(c.name));
}

function txLabelledSelect(pairs: Array<[string, string]>, selected: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  pairs.forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    if (v === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function txCheck(label: string, on: boolean): { row: HTMLElement; box: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'ds-step-check tx-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = on;
  const s = document.createElement('span');
  s.textContent = label;
  row.append(box, s);
  return { row, box };
}

/** Ask main what this unsaved step would do; null on any failure. */
async function txPreview(step: any): Promise<any> {
  if (!currentProjectId || !expId || !window.hubText) return null;
  try {
    return await window.hubText.preview(currentProjectId, expId, dsStepEditIndex, step);
  } catch (_) {
    return null;
  }
}

/** A debounced "ask main again" for a form's controls. */
function txLive(run: () => Promise<void>): () => void {
  let t = 0;
  return () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => { void run(); }, 250);
  };
}

// ── Count terms ──────────────────────────────────────────────────────────────

function txTermsForm(body: HTMLElement, e: any): () => any {
  const cols = txTextColumns();
  const colSel = makeNameSelect(cols, e.column || cols[0]);
  const langSel = txLabelledSelect(TX_LANGS, e.lang || 'en');
  const rangeSel = txLabelledSelect(TX_RANGES, (e.minN || 1) + '-' + (e.maxN || 1));
  const bySel = makeNameSelect(expColumns.map((c: any) => String(c.name)), e.by || '', t('textSteps.none_across_all_rows'));
  const rankSel = txLabelledSelect([['tfidf', t('textSteps.most_distinctive_of_each_group_tf')], ['count', t('textSteps.most_frequent_in_each_group')]],
    e.rank || 'tfidf');
  const rankRow = fieldRow(t('textSteps.rank_terms_by'), rankSel);
  const topIn = document.createElement('input');
  topIn.type = 'number';
  topIn.min = '1';
  topIn.max = '1000';
  topIn.className = 'ds-step-input';
  topIn.value = String(e.top || 25);
  const nums = txCheck(t('textSteps.keep_numbers_as_terms'), !!e.keepNumbers);
  const senti = txCheck(t('textSteps.add_each_term_s_average_sentiment'), !!e.sentiment);
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  hint.textContent = t('textSteps.the_table_becomes_one_row_per');
  const preview = makePreviewBox();
  preview.classList.add('tx-preview');
  const read = (): any => {
    const [minN, maxN] = rangeSel.value.split('-').map(Number);
    const step: any = { type: 'text_terms', column: colSel.value, lang: langSel.value, minN, maxN,
      top: Math.max(1, Math.min(1000, Math.floor(Number(topIn.value) || 25))), rank: 'count' };
    if (bySel.value && bySel.value !== colSel.value) {
      step.by = bySel.value;
      step.rank = rankSel.value;
    }
    if (nums.box.checked) step.keepNumbers = true;
    if (senti.box.checked) step.sentiment = true;
    return step;
  };
  let seq = 0;
  const refresh = async (): Promise<void> => {
    rankRow.hidden = !bySel.value;
    if (!colSel.value) return setPreview(preview, [t('textSteps.this_dataset_has_no_text_column')], true);
    const mine = ++seq;
    const res = await txPreview(read());
    if (mine !== seq) return;
    if (!res || !res.ok) return setPreview(preview, [(res && res.error) || t('common.could_not_preview')], true);
    txPaintTermsPreview(preview, res);
  };
  const live = txLive(refresh);
  [colSel, langSel, rangeSel, bySel, rankSel].forEach((el) => el.addEventListener('change', () => void refresh()));
  [topIn, nums.box, senti.box].forEach((el) => el.addEventListener('input', live));
  body.append(fieldRow(t('common.text_column'), colSel), fieldRow(t('textSteps.language_stop_words'), langSel), fieldRow(t('textSteps.terms'), rangeSel),
    fieldRow(t('textSteps.group_by_optional'), bySel), rankRow, fieldRow(t('textSteps.terms_kept_per_group'), topIn), nums.row, senti.row, hint, preview);
  void refresh();
  return () => {
    if (!colSel.value) { window.alert(t('textSteps.pick_the_text_column')); return null; }
    return read();
  };
}

// ── Sentiment ────────────────────────────────────────────────────────────────

function txSentimentForm(body: HTMLElement, e: any): () => any {
  const cols = txTextColumns();
  const colSel = makeNameSelect(cols, e.column || cols[0]);
  const asIn = textInput(e.as || '');
  const syncPlaceholder = (): void => { asIn.placeholder = (colSel.value || 'text') + '_sentiment'; };
  syncPlaceholder();
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  hint.textContent = t('textSteps.vader_sentiment_an_english_lexicon_mit');
  const preview = makePreviewBox();
  preview.classList.add('tx-preview');
  const read = (): any => {
    const step: any = { type: 'text_sentiment', column: colSel.value };
    if (e.lexiconVersion) step.lexiconVersion = e.lexiconVersion;
    if (asIn.value.trim()) step.as = asIn.value.trim();
    return step;
  };
  let seq = 0;
  const refresh = async (): Promise<void> => {
    syncPlaceholder();
    if (!colSel.value) return setPreview(preview, [t('textSteps.this_dataset_has_no_text_column_2')], true);
    const mine = ++seq;
    const res = await txPreview(read());
    if (mine !== seq) return;
    if (!res || !res.ok) return setPreview(preview, [(res && res.error) || t('common.could_not_preview')], true);
    txPaintSentimentPreview(preview, res);
  };
  colSel.addEventListener('change', () => void refresh());
  asIn.addEventListener('input', txLive(refresh));
  body.append(fieldRow(t('common.text_column'), colSel), fieldRow(t('common.new_column_name'), asIn), hint, preview);
  void refresh();
  return () => {
    if (!colSel.value) { window.alert(t('textSteps.pick_the_text_column')); return null; }
    return read();
  };
}

// ── Keyword rules ────────────────────────────────────────────────────────────

/**
 * One rule as a small card — "If [text contains ▾] [refund] → [Billing]" — so a
 * pattern and its category read as one thing however narrow the rail is. The
 * number in its corner is its precedence (a CSS counter, so it follows a move).
 */
function txRuleRow(rule: any, list: HTMLElement, onChange: () => void): HTMLElement {
  const r = rule || {};
  const row = document.createElement('div');
  row.className = 'tx-rule';
  const pat = textInput(r.pattern || '');
  pat.classList.add('tx-pat');
  pat.placeholder = t('textSteps.refund');
  pat.setAttribute('aria-label', t('common.pattern'));
  const match = txLabelledSelect(TX_MATCHES, r.match || 'word');
  match.classList.add('tx-match');
  match.setAttribute('aria-label', t('common.match'));
  const caseLbl = document.createElement('label');
  caseLbl.className = 'tx-case-lbl';
  caseLbl.title = t('textSteps.match_upper_and_lower_case_exactly');
  const cs = document.createElement('input');
  cs.type = 'checkbox';
  cs.className = 'tx-case';
  cs.checked = !!r.caseSensitive;
  const csText = document.createElement('span');
  csText.textContent = t('textSteps.aa');
  csText.setAttribute('aria-hidden', 'true');
  cs.setAttribute('aria-label', t('textSteps.match_case'));
  caseLbl.append(cs, csText);
  const ifLbl = document.createElement('span');
  ifLbl.className = 'pp-arrow';
  ifLbl.textContent = t('textSteps.if_text');
  const arrow = document.createElement('span');
  arrow.className = 'pp-arrow';
  arrow.textContent = '→';
  const cat = textInput(r.category || '');
  cat.classList.add('tx-cat');
  cat.placeholder = t('textSteps.billing');
  cat.setAttribute('aria-label', t('common.category'));
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'ds-step-btn';
  iconOnly(up, 'arrow-up', t('textSteps.move_rule_up_earlier_rules_win'));
  up.addEventListener('click', () => {
    const prev = row.previousElementSibling;
    if (prev) { list.insertBefore(row, prev); onChange(); }
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-step-btn';
  iconOnly(del, 'x', t('common.remove_rule'));
  del.addEventListener('click', () => { row.remove(); onChange(); });
  [pat, cat].forEach((el) => el.addEventListener('input', onChange));
  [match, cs].forEach((el) => el.addEventListener('change', onChange));
  const line1 = document.createElement('div');
  line1.className = 'tx-rule-line';
  line1.append(ifLbl, match, pat, caseLbl);
  const line2 = document.createElement('div');
  line2.className = 'tx-rule-line';
  line2.append(arrow, cat, up, del);
  row.append(line1, line2);
  return row;
}

function txKeywordForm(body: HTMLElement, e: any): () => any {
  const cols = txTextColumns();
  const colSel = makeNameSelect(cols, e.column || cols[0]);
  const asIn = textInput(e.as || '');
  const list = document.createElement('div');
  list.className = 'ds-agg-list tx-rules';
  const preview = makePreviewBox();
  preview.classList.add('tx-preview');
  const read = (): any => {
    const rules: any[] = [];
    list.querySelectorAll('.tx-rule').forEach((row) => {
      const pattern = (row.querySelector('.tx-pat') as HTMLInputElement).value;
      if (!pattern.trim()) return;
      const rule: any = {
        pattern, match: (row.querySelector('.tx-match') as HTMLSelectElement).value,
        category: (row.querySelector('.tx-cat') as HTMLInputElement).value.trim(),
      };
      if ((row.querySelector('.tx-case') as HTMLInputElement).checked) rule.caseSensitive = true;
      rules.push(rule);
    });
    const step: any = { type: 'keyword_rules', column: colSel.value, rules, otherwise: elseIn.value === '' ? null : elseIn.value };
    if (asIn.value.trim()) step.as = asIn.value.trim();
    return step;
  };
  let seq = 0;
  const refresh = async (): Promise<void> => {
    asIn.placeholder = (colSel.value || 'text') + '_category';
    const step = read();
    if (!colSel.value) return setPreview(preview, [t('textSteps.this_dataset_has_no_text_column_3')], true);
    if (!step.rules.length) return setPreview(preview, [t('textSteps.add_a_rule_to_see_how')]);
    const mine = ++seq;
    const res = await txPreview(step);
    if (mine !== seq) return;
    if (!res || !res.ok) return setPreview(preview, [(res && res.error) || t('common.could_not_preview')], true);
    txPaintCategoryPreview(preview, res);
  };
  const live = txLive(refresh);
  const add = (r?: any): void => { list.appendChild(txRuleRow(r, list, live)); };
  (Array.isArray(e.rules) && e.rules.length ? e.rules : [null]).forEach((r: any) => add(r));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = t('common.add_rule_2');
  addBtn.addEventListener('click', () => add());
  const elseIn = textInput(e.otherwise === undefined ? t('common.other') : e.otherwise === null ? '' : String(e.otherwise));
  elseIn.placeholder = t('common.leave_empty');
  elseIn.addEventListener('input', live);
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  hint.textContent = t('textSteps.the_first_rule_that_matches_decides');
  colSel.addEventListener('change', () => void refresh());
  asIn.addEventListener('input', live);
  body.append(fieldRow(t('common.text_column'), colSel), fieldRow(t('common.new_column_name'), asIn));
  // From the profile: its top terms as one-click rules.
  const terms: string[] = Array.isArray(e.terms) ? e.terms.slice(0, 8) : [];
  if (terms.length) {
    const chips = document.createElement('div');
    chips.className = 'tx-chips';
    const lead = document.createElement('span');
    lead.className = 'tx-muted';
    lead.textContent = t('textSteps.common_words');
    chips.appendChild(lead);
    terms.forEach((tv) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tx-chip';
      b.textContent = tv;
      b.setAttribute('aria-label', t('textSteps.add_a_rule_for', { t: tv }));
      b.addEventListener('click', () => {
        const blank = Array.from(list.querySelectorAll('.tx-rule')).find((row) => !(row.querySelector('.tx-pat') as HTMLInputElement).value.trim());
        if (blank) blank.remove();
        add({ pattern: tv, match: 'word', category: tv.charAt(0).toUpperCase() + tv.slice(1) });
        live();
      });
      chips.appendChild(b);
    });
    body.appendChild(chips);
  }
  body.append(list, addBtn, fieldRow(t('common.otherwise'), elseIn), hint, preview);
  void refresh();
  return () => {
    if (!colSel.value) { window.alert(t('textSteps.pick_the_text_column')); return null; }
    const step = read();
    if (!step.rules.length) { window.alert(t('textSteps.add_at_least_one_rule_with')); return null; }
    if (step.rules.some((r: any) => !r.category)) { window.alert(t('textSteps.give_every_rule_a_category')); return null; }
    return step;
  };
}

// ── Hooks for prepare.ts / prepareForms.ts ───────────────────────────────────

/** prepareForms.buildStepForm's default, before the power forms: a text step's editor, or null. */
function txBuildStepForm(type: string, body: HTMLElement, existing: any): (() => any) | null {
  if (!TX_STEP_TYPES.has(type)) return null;
  const e = existing || txPrefill || {};
  txPrefill = null;
  if (type === 'text_terms') return txTermsForm(body, e);
  if (type === 'text_sentiment') return txSentimentForm(body, e);
  return txKeywordForm(body, e);
}

/** prepare.stepSummaryText's default, before the power summaries. */
function txStepSummary(step: any): string {
  if (!step || !TX_STEP_TYPES.has(step.type)) return '';
  if (step.type === 'text_sentiment') {
    return t('textSteps.sentiment_of', { column: step.column, p1: (step.as || step.column + '_sentiment'), p2: (step.lexiconVersion ? ' (' + step.lexiconVersion + ')' : '') });
  }
  if (step.type === 'keyword_rules') {
    const n = Array.isArray(step.rules) ? step.rules.length : 0;
    return t('textSteps.tag_with', { column: step.column, n, p3: (step.as || step.column + '_category') });
  }
  const range = step.minN === step.maxN ? (step.minN === 1 ? 'words' : t('textSteps.word_terms', { minN: step.minN })) : t('textSteps.word_terms_2', { minN: step.minN, maxN: step.maxN });
  return t('textSteps.top_in', { top: step.top, range, column: step.column, p3: (step.by ? (step.rank === 'tfidf' ? t('textSteps.most_distinctive_per') : t('textSteps.per')) + step.by : '') });
}

/** Save a text step (add at -1, else replace) — replies like dataset:addStep, or { cancelled }. */
async function txCommitStep(index: number, step: any): Promise<any> {
  if (!currentProjectId || !expId || !window.hubText) return { ok: false, error: t('textSteps.no_dataset_is_open') };
  const save = document.querySelector('#ds-step-editor .btn-primary') as HTMLButtonElement | null;
  const label = save ? save.textContent : '';
  if (save) { save.disabled = true; save.textContent = t('common.saving'); }
  try {
    return await window.hubText.commitStep(currentProjectId, expId, index, step);
  } catch (_) {
    return { ok: false, error: t('textSteps.could_not_save_the_step') };
  } finally {
    if (save && save.isConnected) { save.disabled = false; save.textContent = label; }
  }
}

/** Open the Prepare tab on a NEW text step, prefilled (the profile's buttons). */
function txOpenStep(type: string, prefill: any): void {
  togglePreparePanel();
  txPrefill = prefill || null;
  openStepEditor(type, -1);
  const editor = pEl('ds-step-editor');
  if (editor) editor.scrollIntoView({ block: 'nearest' });
}
