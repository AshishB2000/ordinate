// Make or change one hierarchy: a name, then its levels in order (coarse first). Levels are the dataset's text columns;
// a column that is a level of another hierarchy is shown, disabled, with whose it is. Save sends the WHOLE list (the
// server replaces it) and says its own sentence under the levels when it refuses; the dialog stays open.

import { useState } from 'react';
import type { DatasetColumns } from '../../../api/datasets';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { useWrite } from '../../data/api';
import type { NavHierarchy } from '../navigation';
import m from '../Model.module.css';

// The server's caps (src/app/hierarchies.ts, which pulls in node's crypto: not imported here).
const MAX_HIERARCHY_NAME = 80;
const MIN_LEVELS = 2;
const MAX_LEVELS = 6;

/** What a save sends: each hierarchy as stored (its id kept), the edited one replaced or added. */
export const listWith = (all: readonly NavHierarchy[], draft: { id?: string; name: string; levels: string[] }) =>
  (draft.id && all.some((h) => h.id === draft.id) ? all.map((h) => (h.id === draft.id ? draft : h)) : [...all, draft]).map(({ id, name, levels }) => ({ ...(id && { id }), name, levels }));

export function HierarchyDialog({ projectId, dataset, all, existing, onClose }: { projectId: string; dataset: DatasetColumns; all: readonly NavHierarchy[]; existing?: NavHierarchy; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [levels, setLevels] = useState<string[]>(existing?.levels ?? []);
  const [refusal, setRefusal] = useState('');
  const save = useWrite('catalog:setTable', ['catalog:getTable', 'model:overview', 'model:navigation'], { quiet: true }); // a refusal is said here, not in a toast

  const owner = new Map(all.filter((h) => h.id !== existing?.id).flatMap((h) => h.levels.map((l) => [l, h.name] as const)));
  const options = dataset.columns
    .filter((c) => c.type === 'text' && !levels.includes(c.name))
    .map((c) => ({ value: c.name, label: owner.has(c.name) ? `${c.name} · Already a level of ${owner.get(c.name)}` : c.name, disabled: owner.has(c.name) }));
  const edit = (next: string[]) => {
    setLevels(next);
    setRefusal('');
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...levels];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    edit(next);
  };
  const ready = name.trim() !== '' && levels.length >= MIN_LEVELS;
  const submit = async () => {
    const r = (await save.mutateAsync({ projectId, datasetId: dataset.id, patch: { hierarchies: listWith(all, { id: existing?.id, name: name.trim(), levels }) } }).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (r?.ok) onClose();
    else if (r) setRefusal(r.error || 'The hierarchy could not be saved.');
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? `Edit ${existing.name}` : 'New hierarchy'}
      description="Order a table's text columns from coarse to fine, like region, then state. A chart on one level can then break down into the next."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={save.isPending} disabled={!ready} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <div className={m.hForm}>
        <Input label="Name" value={name} maxLength={MAX_HIERARCHY_NAME} placeholder="Geography" onChange={(e) => { setName(e.target.value); setRefusal(''); }} />
        <div className={m.hLevels}>
          <span className={m.hCap}>Levels, coarse to fine</span>
          {levels.length ? (
            <ol className={m.hOrder}>
              {levels.map((l, i) => (
                <li key={l}>
                  <span className={m.hStep} aria-hidden="true">{i + 1}</span>
                  <code className={m.hLevel}>{l}</code>
                  <span className={m.hMoves}>
                    <IconButton icon="arrow-up" size="sm" label={`Move ${l} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton icon="arrow-down" size="sm" label={`Move ${l} down`} disabled={i === levels.length - 1} onClick={() => move(i, 1)} />
                    <IconButton icon="x" size="sm" label={`Remove ${l}`} onClick={() => edit(levels.filter((x) => x !== l))} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={m.hNone}>No levels yet. Add at least {MIN_LEVELS}.</p>
          )}
          <Select
            aria-label="Add level"
            value={null}
            options={options}
            placeholder={levels.length >= MAX_LEVELS ? `At most ${MAX_LEVELS} levels` : options.length ? 'Add a level…' : 'No more text columns'}
            disabled={levels.length >= MAX_LEVELS || options.length === 0}
            onValueChange={(v) => edit([...levels, v])}
          />
        </div>
        {refusal && (
          <p className={m.hAlert} role="alert">
            {refusal}
          </p>
        )}
      </div>
    </Dialog>
  );
}
