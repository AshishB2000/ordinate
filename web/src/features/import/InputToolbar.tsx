// An input table's toolbar and status line (legacy inputPage.ts itPaintBar):
// + Row, Delete rows, Undo / Redo (named after the step), Edit columns — and
// on the right what the save is doing, and how many cells the server flagged
// (a click goes to the next one).

import { formatNumber } from '../../../../src/app/format.ts';
import * as edits from '../../../../src/data/inputTable/edits.ts';
import { Button, IconButton } from '../../ui/Button';
import type { GridRange } from '../../ui/DataGrid/DataGrid';
import { Toolbar, ToolbarDivider, ToolbarSpacer } from '../../ui/Toolbar';
import { Icon } from '../../ui/icons/Icon';
import type { Model } from './InputTablePage';
import s from './Import.module.css';

interface Props {
  m: Model;
  sel: GridRange;
  onAddRow: () => void;
  onDeleteRows: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onEditColumns: () => void;
  onRetry: () => void;
  onNextIssue: () => void;
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

export function InputToolbar({ m, sel, onAddRow, onDeleteRows, onUndo, onRedo, onEditColumns, onRetry, onNextIssue }: Props) {
  const labels = edits.histLabels(m.hist);
  const a = Math.min(sel.r0, sel.r1);
  const b = Math.min(Math.max(sel.r0, sel.r1), m.rows.length - 1);
  const n = b - a + 1;
  const { failCells, warnCells } = m.view.check;
  const flagged = failCells + warnCells;

  let status;
  if (m.error) {
    status = (
      <span className={`${s.status} ${s.statusError}`} role="status">
        <Icon name="alert" size={12} />
        Not saved: {m.error}
        <button type="button" className={s.linkBtn} onClick={onRetry}>
          Try again
        </button>
      </span>
    );
  } else if (m.saving || m.pending.length) {
    status = (
      <span className={s.status} role="status">
        Saving…
      </span>
    );
  } else {
    status = (
      <span className={`${s.status} ${s.statusOk}`} role="status">
        <Icon name="check" size={12} />
        Saved · {formatNumber(m.rows.length)} row{m.rows.length === 1 ? '' : 's'}
      </span>
    );
  }

  return (
    <Toolbar label="Table actions" className={s.inputBar}>
      <Button size="sm" icon="plus" onClick={onAddRow} disabled={m.rows.length >= m.view.cap} title="Add a row at the end">
        Row
      </Button>
      <Button size="sm" variant="ghost" icon="trash" onClick={onDeleteRows} disabled={b < a}>
        {n > 1 ? `Delete ${formatNumber(n)} rows` : 'Delete row'}
      </Button>
      <ToolbarDivider />
      <IconButton size="sm" icon="undo" label={labels.undo ? `Undo ${lower(labels.undo)}` : 'Nothing to undo'} onClick={onUndo} disabled={!labels.undo} />
      <IconButton size="sm" icon="redo" label={labels.redo ? `Redo ${lower(labels.redo)}` : 'Nothing to redo'} onClick={onRedo} disabled={!labels.redo} />
      <ToolbarDivider />
      <Button size="sm" variant="ghost" icon="columns" onClick={onEditColumns}>
        Edit columns
      </Button>
      <ToolbarSpacer />
      {status}
      {flagged > 0 && (
        <button type="button" className={failCells ? s.attn : `${s.attn} ${s.attnWarn}`} onClick={onNextIssue} title="Go to the next one">
          <Icon name="alert" size={12} />
          {formatNumber(flagged)} cell{flagged === 1 ? '' : 's'} need{flagged === 1 ? 's' : ''} attention
        </button>
      )}
    </Toolbar>
  );
}
