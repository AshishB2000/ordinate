'use strict';

// TYPED FILTERS — the box at the start of a dashboard's filter bar (the strip
// the control chips sit in, #dash-control-bar).
//
// "Filter… e.g. west technology last quarter": as you type, main parses the
// text against the dashboard's own values (src/ipc/filterParse.ts — a
// deterministic parser, no model) and this paints what it read — a popover of
// suggestions grouped by column, and the typed words underlined in place,
// with anything it could NOT read highlighted rather than guessed at.
//
//   ↑ / ↓   move through the suggestions
//   Enter   apply every recognised chip (on an alternative: switch to it first)
//   Esc     close the popover
//   click   an alternative — the same value in another column — to switch
//
// Applying goes through filterTypeApply.ts, which turns chips into ordinary
// controls and selections. The input is a combobox over a listbox; the
// underline layer behind it is aria-hidden, and the popover holds nothing
// tabbable, so Tab walks the toolbar exactly as it did without it.
//
// Classic global-scope renderer <script>: no import/export. Loads after
// dashSelection.js and before filterTypeApply.js; builds its own markup into
// the filter bar at load.

const FT_DEBOUNCE_MS = 120;
const FT_MATCH_WORD: Record<string, string> = { exact: 'exact', prefix: 'prefix', fuzzy: t('filterType.close'), date: 'date', number: 'compare' };

interface FtOption {
  /** A suggestion from the parse, or an example to type. */
  item?: any;
  example?: string;
}

let ftTimer: number | null = null;
let ftSeq = 0;
let ftResult: any = null;
/** The text `ftResult` is the parse of — Enter re-parses when they differ. */
let ftResultText = '';
let ftPick: Record<string, string> = {};
let ftOptions: FtOption[] = [];
let ftActive = 0;
let ftDashId = '';

function ftInputEl(): HTMLInputElement | null {
  return document.getElementById('ft-input') as HTMLInputElement | null;
}

/** Ask main to read `text` on the open dashboard. Null when there is no dashboard. */
async function ftParse(text: string, pick: Record<string, string>): Promise<any> {
  if (!dashCurrent || !dashCurrent.id || !currentProjectId || !window.hubFilters) return null;
  try {
    return await window.hubFilters.parse(currentProjectId, String(dashCurrent.id), text, pick);
  } catch (_) {
    return { ok: false, error: t('filterType.could_not_read_that_filter') };
  }
}

// ── The box ──────────────────────────────────────────────────────────────────

function ftInit(): void {
  // The strip every control chip sits in — outside the toolbar, which an
  // analysis moves into its Filters flyout and presenting hides.
  const host = document.getElementById('dash-control-bar');
  if (!host || ftInputEl()) return;
  const box = document.createElement('div');
  box.className = 'ft-box';
  box.appendChild(icon('filter', 16));

  const field = document.createElement('div');
  field.className = 'ft-field';
  const mirror = document.createElement('div');
  mirror.className = 'ft-mirror';
  mirror.id = 'ft-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const input = document.createElement('input');
  input.id = 'ft-input';
  input.type = 'text';
  input.className = 'ft-input';
  input.placeholder = t('filterType.filter_e_g_west_technology_last');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'ft-list');
  input.setAttribute('aria-label', t('filterType.type_a_filter_for_this_dashboard'));
  field.append(mirror, input);
  box.appendChild(field);

  const pop = document.createElement('div');
  pop.className = 'ft-pop';
  pop.id = 'ft-pop';
  pop.hidden = true;
  const list = document.createElement('div');
  list.className = 'ft-list';
  list.id = 'ft-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('filterType.filter_suggestions'));
  const foot = document.createElement('div');
  foot.className = 'ft-foot';
  foot.id = 'ft-foot';
  foot.setAttribute('role', 'status');
  pop.append(list, foot);
  box.appendChild(pop);
  // Clicks inside the popover must not take focus from the input.
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  host.prepend(box);
  host.hidden = false;

  input.addEventListener('input', () => {
    ftOpen(); // typing again after an apply or an Escape reopens it
    ftPaintMirror(null);
    ftSchedule();
  });
  input.addEventListener('scroll', () => { mirror.scrollLeft = input.scrollLeft; });
  input.addEventListener('focus', () => { ftOpen(); ftSchedule(0); });
  input.addEventListener('blur', () => ftClose());
  input.addEventListener('keydown', ftKeydown);
}

function ftOpen(): void {
  const pop = document.getElementById('ft-pop');
  const input = ftInputEl();
  if (!pop || !input) return;
  pop.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function ftClose(): void {
  const pop = document.getElementById('ft-pop');
  const input = ftInputEl();
  if (pop) pop.hidden = true;
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function ftIsOpen(): boolean {
  const pop = document.getElementById('ft-pop');
  return !!pop && !pop.hidden;
}

/** Back to empty — after an apply, or when a different dashboard opens. */
function ftReset(): void {
  const input = ftInputEl();
  if (input) input.value = '';
  ftPick = {};
  ftResult = null;
  ftResultText = '';
  ftPaintMirror(null);
}

function ftSchedule(wait = FT_DEBOUNCE_MS): void {
  if (ftTimer) window.clearTimeout(ftTimer);
  ftTimer = window.setTimeout(() => { ftTimer = null; void ftRefresh(); }, wait);
}

async function ftRefresh(): Promise<any> {
  const input = ftInputEl();
  if (!input) return null;
  const id = dashCurrent && dashCurrent.id ? String(dashCurrent.id) : '';
  if (id !== ftDashId) { ftDashId = id; ftPick = {}; }
  const text = input.value;
  const seq = ++ftSeq;
  // Empty text is parsed too: main answers with examples built from this
  // dashboard's own values, for the popover's first state.
  const res = await ftParse(text, ftPick);
  if (seq !== ftSeq) return ftResult;
  ftResult = res;
  ftResultText = text;
  ftPaintMirror(res);
  ftPaint(text, res);
  return res;
}

// ── Painting ────────────────────────────────────────────────────────────────

/** The layer behind the input: recognised words underlined, unknown ones highlighted. */
function ftPaintMirror(res: any): void {
  const mirror = document.getElementById('ft-mirror');
  const input = ftInputEl();
  if (!mirror || !input) return;
  mirror.innerHTML = '';
  const text = input.value;
  const tokens = res && res.ok && ftResultText === text && Array.isArray(res.tokens) ? res.tokens : [];
  let at = 0;
  for (const t of tokens) {
    if (t.start > at) mirror.appendChild(document.createTextNode(text.slice(at, t.start)));
    const span = document.createElement('span');
    span.className = 'ft-tok ft-tok--' + t.kind;
    span.textContent = text.slice(t.start, t.end);
    mirror.appendChild(span);
    at = t.end;
  }
  if (at < text.length) mirror.appendChild(document.createTextNode(text.slice(at)));
  mirror.scrollLeft = input.scrollLeft;
}

function ftPaint(text: string, res: any): void {
  const list = document.getElementById('ft-list');
  const foot = document.getElementById('ft-foot');
  if (!list || !foot) return;
  list.innerHTML = '';
  foot.innerHTML = '';
  ftOptions = [];

  if (!text.trim()) { ftPaintExamples(list, foot, res); return; }
  if (!res || !res.ok) {
    ftEmpty(list, 'alert', t('filterType.could_not_read_that'), (res && res.error) || t('filterType.open_a_dashboard_to_filter_it'));
    return;
  }
  const groups = Array.isArray(res.groups) ? res.groups : [];
  if (!groups.length) {
    const cols = res.columns || {};
    const some = (cols.dimensions || []).slice(0, 3).join(', ');
    const line = (some ? t('filterType.try_a_value_from', { some }) : t('filterType.try_a_value_from_this_dashboard'))
      + (cols.dates && cols.dates.length ? t('filterType.a_date_like_last_quarter') : '')
      + (cols.measures && cols.measures.length ? t('filterType.or_100', { p0: String(cols.measures[0]).replace(/_/g, ' ') }) : '') + '.';
    ftEmpty(list, 'search', t('filterType.nothing_recognised_yet'), line);
  } else {
    groups.forEach((g: any, gi: number) => {
      const group = document.createElement('div');
      group.className = 'ft-group';
      group.setAttribute('role', 'group');
      const head = document.createElement('div');
      head.className = 'ft-group-h';
      head.id = 'ft-group-' + gi;
      head.setAttribute('role', 'presentation');
      head.appendChild(icon(ftColumnIcon(res, g.column), 16));
      const name = document.createElement('span');
      name.textContent = g.column;
      head.appendChild(name);
      group.setAttribute('aria-labelledby', head.id);
      group.appendChild(head);
      (g.items || []).forEach((item: any) => group.appendChild(ftOptionEl({ item })));
      list.appendChild(group);
    });
  }
  ftPaintFoot(foot, res);
  // The cursor starts on the first reading Enter would use, never on an
  // alternative — Enter on an alternative switches to it.
  ftActive = Math.max(0, ftOptions.findIndex((o) => o.item && o.item.chosen));
  ftHighlight();
}

function ftColumnIcon(res: any, column: string): string {
  const cols = res.columns || {};
  if ((cols.dates || []).includes(column)) return 'type-date';
  if ((cols.measures || []).includes(column)) return 'type-number';
  return 'type-text';
}

function ftEmpty(list: HTMLElement, iconName: string, title: string, line: string): void {
  const box = document.createElement('div');
  box.className = 'ft-empty';
  box.appendChild(icon(iconName, 20));
  const t = document.createElement('div');
  t.className = 'ft-empty-t';
  t.textContent = title;
  const l = document.createElement('div');
  l.className = 'ft-empty-l';
  l.textContent = line;
  box.append(t, l);
  list.appendChild(box);
}

/** Nothing typed: what you CAN type, from this dashboard's own values. */
function ftPaintExamples(list: HTMLElement, foot: HTMLElement, res: any): void {
  const examples: string[] = res && Array.isArray(res.examples) && res.examples.length
    ? res.examples
    : [t('filterType.west_technology'), t('filterType.last_quarter'), t('filterType.revenue_10k'), t('filterType.not_furniture')];
  const group = document.createElement('div');
  group.className = 'ft-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', 'ft-group-try');
  const head = document.createElement('div');
  head.className = 'ft-group-h';
  head.id = 'ft-group-try';
  head.setAttribute('role', 'presentation');
  head.appendChild(icon('sparkles', 16));
  const name = document.createElement('span');
  name.textContent = t('filterType.try_typing');
  head.appendChild(name);
  group.appendChild(head);
  examples.forEach((ex) => group.appendChild(ftOptionEl({ example: ex })));
  list.appendChild(group);
  const line = document.createElement('span');
  line.className = 'ft-foot-line';
  line.textContent = t('filterType.values_dates_comparisons_and_not_read');
  foot.appendChild(line);
  if (ftActive >= ftOptions.length) ftActive = 0;
  ftHighlight();
}

function ftOptionEl(o: FtOption): HTMLElement {
  const n = ftOptions.length;
  ftOptions.push(o);
  const opt = document.createElement('div');
  opt.className = 'ft-opt';
  opt.id = 'ft-opt-' + n;
  opt.setAttribute('role', 'option');
  const label = document.createElement('span');
  label.className = 'ft-opt-label';
  const meta = document.createElement('span');
  meta.className = 'ft-opt-meta';
  if (o.example !== undefined) {
    opt.classList.add('ft-opt--example');
    opt.appendChild(icon('search', 16));
    label.textContent = o.example;
    opt.appendChild(label);
  } else {
    const it = o.item;
    opt.classList.toggle('is-chosen', !!it.chosen);
    opt.appendChild(icon(it.chosen ? 'check' : 'circle', 16));
    if (it.negated) {
      const not = document.createElement('span');
      not.className = 'ft-not';
      not.textContent = t('filterType.not');
      opt.appendChild(not);
    }
    label.textContent = it.label;
    opt.appendChild(label);
    // What was typed, when it is not simply the value itself.
    if (it.match === 'prefix' || it.match === 'fuzzy' || !it.chosen) {
      meta.textContent = (it.chosen ? '' : t('filterType.use_for')) + '“' + it.phrase + '”';
    }
    opt.appendChild(meta);
    const tag = document.createElement('span');
    tag.className = 'ft-tag ft-tag--' + it.match;
    tag.textContent = FT_MATCH_WORD[it.match] || it.match;
    opt.appendChild(tag);
    if (!it.chosen) opt.setAttribute('aria-description', t('filterType.switch_to', { phrase: it.phrase, column: it.column }));
  }
  opt.addEventListener('mousedown', (e) => { e.preventDefault(); ftActive = n; void ftChoose(n); });
  opt.addEventListener('mousemove', () => { if (ftActive !== n) { ftActive = n; ftHighlight(); } });
  return opt;
}

function ftPaintFoot(foot: HTMLElement, res: any): void {
  const unknown: string[] = Array.isArray(res.unknown) ? res.unknown : [];
  if (unknown.length) {
    const u = document.createElement('div');
    u.className = 'ft-unknown';
    const lead = document.createElement('span');
    lead.textContent = t('filterType.not_recognised');
    u.appendChild(lead);
    unknown.forEach((w) => {
      const m = document.createElement('mark');
      m.className = 'ft-unknown-w';
      m.textContent = w;
      u.appendChild(m);
    });
    foot.appendChild(u);
  }
  const chips = Array.isArray(res.chips) ? res.chips.length : 0;
  const keys = document.createElement('div');
  keys.className = 'ft-keys';
  const k = document.createElement('span');
  k.className = 'kbd';
  k.textContent = '↵';
  const tv = document.createElement('span');
  tv.textContent = chips ? t('filterType.apply', { chips }) : t('filterType.nothing_to_apply_yet');
  const k2 = document.createElement('span');
  k2.className = 'kbd';
  k2.textContent = '↑↓';
  const t2 = document.createElement('span');
  t2.textContent = t('filterType.choose');
  const k3 = document.createElement('span');
  k3.className = 'kbd';
  k3.textContent = t('filterType.esc');
  const t3 = document.createElement('span');
  t3.textContent = t('filterType.close_2');
  keys.append(k, tv, k2, t2, k3, t3);
  foot.appendChild(keys);
}

function ftHighlight(): void {
  const input = ftInputEl();
  ftOptions.forEach((_, i) => {
    const el = document.getElementById('ft-opt-' + i);
    if (!el) return;
    const on = i === ftActive;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
  if (!input) return;
  if (ftOptions.length && ftIsOpen()) input.setAttribute('aria-activedescendant', 'ft-opt-' + ftActive);
  else input.removeAttribute('aria-activedescendant');
}

// ── Acting ──────────────────────────────────────────────────────────────────

/** A click, or Enter on the active row: type an example, switch an alternative, or apply. */
async function ftChoose(n: number): Promise<void> {
  const o = ftOptions[n];
  const input = ftInputEl();
  if (!o || !input) return;
  if (o.example !== undefined) {
    input.value = o.example;
    ftPaintMirror(null);
    ftActive = 0;
    await ftRefresh();
    return;
  }
  if (!o.item.chosen) {
    ftPick[o.item.key] = o.item.id;
    await ftRefresh();
    return;
  }
  await ftApplyTyped();
}

/** Enter: every recognised chip, from a parse of exactly what is in the box. */
async function ftApplyTyped(): Promise<void> {
  const input = ftInputEl();
  if (!input || !input.value.trim()) return;
  if (ftTimer) { window.clearTimeout(ftTimer); ftTimer = null; }
  const res = ftResult && ftResultText === input.value ? ftResult : await ftRefresh();
  if (!res || !res.ok || !Array.isArray(res.chips) || !res.chips.length) return;
  const applied = ftApplyChips(res.chips);
  if (!applied.length) return;
  ftReset();
  ftClose();
  showToast(t('common.filtered_to', { p0: applied.join(' · ') }));
}

function ftKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!ftIsOpen()) { ftOpen(); ftHighlight(); return; }
    if (!ftOptions.length) return;
    ftActive = (ftActive + (e.key === 'ArrowDown' ? 1 : -1) + ftOptions.length) % ftOptions.length;
    ftHighlight();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const o = ftOptions[ftActive];
    const pending = !!ftTimer || ftResultText !== (ftInputEl() || { value: '' }).value;
    // An alternative or an example under the cursor is chosen first; otherwise
    // Enter means "apply everything I typed".
    if (ftIsOpen() && o && !pending && (o.example !== undefined || (o.item && !o.item.chosen))) {
      void ftChoose(ftActive).then(() => { if (o.item) void ftApplyTyped(); });
      return;
    }
    void ftApplyTyped();
    return;
  }
  if (e.key === 'Escape' && ftIsOpen()) {
    e.preventDefault();
    e.stopPropagation();
    ftClose();
  }
}

ftInit();
