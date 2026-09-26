'use strict';

// The New relationship dialog. Classic global-scope renderer <script>.
//
// Pick the MANY side (rows that look something up) and the ONE side (the
// lookup); main ranks every column pair by name similarity, type agreement and
// a sampled match rate (analysis/keySuggest.ts), and the best pair arrives
// preselected with the cardinality its data supports. Saving counts matches
// over the full tables — the numbers the Relationships list shows.

async function relColumns(id: string): Promise<any[]> {
  if (!currentProjectId || !id) return [];
  if (!relMetas.has(id)) relMetas.set(id, await window.hub.getDatasetMeta(currentProjectId, id));
  const meta = relMetas.get(id);
  return meta && Array.isArray(meta.columns) ? meta.columns : [];
}

function relSelect2(label: string, hint: string): { wrap: HTMLElement; sel: HTMLSelectElement } {
  const sel = document.createElement('select');
  sel.className = 'ws-modal-input';
  return { wrap: meField(label, sel, hint), sel };
}

function relFillSelect(sel: HTMLSelectElement, items: Array<{ value: string; label: string }>, value: string): void {
  sel.innerHTML = '';
  items.forEach((it) => {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  });
  if (items.some((i) => i.value === value)) sel.value = value;
}

async function openRelationshipDialog(): Promise<void> {
  if (!currentProjectId) return;
  if (!relDatasets.length) await refreshRelationships();
  if (relDatasets.length < 2) {
    showToast('Import a second dataset first — a relationship joins two.', { kind: 'info' });
    return;
  }
  const pid = currentProjectId;
  relMetas = new Map();

  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal rel-modal';
  const title = document.createElement('div');
  title.className = 'ws-modal-title';
  title.textContent = 'New relationship';
  const intro = document.createElement('p');
  intro.className = 'rel-modal-intro';
  intro.textContent = 'Each row of the many side finds its one row on the other side where the key columns agree. Visuals built on the many side can then use both.';

  const sides = document.createElement('div');
  sides.className = 'rel-modal-sides';
  const fromDs = relSelect2('Many side', 'The rows that look something up — orders, events.');
  const toDs = relSelect2('One side', 'The lookup — targets, regions, products.');
  const fromCol = relSelect2('Key column', '');
  const toCol = relSelect2('Matches column', '');
  const left = document.createElement('div');
  left.className = 'rel-modal-side';
  left.append(fromDs.wrap, fromCol.wrap);
  const arrow = document.createElement('span');
  arrow.className = 'rel-modal-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.appendChild(icon('arrow-right', 18));
  const right = document.createElement('div');
  right.className = 'rel-modal-side';
  right.append(toDs.wrap, toCol.wrap);
  sides.append(left, arrow, right);

  const sugHead = document.createElement('div');
  sugHead.className = 'rel-sug-head';
  sugHead.id = 'rel-sug-head';
  sugHead.textContent = 'Suggested keys';
  const sug = document.createElement('div');
  sug.className = 'rel-sug';
  sug.setAttribute('role', 'radiogroup');
  sug.setAttribute('aria-labelledby', 'rel-sug-head');

  const card = relSelect2('Kind', '');
  relFillSelect(card.sel, [
    { value: 'many_to_one', label: 'Many to one — many rows share one lookup row' },
    { value: 'one_to_one', label: 'One to one — each row has exactly one partner' },
  ], 'many_to_one');
  const cardHint = card.wrap.querySelector('.me-field-hint') as HTMLElement | null;
  const note = document.createElement('p');
  note.className = 'rel-modal-note';
  note.setAttribute('role', 'status');

  const err = document.createElement('p');
  err.className = 'me-error rel-modal-error';
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary';
  save.textContent = 'Save relationship';
  actions.append(cancel, save);

  box.append(title, intro, sides, sugHead, sug, card.wrap, note, err, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const a11y = makeModalAccessible(box, 'New relationship', fromDs.sel);

  const finish = (): void => {
    a11y.release();
    overlay.remove();
  };
  cancel.addEventListener('click', finish);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(); return; }
    a11y.onTabKey(e);
  });

  const dsItems = relDatasets.map((d) => ({ value: d.id, label: d.name }));
  relFillSelect(fromDs.sel, dsItems, dsItems[0].value);
  relFillSelect(toDs.sel, dsItems, dsItems[1].value);

  let candidates: any[] = [];
  let seq = 0;

  const paintSuggestions = (): void => {
    sug.innerHTML = '';
    if (!candidates.length) {
      const none = document.createElement('p');
      none.className = 'rel-sug-none';
      none.textContent = 'No column pair looks related. Choose the key columns yourself above.';
      sug.appendChild(none);
      return;
    }
    candidates.slice(0, 5).forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rel-sug-item';
      b.setAttribute('role', 'radio');
      const on = fromCol.sel.value === c.from && toCol.sel.value === c.to;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on || (i === 0 && !candidates.some((x) => fromCol.sel.value === x.from && toCol.sel.value === x.to)) ? 0 : -1;
      const pair = document.createElement('span');
      pair.className = 'rel-sug-pair';
      pair.textContent = `${c.from} → ${c.to}`;
      const rate = document.createElement('span');
      rate.className = 'rel-sug-rate';
      rate.textContent = c.rate === null ? 'not measured' : `${relPct(c.rate)} match`;
      const meter = document.createElement('span');
      meter.className = 'rel-sug-meter';
      meter.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.style.width = Math.round((c.rate || 0) * 100) + '%';
      meter.appendChild(fill);
      const why = document.createElement('span');
      why.className = 'rel-sug-why';
      why.textContent = [c.name === 1 ? 'same name' : c.name >= 0.6 ? 'similar names' : '', c.typeMatch ? 'same type' : 'different types']
        .filter(Boolean).join(' · ');
      b.append(pair, meter, rate, why);
      b.addEventListener('click', () => {
        fromCol.sel.value = c.from;
        toCol.sel.value = c.to;
        paintSuggestions();
      });
      b.addEventListener('keydown', (e) => {
        const items = [...sug.querySelectorAll('.rel-sug-item')] as HTMLElement[];
        const k = items.indexOf(b);
        const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? k + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? k - 1 : -2;
        if (next === -2) return;
        e.preventDefault();
        const t = items[(next + items.length) % items.length];
        t.click();
        (sug.querySelectorAll('.rel-sug-item')[(next + items.length) % items.length] as HTMLElement).focus();
      });
      sug.appendChild(b);
    });
  };

  const loadSides = async (): Promise<void> => {
    const my = ++seq;
    err.hidden = true;
    note.textContent = '';
    const [fc, tc] = await Promise.all([relColumns(fromDs.sel.value), relColumns(toDs.sel.value)]);
    if (my !== seq) return;
    relFillSelect(fromCol.sel, fc.map((c: any) => ({ value: c.name, label: c.name })), fromCol.sel.value);
    relFillSelect(toCol.sel, tc.map((c: any) => ({ value: c.name, label: c.name })), toCol.sel.value);
    if (fromDs.sel.value === toDs.sel.value) {
      candidates = [];
      sug.innerHTML = '';
      note.textContent = 'Pick two different datasets.';
      return;
    }
    sug.innerHTML = '';
    const busy = document.createElement('p');
    busy.className = 'rel-sug-none';
    busy.textContent = 'Checking which columns match…';
    sug.appendChild(busy);
    const res = await window.hubAuthoring.suggestRelationshipKeys(pid, fromDs.sel.value, toDs.sel.value);
    if (my !== seq) return;
    // A pair is worth offering when its values actually meet, or its names
    // clearly agree (a key whose sample happened to miss). 0% strangers are noise.
    candidates = (res && res.ok ? res.candidates : []).filter((c: any) => (c.rate || 0) > 0 || c.name >= 0.6);
    const best = res && res.ok ? res.best : null;
    if (best) {
      fromCol.sel.value = best.from;
      toCol.sel.value = best.to;
      if (best.cardinality) card.sel.value = best.cardinality;
      if (best.stats && best.stats.toKeys !== best.stats.toKeyed) {
        note.textContent = `${relName(toDs.sel.value)}.${best.to} repeats some values — each lookup uses the first row with that value.`;
      }
    }
    if (cardHint) cardHint.textContent = best && best.cardinality ? 'Chosen from the data.' : '';
    paintSuggestions();
  };
  fromDs.sel.addEventListener('change', () => void loadSides());
  toDs.sel.addEventListener('change', () => void loadSides());
  [fromCol.sel, toCol.sel].forEach((s) => s.addEventListener('change', () => paintSuggestions()));

  save.addEventListener('click', async () => {
    save.disabled = true;
    err.hidden = true;
    const res = await window.hubAuthoring.saveRelationship(pid, {
      from: { datasetId: fromDs.sel.value, column: fromCol.sel.value },
      to: { datasetId: toDs.sel.value, column: toCol.sel.value },
      cardinality: card.sel.value,
    });
    save.disabled = false;
    if (!res || !res.ok) {
      err.textContent = (res && res.error) || 'Could not save the relationship.';
      err.hidden = false;
      return;
    }
    finish();
    encRelatedInvalidate();
    const r = res.relationship;
    relSelectedId = r.id;
    showToast(`Related ${relName(r.from.datasetId)} → ${relName(r.to.datasetId)} on ${r.from.column} (${relPct(relRate(r))} matched)`, { kind: 'success' });
    await refreshRelationships();
  });

  await loadSides();
}
