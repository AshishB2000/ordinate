// The Views menu in a dashboard's header (docs/dashboard-filters/00-design.md):
// "As authored" and every saved view as a radio list, the default marked; for
// an editor, Save as a new view and — on the view on screen — Update, Rename,
// Set / Stop default and Delete; for everyone, Copy link. Views are SHARED (they
// live on the dashboard and reach /p/, embeds, subscriptions and reports), so a
// viewer lists, applies and links them and nothing else: the write items are
// not drawn for them, and the menu is not drawn at all while there is no view.
// `boxed`: the view page's filter box (FilterBar) — "Saved view" over the view on screen, picked and linked only,
// as that page writes nothing; saving and editing views stays in the editor.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { useEditor } from '../../analyses/editor/context';
import { NameDialog } from '../../analyses/editor/NameDialog';
import { useSavedViews } from './useSavedViews';
import { AUTHORED, MAX_VIEW_NAME, viewHref, viewOptions } from './viewState';
import s from './Views.module.css';

async function copyLink(href: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(href);
    toast('Link copied', { kind: 'success' });
  } catch {
    toast('The clipboard is not available here.', { kind: 'error' });
  }
}

export function ViewsMenu({ boxed = false }: { boxed?: boolean }) {
  const ed = useEditor();
  const v = useSavedViews();
  const [naming, setNaming] = useState<'create' | 'rename' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const writer = ed.writer && !boxed;
  if (!writer && v.list.length === 0) return null;
  const cur = v.list.find((x) => x.id === v.applied) ?? null;

  const onView: MenuEntry[] = cur
    ? [
        { label: `Update “${cur.name}”`, icon: 'refresh', onSelect: () => void v.run({ op: 'update', viewId: cur.id }) },
        { label: 'Rename…', icon: 'pencil', onSelect: () => setNaming('rename') },
        cur.id === v.defaultId
          ? { label: 'Stop being the default', icon: 'star', onSelect: () => void v.run({ op: 'default', viewId: '' }) }
          : { label: 'Set as default', icon: 'star-filled', onSelect: () => void v.run({ op: 'default', viewId: cur.id }) },
        { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setDeleting(true) },
      ]
    : [];
  const items: MenuEntry[] = [
    { kind: 'heading', label: 'Views' },
    { kind: 'radio', label: 'Saved views', value: cur?.id ?? AUTHORED, options: viewOptions(v.list, v.defaultId), onChange: (id) => v.apply(id === AUTHORED ? '' : id) },
    { kind: 'separator' },
    ...(writer ? [{ label: 'Save as a new view…', icon: 'plus' as const, onSelect: () => setNaming('create') }, ...onView, { kind: 'separator' as const }] : []),
    { label: 'Copy link', icon: 'link', onSelect: () => void copyLink(viewHref(window.location.origin, ed.projectId, ed.analysisId, cur?.id ?? '')) },
  ];

  if (boxed) {
    const name = cur ? cur.name : 'As authored';
    return (
      <div className={s.field}>
        <span className={s.label} aria-hidden="true">
          Saved view
        </span>
        <Menu
          label="Views"
          align="end"
          items={items}
          trigger={
            <Button size="sm" iconEnd="chevron-down" className={s.picker} aria-label={`Saved view: ${name}`}>
              <span className={s.name}>{name}</span>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <>
      <Menu
        label="Views"
        align="end"
        items={items}
        trigger={
          <Button size="sm" icon="layers" iconEnd="chevron-down" aria-label={cur ? `Views: ${cur.name}` : 'Views'}>
            <span className={s.name}>{cur ? cur.name : 'Views'}</span>
          </Button>
        }
      />
      {naming && (
        <NameDialog
          title={naming === 'create' ? 'Save as a new view' : 'Rename view'}
          initial={naming === 'rename' && cur ? cur.name : ''}
          maxLength={MAX_VIEW_NAME}
          saveLabel={naming === 'create' ? 'Save view' : 'Save'}
          onClose={() => setNaming(null)}
          onSave={(name) => void v.run(naming === 'create' || !cur ? { op: 'create', name } : { op: 'rename', viewId: cur.id, name })}
        />
      )}
      {deleting && cur && (
        <Dialog
          open
          onOpenChange={(o) => !o && setDeleting(false)}
          size="sm"
          title={`Delete “${cur.name}”?`}
          description="Subscriptions and reports that use this view fall back to the dashboard as saved. What is on screen now stays."
          footer={
            <>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                onClick={() => {
                  setDeleting(false);
                  void v.run({ op: 'delete', viewId: cur.id });
                }}
              >
                Delete view
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
