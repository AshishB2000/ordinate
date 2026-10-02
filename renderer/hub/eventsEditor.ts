'use strict';

// The event editor — one `.ws-modal` for an event's title, kind, dates and
// scope. Classic global-scope renderer <script>: no import/export.
//
// Fields are the metric editor's `meField`; the kind is a row of the catalog's
// `.home-pill`s; dates are native `<input type="date">`. Main sanitizes and
// stores (events:save) — a refused save is shown in the dialog with the work
// kept, as the input-table dialog does.

/** Open the editor for `existing`, or for a new event when null. Resolves when it closes. */
function evEdit(existing: any): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    const draft: any = existing ? JSON.parse(JSON.stringify(existing)) : { kind: 'launch' };
    const title = existing ? t('eventsEditor.edit_event') : t('common.new_event');

    const overlay = evMk('div', 'ws-modal-overlay');
    const box = evMk('div', 'ws-modal ev-modal');
    box.appendChild(evMk('div', 'ws-modal-title', title));
    box.appendChild(evMk('p', 'ev-modal-sub', t('eventsEditor.charts_with_a_date_axis_mark')));

    const name = evMk<HTMLInputElement>('input', 'ws-modal-input ev-in-title');
    name.type = 'text';
    name.maxLength = 200;
    name.placeholder = t('eventsEditor.e_g_holiday_campaign');
    name.value = draft.title || '';
    box.appendChild(meField(t('common.title'), name));

    const kinds = evMk('div', 'ev-kind-pick');
    kinds.setAttribute('role', 'radiogroup');
    kinds.setAttribute('aria-label', t('common.kind'));
    const paintKinds = (): void => {
      kinds.textContent = '';
      EV_KINDS.forEach(([k, label]) => {
        const b = evMk<HTMLButtonElement>('button', 'home-pill ev-kind-opt' + (draft.kind === k ? ' is-active' : ''));
        b.type = 'button';
        b.dataset.kind = k;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(draft.kind === k));
        b.append(evKindMark(k), evMk('span', '', label));
        b.addEventListener('click', () => { draft.kind = k; paintKinds(); });
        kinds.appendChild(b);
      });
    };
    paintKinds();
    box.appendChild(meField(t('common.kind'), kinds));

    const dates = evMk('div', 'ev-dates');
    const start = evMk<HTMLInputElement>('input', 'ws-modal-input ev-in-date');
    start.type = 'date';
    start.value = draft.date || '';
    const end = evMk<HTMLInputElement>('input', 'ws-modal-input ev-in-end');
    end.type = 'date';
    end.value = draft.end || '';
    dates.append(meField(t('eventsEditor.starts'), start), meField(t('eventsEditor.ends'), end, t('eventsEditor.leave_empty_for_a_single_day')));
    box.appendChild(dates);

    const ds = evMk<HTMLSelectElement>('select', 'ws-modal-input ev-in-dataset');
    ds.appendChild(new Option(t('eventsEditor.every_dataset'), ''));
    evState.datasets.forEach((d) => ds.appendChild(new Option(String(d.name), String(d.id))));
    const scope = draft.scope || {};
    ds.value = Array.isArray(scope.datasetIds) && scope.datasetIds[0] ? scope.datasetIds[0] : '';
    box.appendChild(meField(t('common.applies_to'), ds));

    const where = evMk('div', 'ev-where');
    const col = evMk<HTMLSelectElement>('select', 'ws-modal-input ev-in-col');
    const val = evMk<HTMLInputElement>('input', 'ws-modal-input ev-in-val');
    val.type = 'text';
    val.placeholder = t('eventsEditor.value_e_g_west');
    const f0 = Array.isArray(scope.filters) && scope.filters[0] ? scope.filters[0] : null;
    val.value = f0 ? (f0.values || []).join(', ') : '';
    where.append(col, val);
    const whereField = meField(t('eventsEditor.only_where'), where, t('eventsEditor.optional_a_chart_filtered_to_a'));
    box.appendChild(whereField);
    const loadColumns = async (): Promise<void> => {
      col.textContent = '';
      col.appendChild(new Option(t('eventsEditor.any_column'), ''));
      let meta: any = null;
      try { meta = ds.value && currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, ds.value) : null; } catch (_) { meta = null; }
      const cols: any[] = meta && Array.isArray(meta.columns) ? meta.columns : [];
      cols.filter((c) => c && c.type === 'text').forEach((c) => col.appendChild(new Option(String(c.name), String(c.name))));
      if (f0 && !cols.some((c) => c && c.name === f0.column)) col.appendChild(new Option(String(f0.column), String(f0.column)));
      col.value = f0 ? String(f0.column) : '';
      whereField.hidden = !ds.value && !f0;
    };
    ds.addEventListener('change', () => { void loadColumns(); });

    const err = evMk('p', 'it-modal-err');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    box.appendChild(err);

    const actions = evMk('div', 'ws-modal-actions');
    const cancel = evMk<HTMLButtonElement>('button', 'btn btn-ghost', t('common.cancel'));
    cancel.type = 'button';
    const save = evMk<HTMLButtonElement>('button', 'btn btn-primary ev-save', existing ? t('eventsEditor.save_event') : t('eventsEditor.add_event'));
    save.type = 'button';
    actions.append(cancel, save);
    box.appendChild(actions);

    const finish = (): void => {
      if (done) return;
      done = true;
      if (a11y) a11y.release();
      overlay.remove();
      resolve();
    };
    cancel.addEventListener('click', finish);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(); });
    box.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(); return; }
      if (a11y) a11y.onTabKey(e);
    });
    save.addEventListener('click', async () => {
      err.hidden = true;
      if (!currentProjectId) return;
      const values = val.value.split(',').map((s) => s.trim()).filter(Boolean);
      const ev: any = { id: existing ? existing.id : undefined, title: name.value.trim(), kind: draft.kind, date: start.value, end: end.value || null };
      const sc: any = {};
      if (ds.value) sc.datasetIds = [ds.value];
      if (col.value && values.length) sc.filters = [{ type: 'filter', column: col.value, op: 'in', values }];
      if (sc.datasetIds || sc.filters) ev.scope = sc;
      if (!ev.title || !ev.date) { err.textContent = t('eventsEditor.an_event_needs_a_title_and'); err.hidden = false; return; }
      save.disabled = true;
      let res: any = null;
      try { res = await window.hubEvents.save(currentProjectId, ev); } catch (e: any) { res = { ok: false, error: (e && e.message) || t('common.could_not_save') }; }
      save.disabled = false;
      if (!res || !res.ok) { err.textContent = (res && res.error) || t('eventsEditor.could_not_save_the_event'); err.hidden = false; return; }
      evFlash(existing ? t('eventsEditor.saved', { title: res.event.title }) : t('eventsEditor.added_every_date_axis_it_falls', { title: res.event.title }));
      finish();
      await evRefresh();
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    void loadColumns();
    a11y = makeModalAccessible(box, title, name);
  });
}
