// "Save as verified" on an answer card (semantic part 3 D11): a good answer becomes a verified question the team's
// Assistant gives every time. The browser sends the card's stored SPEC and the question asked; the server validates and
// draws it again before it saves (`verified:save`, src/ipc/verified.ts), and a refusal comes back as a sentence for
// one field, shown beside it with the input kept. An editor's: a viewer is never offered it.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { useCanEdit } from '../projects/api';
import s from './SaveAsVerified.module.css';

type Field = 'question' | 'phrasings' | 'spec' | 'form';
const MAX_PHRASINGS = 8;

export function SaveAsVerified({ projectId, spec, question }: { projectId: string; spec: { datasetId: string } & Record<string, unknown>; question: string }) {
  const canEdit = useCanEdit(projectId);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [q, setQ] = useState('');
  const [phrasings, setPhrasings] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);
  if (!canEdit) return null;
  if (saved) return <span className={s.saved}>Saved as verified</span>;

  const show = () => {
    setQ(question.trim().slice(0, 300));
    setErrors({});
    setOpen(true);
  };
  async function save(): Promise<void> {
    const lines = phrasings.split('\n').map((p) => p.trim()).filter(Boolean);
    if (!q.trim()) return setErrors({ question: 'Write the question first.' });
    if (lines.length > MAX_PHRASINGS) return setErrors({ phrasings: `At most ${MAX_PHRASINGS} other ways: this has ${lines.length}.` });
    setErrors({});
    setSaving(true);
    try {
      const r = (await rpc('verified:save', { projectId, input: { question: q.trim(), phrasings: lines, note: note.trim(), spec } })) as { ok: boolean; error?: string; field?: Field };
      if (!r.ok) return setErrors({ [r.field ?? 'form']: r.error || 'Could not save the question.' });
      setSaved(true);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['verified:list', projectId] }); // the list, and the chips
      void qc.invalidateQueries({ queryKey: ['answer:card'] }); // the mark appears on this card
    } catch (e) {
      setErrors({ form: e instanceof Error && e.message ? e.message : 'Could not save the question.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={show}>
        Save as verified
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(false)}
          size="md"
          title="Save as a verified question"
          description="The Assistant will give this answer every time it is asked, drawn again from today’s data. Only how it is worked out is kept, never the figures."
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
          <div className={s.fields}>
            <Input label="Question" value={q} error={errors.question} maxLength={300} autoFocus onChange={(e) => setQ(e.target.value)} />
            <Textarea
              label="Other ways people ask it"
              hint={`One per line, up to ${MAX_PHRASINGS}. Each is answered the same way.`}
              rows={3}
              value={phrasings}
              error={errors.phrasings}
              onChange={(e) => setPhrasings(e.target.value)}
            />
            <Input label="Why this is the answer" placeholder="e.g. net of refunds" hint="Optional." value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
          {(errors.form || errors.spec) && (
            <p className={s.error} role="alert">
              {errors.form || errors.spec}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
