// Selectable cards over NATIVE radios — the one control of the ask-first
// screens (DraftBrief.tsx: the kind and the look; DraftClarify.tsx: a question's
// options). As ui/Choice.tsx: the browser gives each input its role, one tab
// stop per group, the arrow keys between options and Space to pick, so none of
// that is written here. The card paints the input's own state (Draft.module.css).

import { useId, type ReactNode } from 'react';
import s from './Draft.module.css';

export interface CardOption<T extends string> {
  value: T;
  title: string;
  /** One muted line under the title. */
  hint?: string;
  /** A picture above the title (a layout sketch, a swatch). Decoration: the title says it. */
  art?: ReactNode;
}

export function CardRadios<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  as = 'cards',
}: {
  /** Names the group. */
  label: string;
  hint?: string;
  /** The picked option, or `undefined` while there is none. */
  value: T | undefined;
  onChange: (value: T) => void;
  options: readonly CardOption<T>[];
  /** `cards`: a grid under a section label — `lead`, with a wider first card. `options`: a question, its answers a row of pills. */
  as?: 'cards' | 'lead' | 'options';
}) {
  const id = useId();
  return (
    <div className={s.pick} role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <h3 id={`${id}-label`} className={as === 'options' ? s.ask : s.sectionH}>
        {label}
      </h3>
      {hint && (
        <p id={`${id}-hint`} className={s.note}>
          {hint}
        </p>
      )}
      <div className={s[as]}>
        {options.map((o) => (
          <label key={o.value} className={s.card}>
            {o.art && <span aria-hidden="true">{o.art}</span>}
            <span className={s.cardT}>
              <input type="radio" className={s.cardRadio} name={id} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
              {o.title}
            </span>
            {o.hint && <span className={s.cardP}>{o.hint}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
