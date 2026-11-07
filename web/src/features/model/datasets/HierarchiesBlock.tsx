// A dataset's drill hierarchies on the Data model's Fields tab: each as a chip (its name, then its levels, coarse to
// fine), a warning on one whose level is no longer a text column, and the line saying dates drill by themselves.
// An editor adds, edits and removes; a viewer reads. Every level and the ladder are the server's (`model:navigation`).

import { useState } from 'react';
import type { DatasetColumns } from '../../../api/datasets';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useWrite } from '../../data/api';
import { useCanEdit } from '../../projects/api';
import { grainWord } from '../../../../../src/analysis/drillLevels.ts';
import { navFor, useNavigation, type NavHierarchy } from '../navigation';
import { HierarchyDialog } from './HierarchyDialog';
import m from '../Model.module.css';

const missingText = (missing: string[]) => `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no longer ${missing.length === 1 ? 'a text column' : 'text columns'}`;

export function HierarchiesBlock({ projectId, dataset }: { projectId: string; dataset: DatasetColumns }) {
  const canEdit = useCanEdit(projectId);
  const nav = useNavigation(projectId);
  const [dialog, setDialog] = useState<{ existing?: NavHierarchy } | null>(null);
  const [removing, setRemoving] = useState<NavHierarchy | null>(null);
  const write = useWrite('catalog:setTable', ['catalog:getTable', 'model:overview', 'model:navigation']);
  const all = navFor(nav.data, dataset.id);
  const remove = (h: NavHierarchy) =>
    write.mutate({ projectId, datasetId: dataset.id, patch: { hierarchies: all.filter((x) => x.id !== h.id).map(({ id, name, levels }) => ({ id, name, levels })) } }, { onSettled: () => setRemoving(null) });
  const add = (
    <Button size="sm" variant="secondary" icon="plus" onClick={() => setDialog({})}>
      Hierarchy
    </Button>
  );
  const ladder = nav.data?.dateLadder ?? [];

  return (
    <section className={m.hier} aria-label="Hierarchies">
      <div className={m.hierHead}>
        <h3 className={m.calcHead}>Hierarchies</h3>
        {canEdit && all.length > 0 && add}
      </div>
      {nav.isPending ? (
        <SkeletonRows rows={2} label="Loading the hierarchies" />
      ) : nav.isError ? (
        <ErrorState compact heading={3} title="The hierarchies could not be loaded" message={nav.error.message} onRetry={() => void nav.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon="layers" heading={3} compact title="No hierarchies yet" actions={canEdit && add}>
          {canEdit ? 'Group levels like region › state so charts can drill from one to the next.' : 'An editor of this project can group text columns into drill levels.'}
        </EmptyState>
      ) : (
        <ul className={m.hList}>
          {all.map((h) => (
            <li key={h.id} className={h.missing ? `${m.hChip} ${m.hChipWarn}` : m.hChip}>
              <span className={m.hName}>{h.name}</span>
              <span className={m.hPath}>{h.levels.join(' › ')}</span>
              {h.missing && <Badge tone="warn" icon="alert">{missingText(h.missing)}</Badge>}
              {canEdit && (
                <span className={m.hMoves}>
                  <IconButton icon="pencil" size="sm" label={`Edit ${h.name}`} onClick={() => setDialog({ existing: h })} />
                  <IconButton icon="trash" size="sm" label={`Remove ${h.name}`} disabled={write.isPending} onClick={() => setRemoving(h)} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {ladder.length > 0 && <p className={m.hLadder}>{`Dates drill by themselves: ${ladder.map((g) => grainWord(g, ladder)).join(' › ')}`}</p>}
      {removing && (
        <ConfirmDelete
          title={`Remove ${removing.name}?`}
          description={`Charts stop drilling from ${removing.levels.join(' › ')}, for everyone in this project.`}
          confirm="Remove"
          busy={write.isPending}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
      {dialog && <HierarchyDialog projectId={projectId} dataset={dataset} all={all} existing={dialog.existing} onClose={() => setDialog(null)} />}
    </section>
  );
}
