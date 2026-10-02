// The dataset page's LINEAGE line: what this dataset was built from, and which
// SQL datasets are built on it — plus "View query" for a SQL dataset.
//
// Classic global-scope renderer <script>: no import/export. Called from
// dsExplorer.ts's renderExplorerIdent. Everything comes from the same
// `listDatasets` summaries the Data list paints (`originDeps`, `originKind`),
// so the page and the list cannot disagree about where data came from.
//
//   Reads from  [Retail orders] [Regions]          a query's inputs, or the
//                                                  datasets a combine joined
//   Used by     [Revenue by region]                SQL datasets over this one
//
// A chip opens that dataset. An input that has since been deleted is still
// named — as a disabled chip — because "built from something that is gone" is
// exactly what a refresh failure on this page will be about.

let dlSeq = 0;

function dlChip(label: string, id: string | null, kind: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ds-lineage-chip';
  chip.appendChild(icon(kind === 'sql' ? 'code' : kind === 'notebook' ? 'file-text' : 'database', 16));
  const text = document.createElement('span');
  text.textContent = label;
  chip.appendChild(text);
  if (id) {
    chip.title = t('dsLineage.open', { label });
    chip.addEventListener('click', () => { void openSavedDataset(id); });
  } else {
    chip.disabled = true;
    chip.title = t('dsLineage.this_dataset_has_been_deleted');
  }
  return chip;
}

function dlGroup(label: string, chips: HTMLElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'ds-lineage-group';
  const head = document.createElement('span');
  head.className = 'ds-lineage-label';
  head.textContent = label;
  group.appendChild(head);
  for (const c of chips) group.appendChild(c);
  return group;
}

/** `d` is the open dataset's metadata (dataset:meta) — its full `origin` included. */
async function dsRenderLineage(d: any): Promise<void> {
  const host = document.getElementById('ds-lineage');
  if (!host) return;
  const seq = ++dlSeq;
  host.innerHTML = '';
  host.hidden = true;
  const id = String((d && d.id) || '');
  if (!id || !currentProjectId) return;

  let list: any[] = [];
  try {
    const res = await window.hub.listDatasets(currentProjectId);
    list = Array.isArray(res) ? res : [];
  } catch (_) {
    list = [];
  }
  if (seq !== dlSeq) return; // another dataset opened meanwhile

  const byId = new Map<string, any>(list.map((x) => [String(x.id), x]));
  const me = byId.get(id);
  const upIds: string[] = me && Array.isArray(me.originDeps) ? me.originDeps : [];
  const down = list.filter((x) => x && (x.originKind === 'sql' || x.originKind === 'notebook') && Array.isArray(x.originDeps) && x.originDeps.includes(id));

  if (upIds.length) {
    host.appendChild(dlGroup(t('dsLineage.reads_from'), upIds.map((u) => {
      const s = byId.get(u);
      return s ? dlChip(String(s.name), u, String(s.sourceKind || '')) : dlChip(t('dsLineage.deleted_dataset'), null, '');
    })));
  }
  if (down.length) {
    host.appendChild(dlGroup(t('common.used_by'), down.map((x) => dlChip(String(x.name), String(x.id), String(x.originKind)))));
  }

  const origin = d && d.origin;
  if (origin && origin.kind === 'sql' && typeof origin.sql === 'string') {
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn btn-sm btn-ghost ds-lineage-query';
    view.appendChild(icon('code', 16));
    const text = document.createElement('span');
    text.textContent = t('dsLineage.view_query');
    view.appendChild(text);
    view.title = origin.sql.length > 400 ? origin.sql.slice(0, 400) + '…' : origin.sql;
    view.addEventListener('click', () => qtOpenWithSql(origin.sql, origin.params));
    host.appendChild(view);
  }
  // r7:notebooks — a notebook cell's result names its notebook and opens it there.
  if (origin && origin.kind === 'notebook' && typeof origin.notebookId === 'string') {
    const from = document.createElement('button');
    from.type = 'button';
    from.className = 'btn btn-sm btn-ghost ds-lineage-query ds-lineage-notebook';
    from.appendChild(icon('file-text', 16));
    const text = document.createElement('span');
    text.textContent = t('dsLineage.open_notebook');
    from.appendChild(text);
    from.title = t('dsLineage.saved_from_a_notebook_cell_it');
    from.addEventListener('click', () => { void nbOpenById(origin.notebookId, origin.cellId); });
    host.appendChild(from);
  }
  host.hidden = host.childNodes.length === 0;
}
