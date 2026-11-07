// Retire an item, naming what replaces it. The replacement is of the same kind, never the item itself or a retired
// one; the server's refusal sentence shows under the replacement field.

import { useState } from 'react';
import { useDatasets } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select, type SelectOption } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { useMetricList } from '../../analyses/metrics/api';
import { useTerms } from '../terms/api';
import { refOf, useStatusActions, type Refusal } from './api';
import type { StatusKind, StatusView } from './status';
import s from './Status.module.css';

const NONE = '';

/** The items of this kind a replacement can be: not itself, not retired. */
function useCandidates(projectId: string, kind: StatusKind, id: string): SelectOption[] {
  const metrics = useMetricList(kind === 'metric' ? projectId : '');
  const terms = useTerms(kind === 'term' ? projectId : undefined);
  const datasets = useDatasets(kind === 'dataset' ? projectId : undefined);
  const rows: { id: string; name: string; status?: StatusView }[] = (kind === 'metric' ? metrics.data : kind === 'term' ? terms.data : datasets.data) ?? [];
  return rows.filter((x) => x.id !== id && x.status?.state !== 'retired').map((x) => ({ value: refOf(kind, x.id), label: x.name }));
}

export function RetireDialog({ projectId, kind, id, name, onClose }: { projectId: string; kind: StatusKind; id: string; name: string; onClose: () => void }) {
  const options = useCandidates(projectId, kind, id);
  const { retire } = useStatusActions(projectId);
  const [to, setTo] = useState(NONE);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<Refusal | null>(null);
  const go = () =>
    retire.mutate(
      { ref: refOf(kind, id), ...(to && { replacedBy: to }), ...(note.trim() && { note: note.trim() }) },
      {
        onSuccess: (r) => {
          if (r.ok) {
            toast(`${name} is retired.`, { kind: 'success' });
            onClose();
          } else setProblem(r);
        },
      },
    );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Retire ${name}`}
      description="It stays where it is used, with a note saying so. Pickers stop offering it."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="archive" loading={retire.isPending} onClick={go}>
            Retire
          </Button>
        </>
      }
    >
      <div className={s.review}>
        <Select
          label="Replaced by"
          value={to}
          options={[{ value: NONE, label: 'Nothing: it is just retired' }, ...options]}
          onValueChange={(v) => {
            setTo(v);
            setProblem(null);
          }}
          error={problem?.field === 'replacedBy' ? problem.error : undefined}
        />
        {problem && problem.field !== 'replacedBy' && (
          <p className={s.stale} role="alert">
            {problem.error}
          </p>
        )}
        <Input label="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}
