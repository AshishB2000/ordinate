// The Data model header's topic picker (semantic layer part 6, D14–D16): "All" first, then the project's topics; an
// editor also gets "New topic…" and, with one picked, "Edit Sales…", which open the drawer. The list is
// `model:navigation`'s, so the picker costs no read of its own. A failed read hides it (the tabs draw unnarrowed, as
// before topics); a viewer with no topics has nothing to pick. `TopicLine` is the line a narrowed tab carries.

import { useState } from 'react';
import { Select } from '../../../ui/Select';
import { Skeleton } from '../../../ui/Skeleton';
import { Icon } from '../../../ui/icons/Icon';
import { formatNumber } from '../../data/format';
import { useCanEdit } from '../../projects/api';
import { useNavigation } from '../navigation';
import { useTopicPick } from './rememberTopic';
import { TopicDrawer } from './TopicDrawer';
import type { NavTopic } from './api';
import s from './Topics.module.css';

const ALL = '';
const NEW = '\u0000new';
const EDIT = '\u0000edit';

/** `value`: the picked topic's id, null for All (a pick that names no topic reads as All). */
export function TopicPicker({ projectId, value, onChange }: { projectId: string; value: string | null; onChange: (id: string | null) => void }) {
  const nav = useNavigation(projectId);
  const canEdit = useCanEdit(projectId);
  const [open, setOpen] = useState<{ id?: string } | null>(null);
  if (nav.isPending) {
    return (
      <span role="status" aria-label="Loading the topics" className={s.pickerLoading}>
        <Skeleton className={s.pickerBar} />
      </span>
    );
  }
  if (nav.isError) return null;
  const topics = nav.data.topics ?? [];
  if (!topics.length && !canEdit) return null;
  const current = topics.find((t) => t.id === value);
  const options = [
    { value: ALL, label: 'All' },
    ...topics.map((t) => ({ value: t.id, label: t.name })),
    ...(canEdit ? [{ value: NEW, label: 'New topic…' }, ...(current ? [{ value: EDIT, label: `Edit ${current.name}…` }] : [])] : []),
  ];
  const choose = (v: string) => {
    if (v === NEW) setOpen({});
    else if (v === EDIT && current) setOpen({ id: current.id });
    else onChange(v === ALL ? null : v);
  };
  return (
    <div className={s.picker} title={current?.description}>
      <Select label="Topic" value={current?.id ?? ALL} options={options} onValueChange={choose} />
      {open && (
        <TopicDrawer
          projectId={projectId}
          id={open.id}
          onClose={() => setOpen(null)}
          onSaved={(id) => onChange(id)}
          onDeleted={() => onChange(null)}
        />
      )}
    </div>
  );
}

/** "Sales · 2 of 5 metrics · Show all": what a narrowed tab carries. Show all picks All. */
export function TopicLine({ projectId, topic, shown, total, noun }: { projectId: string; topic: NavTopic; shown: number; total: number; noun: string }) {
  const [, setPick] = useTopicPick(projectId);
  return (
    <p className={s.line} data-testid="topic-line">
      <Icon name="layers" size={16} />
      <span className={s.lineName} title={topic.description}>
        {topic.name}
      </span>
      {' · '}
      <span>{`${formatNumber(shown)} of ${formatNumber(total)} ${total === 1 ? noun : `${noun}s`}`}</span>
      {' · '}
      <button type="button" className={s.showAll} onClick={() => setPick(null)}>
        Show all
      </button>
    </p>
  );
}
