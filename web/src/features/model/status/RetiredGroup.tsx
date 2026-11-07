// "Retired (n)": a closed disclosure under a picker. Retired items are not offered; this says what they are and what replaces them.

import { useState } from 'react';
import { Icon } from '../../../ui/icons/Icon';
import type { StatusView } from './status';
import s from './Status.module.css';

export function RetiredGroup({ items }: { items: { name: string; status?: StatusView }[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className={s.retired}>
      <button type="button" className={s.retiredToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {`Retired (${items.length})`}
      </button>
      {open && (
        <ul className={s.retiredList}>
          {items.map((x) => (
            <li key={x.name}>{x.status?.replacedBy ? `${x.name} · use ${x.status.replacedBy.name}` : x.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
