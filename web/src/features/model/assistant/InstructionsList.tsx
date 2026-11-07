// The project's Assistant instructions (semantic D1): short rules every ask, narration and dashboard draft reads,
// fenced as the editors' words. Editors add, edit (inline, Enter saves, Escape cancels) and remove one at a time,
// a remove behind the house confirm (no Trash brings one back); a refusal is the server's sentence at the field, with
// the text kept. A figure-like token is flagged, never refused.

import { useId, useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { day } from '../../data/format';
import { useChangeInstruction, useInstructions, type Instruction, type InstructionOp } from './api';
import a from './Assistant.module.css';

const MAX = 300;
const EXAMPLE = '“Revenue means net_amount unless they say gross”';

/** One line of text being written: Enter saves, Escape cancels; the server's refusal stays at the field with the text. */
function Editor({ label, initial, save, onDone }: { label: string; initial: string; save: (text: string) => Promise<string | null>; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const refused = await save(text);
    setBusy(false);
    if (refused) setError(refused);
    else onDone();
  };
  return (
    <div className={a.editor}>
      <div className={a.editorField}>
        <Input
          aria-label={label}
          autoFocus
          maxLength={MAX}
          value={text}
          placeholder="e.g. Revenue means net_amount unless they say gross."
          error={error}
          hint={`One rule, on one line. Enter saves, Esc cancels · ${text.length}/${MAX}`}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
        />
      </div>
      <div className={a.editorActions}>
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon="check" loading={busy} disabled={text === initial} onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Row({ item, canEdit, editing, onEdit, onDone, change }: {
  item: Instruction;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  change: (op: InstructionOp) => Promise<string | null>;
}) {
  const textId = useId();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    const refused = await change({ kind: 'remove', id: item.id });
    setBusy(false);
    setAsking(false);
    setError(refused);
  };
  const when = Number.isNaN(Date.parse(item.updatedAt)) ? '' : day.format(new Date(item.updatedAt));
  const meta = [item.updatedBy, when].filter(Boolean).join(' · ');
  if (editing) {
    return (
      <li className={`${a.row} ${a.rowEditing}`}>
        <Editor label="Edit instruction" initial={item.text} save={(text) => change({ kind: 'edit', id: item.id, text })} onDone={onDone} />
      </li>
    );
  }
  return (
    <li className={a.row}>
      <div className={a.main}>
        <p className={a.text} id={textId}>
          {item.text}
        </p>
        {item.figure && (
          <p className={a.warn}>
            <Icon name="alert" size={12} />
            Figures belong in metrics.
          </p>
        )}
        {error && (
          <p className={a.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={a.side}>
        {meta && <span className={a.meta}>{meta}</span>}
        {canEdit && (
          <span className={a.actions}>
            <IconButton icon="pencil" size="sm" label="Edit" aria-describedby={textId} onClick={onEdit} />
            <IconButton icon="trash" size="sm" label="Remove" aria-describedby={textId} onClick={() => setAsking(true)} />
          </span>
        )}
      </div>
      {asking && (
        <ConfirmDelete
          title="Remove this instruction?"
          description={`“${item.text}” goes for everyone in this project, and the Assistant stops following it. Nothing brings it back.`}
          confirm="Remove"
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setAsking(false)}
        />
      )}
    </li>
  );
}

export function InstructionsList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useInstructions(projectId);
  const mutation = useChangeInstruction(projectId);
  const change = (op: InstructionOp) => mutation.mutateAsync(op);
  // 'new' = the add row is open; an id = that row is being edited. One at a time.
  const [open, setOpen] = useState<string | null>(null);
  const close = () => setOpen(null);
  const list = q.data ?? [];

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading the instructions" />;
  else if (q.isError) body = <ErrorState heading={3} title="The instructions could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (!list.length && open !== 'new') {
    body = (
      <EmptyState
        icon="sparkles"
        heading={3}
        title="No instructions yet"
        actions={
          canEdit && (
            <Button variant="primary" icon="plus" onClick={() => setOpen('new')}>
              Instruction
            </Button>
          )
        }
      >
        {canEdit
          ? `Write the rules your team follows, like ${EXAMPLE}, and every Assistant answer follows them.`
          : `The rules your team follows, like ${EXAMPLE}, go here, and every Assistant answer follows them. An editor of this project can add instructions.`}
      </EmptyState>
    );
  } else {
    body = (
      <div className={a.card}>
        {!!list.length && (
          <ol className={a.list} aria-label="Instructions">
            {list.map((item) => (
              <Row key={item.id} item={item} canEdit={canEdit} editing={open === item.id} onEdit={() => setOpen(item.id)} onDone={close} change={change} />
            ))}
          </ol>
        )}
        {open === 'new' && (
          <div className={`${a.row} ${a.rowEditing} ${a.adding}`}>
            <Editor label="New instruction" initial="" save={(text) => change({ kind: 'add', text })} onDone={close} />
          </div>
        )}
        <p className={a.foot}>
          <Icon name="info" size={12} />
          The Assistant reads these in order, with the guide of the dataset it is reading, before every answer, chart explanation and dashboard draft. They shape its choices and words; every figure still comes from your data.
        </p>
      </div>
    );
  }

  return (
    <section className={a.section} aria-labelledby="instructions-h">
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id="instructions-h">
              Instructions
            </h2>
            {!!list.length && <Badge>{list.length}</Badge>}
          </div>
          <p className={a.sub}>Everyone in this project, and their Assistant, reads these.</p>
        </div>
        {canEdit && !!list.length && open !== 'new' && (
          <Button icon="plus" onClick={() => setOpen('new')}>
            Instruction
          </Button>
        )}
      </div>
      {body}
    </section>
  );
}
