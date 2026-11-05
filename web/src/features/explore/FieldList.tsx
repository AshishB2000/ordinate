// The dataset's fields (explore:suggest's groups, in the server's order): a
// search, then Dimensions, Dates and Measures. Each row is ONE button; a click
// is the caller's — in the rail and the phone's Fields sheet it puts the field
// in the question or takes it out (./spec withField), in a well's picker it
// fills that well. A field in the question says where it is.

import { useState } from 'react';
import { Input } from '../../ui/Field';
import { Icon, type IconName } from '../../ui/icons/Icon';
import type { NavHierarchy } from '../model/navigation';
import type { Field, FieldKind } from './spec';
import s from './Explore.module.css';

const GROUPS: readonly { kind: FieldKind; label: string }[] = [
  { kind: 'dimension', label: 'Dimensions' },
  { kind: 'date', label: 'Dates' },
  { kind: 'measure', label: 'Measures' },
];
const TYPE_ICON: Record<Field['type'], IconName> = { text: 'type-text', number: 'type-number', date: 'type-date' };

export function FieldList({
  fields,
  kinds,
  roleOf,
  onPick,
  autoFocus,
  hierarchies = [],
}: {
  fields: readonly Field[];
  /** The groups to offer (a well's picker); all three by default. */
  kinds?: readonly FieldKind[];
  /** Where a field sits in the question ('Measure', 'Group by', 'Split by'), or null. */
  roleOf: (name: string) => string | null;
  onPick: (f: Field) => void;
  autoFocus?: boolean;
  /** Drill hierarchies: a usable one whose levels are all dimensions here is nested under Dimensions. */
  hierarchies?: readonly NavHierarchy[];
}) {
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  const match = (f: Field) => !needle || f.name.toLowerCase().includes(needle);
  const dims = new Map(fields.filter((f) => f.kind === 'dimension').map((f) => [f.name, f]));
  const nested = hierarchies.filter((h) => !h.missing?.length && h.levels.every((l) => dims.has(l)));
  const inHierarchy = new Set(nested.flatMap((h) => h.levels));
  const groups = GROUPS.filter((g) => !kinds || kinds.includes(g.kind)).map((g) => ({
    ...g,
    nested: g.kind === 'dimension' ? nested.map((h) => ({ h, fields: h.levels.map((l) => dims.get(l)!).filter(match) })).filter((n) => n.fields.length > 0) : [],
    fields: fields.filter((f) => f.kind === g.kind && !(g.kind === 'dimension' && inHierarchy.has(f.name)) && match(f)),
  }));
  const shown = groups.some((g) => g.fields.length > 0 || g.nested.length > 0);
  const row = (f: Field) => {
    const role = roleOf(f.name);
    return (
      <li key={f.name}>
        <button type="button" className={role ? `${s.field} ${s.fieldOn}` : s.field} data-kind={f.kind} aria-pressed={!!role} onClick={() => onPick(f)}>
          <span className={s.fieldIcon} aria-hidden="true">
            <Icon name={TYPE_ICON[f.type]} size={16} />
          </span>
          <span className={s.fieldName}>{f.name}</span>
          {role && <span className={s.fieldRole}>{role}</span>}
        </button>
      </li>
    );
  };
  return (
    <div className={s.fields}>
      <Input icon="search" size="sm" aria-label="Search fields" placeholder="Search fields" value={find} autoFocus={autoFocus} onChange={(e) => setFind(e.target.value)} />
      {groups.map(
        (g) =>
          (g.fields.length > 0 || g.nested.length > 0) && (
            <section key={g.kind} className={s.group} aria-label={g.label}>
              <h3 className={s.groupH}>
                {g.label}
                <span className={s.groupN}>{g.fields.length + g.nested.reduce((n, x) => n + x.fields.length, 0)}</span>
              </h3>
              {g.nested.map(({ h, fields: levels }) => (
                <div key={h.id} role="group" aria-label={h.name} className={s.hier}>
                  <p className={s.hierName}>
                    <Icon name="layers" size={12} />
                    {h.name}
                  </p>
                  <ul className={`${s.fieldRows} ${s.hierRows}`}>{levels.map(row)}</ul>
                </div>
              ))}
              {g.fields.length > 0 && <ul className={s.fieldRows}>{g.fields.map(row)}</ul>}
            </section>
          ),
      )}
      {!shown && <p className={s.fieldsNone}>{needle ? `No field matches “${find.trim()}”.` : 'No field of this kind in this dataset.'}</p>}
    </div>
  );
}
