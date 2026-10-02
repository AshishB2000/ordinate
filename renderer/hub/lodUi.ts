'use strict';

// Level-of-detail expressions — the RENDERER half. Small pieces the formula
// editor, the filter dialog and the two filter lists call into, kept here so
// each of those files grows by a line rather than by a feature.
//
// Nothing here decides what an LOD means or whether one is valid: the formula
// editor's verdicts come from `formula:check` in main, and a filter's
// `context: true` is read by main's analysis/lodQuery. This file draws.

// ── Formula editor ───────────────────────────────────────────────────────────

/** Caret position for a clicked LOD keyword template: inside its first `[]`. */
function lodCaretBack(d: any): number {
  const ins = String(d && d.insert ? d.insert : '');
  const at = ins.indexOf('[]');
  return d && d.kind === 'keyword' && at >= 0 ? ins.length - at - 1 : 0;
}

/** What completing `fix` → FIXED inserts: the brace too, unless one is already typed. */
function lodKeywordInsert(d: any, braced: boolean): string {
  if (!d || d.kind !== 'keyword') return '';
  const kw = String(d.name).toUpperCase() + ' ';
  return braced ? kw : '{' + kw;
}

/**
 * Column completion in an LOD's dimension list — `{FIXED ` or `{FIXED [Region], `
 * with no bracket open yet. Offers every column as a `[name]` reference, so
 * picking one writes the bracketed form the grammar reads.
 */
function lodDimContext(
  before: string,
  columns: any[],
): { items: Array<{ label: string; insert: string; sub: string }>; from: number } | null {
  const m = /\{\s*(fixed|include|exclude)(\s[^:{}]*)$/i.exec(before);
  if (!m) return null;
  const part = m[2].split(',').pop() || '';
  if (/[[\]]/.test(part)) return null;
  const frag = part.trim().toLowerCase();
  const items = columns
    .filter((c) => String(c.name).toLowerCase().indexOf(frag) >= 0)
    .slice(0, 12)
    .map((c) => ({ label: String(c.name), insert: '[' + c.name + ']', sub: t('lodUi.dimension', { type: c.type }) }));
  return items.length ? { items, from: before.length - part.trimStart().length } : null;
}

/** A preview column that holds an LOD's value rather than a dataset column. */
function lodPreviewHeader(th: HTMLElement, text: string): void {
  th.classList.add('fx-lod-col');
  th.title = t('lodUi.computed_over_the_whole_table_not', { text });
}

function lodPreviewNote(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fx-lod-note';
  el.textContent = text;
  return el;
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * The filter dialog's "Apply before LOD" switch. A context filter narrows the
 * rows FIXED / INCLUDE / EXCLUDE aggregate over; every other filter runs after
 * them. The two sentences under the switch say which one the user is making,
 * because the difference is invisible until a share stops adding up to 100%.
 */
function lodContextToggle(initial: boolean): { el: HTMLElement; on: () => boolean } {
  let on = !!initial;
  const row = document.createElement('div');
  row.className = 'lod-ctx-row';
  const text = document.createElement('div');
  text.className = 'lod-ctx-text';
  const label = document.createElement('div');
  label.className = 'lod-ctx-label';
  label.id = 'lod-ctx-label';
  label.textContent = t('lodUi.apply_before_lod');
  const hint = document.createElement('div');
  hint.className = 'lod-ctx-hint';
  text.appendChild(label);
  text.appendChild(hint);
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'stp-switch lod-ctx-switch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-labelledby', 'lod-ctx-label');
  const thumb = document.createElement('span');
  thumb.className = 'stp-switch-thumb';
  sw.appendChild(thumb);
  const paint = (): void => {
    sw.classList.toggle('stp-switch-on', on);
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    row.classList.toggle('is-on', on);
    hint.textContent = on
      ? t('lodUi.context_filter_runs_first_so_fixed')
      : t('lodUi.runs_after_lod_expressions_so_a');
  };
  sw.addEventListener('click', () => { on = !on; paint(); });
  row.appendChild(text);
  row.appendChild(sw);
  paint();
  return { el: row, on: () => on };
}

/** The dialog's steps, marked (or unmarked) as context filters. */
function lodMarkContext(steps: any[] | null, on: boolean): any[] | null {
  if (!steps) return steps;
  return steps.map((s) => {
    const out = { ...s };
    if (on) out.context = true;
    else delete out.context;
    return out;
  });
}

/** The small tag a context filter wears in a filter bar or a FILTERS well. */
function lodContextTag(step: any): HTMLElement | null {
  if (!step || step.context !== true) return null;
  const tag = document.createElement('span');
  tag.className = 'lod-ctx-tag';
  tag.textContent = t('lodUi.context');
  tag.title = t('lodUi.applied_before_lod_expressions');
  return tag;
}
