// The locked filters of an embed: a column the dashboard's tiles read, and the
// value(s) it is held to. What a token's `params` claim says — in a real host,
// the backend fills the values from ITS session for each customer; here they
// shape the preview and the snippet. A column some tiles lack is offered with
// a note: those tiles are refused in the embed, never drawn unfiltered.

import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import type { ColumnsReply, Lock } from './api';
import s from './Embed.module.css';

export function LockPicker({ columns, locks, onChange, max = 8 }: {
  columns: { isPending: boolean; isError: boolean; error: Error | null; data?: ColumnsReply; refetch: () => unknown };
  locks: Lock[];
  onChange: (locks: Lock[]) => void;
  max?: number;
}) {
  if (columns.isPending) return <SkeletonRows rows={2} label="Loading the dashboard’s columns" />;
  if (columns.isError || !columns.data) {
    return <ErrorState compact heading={3} title="The columns could not be loaded" message={columns.error?.message ?? ''} onRetry={() => void columns.refetch()} />;
  }
  const reply = columns.data;
  if (!reply.ok) {
    return (
      <p className={`${s.lockNote} ${s.lockWarn}`} role="note">
        <Icon name="alert" size={12} />
        <span>{reply.error}</span>
      </p>
    );
  }
  const used = new Set(locks.map((l) => l.column));
  const options = reply.columns.map((c) => ({
    value: c.name,
    label: c.tiles === reply.tiles ? c.name : `${c.name} · ${c.tiles} of ${reply.tiles} tiles`,
  }));
  const set = (i: number, next: Partial<Lock>) => onChange(locks.map((l, j) => (j === i ? { ...l, ...next } : l)));
  const partial = locks.filter((l) => {
    const c = reply.columns.find((x) => x.name === l.column);
    return c && c.tiles < reply.tiles;
  });
  return (
    <div className={s.locks}>
      {locks.map((l, i) => (
        <div className={s.lock} key={i}>
          <Select label={i === 0 ? 'Column' : undefined} aria-label="Locked column" value={l.column || null} onValueChange={(v) => set(i, { column: v })}
            options={options.map((o) => ({ ...o, disabled: used.has(o.value) && o.value !== l.column }))} placeholder="Pick a column" />
          <Input label={i === 0 ? 'Held to' : undefined} aria-label={`Values for ${l.column || 'the column'}`} placeholder="Acme, Globex" value={l.values.join(', ')}
            onChange={(e) => set(i, { values: e.target.value.split(',').map((v) => v.trimStart()) })} />
          <IconButton icon="x" label="Remove this lock" size="sm" onClick={() => onChange(locks.filter((_, j) => j !== i))} />
        </div>
      ))}
      {partial.map((l) => (
        <p className={`${s.lockNote} ${s.lockWarn}`} key={l.column} role="note">
          <Icon name="alert" size={12} />
          <span>Some tiles read a dataset without “{l.column}”. They show “Not available in this embedded view” — never their unfiltered figures.</span>
        </p>
      ))}
      <div>
        <Button size="sm" icon="plus" disabled={locks.length >= max || reply.columns.length === 0} onClick={() => onChange([...locks, { column: '', values: [] }])}>
          {locks.length ? 'Lock another column' : 'Lock a column'}
        </Button>
      </div>
      {!locks.length && (
        <p className={s.lockNote}>
          <Icon name="lock" size={12} />
          <span>No lock: the viewer sees the dashboard as published, every row. For a customer-facing page, lock the column that says whose rows they are.</span>
        </p>
      )}
    </div>
  );
}
