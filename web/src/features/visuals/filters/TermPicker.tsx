// "Add term" in the filter rows: the project's glossary is read (one `term:list`) only once the
// picker is first opened, so a screen that merely draws filters makes no call for it.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { EmptyState } from '../../../ui/States';
import { SkeletonRows } from '../../../ui/Skeleton';
import { useCanEdit } from '../../projects/api';
import { useTerms } from '../../model/terms/api';
import { pickerOrder } from '../../model/status/status';
import type { FilterStep } from '../api';
import s from './Filters.module.css';

export function TermPicker({ projectId, datasetId, onPick }: { projectId: string; datasetId: string; onPick: (next: FilterStep) => void }) {
  const [asked, setAsked] = useState(false);
  const glossary = useTerms(asked ? projectId : undefined);
  const canEdit = useCanEdit(projectId, asked);
  // This dataset's terms first; another dataset's applies through a relationship (or is refused, with a sentence).
  // Certified first, retired last (pickerOrder is stable, so this dataset's terms stay ahead within a rank).
  const here = [...(glossary.data ?? [])].sort((a, b) => Number(b.datasetId === datasetId) - Number(a.datasetId === datasetId));
  const o = pickerOrder(here);
  const offered = [...o.main, ...o.retired];
  const state = glossary.isError ? 'error' : glossary.data ? (offered.length ? 'ready' : 'empty') : 'loading';
  return (
    <Menu
      label="Add a glossary term"
      onOpenChange={(o) => o && setAsked(true)}
      trigger={
        <Button size="sm" icon="list" className={s.add}>
          Add term
        </Button>
      }
      header={
        state === 'loading' ? (
          <SkeletonRows rows={3} label="Loading glossary terms" />
        ) : state === 'error' ? (
          <EmptyState compact heading={3} icon="list" title="Glossary terms could not be loaded">
            Close this and open it again to retry.
          </EmptyState>
        ) : state === 'empty' ? (
          <EmptyState compact heading={3} icon="list" title="No glossary terms yet">
            {canEdit ? 'Define one on the Glossary tab of the Data model.' : 'An editor of this project can define one on the Data model’s Glossary tab.'}
          </EmptyState>
        ) : undefined
      }
      items={offered.map((t) => ({
        label: (t.datasetId === datasetId ? t.name : `${t.name} (${t.datasetName ?? 'another dataset'})`) + (t.status?.state === 'retired' ? ' · retired' : ''),
        onSelect: () => onPick({ type: 'term', term: t.id } as unknown as FilterStep),
      }))}
    />
  );
}
