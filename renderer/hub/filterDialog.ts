'use strict';

// ONE filter dialog, adapting to the column's DECLARED type — RENDERER ONLY.
//
// Three surfaces show filters (the prepare pipeline, a visual's FILTERS well,
// the sheet filter bar) and all three used to show the same generic
// column/operator/value row. That row asks the user to know that a dimension
// wants `in`, a measure wants a range, and that `>` on a text column compares
// strings. This asks the column instead.
//
//   text   → a checkbox list of real distinct values, with a SERVER-SIDE search,
//            plus Select all / none. Free-text columns keep contains / = /
//            is empty / is not empty via the Condition tab.
//   number → min / max, which compiles to two AND-ed steps (already supported),
//            plus the comparison operators.
//   date   → from / to, or a RELATIVE period ("last 30 days", "this fiscal
//            quarter") stored as its preset and resolved in main at query
//            time — the picker is periodPicker.ts, shared with the filter bar.
//
// This is Tableau's model deliberately, not Power BI's. Power BI splits the same
// job into a Basic/Advanced toggle capped at two conditions — two modes for one
// job, and the user has to know which mode holds the thing they want.
//
// ── The two things that would make this quietly wrong ────────────────────────
//
// 1. THE VALUE LIST IS NOT FETCHED WHOLE. A text column on a 1,000,000-row
//    dataset can have hundreds of thousands of distinct values. The search runs
//    in SQL (`dataset:distinct` → `datasetPage.readDistinctPage`) and only ever
//    ships a capped page. Fetching everything and filtering here is exactly the
//    pattern that capped datasets at 50k before `datasetPage.ts`.
//
// 2. TRUNCATION IS NEVER SILENT. The IPC returns the pre-cap `total`, and when
//    it exceeds what came back the dialog SAYS so. A list that quietly stops at
//    200 reads as "these are all the values", and the user then trusts a filter
//    built from a lie.
//
// ── Dates, and why there are two input shapes ────────────────────────────────
//
// A `date` column is stored as the ORIGINAL STRING (parse.ts keeps it lossless),
// and `>=` / `<=` compare those strings lexicographically. That is correct for
// ISO `YYYY-MM-DD` and MEANINGLESS for `MM/DD/YYYY` — '03/01/2024' sorts below
// '12/31/2023' because '0' < '1'. So the native `<input type="date">` is offered
// ONLY when the stored values are actually ISO-shaped; anything else gets plain
// text boxes and a note saying the comparison is textual. Shipping an ISO date
// picker over `MM/DD/YYYY` data would produce a confidently wrong filter, which
// is the one failure mode this codebase is built to avoid.

/** How many options one page of the checkbox list shows. The cap is enforced in main. */
const FD_PAGE = 200;

interface FilterDialogOpts {
  projectId: string;
  datasetId: string;
  column: string;
  /** The column's DECLARED type — never inferred here. */
  type: string;
  /** An existing step to re-open for editing, if any. */
  existing?: any;
}

/**
 * Returns the steps to apply — 0, 1 or 2 of them — or `null` if cancelled.
 *
 * A LIST, because a min/max range is two AND-ed steps and always was; the
 * dialog just stops making the user type both.
 */
function openFilterDialog(opts: FilterDialogOpts): Promise<any[] | null> {
  return new Promise((resolve) => {
    const column = opts.column;
    const type = opts.type === 'number' || opts.type === 'date' ? opts.type : 'text';
    const existing = opts.existing || {};

    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal fd-modal';

    const title = document.createElement('div');
    title.className = 'ws-modal-title';
    title.textContent = 'Filter: ' + column;
    box.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'fd-sub';
    sub.textContent =
      type === 'number' ? 'Number column' : type === 'date' ? 'Date column' : 'Text column';
    box.appendChild(sub);

    // ── Mode tabs ────────────────────────────────────────────────────────────
    const modes: Array<{ id: string; label: string }> =
      type === 'number'
        ? [{ id: 'range', label: 'Range' }, { id: 'cond', label: 'Condition' }]
        : type === 'date'
          ? [{ id: 'range', label: 'Range' }, { id: 'relative', label: 'Relative' }]
          : [{ id: 'values', label: 'Values' }, { id: 'cond', label: 'Condition' }];

    let mode = modes[0].id;
    if (existing.op === 'period') mode = 'relative';
    // Re-open in the mode that matches the step being edited, so editing a
    // `contains` filter doesn't drop the user on a checkbox list.
    if (existing.op) {
      if (isListFilterOp(existing.op)) mode = 'values';
      else if (type === 'text') mode = 'cond';
      else if (isValuelessFilterOp(existing.op)) mode = 'cond';
    }

    const tabs = document.createElement('div');
    tabs.className = 'fd-tabs';
    tabs.setAttribute('role', 'tablist');
    const tabBtns: HTMLButtonElement[] = [];
    if (modes.length > 1) {
      modes.forEach((m) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fd-tab';
        b.setAttribute('role', 'tab');
        b.textContent = m.label;
        b.addEventListener('click', () => {
          mode = m.id;
          paintTabs();
          paintBody();
          syncApply();
        });
        tabBtns.push(b);
        tabs.appendChild(b);
      });
      box.appendChild(tabs);
    }
    function paintTabs(): void {
      tabBtns.forEach((b, i) => {
        const on = modes[i].id === mode;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    const body = document.createElement('div');
    body.className = 'fd-body';
    box.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary';
    apply.textContent = 'Apply';
    actions.appendChild(cancel);
    actions.appendChild(apply);
    box.appendChild(actions);

    // ── State, one bag per mode ──────────────────────────────────────────────
    // `selected` is deliberately INDEPENDENT of what the list currently shows:
    // typing in the search box must never silently drop a value picked before.
    const selected = new Set<string>(
      isListFilterOp(existing.op) && Array.isArray(existing.values)
        ? existing.values.map((v: any) => (v == null ? '' : String(v)))
        : [],
    );
    let exclude = existing.op === 'not in';
    let condOp = !isListFilterOp(existing.op) && existing.op ? String(existing.op) : type === 'text' ? 'contains' : '>=';
    let condVal = existing.value != null ? String(existing.value) : '';
    let rangeMin = '';
    let rangeMax = '';
    // Re-opening a single-sided range lands its value in the right box.
    if (existing.op === '>=') rangeMin = condVal;
    if (existing.op === '<=') rangeMax = condVal;

    let relSpec: any = existing.op === 'period' && existing.period ? { ...existing.period } : null;
    let isoDates = true; // assumed until a sample says otherwise
    let searchTerm = '';
    let searchTimer: number | null = null;
    let listSeq = 0; // guards against an out-of-order search response

    // ── Result construction ──────────────────────────────────────────────────
    function buildSteps(): any[] {
      if (mode === 'values') {
        if (selected.size === 0) return [];
        return [{ type: 'filter', column, op: exclude ? 'not in' : 'in', values: [...selected] }];
      }
      if (mode === 'relative') {
        return relSpec ? [{ type: 'filter', column, op: 'period', period: relSpec }] : [];
      }
      if (mode === 'range') {
        const out: any[] = [];
        if (rangeMin.trim() !== '') out.push({ type: 'filter', column, op: '>=', value: rangeMin.trim() });
        if (rangeMax.trim() !== '') out.push({ type: 'filter', column, op: '<=', value: rangeMax.trim() });
        return out;
      }
      if (isValuelessFilterOp(condOp)) return [{ type: 'filter', column, op: condOp }];
      if (condVal.trim() === '') return [];
      return [{ type: 'filter', column, op: condOp, value: condVal }];
    }
    function syncApply(): void {
      // An Apply that produces nothing would silently close having done nothing.
      apply.disabled = buildSteps().length === 0;
    }

    // ── Bodies ───────────────────────────────────────────────────────────────
    function paintBody(): void {
      body.innerHTML = '';
      if (mode === 'values') paintValues();
      else if (mode === 'relative') {
        body.appendChild(buildPeriodPanel({
          value: relSpec,
          relativeOnly: true,
          onChange: (v) => { relSpec = v; syncApply(); },
        }));
      } else if (mode === 'range') paintRange();
      else paintCondition();
    }

    // Text → the checkbox list.
    let listHost: HTMLElement | null = null;
    let noteEl: HTMLElement | null = null;

    function paintValues(): void {
      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'ws-modal-input fd-search';
      search.placeholder = 'Search values…';
      search.value = searchTerm;
      search.setAttribute('aria-label', 'Search values');
      search.addEventListener('input', () => {
        searchTerm = search.value;
        // Debounced: every keystroke is a query against main, and the answer
        // for "Cali" is worthless once "Calif" has been typed.
        if (searchTimer !== null) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => { void loadValues(); }, 250);
      });
      body.appendChild(search);

      const bulk = document.createElement('div');
      bulk.className = 'fd-bulk';
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'fd-link';
      // "shown", not "all": the list is capped, and a button that claimed to
      // select every value while selecting 200 would be a lie.
      all.textContent = 'Select all shown';
      all.addEventListener('click', () => {
        listHost?.querySelectorAll('input[type=checkbox]').forEach((el) => {
          const cb = el as HTMLInputElement;
          cb.checked = true;
          selected.add(cb.value);
        });
        paintNote();
        syncApply();
      });
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'fd-link';
      none.textContent = 'Clear selection';
      none.addEventListener('click', () => {
        selected.clear();
        listHost?.querySelectorAll('input[type=checkbox]').forEach((el) => {
          (el as HTMLInputElement).checked = false;
        });
        paintNote();
        syncApply();
      });
      bulk.appendChild(all);
      bulk.appendChild(none);

      const exWrap = document.createElement('label');
      exWrap.className = 'fd-exclude';
      const exCb = document.createElement('input');
      exCb.type = 'checkbox';
      exCb.checked = exclude;
      exCb.addEventListener('change', () => { exclude = exCb.checked; });
      exWrap.appendChild(exCb);
      exWrap.appendChild(document.createTextNode(' Exclude these'));
      bulk.appendChild(exWrap);
      body.appendChild(bulk);

      listHost = document.createElement('div');
      listHost.className = 'fd-list';
      body.appendChild(listHost);

      noteEl = document.createElement('p');
      noteEl.className = 'fd-note';
      body.appendChild(noteEl);

      void loadValues();
    }

    let lastTotal = 0;
    let lastShown = 0;

    async function loadValues(): Promise<void> {
      if (!listHost) return;
      const seq = ++listSeq;
      listHost.textContent = 'Loading…';
      let res: any = null;
      try {
        res = await window.hub.datasetDistinct(opts.projectId, opts.datasetId, column, FD_PAGE, searchTerm);
      } catch (_) {
        res = null;
      }
      // A slower earlier request must not overwrite a newer answer.
      if (seq !== listSeq || !listHost) return;

      const values: string[] = res && Array.isArray(res.values) ? res.values : [];
      lastTotal = res && typeof res.total === 'number' ? res.total : values.length;
      lastShown = values.length;

      listHost.innerHTML = '';
      if (values.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'fd-empty';
        empty.textContent = searchTerm ? 'No values match that search.' : 'This column has no values to filter on.';
        listHost.appendChild(empty);
      }
      values.forEach((v) => {
        const row = document.createElement('label');
        row.className = 'fd-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = v;
        cb.checked = selected.has(v);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(v);
          else selected.delete(v);
          paintNote();
          syncApply();
        });
        const span = document.createElement('span');
        span.className = 'fd-opt-label';
        span.textContent = v;
        row.appendChild(cb);
        row.appendChild(span);
        listHost!.appendChild(row);
      });
      paintNote();
      syncApply();
    }

    function paintNote(): void {
      if (!noteEl) return;
      const parts: string[] = [];
      // Say it plainly when the list is a window onto something larger.
      if (lastTotal > lastShown) parts.push(`Showing the first ${lastShown} of ${lastTotal} values — search to narrow.`);
      if (selected.size > 0) parts.push(`${selected.size} selected.`);
      noteEl.textContent = parts.join(' ');
    }

    // Number / date → min & max.
    function paintRange(): void {
      const useDate = type === 'date' && isoDates;
      const mk = (label: string, val: string, set: (v: string) => void): HTMLElement => {
        const wrap = document.createElement('label');
        wrap.className = 'fd-field';
        const span = document.createElement('span');
        span.className = 'fd-field-label';
        span.textContent = label;
        const input = document.createElement('input');
        input.className = 'ws-modal-input';
        input.type = type === 'number' ? 'number' : useDate ? 'date' : 'text';
        input.value = val;
        input.addEventListener('input', () => { set(input.value); syncApply(); });
        wrap.appendChild(span);
        wrap.appendChild(input);
        return wrap;
      };
      body.appendChild(mk(type === 'date' ? 'From' : 'Minimum', rangeMin, (v) => { rangeMin = v; }));
      body.appendChild(mk(type === 'date' ? 'To' : 'Maximum', rangeMax, (v) => { rangeMax = v; }));

      const hint = document.createElement('p');
      hint.className = 'fd-note';
      if (type === 'date' && !useDate) {
        // The honest version of "we can't use a date picker here".
        hint.textContent =
          'These dates are not stored as YYYY-MM-DD, so they are compared as text. ' +
          'Type the value exactly as it appears in the data.';
      } else {
        hint.textContent = 'Leave either box empty for an open-ended range. Both bounds are inclusive.';
      }
      body.appendChild(hint);
    }

    // The escape hatch: the operators that were always there.
    function paintCondition(): void {
      const ops =
        type === 'text'
          ? [
              { value: 'contains', label: 'contains' },
              { value: '=', label: 'equals' },
              { value: '!=', label: 'does not equal' },
              { value: 'is_empty', label: 'is empty' },
              { value: 'not_empty', label: 'is not empty' },
            ]
          : [
              { value: '=', label: 'equals' },
              { value: '!=', label: 'does not equal' },
              { value: '>', label: 'greater than' },
              { value: '<', label: 'less than' },
              { value: '>=', label: 'at least' },
              { value: '<=', label: 'at most' },
              { value: 'is_empty', label: 'is empty' },
              { value: 'not_empty', label: 'is not empty' },
            ];
      if (!ops.some((o) => o.value === condOp)) condOp = ops[0].value;

      const opWrap = document.createElement('label');
      opWrap.className = 'fd-field';
      const opSpan = document.createElement('span');
      opSpan.className = 'fd-field-label';
      opSpan.textContent = 'Condition';
      const sel = document.createElement('select');
      sel.className = 'ws-modal-input';
      ops.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === condOp) opt.selected = true;
        sel.appendChild(opt);
      });
      opWrap.appendChild(opSpan);
      opWrap.appendChild(sel);
      body.appendChild(opWrap);

      const valWrap = document.createElement('label');
      valWrap.className = 'fd-field';
      const valSpan = document.createElement('span');
      valSpan.className = 'fd-field-label';
      valSpan.textContent = 'Value';
      const valIn = document.createElement('input');
      valIn.className = 'ws-modal-input';
      valIn.type = type === 'number' ? 'number' : 'text';
      valIn.value = condVal;
      valIn.addEventListener('input', () => { condVal = valIn.value; syncApply(); });
      valWrap.appendChild(valSpan);
      valWrap.appendChild(valIn);
      body.appendChild(valWrap);

      const syncOp = (): void => { valWrap.hidden = isValuelessFilterOp(condOp); };
      sel.addEventListener('change', () => { condOp = sel.value; syncOp(); syncApply(); });
      syncOp();
    }

    // ── Is this date column ISO-shaped? ──────────────────────────────────────
    // One bounded peek at the real values decides which input to draw. It costs
    // the same query the value list uses and is capped in main.
    async function probeDateShape(): Promise<void> {
      try {
        const res = await window.hub.datasetDistinct(opts.projectId, opts.datasetId, column, 20, '');
        const vals: string[] = res && Array.isArray(res.values) ? res.values : [];
        if (vals.length > 0) isoDates = vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v));
      } catch (_) {
        isoDates = false; // unknown shape → the safe, honest input
      }
      if (!done) paintBody();
    }

    // ── Wiring ───────────────────────────────────────────────────────────────
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: any[] | null): void {
      if (done) return;
      done = true;
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      // Deliberately NO Enter-to-apply: the values list is a multi-select and
      // Enter while searching would commit a half-made selection.
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(null));
    apply.addEventListener('click', () => { if (!apply.disabled) close(buildSteps()); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintTabs();
    paintBody();
    syncApply();
    a11y = makeModalAccessible(box, 'Filter: ' + column, box.querySelector('input') as HTMLElement | null);
    if (type === 'date') void probeDateShape();
  });
}
