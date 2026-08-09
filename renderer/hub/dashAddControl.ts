// The add-control flow: `+ Control`'s single dialog (kind tiles, dataset,
// column, label, live preview-as-default) and the card it pushes.
//
// Split out of dashAdd.ts — see .claude/rules/file-size.md (dashAdd.ts hit the
// 800-line cap). Classic global-scope renderer <script>: no import/export.
// Loads AFTER dashAdd.js, which is where `pushCard` (and the rest of the
// module-local state this file reads — currentProjectId, dashUuid,
// nextFreeRow, makeModalAccessible) live.

async function handleAddControl(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  let datasets: any[] = [];
  try {
    datasets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    datasets = [];
  }
  if (!Array.isArray(datasets)) datasets = [];
  const control = await openControlDialog(datasets);
  if (!control) return;
  // A filter widget is short and wide — proportionate to, but shorter than, a
  // metric card's 3×2 (h:2 would waste half the card on empty space below a
  // one-line dropdown/date-range control).
  pushCard({ id: dashUuid(), type: 'control', control, layout: { x: 0, y: nextFreeRow(), w: 3, h: 1 } });
}

// The three control kinds, named once — read here (dialog tiles) and from
// authoringProps.ts (the locked "Kind: …" line in the properties panel), so
// the label text can't drift between the two places it's shown.
const CONTROL_KINDS_UI: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'dropdown', label: 'Dropdown', hint: 'Pick one value' },
  { kind: 'multi', label: 'Multi-select', hint: 'Pick several values' },
  { kind: 'date_range', label: 'Date range', hint: 'From / to' },
];
const CONTROL_KIND_LABELS: Record<string, string> = Object.fromEntries(
  CONTROL_KINDS_UI.map((k) => [k.kind, k.label]),
);

/**
 * ONE dialog for the whole control — kind (three tiles), dataset, column,
 * label, optional default — the same single-dialog shape as `openMetricDialog`.
 *
 * There is no separate "default value" field: the live preview IS one. It is a
 * fully working instance of the widget (options loaded via the SAME
 * `window.hub.datasetDistinct` a placed control uses) that writes to a
 * throwaway local variable, never `controlState` — there is no card yet to
 * filter, so nothing done here can leak into a live filter. Whatever is left
 * selected when "Add" is pressed becomes `default`; an untouched preview
 * means no default, same as today's unset control.
 */
function openControlDialog(
  datasets: any[],
): Promise<{ kind: string; datasetId: string; column: string; label: string; default?: any } | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-control-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'Add a control';

    const field = (labelText: string, control: HTMLElement): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'dm-field';
      const span = document.createElement('span');
      span.className = 'dm-field-label';
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(control);
      return row;
    };

    // ── Kind: three tiles, same segmented-row shape as the metric dialog's
    // aggregation row (role=radiogroup, aria-checked, .is-on) — all three
    // visible at once rather than a select, per the brief.
    let kind = 'dropdown';
    const kindRow = document.createElement('div');
    kindRow.className = 'dc-kind';
    kindRow.setAttribute('role', 'radiogroup');
    kindRow.setAttribute('aria-label', 'Kind');
    const paintKind = (): void => {
      kindRow.querySelectorAll('.dc-kind-tile').forEach((b) => {
        const on = (b as HTMLElement).dataset.kind === kind;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    CONTROL_KINDS_UI.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dc-kind-tile';
      b.dataset.kind = k.kind;
      b.setAttribute('role', 'radio');
      const t = document.createElement('span');
      t.className = 'dc-kind-tile-label';
      t.textContent = k.label;
      const s = document.createElement('span');
      s.className = 'dc-kind-tile-hint';
      s.textContent = k.hint;
      b.appendChild(t);
      b.appendChild(s);
      b.addEventListener('click', () => {
        if (kind === k.kind) return;
        kind = k.kind;
        paintKind();
        renderColumns(); // column order depends on kind (date-first for date_range)
        onChange();
        buildPreview();
      });
      kindRow.appendChild(b);
    });

    const dsSel = document.createElement('select');
    dsSel.className = 'ws-modal-input';
    datasets.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      dsSel.appendChild(opt);
    });

    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'ws-modal-input';
    labelInput.placeholder = 'Label';
    let labelTouched = false;
    labelInput.addEventListener('input', () => { labelTouched = true; });
    const autoLabel = (): string => 'Filter by ' + (colSel.value || '');
    const onChange = (): void => {
      if (!labelTouched) labelInput.value = autoLabel();
    };

    // Columns for the picked dataset — DATE-FIRST when the kind is date_range
    // (mirrors the metric dialog's numeric-first sort); dataset order otherwise,
    // since a dropdown/multi filter is as likely to want a text column as a
    // number one, so no ordering is more "right" than the source's own.
    let colsCache: any[] = [];
    const renderColumns = (): void => {
      colSel.innerHTML = '';
      const mapped = colsCache.map((c, i) => ({ c, i }));
      const ordered = kind === 'date_range'
        ? mapped.sort((a, b) => Number(b.c && b.c.type === 'date') - Number(a.c && a.c.type === 'date') || a.i - b.i)
        : mapped;
      ordered.forEach(({ c }) => {
        const opt = document.createElement('option');
        opt.value = String(c.name);
        opt.textContent = String(c.name) + (c.type ? ' (' + c.type + ')' : '');
        colSel.appendChild(opt);
      });
      ok.disabled = colSel.options.length === 0;
    };
    const loadColumns = async (): Promise<void> => {
      let meta: any = null;
      try {
        meta = currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, dsSel.value) : null;
      } catch (_) {
        meta = null;
      }
      if (done) return;
      colsCache = meta && Array.isArray(meta.columns) ? meta.columns : [];
      renderColumns();
      onChange();
      buildPreview();
    };

    // ── Preview / default ────────────────────────────────────────────────────
    const previewWrap = document.createElement('div');
    previewWrap.className = 'dc-preview';
    let previewValue: any = {};
    let previewSeq = 0;
    async function loadPreviewOptions(apply: (values: string[]) => void): Promise<void> {
      const seq = ++previewSeq;
      const dsId = dsSel.value;
      const column = colSel.value;
      if (!dsId || !column || !currentProjectId) return;
      let res: any = null;
      try {
        res = await window.hub.datasetDistinct(currentProjectId, dsId, column, 200);
      } catch (_) {
        res = null;
      }
      if (done || seq !== previewSeq) return;
      apply(res && Array.isArray(res.values) ? res.values : []);
    }
    function buildPreview(): void {
      previewWrap.innerHTML = '';
      previewValue = {};
      if (!dsSel.value || !colSel.value) return;
      if (kind === 'multi') {
        const list = document.createElement('div');
        list.className = 'fd-list dc-preview-list';
        list.textContent = 'Loading…';
        previewWrap.appendChild(list);
        const selected = new Set<string>();
        void loadPreviewOptions((values) => {
          list.innerHTML = '';
          if (!values.length) {
            const p = document.createElement('p');
            p.className = 'fd-empty';
            p.textContent = 'This column has no values.';
            list.appendChild(p);
          }
          values.forEach((v) => {
            const row = document.createElement('label');
            row.className = 'fd-opt';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = v;
            cb.addEventListener('change', () => {
              if (cb.checked) selected.add(v); else selected.delete(v);
              previewValue = { values: [...selected] };
            });
            const span = document.createElement('span');
            span.className = 'fd-opt-label';
            span.textContent = v;
            row.appendChild(cb);
            row.appendChild(span);
            list.appendChild(row);
          });
        });
      } else if (kind === 'date_range') {
        const row = document.createElement('div');
        row.className = 'dash-ctrl-daterange';
        const from = document.createElement('input');
        from.type = 'date';
        from.className = 'dash-ctrl-date';
        const sep = document.createElement('span');
        sep.className = 'dash-ctrl-date-sep';
        sep.textContent = '–';
        const to = document.createElement('input');
        to.type = 'date';
        to.className = 'dash-ctrl-date';
        const commit = (): void => {
          const next: any = {};
          if (from.value) next.from = from.value;
          if (to.value) next.to = to.value;
          previewValue = next;
        };
        from.addEventListener('change', commit);
        to.addEventListener('change', commit);
        row.appendChild(from);
        row.appendChild(sep);
        row.appendChild(to);
        previewWrap.appendChild(row);
      } else {
        const sel = document.createElement('select');
        sel.className = 'dash-ctrl-select';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All';
        sel.appendChild(all);
        sel.addEventListener('change', () => { previewValue = sel.value ? { value: sel.value } : {}; });
        previewWrap.appendChild(sel);
        void loadPreviewOptions((values) => {
          values.forEach((v) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
          });
        });
      }
    }

    dsSel.addEventListener('change', () => { void loadColumns(); });
    colSel.addEventListener('change', () => { onChange(); buildPreview(); });
    labelInput.addEventListener('input', onChange);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'Add';
    ok.disabled = datasets.length === 0;

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: { kind: string; datasetId: string; column: string; label: string; default?: any } | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function submit(): void {
      if (ok.disabled || !dsSel.value || !colSel.value) return;
      const out: { kind: string; datasetId: string; column: string; label: string; default?: any } = {
        kind, datasetId: dsSel.value, column: colSel.value,
        label: labelInput.value.trim() || autoLabel(),
      };
      const hasDefault = kind === 'multi'
        ? Array.isArray(previewValue.values) && previewValue.values.length > 0
        : kind === 'date_range'
          ? !!(previewValue.from || previewValue.to)
          : !!previewValue.value;
      if (hasDefault) out.default = previewValue;
      close(out);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    if (datasets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'dash-modal-empty';
      empty.textContent = 'Import a dataset first — a control filters one.';
      box.appendChild(empty);
    } else {
      box.appendChild(field('Kind', kindRow));
      box.appendChild(field('Dataset', dsSel));
      box.appendChild(field('Column', colSel));
      box.appendChild(field('Label', labelInput));
      box.appendChild(field('Preview (also sets the default, if left selected)', previewWrap));
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Add a control', datasets.length ? dsSel : cancel);
    paintKind();
    if (datasets.length) void loadColumns();
  });
}
