// The editor's top strip (legacy dashboards.ts .dash-editor-head, moved above
// the workbench by authoring.ts anMountTopStrip): Back, the name (the rename
// control), the save state, the sheet tabs, the add row, undo / redo, the
// layout size, and ⋯ — History and Publish.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, IconButton, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Menu } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { LineageDrawer } from '../../data/LineageDrawer';
import { useAddImage, useAddKind, useAddNav } from './AddDialogs';
import { useEditor } from './context';
import { nextSheetName, uuid } from './doc';
import { SizeSwitch } from './SizeNote';
import s from './Editor.module.css';

function NameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(initial);
  const save = () => {
    if (v.trim()) onSave(v.trim());
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input label="Name" value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={200} />
      </form>
    </Dialog>
  );
}

function SaveChip() {
  const { save } = useEditor();
  if (save.state === 'error') {
    return (
      <button type="button" className={`${s.saveChip} ${s.saveError}`} onClick={save.retry}>
        <Icon name="alert" size={12} /> Not saved — retry
      </button>
    );
  }
  return (
    <span className={s.saveChip} role="status">
      {save.state === 'saving' ? 'Saving…' : (
        <>
          <Icon name="check" size={12} /> Saved
        </>
      )}
    </span>
  );
}

function SheetTabs() {
  const ed = useEditor();
  const [renaming, setRenaming] = useState<number | null>(null);
  const sheets = ed.doc.sheets;
  const removeSheet = (i: number) => {
    ed.edit('Remove sheet', (d) => void d.sheets.splice(i, 1));
    ed.setSheet(Math.max(0, i - 1));
    toast(`Removed “${sheets[i].name}”`, { action: { label: 'Undo', onClick: ed.undo } });
  };
  return (
    <div className={s.sheets} role="tablist" aria-label="Sheets">
      {sheets.map((sh, i) => (
        <span key={sh.id} className={i === ed.sheet ? `${s.sheetTab} ${s.sheetOn}` : s.sheetTab}>
          <button
            type="button"
            role="tab"
            aria-selected={i === ed.sheet}
            className={s.sheetBtn}
            onClick={() => ed.setSheet(i)}
            onDoubleClick={() => setRenaming(i)}
          >
            {sh.name}
          </button>
          {i === ed.sheet && (
            <Menu
              label={`${sh.name} sheet actions`}
              trigger={<IconButton icon="chevron-down" size="sm" label={`${sh.name} sheet actions`} />}
              items={[
                { label: 'Rename sheet', icon: 'pencil', onSelect: () => setRenaming(i) },
                { label: 'Remove sheet', icon: 'trash', danger: true, disabled: sheets.length < 2, onSelect: () => removeSheet(i) },
              ]}
            />
          )}
        </span>
      ))}
      <IconButton
        icon="plus"
        size="sm"
        label="Add sheet"
        onClick={() => {
          const id = uuid();
          const n = sheets.length;
          ed.edit('Add sheet', (d) => void d.sheets.push({ id, name: nextSheetName(d), cards: [] }));
          ed.setSheet(n);
        }}
      />
      {renaming !== null && sheets[renaming] && (
        <NameDialog
          title="Rename sheet"
          initial={sheets[renaming].name}
          onClose={() => setRenaming(null)}
          onSave={(v) => {
            const i = renaming;
            ed.edit('Rename sheet', (d) => void (d.sheets[i].name = v));
          }}
        />
      )}
    </div>
  );
}

export function Head() {
  const ed = useEditor();
  const navigate = useNavigate();
  const addKind = useAddKind();
  const addImage = useAddImage();
  const addNav = useAddNav();
  const [renaming, setRenaming] = useState(false);
  const [lineage, setLineage] = useState(false);
  const { past, future } = ed.history;
  const back = `/analyses?project=${ed.projectId}`;
  // Publishing lives with the dashboard viewer (T2.9): write what is on screen now, then go there.
  const publish = () => {
    ed.save.retry();
    void navigate(`/dashboards?project=${ed.projectId}&dashboard=${ed.analysisId}`);
  };
  return (
    <header className={s.head}>
      <div className={s.headRow}>
        <Link className={buttonClass('ghost', 'sm')} to={back}>
          <Icon name="chevron-left" />
          <span>Analyses</span>
        </Link>
        <h1 className={s.nameH}>
          <button type="button" className={s.name} title="Click to rename" onClick={() => setRenaming(true)}>
            {ed.doc.name}
          </button>
        </h1>
        <SaveChip />
        <span className={s.grow} />
        <IconButton icon="undo" size="sm" label={past.length ? `Undo ${past[past.length - 1].label}` : 'Nothing to undo'} disabled={!past.length} onClick={ed.undo} />
        <IconButton icon="redo" size="sm" label={future.length ? `Redo ${future[0].label}` : 'Nothing to redo'} disabled={!future.length} onClick={ed.redo} />
        <SizeSwitch />
        <Menu
          label="More dashboard actions"
          align="end"
          trigger={<IconButton icon="more-horizontal" size="sm" label="More dashboard actions" />}
          items={[
            { label: 'History', icon: 'history', onSelect: () => void navigate(`/versions/${ed.projectId}/dashboard/${ed.analysisId}`) },
            { label: 'Lineage', icon: 'lineage', onSelect: () => setLineage(true) },
            { label: 'Publish…', icon: 'external-link', onSelect: publish },
          ]}
        />
      </div>
      <div className={s.headRow}>
        <SheetTabs />
        <span className={s.grow} />
        <div className={s.adds} role="group" aria-label="Add to the sheet">
          <Button size="sm" icon="plus" onClick={() => ed.openAdd('visual')}>
            Visual
          </Button>
          <Button size="sm" icon="plus" onClick={() => ed.openAdd('kpi')}>
            KPI
          </Button>
          <Button size="sm" icon="plus" onClick={() => ed.openAdd('text')}>
            Text
          </Button>
          <Menu
            label="Add a control"
            trigger={
              <Button size="sm" icon="filter" iconEnd="chevron-down">
                Control
              </Button>
            }
            items={[
              { label: 'Filter control…', icon: 'filter', onSelect: () => ed.openAdd('control') },
              { label: 'Parameter…', icon: 'sliders', onSelect: () => ed.openAdd('param') },
            ]}
          />
          <Menu
            label="Add more"
            trigger={
              <Button size="sm" iconEnd="chevron-down">
                More
              </Button>
            }
            items={[
              { label: 'Image…', icon: 'camera', onSelect: addImage },
              { label: 'Navigation', icon: 'arrow-right', onSelect: () => void addNav() },
              { label: 'Divider', icon: 'minus', onSelect: () => addKind('divider') },
              { label: 'Container', icon: 'layout-dashboard', onSelect: () => addKind('container') },
              { label: 'Tabs', icon: 'columns', onSelect: () => addKind('tabs') },
            ]}
          />
        </div>
      </div>
      {lineage && <LineageDrawer projectId={ed.projectId} type="dashboard" id={ed.analysisId} name={ed.doc.name} onClose={() => setLineage(false)} />}
      {renaming && <NameDialog title="Rename dashboard" initial={ed.doc.name} onClose={() => setRenaming(false)} onSave={(v) => ed.edit('Rename dashboard', (d) => void (d.name = v))} />}
    </header>
  );
}
