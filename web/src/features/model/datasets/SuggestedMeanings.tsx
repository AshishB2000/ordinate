// "Suggested by the warehouse": a source table's comments and primary key, offered for this dataset (editors only).
// Nothing here is the dataset's until Use; Dismiss keeps one away until the warehouse's text changes. The server
// chooses what to offer; this only words it.

import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { useCanEdit } from '../../projects/api';
import { useSuggestionActions, useSuggestions, type Suggestion } from '../sources/suggestApi';
import s from './SuggestedMeanings.module.css';

const keyOf = (x: Suggestion) => `${x.kind}:${x.column ?? ''}`;

function Row({ x, busy, onUse, onDismiss }: { x: Suggestion; busy: boolean; onUse: () => void; onDismiss: () => void }) {
  return (
    <li className={s.row}>
      <div className={s.what}>
        {x.kind === 'column' && <span className={s.head}><code className={s.col}>{x.column}</code><span className={s.cap}>Meaning</span></span>}
        {x.kind === 'table' && <span className={s.head}><span className={s.cap}>Description</span></span>}
        <span className={s.text}>
          {x.kind === 'column' ? `The warehouse says: "${x.text}"` : x.kind === 'table' ? x.text : `The warehouse's primary key is ${x.text}`}
        </span>
        <span className={s.from}>{`from ${x.table}`}</span>
      </div>
      <div className={s.actions}>
        <Button size="sm" variant="primary" disabled={busy} onClick={onUse}>Use</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>Dismiss</Button>
      </div>
    </li>
  );
}

export function SuggestedMeanings({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const canEdit = useCanEdit(projectId);
  const q = useSuggestions(projectId, datasetId, canEdit);
  const { use, dismiss } = useSuggestionActions(projectId);
  const list = canEdit ? q.data?.suggestions ?? [] : [];
  if (!list.length) return null;
  const busy = use.isPending || dismiss.isPending;
  return (
    <section className={s.block} aria-label="Suggested by the warehouse">
      <h3 className={s.title}><Icon name="sparkles" size={16} />Suggested by the warehouse</h3>
      <ul className={s.list}>
        {list.map((x) => <Row key={keyOf(x)} x={x} busy={busy} onUse={() => use.mutate(x)} onDismiss={() => dismiss.mutate(x)} />)}
      </ul>
    </section>
  );
}
