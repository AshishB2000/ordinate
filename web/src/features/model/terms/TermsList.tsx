// The Glossary: the project's terms (semantic D10) — each a filter with a name that every chart, KPI and
// the Assistant can use. Name, other names, dataset and its filters in the server's words (a viewer row
// access rules restrict reads them without values), and where each is used (`term:usage`, the server's
// count). Editing and deleting are an editor's; "New term" is the Data model header's (one door).

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState } from '../../../app/blocks';
import { IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { SkeletonTable } from '../../../ui/Skeleton';
import { formatNumber } from '../../data/format';
import { toastMovedToTrash } from '../../projects/trashToast';
import { StatusActions } from '../status/StatusActions';
import { StatusBadge } from '../status/StatusBadge';
import { useTerms, type TermSummary, type TermUsage } from './api';
import { TermDialog } from './TermDialog';
import d from '../../data/Data.module.css';
import s from './Terms.module.css';

/** `usage`: the server's, by term id; absent (an older pod, a failed read) reads "—", never "Not used yet". */
export function TermsList({ projectId, canEdit, usage }: { projectId: string; canEdit: boolean; usage?: Record<string, TermUsage> }) {
  const q = useTerms(projectId);
  const client = useQueryClient();
  const [editing, setEditing] = useState<TermSummary | null>(null);
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
      <EmptyState icon="list" heading={3} title="No terms yet">
        A term is a filter with a name — EMEA, Enterprise, Recent order — that every chart and the
        Assistant can use.
        {canEdit ? ' Use New term to define one.' : ' An editor of this project can define one.'}
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
              <th scope="col">Used by</th>
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
                  {t.status && (
                    <div className={s.status}>
                      <StatusBadge status={t.status} />
                    </div>
                  )}
                </td>
                <td className={s.dim}>{t.aliases.join(', ') || '—'}</td>
                <td className={s.dim}>{t.datasetName ?? '(missing dataset)'}</td>
                <td className={s.def} title={t.definition}>
                  {t.definition}
                </td>
                <UsedBy u={usage && (usage[t.id] ?? null)} />
                <td className={s.actions}>
                  <StatusActions projectId={projectId} kind="term" id={t.id} name={t.name} status={t.status} compact />
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

  const count = q.data?.length ?? 0;
  return (
    <section className={d.section} aria-label="Glossary">
      <div className={d.listBar}>
        {count > 0 && <span className={d.muted}>{count === 1 ? '1 term' : `${formatNumber(count)} terms`}</span>}
        <p className={d.lead}>Business words defined once as filters, so “EMEA” means the same rows everywhere.</p>
      </div>
      {body}
      {editing && canEdit && <TermDialog projectId={projectId} term={editing} used={usage?.[editing.id]?.summary} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** The records that use a term, as the server worded them; their names on hover. Undefined: unknown. */
function UsedBy({ u }: { u: TermUsage | null | undefined }) {
  if (u === undefined) return <td className={s.dim}>—</td>;
  if (!u) return <td className={s.dim}>Not used yet</td>;
  return (
    <td className={s.dim} title={u.refs.map((r) => r.name).join(', ')}>
      {u.summary}
    </td>
  );
}
