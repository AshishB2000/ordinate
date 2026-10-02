// The create-dashboard gallery's "YOURS" group — the user's own templates,
// above the built-ins (r7:templates). Classic global-scope renderer <script>:
// no import/export.
//
// A user template is a card exactly like a built-in one — same `.an-wiz-tpl`
// button, same dimming when a required role cannot map on the chosen dataset,
// same mapping step after it — with two differences: its picture is the
// dashboard it was saved from, and it carries a ⋯ for rename, export and
// delete. "Import template…" sits in the group's header, and in its empty state.

/** Paint the group into `host`. `onChanged` re-reads the catalogue after a
 *  rename, delete or import. */
function utPaintYours(host: HTMLElement, templates: any[], picked: string, onPick: (id: string) => void, onChanged: () => void): void {
  host.innerHTML = '';
  const head = utMk('div', 'an-wiz-grouph ut-yours-h');
  head.append(utMk('span', '', 'Yours'),
    utMk('span', 'an-wiz-grouph-p', 'Templates you saved from your own dashboards.'));
  const imp = utMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost ut-import');
  imp.type = 'button';
  iconLabel(imp, 'upload', 'Import template…');
  imp.addEventListener('click', () => { void utImport(onChanged); });
  head.appendChild(imp);
  host.appendChild(head);

  if (!templates.length) {
    const empty = utMk('div', 'ut-yours-empty');
    const art = utMk('span', 'ut-yours-empty-art');
    art.appendChild(icon('layout-dashboard', 20));
    const words = utMk('div', 'ut-yours-empty-w');
    words.append(utMk('span', 'ut-yours-empty-t', 'No templates of your own yet'),
      utMk('span', 'ut-yours-empty-p', 'Open any dashboard and choose Save as template… from its options menu — it appears here, ready to map onto any dataset.'));
    empty.append(art, words);
    host.appendChild(empty);
    return;
  }

  const grid = utMk('div', 'an-wiz-tpls ut-yours');
  for (const tpl of templates) {
    const wrap = utMk('div', 'ut-card');
    // The card itself is the gallery's own renderer, handed one template —
    // the ⋯ sits beside it, never inside a button.
    anTplRenderGallery(wrap, [tpl], picked, onPick);
    const more = utMk<HTMLButtonElement>('button', 'ut-card-more');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    iconOnly(more, 'more-horizontal', `Options for ${String(tpl.name)}`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(more, [
        { label: 'Rename', onClick: () => { void utRename(tpl, onChanged); } },
        { label: 'Export…', onClick: () => { void utExport(tpl); } },
        { label: 'Delete', danger: true, onClick: () => { void utDelete(tpl, onChanged); } },
      ]);
    });
    wrap.appendChild(more);
    grid.appendChild(wrap);
  }
  host.appendChild(grid);
}

async function utImport(onChanged: () => void): Promise<void> {
  let res: any = null;
  try { res = await window.hubTemplates.importFile(); } catch (_) { res = null; }
  if (!res || res.canceled) return;
  if (!res.ok) { showToast(res.error || 'That file could not be imported.', { kind: 'error' }); return; }
  showToast(res.existed ? `“${String(res.name)}” is already in your templates` : `Imported “${String(res.name)}”`, { kind: 'success' });
  onChanged();
}

async function utRename(tpl: any, onChanged: () => void): Promise<void> {
  const name = await promptModal('Rename template', String(tpl.name || ''), 'Rename');
  if (name === null || !name.trim()) return;
  const res = await window.hubTemplates.rename(String(tpl.id), name.trim()).catch(() => null);
  if (!res || !res.ok) { showToast((res && res.error) || 'That template could not be renamed.', { kind: 'error' }); return; }
  onChanged();
}

async function utExport(tpl: any): Promise<void> {
  const res = await window.hubTemplates.exportFile(String(tpl.id)).catch(() => null);
  if (!res || res.canceled) return;
  if (!res.ok) { showToast(res.error || 'The template could not be exported.', { kind: 'error' }); return; }
  showToast(`Exported “${String(tpl.name)}” — share the .ordinate-template file by hand`, { kind: 'success' });
}

async function utDelete(tpl: any, onChanged: () => void): Promise<void> {
  // Templates have no Trash: say so before it goes.
  if (!window.confirm(`Delete the template “${String(tpl.name)}”? Dashboards made from it are not affected. This can't be undone.`)) return;
  await window.hubTemplates.remove(String(tpl.id)).catch(() => null);
  onChanged();
}
