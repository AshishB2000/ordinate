// Format → Sort: by value, by label, or a custom order you drag — the section
// formatPanel.ts renders. The order itself is applied in buildChart
// (chartRender.ts), which reads the RAW labels, so a month axis sorts as
// 2023-01 < 2023-04; the stored `sortOrder` is those raw labels too.
//
// Classic global-scope renderer <script>: no import/export.

/**
 * The chart types Sort reorders. Not waterfall or pareto — a waterfall's order
 * is its story, a Pareto sorts itself — and not a gauge (scripts/test-chartSort.ts
 * pins why). buildChart's `canSort` is the rule; this only hides the control.
 */
const sortableType = ['column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'pie', 'donut', 'bullet'];

/** The labels in the order a custom sort draws them: the stored order, then the rest as they came. */
function fmtCustomOrder(labels: any[], order: any): string[] {
  const all = labels.map((l) => String(l));
  const stored = (Array.isArray(order) ? order : []).map(String).filter((l: string) => all.indexOf(l) >= 0);
  return stored.concat(all.filter((l) => stored.indexOf(l) < 0));
}

function fmtOrderList(body: HTMLElement, ctx: FmtPanelCtx): void {
  const labels = (ctx.data && Array.isArray(ctx.data.labels)) ? ctx.data.labels : [];
  const order = fmtCustomOrder(labels, ctx.ov().sortOrder);
  const commit = (next: string[]) => ctx.patch({ sort: 'custom', sortOrder: next });
  const list = document.createElement('ol');
  list.className = 'fmt-order';
  list.setAttribute('aria-label', 'Custom order — drag, or Alt+Up/Down on a focused row');
  let dragFrom = -1;
  order.forEach((label, i) => {
    const li = fmtKeyed(document.createElement('li'), 'order:' + label);
    li.className = 'fmt-order-row';
    li.draggable = true;
    li.tabIndex = 0;
    const grip = document.createElement('span');
    grip.className = 'fmt-grip';
    grip.setAttribute('aria-hidden', 'true');
    setIcon(grip, 'grip-vertical');
    const name = document.createElement('span');
    name.className = 'fmt-order-name';
    name.textContent = label === '' ? '(empty)' : label;
    name.title = name.textContent;
    li.append(grip, name);
    const move = (to: number) => {
      if (to < 0 || to >= order.length || to === i) return;
      const next = order.slice();
      next.splice(to, 0, next.splice(i, 1)[0]);
      commit(next);
    };
    li.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      move(i + (e.key === 'ArrowUp' ? -1 : 1));
    });
    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', label); }
    });
    li.addEventListener('dragend', () => { dragFrom = -1; li.classList.remove('is-dragging'); });
    li.addEventListener('dragover', (e) => { if (dragFrom >= 0) { e.preventDefault(); li.classList.add('is-over'); } });
    li.addEventListener('dragleave', () => li.classList.remove('is-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('is-over');
      if (dragFrom < 0 || dragFrom === i) return;
      const next = order.slice();
      next.splice(i, 0, next.splice(dragFrom, 1)[0]);
      commit(next);
    });
    list.appendChild(li);
  });
  body.appendChild(list);
}

function fmtSortSection(host: HTMLElement, ctx: FmtPanelCtx): void {
  if (sortableType.indexOf(ctx.type) < 0) return;
  const ov = ctx.ov();
  const body = fmtSection(host, 'Sort');
  const labels = (ctx.data && Array.isArray(ctx.data.labels)) ? ctx.data.labels : [];
  fmtField(body, 'Order', fmtSelect('sort', [
    ['none', 'As the data comes'], ['desc', 'Value: high → low'], ['asc', 'Value: low → high'],
    ['label_asc', 'Label: A → Z'], ['label_desc', 'Label: Z → A'], ['custom', 'Custom order'],
  ], ov.sort || 'none', (v) => {
    if (v === 'custom') ctx.patch({ sort: 'custom', sortOrder: fmtCustomOrder(labels, ov.sortOrder) });
    else ctx.patch({ sort: v === 'none' ? null : v });
  }));
  if (ov.sort !== 'custom') return;
  if (!labels.length) { fmtNote(body, 'Reading the categories…'); return; }
  fmtNote(body, 'Drag to reorder. Categories not in the list follow in their own order.');
  fmtOrderList(body, ctx);
}
