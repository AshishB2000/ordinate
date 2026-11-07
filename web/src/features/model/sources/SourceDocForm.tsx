// A source table's notes, edited in one form: owner, refresh, required filters and the markdown guide.
// It saves through the edit guard (the open copy's tag as `base`): when someone else saved first, the
// conflict banner says so and what was typed stays in the fields. Delete notes removes the doc, which
// has no Trash, so the table's name is typed back first.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Dialog } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import type { EditGuard } from '../../editConflicts/useEditGuard';
import type { Fail } from '../../data/api';
import { formatNumber } from '../../data/format';
import { GET, LIST, type SourceDoc } from './api';
import x from './Sources.module.css';

/** Restated from the contract's caps (src/api/sourceTables.ts Patch; the web cannot import them), so a field says its limit instead of being cut silently. */
const MAX = { owner: 80, refresh: 200, requiredFilters: 500, guide: 8_000 } as const;
type Slot = keyof typeof MAX;
const SLOTS = Object.keys(MAX) as Slot[];

export function SourceDocForm({ projectId, connId, doc, guard, atGuide, onClose, onDeleted, onReload }: {
  projectId: string;
  connId: string;
  doc: SourceDoc;
  guard: EditGuard;
  /** Opened from the Guide: the cursor starts there. */
  atGuide?: boolean;
  onClose: () => void;
  onDeleted: () => void;
  onReload: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Record<Slot, string>>(() => ({ owner: doc.owner, refresh: doc.refresh, requiredFilters: doc.requiredFilters, guide: doc.guide }));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [asking, setAsking] = useState<'' | 'discard' | 'delete'>('');
  const [deleting, setDeleting] = useState(false);
  const patch = Object.fromEntries(SLOTS.filter((k) => draft[k] !== doc[k]).map((k) => [k, draft[k]]));
  const dirty = Object.keys(patch).length > 0;
  const field = (k: Slot) => ({ value: draft[k], maxLength: MAX[k], onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value.slice(0, MAX[k]) })) });

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: [GET, projectId, connId, doc.docId] }), client.invalidateQueries({ queryKey: [LIST, projectId] })]);
  const save = async () => {
    if (!dirty) return onClose();
    setSaving(true);
    setProblem('');
    try {
      const r = (await guard.save((base) => rpc('sourceTable:save', { projectId, connId, docId: doc.docId, patch, base }))) as { ok: true } | Fail | null;
      if (r === null) return; // someone else saved first: the banner says so, the fields keep what was typed
      if (!r.ok) return setProblem(r.error || 'The notes could not be saved.');
      await refresh();
      onClose();
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'The notes could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      const r = (await rpc('sourceTable:delete', { projectId, connId, docId: doc.docId })) as { ok: true } | Fail;
      if (!r.ok) throw new Error(r.error || 'The notes could not be deleted.');
      await client.invalidateQueries({ queryKey: [LIST, projectId] });
      client.removeQueries({ queryKey: [GET, projectId, connId, doc.docId] });
      onDeleted();
    } catch (err) {
      setAsking('');
      setDeleting(false);
      setProblem(err instanceof Error && err.message ? err.message : 'The notes could not be deleted.');
    }
  };
  // Closing with a change nobody saved asks first: the guide alone is up to 8,000 characters.
  const leave = () => (saving ? undefined : dirty && !guard.changed ? setAsking('discard') : onClose());

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && leave()}
      title={`Notes on ${doc.table}`}
      description="For editors of this project: what to know before building on this table."
      footer={
        <>
          <Button variant="ghost" icon="trash" className={x.footLeft} onClick={() => setAsking('delete')}>
            Delete notes
          </Button>
          <Button onClick={leave} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={guard.changed} onClick={() => void save()}>
            Save notes
          </Button>
        </>
      }
    >
      <div className={x.form}>
        {guard.changed && <ConflictBanner compact noun="source table doc" onReload={onReload} />}
        <Input label="Owner" hint="Who to ask about this table: a team or a person." autoFocus={!atGuide} {...field('owner')} />
        <Input label="Refreshes" hint="When new rows land, and what loads them." {...field('refresh')} />
        <Textarea label="Required filters" hint="The filters every query should use, such as a partition column." rows={2} {...field('requiredFilters')} />
        <Textarea
          label="Guide"
          hint={`Markdown: headings, lists, links and code. ${formatNumber(draft.guide.length)} of ${formatNumber(MAX.guide)} characters.`}
          rows={12}
          autoFocus={atGuide}
          className={x.guideInput}
          {...field('guide')}
        />
        {problem && (
          <p className={x.formError} role="alert">
            {problem}
          </p>
        )}
      </div>
      {asking === 'discard' && (
        <ConfirmDelete title="Discard your changes to the notes?" description="What you wrote here is not saved yet." confirm="Discard changes" onConfirm={onClose} onClose={() => setAsking('')} />
      )}
      {asking === 'delete' && (
        <ConfirmDelete
          title={`Delete the notes on ${doc.table}?`}
          description="Its owner, refresh, required filters, guide and what was read from the warehouse are deleted. The table itself is not touched. This cannot be undone."
          confirm="Delete notes"
          typeToConfirm={doc.table}
          busy={deleting}
          onConfirm={() => void remove()}
          onClose={() => setAsking('')}
        />
      )}
    </Dialog>
  );
}
