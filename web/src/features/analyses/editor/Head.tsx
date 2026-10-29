// The editor's top strip (legacy dashboards.ts .dash-editor-head, moved above
// the workbench by authoring.ts anMountTopStrip): Back, the name (the rename
// control), the save state, the sheet tabs, the add row, undo / redo, the
// layout size, and ⋯ — History, Lineage, Style, export and print. Ready is the
// one switch that puts a dashboard in front of readers; there is no Publish here.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHead } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { LineageDrawer } from '../../data/LineageDrawer';
import { useAddImage, useAddKind, useAddNav } from './AddDialogs';
import { useEditor } from './context';
import { nextSheetName, uuid } from './doc';
import { NameDialog } from './NameDialog';
import { SizeSwitch } from './SizeNote';
import s from './Editor.module.css';
import { StyleDialog, SubscribeButton, ViewControls, exportHtml } from '../../dashboards/DashboardChrome';
import { addSummary } from '../../dashboards/SummaryBody';
import { ViewsMenu } from '../../dashboards/views/ViewsMenu';
import { ReadySwitch } from '../../dashboards/ReadySwitch';

function SaveChip() {
  const { save } = useEditor();
  // The conflict banner says why and offers the way on; a retry would be refused the same way.
  if (save.state === 'paused') {
    return (
      <span className={`${s.saveChip} ${s.saveError}`} role="status">
        <Icon name="alert" size={12} /> Not saved
      </span>
    );
  }
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
            onDoubleClick={() => !ed.readOnly && setRenaming(i)}
          >
            {sh.name}
          </button>
          {i === ed.sheet && !ed.readOnly && (
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
      {!ed.readOnly && (
        <IconButton
          icon="plus"
          size="sm"
          label="Add sheet"
          onClick={() => {
            const id = uuid();
            const n = sheets.length;
            // A new sheet has click-to-filter ON, written explicitly (an absent switch means "as before": off).
            ed.edit('Add sheet', (d) => void d.sheets.push({ id, name: nextSheetName(d), cards: [], clickFilter: true }));
            ed.setSheet(n);
          }}
        />
      )}
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
  const [styling, setStyling] = useState(false);
  const { past, future } = ed.history;
  const ro = ed.readOnly;
  // The view page (ed.viewing) has its own header, dashboards/ViewHead.
  const back = { to: `/analyses?project=${ed.projectId}`, label: 'Analyses' };
  return (
    <div className={s.head}>
      <PageHead
        back={back}
        title={
          ro ? (
            <span className={s.name}>{ed.doc.name}</span>
          ) : (
            <button type="button" className={s.name} title="Click to rename" onClick={() => setRenaming(true)}>
              {ed.doc.name}
            </button>
          )
        }
        status={
          ro ? (
            <span title="You can read this dashboard, use its filters and comment. A project admin can make you an editor.">
              <Badge icon="eye">View only</Badge>
            </span>
          ) : (
            <SaveChip />
          )
        }
        actions={
          <>
            {!ro && (
              <>
                <ReadySwitch />
                <IconButton icon="undo" size="sm" label={past.length ? `Undo ${past[past.length - 1].label}` : 'Nothing to undo'} disabled={!past.length} onClick={ed.undo} />
                <IconButton icon="redo" size="sm" label={future.length ? `Redo ${future[0].label}` : 'Nothing to redo'} disabled={!future.length} onClick={ed.redo} />
              </>
            )}
            <ViewsMenu />
            <ViewControls />
            <SizeSwitch />
            <IconButton icon="message-square" size="sm" label="Comments on this dashboard" onClick={() => ed.view.openComments('all')} />
            <SubscribeButton />
            <Button size="sm" icon="monitor" onClick={() => ed.view.setPresenting(true)}>
              Present
            </Button>
            <Menu
              label="More dashboard actions"
              align="end"
              trigger={<IconButton icon="more-horizontal" size="sm" label="More dashboard actions" />}
              items={[
                { label: 'History', icon: 'history', onSelect: () => void navigate(`/versions/${ed.projectId}/dashboard/${ed.analysisId}`) },
                { label: 'Lineage', icon: 'lineage', onSelect: () => setLineage(true) },
                ...(ro ? [] : [{ label: 'Style…', icon: 'sliders' as const, onSelect: () => setStyling(true) }]),
                { label: 'Export HTML', icon: 'download', onSelect: () => void exportHtml(ed) },
                { label: 'Print or save as PDF', icon: 'file-text', onSelect: () => window.print() },
              ]}
            />
          </>
        }
      />
      {/* A reader with one sheet gets no tabs row, like PhoneHead and /p/<id>/. */}
      {(!ro || ed.doc.sheets.length > 1) && (
        <div className={s.headRow}>
          <SheetTabs />
          <span className={s.grow} />
          {!ro && (
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
                  { label: 'Summary', icon: 'sparkles', onSelect: () => addSummary(ed) },
                  { label: 'Metric tree…', icon: 'lineage', onSelect: () => ed.openAdd('tree') },
                ]}
              />
            </div>
          )}
        </div>
      )}
      {styling && <StyleDialog onClose={() => setStyling(false)} />}
      {lineage && <LineageDrawer projectId={ed.projectId} type="dashboard" id={ed.analysisId} name={ed.doc.name} onClose={() => setLineage(false)} />}
      {renaming && <NameDialog title="Rename dashboard" initial={ed.doc.name} onClose={() => setRenaming(false)} onSave={(v) => ed.edit('Rename dashboard', (d) => void (d.name = v))} />}
    </div>
  );
}
