// The Trash page, the sidebar entry's count, and the "Moved to Trash · Undo"
// toast every delete ends in. Classic global-scope renderer <script>.
//
// Every delete in the app is a MOVE (src/app/trash.ts): the record leaves every
// list, search and Home row at once and waits here for 30 days. The table is
// the standard `.ws-table`; only `.tr-*` is this page's own, and it is column
// widths, the type tile and the days-left pill.

const TR_TYPE: Record<string, { word: string; icon: string }> = {
  dataset: { word: 'Dataset', icon: 'database' },
  visual: { word: 'Visual', icon: 'chart-bar' },
  dashboard: { word: 'Dashboard', icon: 'layout-dashboard' },
  metric: { word: 'Metric', icon: 'gauge' },
  report: { word: 'Report', icon: 'file-text' },
  alert: { word: 'Alert', icon: 'bell' },
};

/** Names of the records on screen, so a "taken along with" line can name its parent. */
let trItems: any[] = [];

function trEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** The sidebar badge: how many things this project has in its Trash. */
async function trSyncCount(): Promise<void> {
  const badge = trEl('as-trash-count');
  if (!badge) return;
  let n = 0;
  if (currentProjectId) {
    try { n = (await window.hub.trashList(currentProjectId)).length; } catch (_) { n = 0; }
  }
  badge.textContent = n ? String(n) : '';
  badge.hidden = !n;
}

async function trRefresh(): Promise<void> {
  const list = trEl('tr-list');
  const table = trEl('tr-table');
  const emptyHost = trEl('tr-empty');
  const count = trEl('tr-count');
  const emptyBtn = trEl('tr-empty-btn') as HTMLButtonElement | null;
  if (!list || !table || !emptyHost) return;
  trItems = [];
  if (currentProjectId) {
    try { trItems = await window.hub.trashList(currentProjectId); } catch (_) { trItems = []; }
  }
  if (!Array.isArray(trItems)) trItems = [];
  list.textContent = '';
  for (const it of trItems) list.appendChild(trRow(it));
  table.hidden = !trItems.length;
  emptyHost.hidden = !!trItems.length;
  if (!trItems.length) {
    emptyHost.replaceChildren(makeEmptyState({
      variant: 'page',
      iconName: 'trash',
      title: 'Trash is empty',
      line: 'Anything you delete — a dataset, a visual, a dashboard, a metric, a report or an alert — waits here for 30 days, and can be put back exactly where it was.',
    }));
  }
  if (count) {
    count.textContent = trItems.length ? `${trItems.length} ${trItems.length === 1 ? 'item' : 'items'}` : '';
    count.hidden = !trItems.length;
  }
  if (emptyBtn) emptyBtn.disabled = !trItems.length;
  const badge = trEl('as-trash-count');
  if (badge) { badge.textContent = trItems.length ? String(trItems.length) : ''; badge.hidden = !trItems.length; }
}

function trRow(it: any): HTMLElement {
  const t = TR_TYPE[it.type] || { word: 'Record', icon: 'file-text' };
  const row = document.createElement('div');
  row.className = 'ws-row tr-row';
  row.dataset.type = String(it.type);
  row.dataset.id = String(it.id);

  const nameCell = document.createElement('div');
  nameCell.className = 'tr-name-cell';
  const tile = document.createElement('span');
  tile.className = 'tr-type-tile tr-type-tile--' + it.type;
  tile.appendChild(icon(t.icon));
  const text = document.createElement('div');
  text.className = 'tr-name-text';
  const name = document.createElement('span');
  name.className = 'tr-name';
  name.textContent = it.name || 'Untitled';
  text.appendChild(name);
  if (it.deletedWith) {
    const parent = trItems.find((x) => x.id === it.deletedWith);
    const sub = document.createElement('span');
    sub.className = 'tr-sub';
    sub.textContent = parent ? `Deleted with “${parent.name}”` : 'Deleted with its dataset';
    text.appendChild(sub);
  }
  nameCell.append(tile, text);

  const type = document.createElement('span');
  type.className = 'ws-cell';
  type.textContent = t.word;

  const when = document.createElement('span');
  when.className = 'ws-cell tnum';
  when.textContent = spWhen(it.deletedAt);

  const left = document.createElement('span');
  left.className = 'tr-left' + (it.daysLeft <= 3 ? ' is-soon' : '');
  left.textContent = it.daysLeft === 0 ? 'Removed today' : `${it.daysLeft} ${it.daysLeft === 1 ? 'day' : 'days'} left`;

  const actions = document.createElement('div');
  actions.className = 'tr-actions';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-sm tr-restore';
  iconLabel(restore, 'rotate-ccw', 'Restore');
  restore.addEventListener('click', () => void trRestore(it));
  const purge = document.createElement('button');
  purge.type = 'button';
  purge.className = 'btn btn-sm btn-ghost tr-purge';
  purge.textContent = 'Delete permanently';
  purge.addEventListener('click', () => void trPurge(it));
  actions.append(restore, purge);

  row.append(nameCell, type, when, left, actions);
  return row;
}

async function trRestore(it: any): Promise<void> {
  if (!currentProjectId) return;
  let res: any = null;
  try { res = await window.hub.trashRestore(currentProjectId, it.type, it.id); } catch (_) { res = null; }
  if (!res || !res.ok) { showToast((res && res.error) || 'Could not restore that', { kind: 'error' }); return; }
  showToast(trRestoredLine(res.restored || []), { kind: 'success' });
  await trRefresh();
}

/** "Restored “Revenue by month” — and its dataset “Retail orders”, which was in Trash too". */
function trRestoredLine(restored: any[]): string {
  const main = restored[0];
  if (!main) return 'Restored';
  let line = `Restored “${main.name}”`;
  const rest = restored.slice(1);
  if (main.type === 'visual' && rest.length && rest[0].type === 'dataset') {
    line += ` — and its dataset “${rest[0].name}”, which was in Trash too`;
  } else if (main.type === 'dataset' && rest.length) {
    line += ` and ${rest.length} ${rest.length === 1 ? 'visual' : 'visuals'} deleted with it`;
  }
  return line;
}

async function trPurge(it: any): Promise<void> {
  if (!currentProjectId) return;
  const t = TR_TYPE[it.type] || { word: 'record' };
  if (!window.confirm(`Delete “${it.name}” permanently?\n\nThis ${t.word.toLowerCase()} and its version history are removed for good. This cannot be undone.`)) return;
  await window.hub.trashPurge(currentProjectId, it.type, it.id);
  await trRefresh();
}

async function trEmptyAll(): Promise<void> {
  if (!currentProjectId || !trItems.length) return;
  const n = trItems.length;
  if (!window.confirm(`Empty the Trash?\n\n${n} ${n === 1 ? 'item is' : 'items are'} removed for good, with ${n === 1 ? 'its' : 'their'} version history. This cannot be undone.`)) return;
  await window.hub.trashEmpty(currentProjectId);
  await trRefresh();
  showToast('Trash emptied');
}

/**
 * The toast every delete ends in. `res` is the `*:delete` reply; Undo is a
 * restore through the Trash, the same call the page's Restore makes.
 */
function trDeletedToast(type: string, id: string, name: string, res: any, after?: () => void): void {
  if (!res || res.ok === false) { showToast('Could not delete that', { kind: 'error' }); return; }
  const n = Number(res.cascaded || 0);
  const what = name ? `“${name}”` : (TR_TYPE[type] ? 'the ' + TR_TYPE[type].word.toLowerCase() : 'it');
  const line = `Moved ${what}${n ? ` and ${n} ${n === 1 ? 'visual' : 'visuals'}` : ''} to Trash`;
  showToast(line, {
    action: {
      label: 'Undo',
      onClick: async () => {
        if (!currentProjectId) return;
        const r = await window.hub.trashRestore(currentProjectId, type, id);
        if (r && r.ok) {
          showToast(trRestoredLine(r.restored || []), { kind: 'success' });
          if (after) after();
        }
      },
    },
  });
}

function initTrash(): void {
  const btn = trEl('tr-empty-btn');
  if (btn) btn.addEventListener('click', () => void trEmptyAll());
  window.hub.onTrashChanged((o) => {
    if (!o || o.projectId !== currentProjectId) return;
    if (currentSection === 'trash') void trRefresh();
    else void trSyncCount();
  });
  void trSyncCount();
}
