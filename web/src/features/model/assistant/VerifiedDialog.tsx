// Editing one verified question in place: its words, the other ways people ask it (one per line) and the note on
// why this is the answer. The answer itself (its spec) is kept as it is; the server draws it again before it saves,
// restamps who verified it, and refuses a stale copy (409 `record_changed`) or a taken phrasing beside its box.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { isRecordChanged } from '../../editConflicts/useEditGuard';
import type { VerifiedField, VerifiedRow } from './api';
import a from './Assistant.module.css';

const STALE = 'Someone else changed this question. Reload to see it.';

export function VerifiedDialog({ projectId, row, onClose }: { projectId: string; row: VerifiedRow & { spec: NonNullable<VerifiedRow['spec']> }; onClose: () => void }) {
  const client = useQueryClient();
  const [question, setQuestion] = useState(row.question);
  const [phrasings, setPhrasings] = useState(row.phrasings.join('\n'));
  const [note, setNote] = useState(row.note ?? '');
  const [errors, setErrors] = useState<Partial<Record<VerifiedField | 'form', string>>>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setErrors({});
    if (!question.trim()) return setErrors({ question: 'Write the question first.' });
    const lines = phrasings.split('\n').map((p) => p.trim()).filter(Boolean);
    if (lines.length > 8) return setErrors({ phrasings: `At most 8 other ways: this has ${lines.length}.` });
    setSaving(true);
    const input = { question: question.trim(), phrasings: lines, note: note.trim(), spec: row.spec };
    try {
      const r = (await rpc('verified:save', { projectId, id: row.id, base: row.tag, input })) as { ok: boolean; error?: string; field?: VerifiedField };
      if (!r.ok) return setErrors({ [r.field ?? 'form']: r.error || 'Could not save the question.' });
      void client.invalidateQueries({ queryKey: ['verified:list', projectId] }); // every dataset's order of the list
      onClose();
    } catch (err) {
      setErrors({ form: isRecordChanged(err) ? STALE : err instanceof Error ? err.message : 'Could not save the question.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Edit verified question"
      description={`${row.datasetName} · ${row.describe}. Saving draws it again and marks it verified by you.`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className={a.fields}>
        <Input label="Question" value={question} error={errors.question} maxLength={300} autoFocus onChange={(e) => setQuestion(e.target.value)} />
        <Textarea
          label="Other ways people ask it"
          hint="One per line, up to 8. Each is answered the same way."
          rows={3}
          value={phrasings}
          error={errors.phrasings}
          onChange={(e) => setPhrasings(e.target.value)}
        />
        <Input label="Note" placeholder="Why this is the answer, e.g. net of refunds" hint="Optional." value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
      {(errors.form || errors.spec) && (
        <p className={a.error} role="alert">
          {errors.form || errors.spec}
        </p>
      )}
    </Dialog>
  );
}
