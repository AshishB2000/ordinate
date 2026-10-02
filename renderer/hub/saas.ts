// The folder-watch toggle in the connection workbench's right rail.
//
// Classic global-scope renderer <script>: no import/export. connDetails.ts
// calls saasWatchRow() for a folder connection's `watch` field, in place of the
// read-only Yes/No every other field gets — it is the one setting that can
// change without re-testing the connection, because it changes nothing about
// what is read, only when. Main re-syncs the watcher off the saved record
// (src/ipc/saas.ts), so this file only flips the flag.
//
// The six SaaS sources need nothing here: their forms, tree and import are the
// generic connector UI.

/** A `<dt>`/`<dd>` pair for the rail's details list, holding a live checkbox. */
function saasWatchRow(field: { key: string; label: string }): DocumentFragment {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = field.label;
  const dd = document.createElement('dd');
  const label = document.createElement('label');
  label.className = 'saas-watch';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'conn-wb-watch';
  box.checked = !!(cwConn && cwConn.values && cwConn.values.watch === true);
  const state = document.createElement('span');
  const paint = (): void => {
    state.textContent = box.checked ? t('saas.on_file_changes_refresh_its_datasets') : t('common.off');
  };
  paint();
  box.addEventListener('change', () => { void saasSetWatch(box, paint); });
  label.append(box, state);
  dd.appendChild(label);
  frag.append(dt, dd);
  return frag;
}

async function saasSetWatch(box: HTMLInputElement, paint: () => void): Promise<void> {
  if (!cwConn || !window.hubSaas) return;
  const want = box.checked;
  box.disabled = true;
  let res: any;
  try {
    res = await window.hubSaas.setFolderWatch(currentProjectId, String(cwConn.id), want);
  } catch (_) {
    res = { ok: false, error: t('saas.could_not_change_the_folder_watch') };
  }
  box.disabled = false;
  if (!res || res.ok === false) {
    box.checked = !want;
    showToast((res && res.error) || t('saas.could_not_change_the_folder_watch'));
  } else if (cwConn && res.connection) {
    cwConn.values = res.connection.values;
  }
  paint();
}
