// The add-control flow: the single dialog (kind tiles, dataset, column, label,
// live preview-as-default) behind both `+ Control` and a chip's Edit…, and the
// card `+ Control` pushes.
//
// Split out of dashAdd.ts — see .claude/rules/file-size.md (dashAdd.ts hit the
// 800-line cap). Classic global-scope renderer <script>: no import/export.
// Loads AFTER dashAdd.js, which is where `pushCard` (and the rest of the
// module-local state this file reads — currentProjectId, dashUuid,
// nextFreeRow, makeModalAccessible) live.

async function handleAddControl(): Promise<void> {
  if (!currentProjectId) { window.alert(t('common.open_a_project_first')); return; }
  let datasets: any[] = [];
  try {
    datasets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    datasets = [];
  }
  if (!Array.isArray(datasets)) datasets = [];
  const control = await openControlDialog(datasets);
  if (!control) return;
  // A parameter has a dialog of its own: it filters no column, so none of the
  // dataset/column/preview fields above apply to it.
  if (control.kind === 'parameter') { void addParameterControl(); return; }
  if (control.kind === 'radius') { void addRadiusControl(datasets); return; } // geoRadius.ts (r6:geo)
  // ZEROED, and ignored on read. A control is a chip in the filter bar
  // (dashControlBar.ts), not a tile, so there is no cell for it to occupy —
  // and this used to be `dashFindSlot(dashCards(), 3, 1)`, which on a full
  // sheet meant "the row below the last card", i.e. the filter appeared under
  // the notes at the very bottom. The field stays on the record because every
  // card carries one; `dashFindSlot` now skips control cards so a zeroed
  // layout cannot block the top-left cell either.
  const id = dashUuid();
  // The preview doubles as the default, and a default the author just picked
  // should be what the sheet shows NOW — not only after it is reopened.
  if (control.default) controlState.set(id, control.default);
  pushCard({ id, type: 'control', control, layout: { x: 0, y: 0, w: 0, h: 0 } });
}

// The three control kinds, named once — read here (dialog tiles) and from
// authoringProps.ts (the locked "Kind: …" line in the properties panel), so
// the label text can't drift between the two places it's shown.
const CONTROL_KINDS_UI: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'dropdown', label: t('dashAddControl.dropdown'), hint: t('dashAddControl.pick_one_value') },
  { kind: 'multi', label: 'Multi-select', hint: t('dashAddControl.pick_several_values') },
  { kind: 'date_range', label: t('dashAddControl.date_range'), hint: t('dashAddControl.relative_or_fixed_dates') },
  { kind: 'parameter', label: t('common.parameter'), hint: t('dashAddControl.a_value_you_slide_or_type') },
  { kind: 'radius', label: t('common.radius'), hint: t('dashAddControl.within_a_distance_of_a_place') }, // r6:geo
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
 *
 * `existing` turns it into the EDIT dialog behind a chip's ⋯ → Edit…: the same
 * fields, prefilled, answering with the same shape. One dialog, so an edit can
 * never offer a different vocabulary from an add.
 */
function openControlDialog(
  datasets: any[],
  existing?: any,
): Promise<{ kind: string; datasetId: string; column: string; label: string; default?: any } | null> {
  return new Promise((resolve) => {
    let done = false;
    const editing = !!(existing && existing.kind);
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-control-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = editing ? t('common.edit_control') : t('common.add_a_control');

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
    let kind = editing && existing.kind ? String(existing.kind) : 'dropdown';
    const kindRow = document.createElement('div');
    kindRow.className = 'dc-kind';
    kindRow.setAttribute('role', 'radiogroup');
    kindRow.setAttribute('aria-label', t('common.kind'));
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
        if (k.kind === 'parameter') { close({ kind: 'parameter', datasetId: '', column: '', label: '' }); return; }
        if (k.kind === 'radius') { close({ kind: 'radius', datasetId: '', column: '', label: '' }); return; } // its own dialog
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
      opt.textContent = d && d.name ? String(d.name) : t('common.untitled_dataset');
      dsSel.appendChild(opt);
    });
    if (editing && existing.datasetId) dsSel.value = String(existing.datasetId);

    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'ws-modal-input';
    labelInput.placeholder = t('common.label');
    let labelTouched = false;
    if (editing && existing.label) {
      labelInput.value = String(existing.label);
      // An author's own wording is not "untouched" — re-picking a column here
      // must not silently overwrite it with "Filter by <column>".
      labelTouched = existing.label !== 'Filter by ' + (existing.column || '');
    }
    labelInput.addEventListener('input', () => { labelTouched = true; });
    const autoLabel = (): string => t('dashAddControl.filter_by', { p0: (colSel.value || '') });
    const onChange = (): void => {
      if (!labelTouched) labelInput.value = autoLabel();
    };

    // Columns for the picked dataset — DATE-FIRST when the kind is date_range
    // (mirrors the metric dialog's numeric-first sort); dataset order otherwise,
    // since a dropdown/multi filter is as likely to want a text column as a
    // number one, so no ordering is more "right" than the source's own.
    let colsCache: any[] = [];
    // App-computed per-column stats for the picked dataset, by column name —
    // `distinct` is what picks the default column below. From dataset:stats,
    // which answers straight off the stored .parquet (no rows hydrated).
    let statsCache = new Map<string, any>();

    /**
     * The column the dialog opens on.
     *
     * A filter over 5,000 order ids is not a filter, and one over a column with
     * a single value is not either — so a dropdown/multi opens on the TEXT
     * column with the FEWEST distinct values in [2, 50], which is what a
     * categorical column looks like. Ties go to the earlier column, so a
     * dataset with several equally-small categories opens on the one its author
     * put first. Date range opens on the first date column.
     *
     * Falls back to the first option when stats are unavailable (a non-resident
     * dataset) or nothing qualifies — the old behaviour, never worse than it.
     */
    const bestColumn = (): string => {
      const cols = colsCache.filter((c) => c && c.name);
      if (kind === 'date_range') {
        const d = cols.find((c) => c.type === 'date');
        return String((d || cols[0] || {}).name || '');
      }
      let best: { name: string; distinct: number } | null = null;
      cols.forEach((c) => {
        if (c.type !== 'text') return;
        const n = statsCache.get(String(c.name));
        const distinct = n && typeof n.distinct === 'number' ? n.distinct : null;
        if (distinct === null || distinct < 2 || distinct > 50) return;
        if (!best || distinct < best.distinct) best = { name: String(c.name), distinct };
      });
      return best ? (best as { name: string }).name : String((cols[0] || {}).name || '');
    };

    const renderColumns = (): void => {
      const keep = colSel.value;
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
      // Switching kind re-orders the list; a column already chosen survives it —
      // unless the kind is now Date range and the choice is not a date while a
      // date column exists: a period over `category` keeps no rows, and every
      // card on the sheet would go blank the moment the control was added.
      const typeOf = (n: string): string => String((colsCache.find((c) => c && c.name === n) || {}).type || '');
      const hasDate = colsCache.some((c) => c && c.type === 'date');
      const keepFits = !!keep && !(kind === 'date_range' && hasDate && typeOf(keep) !== 'date');
      const want = (keepFits ? keep : '') || (editing && existing.column ? String(existing.column) : '') || bestColumn();
      if ([...colSel.options].some((o) => o.value === want)) colSel.value = want;
      ok.disabled = colSel.options.length === 0;
    };
    const loadColumns = async (): Promise<void> => {
      const dsId = dsSel.value;
      // In PARALLEL: the stats read is the one that decides the default column,
      // and serialising it behind the metadata read would double the wait
      // before the dialog is usable.
      const [meta, stats] = await Promise.all([
        (async () => {
          try {
            return currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, dsId) : null;
          } catch (_) { return null; }
        })(),
        (async () => {
          try {
            return currentProjectId ? await window.hub.datasetStats(currentProjectId, dsId) : null;
          } catch (_) { return null; }
        })(),
      ]);
      if (done || dsSel.value !== dsId) return; // a newer dataset pick won
      colsCache = meta && Array.isArray(meta.columns) ? meta.columns : [];
      statsCache = new Map<string, any>(
        stats && stats.ok && Array.isArray(stats.summaries)
          ? stats.summaries.map((su: any) => [String(su.name), su])
          : [],
      );
      colSel.value = ''; // renderColumns picks: the edited column, else bestColumn()
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
    // The control's PUBLISHED default, when this dialog is editing one and the
    // preview still points at the column it was set against. Re-pointing the
    // control at a different column drops it rather than carrying a value that
    // may not exist in the new column.
    const seedDefault = (): any => (
      editing && existing.default && kind === existing.kind
        && dsSel.value === String(existing.datasetId) && colSel.value === String(existing.column)
        ? existing.default : null
    );

    function buildPreview(): void {
      previewWrap.innerHTML = '';
      previewValue = {};
      if (!dsSel.value || !colSel.value) return;
      const seed = seedDefault();
      if (seed) previewValue = seed;
      if (kind === 'multi') {
        const list = document.createElement('div');
        list.className = 'fd-list dc-preview-list';
        list.textContent = t('common.loading');
        previewWrap.appendChild(list);
        const selected = new Set<string>(
          seed && Array.isArray(seed.values) ? seed.values.map((v: any) => String(v)) : [],
        );
        void loadPreviewOptions((values) => {
          list.innerHTML = '';
          if (!values.length) {
            const p = document.createElement('p');
            p.className = 'fd-empty';
            p.textContent = t('dashAddControl.this_column_has_no_values');
            list.appendChild(p);
          }
          values.forEach((v) => {
            const row = document.createElement('label');
            row.className = 'fd-opt';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = v;
            cb.checked = selected.has(v);
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
        // The same picker the filter bar opens — what is picked here is the
        // control's default, relative or fixed.
        previewValue = seed && (ppIsRelative(seed) || seed.from || seed.to) ? { ...seed } : {};
        previewWrap.appendChild(buildPeriodPanel({
          value: previewValue.preset || previewValue.from || previewValue.to ? previewValue : null,
          onChange: (v) => { previewValue = v || {}; },
        }));
      } else {
        const sel = document.createElement('select');
        sel.className = 'dash-ctrl-select';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = t('common.all');
        sel.appendChild(all);
        if (seed && seed.value) {
          const o0 = document.createElement('option');
          o0.value = String(seed.value);
          o0.textContent = String(seed.value);
          sel.appendChild(o0);
          sel.value = String(seed.value);
        }
        sel.addEventListener('change', () => { previewValue = sel.value ? { value: sel.value } : {}; });
        previewWrap.appendChild(sel);
        void loadPreviewOptions((values) => {
          const keep = sel.value;
          values.forEach((v) => {
            if (v === keep) return; // already there as the placeholder
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
          });
          sel.value = keep;
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
    cancel.textContent = t('common.cancel');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = editing ? t('common.save') : t('common.add');
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
          ? !!(ppIsRelative(previewValue) || previewValue.from || previewValue.to)
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
      empty.textContent = t('dashAddControl.import_a_dataset_first_a_control');
      box.appendChild(empty);
    } else {
      box.appendChild(field(t('common.kind'), kindRow));
      box.appendChild(field(t('common.dataset'), dsSel));
      box.appendChild(field(t('common.column'), colSel));
      box.appendChild(field(t('common.label'), labelInput));
      box.appendChild(field(t('dashAddControl.preview_also_sets_the_default_if'), previewWrap));
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, editing ? t('common.edit_control') : t('common.add_a_control'), datasets.length ? dsSel : cancel);
    paintKind();
    if (datasets.length) void loadColumns();
  });
}
