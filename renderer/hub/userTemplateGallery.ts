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
    utMk('span', 'an-wiz-grouph-p', t('userTemplateGallery.templates_you_saved_from_your_own')));
  const imp = utMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost ut-import');
  imp.type = 'button';
  iconLabel(imp, 'upload', t('userTemplateGallery.import_template'));
  imp.addEventListener('click', () => { void utImport(onChanged); });
  head.appendChild(imp);
  host.appendChild(head);

  if (!templates.length) {
    const empty = utMk('div', 'ut-yours-empty');
    const art = utMk('span', 'ut-yours-empty-art');
    art.appendChild(icon('layout-dashboard', 20));
    const words = utMk('div', 'ut-yours-empty-w');
    words.append(utMk('span', 'ut-yours-empty-t', t('userTemplateGallery.no_templates_of_your_own_yet')),
      utMk('span', 'ut-yours-empty-p', t('userTemplateGallery.open_any_dashboard_and_choose_save')));
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
    iconOnly(more, 'more-horizontal', t('userTemplateGallery.options_for', { name: String(tpl.name) }));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(more, [
        { label: t('common.rename'), onClick: () => { void utRename(tpl, onChanged); } },
        { label: t('common.export'), onClick: () => { void utExport(tpl); } },
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
  if (!res.ok) { showToast(res.error || t('userTemplateGallery.that_file_could_not_be_imported'), { kind: 'error' }); return; }
  showToast(res.existed ? t('userTemplateGallery.is_already_in_your_templates', { name: String(res.name) }) : t('userTemplateGallery.imported', { name: String(res.name) }), { kind: 'success' });
  onChanged();
}

async function utRename(tpl: any, onChanged: () => void): Promise<void> {
  const name = await promptModal(t('userTemplateGallery.rename_template'), String(tpl.name || ''), t('common.rename'));
  if (name === null || !name.trim()) return;
  const res = await window.hubTemplates.rename(String(tpl.id), name.trim()).catch(() => null);
  if (!res || !res.ok) { showToast((res && res.error) || t('userTemplateGallery.that_template_could_not_be_renamed'), { kind: 'error' }); return; }
  onChanged();
}

async function utExport(tpl: any): Promise<void> {
  const res = await window.hubTemplates.exportFile(String(tpl.id)).catch(() => null);
  if (!res || res.canceled) return;
  if (!res.ok) { showToast(res.error || t('userTemplateGallery.the_template_could_not_be_exported'), { kind: 'error' }); return; }
  showToast(t('userTemplateGallery.exported_share_the_ordinate_template', { name: String(tpl.name) }), { kind: 'success' });
}

async function utDelete(tpl: any, onChanged: () => void): Promise<void> {
  // Templates have no Trash: say so before it goes.
  if (!window.confirm(t('userTemplateGallery.delete_the_template_dashboards_made_from', { name: String(tpl.name) }))) return;
  await window.hubTemplates.remove(String(tpl.id)).catch(() => null);
  onChanged();
}
