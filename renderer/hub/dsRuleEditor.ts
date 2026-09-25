'use strict';

// The data-quality RULE EDITOR — one modal for adding or editing a rule — and
// the vocabulary the Rules list shares with it (kind labels, a rule in words).
// Classic global-scope renderer <script>: no import/export.
//
// NOTHING HERE COUNTS. The live "would fail N rows now" line is main's answer
// (`window.hub.previewQualityRule` runs the same evaluator the stored rule will),
// and every default comes from figures the app already computed: the column
// profile (`dataset:stats` summaries → a range's min/max), the column's
// distinct values (`datasetDistinct` → an allowed-values list) and the stored
// row count. Main also re-validates everything on save — the checks here only
// shape the form.
//
// Modal shell, focus trap and Escape are `.ws-modal` + `makeModalAccessible`,
// the fields are the metric editor's `meField`, the kind tiles are the add-
// control dialog's `.dc-kind-tile`, and the segmented rows are `.dm-aggs` —
// one dialog vocabulary across the hub.

const DQ_KINDS: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'not_null', label: 'Not empty', hint: 'Every row has a value' },
  { kind: 'unique', label: 'Unique', hint: 'No value appears twice' },
  { kind: 'range', label: 'Range', hint: 'Numbers or dates stay in bounds' },
  { kind: 'regex', label: 'Pattern', hint: 'Text matches a format' },
  { kind: 'in_set', label: 'Allowed values', hint: 'Only values from a list' },
  { kind: 'row_count', label: 'Row count', hint: 'The table stays a sensible size' },
  { kind: 'references', label: 'Reference', hint: 'Values exist in another dataset' },
];
const DQ_PRESETS: Array<[string, string]> = [['email', 'Email'], ['phone', 'Phone'], ['zip', 'ZIP code'], ['date', 'ISO date']];
/** Debounce for the live preview — one query per pause, not per keystroke. */
const DQ_PREVIEW_MS = 300;
/** Prefill an allowed-values list only when the column has this few values. */
const DQ_SET_PREFILL = 30;

function dqKindLabel(kind: string): string {
  const k = DQ_KINDS.find((x) => x.kind === kind);
  return k ? k.label : kind;
}

function dqFmtBound(v: any): string {
  return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v);
}

function dqBetween(subject: string, a: any, verbFrom: string): string {
  const has = (v: any): boolean => v !== undefined && v !== null && v !== '';
  if (has(a.min) && has(a.max)) return `${subject} ${verbFrom} between ${dqFmtBound(a.min)} and ${dqFmtBound(a.max)}`;
  if (has(a.min)) return `${subject} ${verbFrom} at least ${dqFmtBound(a.min)}`;
  return `${subject} ${verbFrom} at most ${dqFmtBound(a.max)}`;
}

/**
 * A rule in words — "order_date is never empty", "discount is between 0 and 1",
 * "email matches Email". `dsNames` names the other side of a references rule.
 */
function dqRuleWords(rule: any, dsNames?: Map<string, string>): string {
  const a = (rule && rule.args) || {};
  const col = String((rule && rule.column) || '');
  switch (rule && rule.kind) {
    case 'not_null': return `${col} is never empty`;
    case 'unique': return `${col} is unique`;
    case 'range': return dqBetween(col, a, 'is');
    case 'regex': {
      const preset = DQ_PRESETS.find(([id]) => id === a.preset);
      return preset ? `${col} matches ${preset[1]}` : `${col} matches /${a.pattern || ''}/`;
    }
    case 'in_set': {
      const vals: string[] = Array.isArray(a.values) ? a.values : [];
      const shown = vals.slice(0, 3).join(', ');
      return `${col} is one of ${shown}${vals.length > 3 ? ` +${vals.length - 3} more` : ''}`;
    }
    case 'row_count': return dqBetween('Row count', a, 'is');
    case 'references': {
      const other = (dsNames && dsNames.get(String(a.datasetId))) || 'another dataset';
      return `${col} exists in ${other} · ${a.column || ''}`;
    }
    default: return String((rule && rule.kind) || 'Rule');
  }
}

/** The columns a kind can run on — main refuses the rest with an error. */
function dqColumnsFor(kind: string, cols: ExpCol[]): ExpCol[] {
  if (kind === 'range') return cols.filter((c) => c.type === 'number' || c.type === 'date');
  if (kind === 'regex') return cols.filter((c) => c.type !== 'number');
  return cols;
}

function dqSeg(items: Array<[string, string]>, get: () => string, set: (v: string) => void, label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dm-aggs';
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', label);
  const paint = (): void => row.querySelectorAll('.dm-agg').forEach((b) => {
    const on = (b as HTMLElement).dataset.v === get();
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  items.forEach(([v, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-agg';
    b.dataset.v = v;
    b.setAttribute('role', 'radio');
    b.textContent = text;
    b.addEventListener('click', () => { set(v); paint(); });
    row.appendChild(b);
  });
  paint();
  return row;
}

function dqInput(type: string, value: any, placeholder: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.className = 'ws-modal-input';
  if (type === 'number') i.step = 'any';
  i.placeholder = placeholder;
  i.value = value === undefined || value === null ? '' : String(value);
  return i;
}

/**
 * Open the editor. `existing` null → a new rule. Resolves with main's save reply
 * (`{ ok, rule, quality }`) or null when cancelled. A refused save is shown IN
 * the dialog — the user's work is still in the boxes.
 */
function dqOpenRuleEditor(
  existing: any,
  ctx: { projectId: string; datasetId: string; columns: ExpCol[]; summaries: any[]; rowCount: number },
): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    let kind: string = existing ? String(existing.kind) : 'not_null';
    let column: string = existing && existing.column ? String(existing.column) : '';
    let severity: string = existing && existing.severity === 'warn' ? 'warn' : 'fail';
    // Read back out of whatever the current kind's pane built.
    let readArgs: () => any = () => ({});
    let previewTimer = 0;
    let previewSeq = 0;

    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dq-modal';
    const title = document.createElement('div');
    title.className = 'ws-modal-title';
    title.textContent = existing ? 'Edit rule' : 'Add rule';
    box.appendChild(title);

    // ── Kind tiles ───────────────────────────────────────────────────────────
    const kinds = document.createElement('div');
    kinds.className = 'dq-kinds';
    kinds.setAttribute('role', 'radiogroup');
    kinds.setAttribute('aria-label', 'Rule kind');
    DQ_KINDS.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dc-kind-tile dq-kind';
      b.dataset.kind = k.kind;
      b.setAttribute('role', 'radio');
      const t = document.createElement('span');
      t.className = 'dc-kind-tile-label';
      t.textContent = k.label;
      const s = document.createElement('span');
      s.className = 'dc-kind-tile-hint';
      s.textContent = k.hint;
      b.append(t, s);
      b.addEventListener('click', () => { if (kind !== k.kind) { kind = k.kind; paintKind(); } });
      kinds.appendChild(b);
    });
    box.appendChild(kinds);

    // ── Column ───────────────────────────────────────────────────────────────
    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';
    const colField = meField('Column', colSel);
    box.appendChild(colField);

    // ── Per-kind arguments ───────────────────────────────────────────────────
    const argsHost = document.createElement('div');
    argsHost.className = 'dq-args';
    box.appendChild(argsHost);

    // ── Severity ─────────────────────────────────────────────────────────────
    box.appendChild(meField('Severity', dqSeg([['fail', 'Fail'], ['warn', 'Warn']], () => severity, (v) => { severity = v; schedulePreview(); }, 'Severity'),
      'Fail raises an alert and puts a red dot on the dataset; Warn only shows here.'));

    // ── The live preview (main's count) and the error line ───────────────────
    const preview = document.createElement('div');
    preview.className = 'dq-preview';
    preview.setAttribute('role', 'status');
    box.appendChild(preview);
    const err = document.createElement('p');
    err.className = 'dq-err';
    err.hidden = true;
    box.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = existing ? 'Save rule' : 'Add rule';
    actions.append(cancel, save);
    box.appendChild(actions);

    const colType = (): string => {
      const c = ctx.columns.find((x) => x.name === column);
      return c ? c.type : 'text';
    };
    const draft = (): any => {
      const r: any = { kind, args: readArgs(), severity };
      if (kind !== 'row_count') r.column = column;
      if (existing && existing.id) r.id = existing.id;
      return r;
    };
    const setPreview = (cls: string, text: string): void => {
      preview.className = 'dq-preview' + (cls ? ' is-' + cls : '');
      preview.textContent = text;
    };
    function schedulePreview(): void {
      window.clearTimeout(previewTimer);
      setPreview('busy', 'Checking the data…');
      previewTimer = window.setTimeout(async () => {
        const seq = ++previewSeq;
        let res: any;
        try {
          res = await window.hub.previewQualityRule(ctx.projectId, ctx.datasetId, draft());
        } catch (_) {
          res = null;
        }
        if (seq !== previewSeq || done) return;
        if (!res) setPreview('muted', 'Could not check the data.');
        else if (res.ok === false) setPreview('muted', 'Not checkable yet — ' + String(res.error || 'finish the rule'));
        else if (res.error) setPreview('fail', 'Cannot run: ' + String(res.error));
        else if (res.passed) setPreview('pass', kind === 'row_count' ? 'Passes now' : 'Passes now — no rows fail');
        else if (kind === 'row_count') setPreview('fail', 'Would fail now');
        else setPreview('fail', `Would fail ${Number(res.failing).toLocaleString()} ${res.failing === 1 ? 'row' : 'rows'} now`);
      }, DQ_PREVIEW_MS);
    }

    // Each pane builds its controls and sets `readArgs`. `fresh` = the kind or
    // column just changed, so defaults may be (re)applied; editing an existing
    // rule of the same kind keeps its stored args instead.
    const keep = (): any =>
      (existing && existing.kind === kind && (kind === 'row_count' || existing.column === column) ? existing.args || {} : null);
    function paintArgs(): void {
      argsHost.textContent = '';
      readArgs = () => ({});
      const stored = keep();
      const type = colType();
      if (kind === 'range' || kind === 'row_count') {
        const isDate = kind === 'range' && type === 'date';
        const sum = ctx.summaries.find((s: any) => s && s.name === column);
        const dflt = stored || (kind === 'row_count'
          ? { min: ctx.rowCount }
          : sum && typeof sum.min === 'number' ? { min: sum.min, max: sum.max } : {});
        const min = dqInput(isDate ? 'date' : 'number', dflt.min, 'No minimum');
        const max = dqInput(isDate ? 'date' : 'number', dflt.max, 'No maximum');
        const pair = document.createElement('div');
        pair.className = 'dq-pair';
        pair.append(meField('Minimum', min), meField('Maximum', max));
        argsHost.appendChild(pair);
        const hint = document.createElement('p');
        hint.className = 'me-field-hint dq-hint';
        hint.textContent = kind === 'row_count'
          ? `This dataset has ${ctx.rowCount.toLocaleString()} rows now.`
          : isDate ? 'Dates are compared as YYYY-MM-DD; a cell that is not a date fails.'
            : 'Prefilled with the column’s current min and max. Empty cells are ignored.';
        argsHost.appendChild(hint);
        const num = (i: HTMLInputElement): any => (i.value === '' ? undefined : isDate ? i.value : Number(i.value));
        readArgs = () => ({ min: num(min), max: num(max) });
        [min, max].forEach((i) => i.addEventListener('input', schedulePreview));
      } else if (kind === 'regex') {
        let preset: string = stored ? String(stored.preset || '') : 'email';
        const pattern = dqInput('text', stored && !stored.preset ? stored.pattern : '', 'e.g. [A-Z]{2}-[0-9]{4}');
        pattern.classList.add('dq-mono');
        const custom = meField('Pattern', pattern, 'The whole cell must match. \\s, lookarounds and back-references are not supported.');
        const seg = dqSeg([...DQ_PRESETS, ['', 'Custom']], () => preset, (v) => { preset = v; custom.hidden = preset !== ''; schedulePreview(); }, 'Format');
        argsHost.append(meField('Format', seg), custom);
        custom.hidden = preset !== '';
        readArgs = () => (preset ? { preset } : { pattern: pattern.value });
        pattern.addEventListener('input', schedulePreview);
      } else if (kind === 'in_set') {
        const ta = document.createElement('textarea');
        ta.className = 'ws-modal-input dq-values';
        ta.rows = 5;
        ta.placeholder = 'One value per line';
        ta.value = stored && Array.isArray(stored.values) ? stored.values.join('\n') : '';
        const field = meField('Allowed values', ta, 'One per line, matched exactly. Empty cells are ignored.');
        argsHost.appendChild(field);
        readArgs = () => ({ values: ta.value.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.trim() !== '') });
        ta.addEventListener('input', schedulePreview);
        if (!stored && column) {
          void (async () => {
            let res: any;
            try { res = await window.hub.datasetDistinct(ctx.projectId, ctx.datasetId, column, DQ_SET_PREFILL + 1); } catch (_) { res = null; }
            if (!res || done || ta.value || !Array.isArray(res.values)) return;
            if (res.values.length > DQ_SET_PREFILL) return; // too many to be a list of allowed values
            ta.value = res.values.join('\n');
            const hint = field.querySelector('.me-field-hint');
            if (hint) hint.textContent = `Prefilled with the ${res.values.length} values in this column today. One per line, matched exactly.`;
            schedulePreview();
          })();
        }
      } else if (kind === 'references') {
        const dsSel = document.createElement('select');
        dsSel.className = 'ws-modal-input';
        const refCol = document.createElement('select');
        refCol.className = 'ws-modal-input';
        argsHost.append(meField('Dataset', dsSel), meField('Its column', refCol, 'Every non-empty value must exist there.'));
        readArgs = () => ({ datasetId: dsSel.value, column: refCol.value });
        const loadCols = async (want?: string): Promise<void> => {
          refCol.textContent = '';
          let meta: any = null;
          try { meta = dsSel.value ? await window.hub.getDatasetMeta(ctx.projectId, dsSel.value) : null; } catch (_) { meta = null; }
          (meta && Array.isArray(meta.columns) ? meta.columns : []).forEach((c: any) => {
            const o = document.createElement('option');
            o.value = String(c.name);
            o.textContent = `${c.name} · ${c.type}`;
            refCol.appendChild(o);
          });
          if (want) refCol.value = want;
          schedulePreview();
        };
        dsSel.addEventListener('change', () => { void loadCols(); });
        refCol.addEventListener('change', schedulePreview);
        void (async () => {
          let list: any[] = [];
          try { list = await window.hub.listDatasets(ctx.projectId); } catch (_) { list = []; }
          (Array.isArray(list) ? list : []).forEach((d: any) => {
            const o = document.createElement('option');
            o.value = String(d.id);
            o.textContent = (d.name ? String(d.name) : 'Untitled dataset') + (d.id === ctx.datasetId ? ' (this dataset)' : '');
            dsSel.appendChild(o);
          });
          const wantDs = stored ? String(stored.datasetId || '') : (list.find((d: any) => d.id !== ctx.datasetId) || {}).id;
          if (wantDs) dsSel.value = wantDs;
          await loadCols(stored ? String(stored.column || '') : column);
        })();
      }
    }

    function paintColumns(): void {
      const cols = dqColumnsFor(kind, ctx.columns);
      colSel.textContent = '';
      cols.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.name;
        o.textContent = `${c.name} · ${c.type}`;
        colSel.appendChild(o);
      });
      if (!cols.some((c) => c.name === column)) column = cols.length ? cols[0].name : '';
      colSel.value = column;
      colField.hidden = kind === 'row_count';
    }

    function paintKind(): void {
      kinds.querySelectorAll('.dq-kind').forEach((b) => {
        const on = (b as HTMLElement).dataset.kind === kind;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      paintColumns();
      paintArgs();
      schedulePreview();
    }
    colSel.addEventListener('change', () => { column = colSel.value; paintArgs(); schedulePreview(); });

    const finish = (value: any): void => {
      if (done) return;
      done = true;
      window.clearTimeout(previewTimer);
      if (a11y) a11y.release();
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); return; }
      if (a11y) a11y.onTabKey(e);
    });
    save.addEventListener('click', async () => {
      err.hidden = true;
      save.disabled = true;
      let res: any;
      try {
        res = await window.hub.saveQualityRule(ctx.projectId, ctx.datasetId, draft());
      } catch (e: any) {
        res = { ok: false, error: (e && e.message) || 'Could not save the rule' };
      }
      save.disabled = false;
      if (!res || res.ok === false) {
        err.textContent = (res && res.error) || 'Could not save the rule.';
        err.hidden = false;
        return;
      }
      finish(res);
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintKind();
    a11y = makeModalAccessible(box, existing ? 'Edit rule' : 'Add rule', kinds.querySelector('.dq-kind.is-on') as HTMLElement | null);
  });
}
