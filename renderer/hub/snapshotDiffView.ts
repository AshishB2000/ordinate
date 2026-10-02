'use strict';

// Compare a snapshot with now — the panel under the Snapshots tab's list.
// Classic global-scope renderer <script>: no import/export. Loads after
// snapshots.js (snapEl / snapWhen / snapRows).
//
// Every count and every cell here is main's (src/engine/snapshotDiff.ts, which
// DuckDB computes off the two Parquet files): this file lays them out and
// formats nothing but the numbers' thousands separators.

let snapDiffSeq = 0;

function snapCell(v: string | null): HTMLElement {
  return v === null ? snapEl('span', 'snap-null', '(empty)') : snapEl('span', 'snap-val', v);
}

function snapChip(kind: string, n: number, word: string): HTMLElement {
  const c = snapEl('span', `snap-chip snap-chip-${kind}`);
  c.appendChild(snapEl('b', '', Number(n).toLocaleString('en-US')));
  c.appendChild(document.createTextNode(' ' + word));
  return c;
}

function snapMore(shown: number, total: number): HTMLElement | null {
  return total > shown ? snapEl('p', 'snap-more', t('snapshotDiffView.showing_the_first_of', { p0: shown.toLocaleString('en-US'), p1: total.toLocaleString('en-US') })) : null;
}

/** Added or removed rows: the compared columns, in the current table's order. */
function snapRowsTable(columns: string[], rows: any[]): HTMLElement {
  const wrap = snapEl('div', 'snap-scroll');
  const t = snapEl<HTMLTableElement>('table', 'snap-grid');
  const h = t.createTHead().insertRow();
  for (const c of columns) h.appendChild(snapEl('th', '', c));
  const b = t.createTBody();
  for (const r of rows) {
    const tr = b.insertRow();
    for (const v of r.values) tr.insertCell().appendChild(snapCell(v));
  }
  wrap.appendChild(t);
  return wrap;
}

/** Changed rows: one line per changed cell, the key once per row. */
function snapChangedTable(diff: any): HTMLElement {
  const wrap = snapEl('div', 'snap-scroll');
  const tv = snapEl<HTMLTableElement>('table', 'snap-grid snap-changed');
  const h = tv.createTHead().insertRow();
  for (const c of [diff.key || t('common.row'), t('common.column'), t('common.before'), t('common.after')]) h.appendChild(snapEl('th', '', c));
  const b = tv.createTBody();
  for (const r of diff.changed) {
    r.cells.forEach((cell: any, i: number) => {
      const tr = b.insertRow();
      tr.className = 'snap-change';
      if (i === 0) {
        const k = tr.insertCell();
        k.rowSpan = r.cells.length;
        k.className = 'snap-key';
        k.appendChild(snapCell(r.key));
      }
      tr.insertCell().textContent = cell.column;
      const before = tr.insertCell();
      before.className = 'snap-before';
      before.appendChild(snapCell(cell.old));
      const after = tr.insertCell();
      after.className = 'snap-after';
      after.appendChild(snapCell(cell.new));
    });
  }
  wrap.appendChild(tv);
  return wrap;
}

function snapSection(title: string, n: number, body: HTMLElement, shown: number): HTMLElement {
  const sec = snapEl('section', 'snap-sec');
  sec.appendChild(snapEl('h6', 'snap-sec-h', `${title} · ${Number(n).toLocaleString('en-US')}`));
  sec.appendChild(body);
  const more = snapMore(shown, n);
  if (more) sec.appendChild(more);
  return sec;
}

function snapPaintDiff(out: HTMLElement, diff: any): void {
  out.innerHTML = '';
  const sum = snapEl('div', 'snap-sum');
  sum.append(
    snapChip('added', diff.counts.added, 'added'),
    snapChip('removed', diff.counts.removed, 'removed'),
  );
  if (diff.mode === 'key') sum.appendChild(snapChip('changed', diff.counts.changed, 'changed'));
  sum.appendChild(snapChip('same', diff.counts.unchanged, 'unchanged'));
  out.appendChild(sum);

  const notes: string[] = [];
  if (diff.mode === 'row') notes.push(t('snapshotDiffView.matched_on_the_whole_row_a'));
  if (diff.duplicates.old || diff.duplicates.new) {
    notes.push(t('snapshotDiffView.row_s_repeat_an_earlier_then', { p0: (diff.duplicates.old + diff.duplicates.new).toLocaleString('en-US'), key: diff.key, old: diff.duplicates.old, new: diff.duplicates.new }));
  }
  if (diff.addedColumns.length) notes.push(t('snapshotDiffView.new_columns_not_compared', { p0: diff.addedColumns.join(', ') }));
  if (diff.removedColumns.length) notes.push(t('snapshotDiffView.columns_since_removed_not_compared', { p0: diff.removedColumns.join(', ') }));
  for (const n of notes) out.appendChild(snapEl('p', 'snap-note', n));

  const total = diff.counts.added + diff.counts.removed + diff.counts.changed;
  if (total === 0) {
    out.appendChild(snapEl('p', 'snap-same', t('snapshotDiffView.no_differences_the_compared_columns_hold')));
    return;
  }
  if (diff.counts.changed) out.appendChild(snapSection(t('snapshotDiffView.changed'), diff.counts.changed, snapChangedTable(diff), diff.changed.length));
  if (diff.counts.added) out.appendChild(snapSection(t('snapshotDiffView.added_since'), diff.counts.added, snapRowsTable(diff.columns, diff.added), diff.added.length));
  if (diff.counts.removed) out.appendChild(snapSection(t('snapshotDiffView.removed_since'), diff.counts.removed, snapRowsTable(diff.columns, diff.removed), diff.removed.length));
}

/** Open (or re-point) the compare panel at one snapshot. */
async function snapOpenDiff(datasetId: string, s: any, current: any): Promise<void> {
  const host = document.getElementById('snap-diff');
  if (!host) return;
  host.innerHTML = '';
  document.querySelectorAll('#snap-body .snap-row.is-open').forEach((r) => r.classList.remove('is-open'));
  document.querySelector(`#snap-body .snap-row[data-stamp="${CSS.escape(s.stamp)}"]`)?.classList.add('is-open');

  const head = snapEl('div', 'snap-diff-head');
  head.appendChild(snapEl('h5', 'snap-diff-h', t('snapshotDiffView.compared_with_now', { at: snapWhen(s.at) })));
  const label = snapEl<HTMLLabelElement>('label', 'snap-diff-key', t('snapshotDiffView.match_rows_by'));
  const sel = snapEl<HTMLSelectElement>('select', 'snap-keep-select');
  sel.id = 'snap-diff-key';
  const whole = snapEl<HTMLOptionElement>('option', '', t('snapshotDiffView.the_whole_row'));
  whole.value = '';
  sel.appendChild(whole);
  const shared = (current.columns as string[]).filter((c) => (s.columns as string[]).includes(c));
  for (const c of shared) {
    const o = snapEl<HTMLOptionElement>('option', '', c);
    o.value = c;
    sel.appendChild(o);
  }
  label.appendChild(sel);
  const close = snapEl<HTMLButtonElement>('button', 'btn btn-sm btn-ghost snap-diff-close');
  close.type = 'button';
  close.setAttribute('aria-label', t('snapshotDiffView.close_the_comparison'));
  close.appendChild(icon('x', 14));
  close.addEventListener('click', () => {
    host.innerHTML = '';
    document.querySelectorAll('#snap-body .snap-row.is-open').forEach((r) => r.classList.remove('is-open'));
  });
  head.append(label, close);
  host.appendChild(head);
  const out = snapEl('div', 'snap-diff-out');
  out.id = 'snap-diff-out';
  host.appendChild(out);

  const run = async (): Promise<void> => {
    const seq = ++snapDiffSeq;
    out.innerHTML = '';
    out.appendChild(snapEl('p', 'snap-loading', t('snapshotDiffView.comparing')));
    let r: any = null;
    try { r = await window.hubSnapshots.diff(currentProjectId, datasetId, s.stamp, sel.value || null); } catch (_) { r = null; }
    if (seq !== snapDiffSeq || !out.isConnected) return;
    if (!r || r.ok === false) {
      out.innerHTML = '';
      out.appendChild(snapEl('p', 'snap-error', (r && r.error) || t('snapshotDiffView.could_not_compare_the_snapshot')));
      return;
    }
    snapPaintDiff(out, r.diff);
  };
  sel.addEventListener('change', () => void run());
  host.scrollIntoView({ block: 'nearest' });
  await run();
}
