// The Glossary: the project's terms (semantic D10) — each a filter with a name that every chart, KPI and
// the Assistant can use. Name, other names, dataset and its filters in the server's words (a viewer row
// access rules restrict reads them without values). Defining, editing and deleting are an editor's.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { Button, IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { SkeletonTable } from '../../../ui/Skeleton';
import { toastMovedToTrash } from '../../projects/trashToast';
import { useTerms, type TermSummary } from './api';
import { TermDialog } from './TermDialog';
import s from './Terms.module.css';

export function TermsList({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useTerms(projectId);
  const client = useQueryClient();
  const [editing, setEditing] = useState<TermSummary | 'new' | null>(null);
  const remove = async (t: TermSummary) => {
    let reply: { ok?: boolean } | null = null;
    try {
      reply = (await rpc('term:delete', { projectId, id: t.id })) as { ok?: boolean };
    } catch {
      reply = null;
    }
    toastMovedToTrash(client, { projectId, type: 'term', id: t.id, name: t.name }, reply);
    void client.invalidateQueries({ queryKey: ['term:list', projectId] });
  };

  let body;
  if (q.isPending) body = <SkeletonTable rows={3} cols={4} label="Loading the glossary" />;
  else if (q.isError)
    body = (
      <ErrorState
        title="The glossary could not be loaded"
        message={q.error.message}
        onRetry={() => void q.refetch()}
      />
    );
  else if (!q.data.length) {
    body = (
      <EmptyState
        icon="list"
        title="No terms yet"
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New term
            </Button>
          )
        }
      >
        A term is a filter with a name — EMEA, Enterprise, Recent order — that every chart and the
        Assistant can use.
        {canEdit ? '' : ' An editor of this project can define one.'}
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Also called</th>
              <th scope="col">Dataset</th>
              <th scope="col">Filters</th>
              <th scope="col">
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.id}>
                <td>
                  {canEdit ? (
                    <button
                      type="button"
                      className={s.name}
                      title={t.description || undefined}
                      onClick={() => setEditing(t)}
                    >
                      {t.name}
                    </button>
                  ) : (
                    <span title={t.description || undefined}>{t.name}</span>
                  )}
                </td>
                <td className={s.dim}>{t.aliases.join(', ') || '—'}</td>
                <td className={s.dim}>{t.datasetName ?? '(missing dataset)'}</td>
                <td className={s.def} title={t.definition}>
                  {t.definition}
                </td>
                <td className={s.actions}>
                  {canEdit && (
                    <Menu
                      label={`Actions for ${t.name}`}
                      align="end"
                      trigger={
                        <IconButton
                          icon="more-horizontal"
                          size="sm"
                          label={`Actions for ${t.name}`}
                        />
                      }
                      items={[
                        { label: 'Edit', icon: 'pencil', onSelect: () => setEditing(t) },
                        { kind: 'separator' },
                        {
                          label: 'Delete',
                          icon: 'trash',
                          danger: true,
                          onSelect: () => void remove(t),
                        },
                      ]}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className={s.section} aria-labelledby="glossary-h">
      <div className={s.head}>
        <div>
          <h2 className={s.title} id="glossary-h">
            Glossary
          </h2>
          <p className={s.sub}>
            Business words defined once as filters, so “EMEA” means the same rows everywhere.
          </p>
        </div>
        {canEdit && !!q.data?.length && (
          <Button icon="plus" onClick={() => setEditing('new')}>
            New term
          </Button>
        )}
      </div>
      {body}
      {editing && canEdit && (
        <TermDialog
          projectId={projectId}
          term={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
