// Format → Sort (fmtSort.ts): by value, by label, or a custom order you drag —
// or move with Alt+↑/↓ on a focused row. The order is applied by buildChart,
// which reads the RAW labels; the stored `sortOrder` is those labels too.

import { useState } from 'react';
import type { Cx, Overrides } from '../../../charts/types';
import { Icon } from '../../../ui/icons/Icon';
import { Select } from '../../../ui/Select';
import { Note, type Patch } from './FormatPanel';
import s from './Format.module.css';

/** The labels in the order a custom sort draws them: the stored order, then the rest as they came. */
export function customOrder(labels: Cx[], order: unknown): string[] {
  const all = labels.map((l) => String(l));
  const stored = (Array.isArray(order) ? order : []).map(String).filter((l) => all.includes(l));
  return stored.concat(all.filter((l) => !stored.includes(l)));
}

export function SortOrder({ labels, overrides, patch }: { labels: Cx[]; overrides: Overrides; patch: (p: Patch) => void }) {
  const [from, setFrom] = useState(-1);
  const order = customOrder(labels, overrides.sortOrder);
  const commit = (next: string[]) => patch({ sort: 'custom', sortOrder: next });
  const move = (i: number, to: number) => {
    if (to < 0 || to >= order.length || to === i) return;
    const next = order.slice();
    next.splice(to, 0, next.splice(i, 1)[0]);
    commit(next);
  };
  return (
    <>
      <Select
        label="Order"
        size="sm"
        value={(overrides.sort as string) || 'none'}
        options={[
          { value: 'none', label: 'As the data comes' },
          { value: 'desc', label: 'Value: high → low' },
          { value: 'asc', label: 'Value: low → high' },
          { value: 'label_asc', label: 'Label: A → Z' },
          { value: 'label_desc', label: 'Label: Z → A' },
          { value: 'custom', label: 'Custom order' },
        ]}
        onValueChange={(v) => (v === 'custom' ? patch({ sort: 'custom', sortOrder: order }) : patch({ sort: v === 'none' ? null : v }))}
      />
      {overrides.sort === 'custom' &&
        (labels.length === 0 ? (
          <Note>Reading the categories…</Note>
        ) : (
          <>
            <Note>Drag to reorder. Categories not in the list follow in their own order.</Note>
            <ol className={s.order} aria-label="Custom order — drag, or Alt+Up/Down on a focused row">
              {order.map((label, i) => (
                <li
                  key={label}
                  className={s.orderRow}
                  draggable
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                  }}
                  onDragStart={(e) => {
                    setFrom(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', label);
                  }}
                  onDragEnd={() => setFrom(-1)}
                  onDragOver={(e) => from >= 0 && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (from >= 0) move(from, i);
                  }}
                >
                  <Icon name="grip-vertical" />
                  <span className={s.orderName} title={label === '' ? '(empty)' : label}>
                    {label === '' ? '(empty)' : label}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ))}
    </>
  );
}
