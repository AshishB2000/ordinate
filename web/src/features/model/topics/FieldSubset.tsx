// A topic dataset's fields (semantic layer part 6, D14): a popover of column checkboxes behind "8 of 12 fields". Every
// box checked means no `fields` (the whole dataset, and the columns a later refresh adds); one box always stays checked.
// The columns are read when it opens (`dataset:columns`, metadata only); the count on the button is the list's own.

import { useState } from 'react';
import { useDatasetColumns } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Popover } from '../../../ui/Popover';
import { SkeletonRows } from '../../../ui/Skeleton';
import { formatNumber } from '../../data/format';
import s from './Topics.module.css';

export function FieldSubset({ projectId, datasetId, name, total, fields, onChange }: {
  projectId: string;
  datasetId: string;
  name: string;
  /** The dataset's column count, as `dataset:list` said it. */
  total: number;
  fields: string[] | undefined;
  onChange: (fields: string[] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const cols = useDatasetColumns(projectId, open ? datasetId : undefined);
  const names = (cols.data?.columns ?? []).map((c) => c.name);
  const on = new Set(fields ?? names);
  const set = (next: string[]) => onChange(next.length === names.length ? undefined : next);
  const label = fields ? `${formatNumber(fields.length)} of ${formatNumber(total)} fields` : `All ${formatNumber(total)} fields`;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={`Fields of ${name}`}
      align="end"
      className={s.fieldsPop}
      trigger={
        <Button size="sm" variant="ghost" iconEnd="chevron-down" aria-label={`Fields of ${name}: ${fields ? `${fields.length} of ${total}` : `all ${total}`}`}>
          {label}
        </Button>
      }
    >
      <p className={s.popHead}>Fields people see first</p>
      {cols.isPending ? (
        <SkeletonRows rows={4} label="Loading the fields" />
      ) : cols.isError || !cols.data ? (
        <p className={s.muted}>The fields could not be read. Close this and try again.</p>
      ) : (
        <div className={s.popList}>
          <Checkbox label="All fields" checked={!fields} indeterminate={!!fields} onCheckedChange={() => onChange(undefined)} />
          <div className={s.popCols}>
            {names.map((c) => (
              <Checkbox
                key={c}
                label={c}
                checked={on.has(c)}
                disabled={on.has(c) && on.size === 1}
                onCheckedChange={(v) => set(names.filter((n) => (n === c ? v : on.has(n))))}
              />
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
