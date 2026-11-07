// A semantic layer's models on its connection's page (semantic layer part 7, b3; docs/semantic-layer/07-portability.md
// "What you will see", D11, D14): Snowflake's semantic views beside its tables, or a Cube or dbt deployment's models.
// "Add as dataset" makes a Live dataset whose fields are the model's dimensions and whose measures are the layer's own
// metrics (`connection:addSemanticDataset`; the sync that writes its metrics is queued by the server). Model names
// appear on this page only: the caller already holds the connection's `write`, which the listing contract requires.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useRefreshLists } from './api';
import s from './SemanticModels.module.css';

export interface SemanticModel {
  name: string;
  label?: string;
  description?: string;
}
type Listed = { ok: true; models: SemanticModel[] } | { ok: false; error: string };
type Added = { ok: true; dataset: { id: string; name: string } } | { ok: false; error: string };

export function SemanticModels({ projectId, connId, views, savedQueries, fill }: {
  projectId: string;
  connId: string;
  /** Snowflake's word: semantic views in a database, beside its tables. Otherwise a deployment's models. */
  views?: boolean;
  /** dbt's word: an environment's saved queries (d1). */
  savedQueries?: boolean;
  /** The page's main pane holds nothing else (a layer-only connection: no SQL to run). */
  fill?: boolean;
}) {
  const noun = views ? 'Semantic views' : savedQueries ? 'Saved queries' : 'Models';
  const q = useQuery({
    queryKey: ['connection:semanticModels', projectId, connId],
    queryFn: async () => {
      const r = (await rpc('connection:semanticModels', { projectId, connId })) as Listed;
      if (!r.ok) throw new Error(r.error || 'The layer’s models could not be listed.');
      return r.models;
    },
    retry: false,
  });
  const [adding, setAdding] = useState<SemanticModel | null>(null);

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label={`Loading ${noun.toLowerCase()}`} />;
  else if (q.isError) body = <ErrorState compact heading={3} title={`${noun} could not be listed`} message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!q.data.length) {
    body = (
      <EmptyState compact heading={3} icon="layers" title={views ? 'No semantic views in this database yet.' : savedQueries ? 'No saved queries in this environment yet.' : 'No models in this deployment yet.'}>
        Once one is defined in the layer, it is listed here to add as a dataset.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.list}>
        {q.data.map((m) => (
          <li key={m.name} className={s.row}>
            <Icon name="layers" size={16} />
            <div className={s.text}>
              <span className={s.name}>{m.label || m.name}</span>
              {m.description && <span className={s.desc}>{m.description}</span>}
            </div>
            <Button size="sm" icon="plus" onClick={() => setAdding(m)}>
              Add as dataset
            </Button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className={[s.panel, fill && s.fill].filter(Boolean).join(' ')} aria-labelledby={`models-${connId}`}>
      <header className={s.head}>
        <div className={s.titleRow}>
          <h2 className={s.title} id={`models-${connId}`}>
            {noun}
          </h2>
          {/* The panel scrolls above the SQL editor: the count says when more are listed than show. */}
          {!!q.data?.length && <span className={s.count}>{`${q.data.length} listed`}</span>}
        </div>
        <p className={s.lead}>Each becomes a Live dataset: its fields are the dimensions, its measures the layer’s own metrics, computed there on every question.</p>
      </header>
      {body}
      {adding && <AddDialog projectId={projectId} connId={connId} model={adding} onClose={() => setAdding(null)} />}
    </section>
  );
}

function AddDialog({ projectId, connId, model, onClose }: { projectId: string; connId: string; model: SemanticModel; onClose: () => void }) {
  const navigate = useNavigate();
  const refreshLists = useRefreshLists(projectId);
  const [name, setName] = useState(model.label || model.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setError('');
    if (!name.trim()) return setError('A dataset needs a name.');
    setBusy(true);
    try {
      const r = (await rpc('connection:addSemanticDataset', { projectId, connId, model: model.name, name: name.trim() })) as Added;
      if (!r.ok) return setError(r.error || 'The dataset could not be added.');
      refreshLists();
      toast(`Added “${r.dataset.name}”. Its metrics arrive with the first sync.`, { kind: 'success' });
      onClose();
      void navigate(`/data/${projectId}/${r.dataset.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The dataset could not be added.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Add “${model.label || model.name}” as a dataset`}
      description="A Live dataset: nothing is copied, and each chart asks the layer."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} onClick={() => void add()}>
            Add dataset
          </Button>
        </>
      }
    >
      <Input label="Dataset name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} onKeyDown={(e) => e.key === 'Enter' && void add()} />
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
