// "Did you mean" — the app's own options under an answer that went nowhere: a
// chart refused over a name that does not exist (the options ride on the
// stored turn), or one with no rows because a filter value is not in its
// column (the options ride on the card). Each option is a complete answer
// spec the SERVER built and validated; a click re-runs it (`answer:rerun`) and
// no model decides anything.
//
// A label is a column's or a dataset's name, or a stored value; `said` is the
// model's word. All of it is rendered as text.

import { useState } from 'react';
import s from './DidYouMean.module.css';

export interface MeantOption {
  label: string;
  spec: Record<string, unknown>;
}

export function DidYouMean({
  options,
  said,
  onPick,
}: {
  options: readonly MeantOption[];
  /** What was said instead — named on each chip's tooltip and to a screen reader. */
  said?: string;
  onPick: (spec: Record<string, unknown>, label: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  if (options.length === 0) return null;
  return (
    <div className={s.row} role="group" aria-label={said ? `Did you mean, instead of ${said}` : 'Did you mean'} data-testid="did-you-mean">
      <span className={s.lead}>Did you mean</span>
      {options.map((o, i) => (
        <button
          // By position too: two columns may share a display name.
          key={`${i}:${o.label}`}
          type="button"
          className={s.option}
          title={said ? `Use ${o.label} instead of “${said}”` : undefined}
          disabled={busy !== null}
          aria-busy={busy === i || undefined}
          onClick={() => {
            setBusy(i);
            void onPick(o.spec, o.label).finally(() => setBusy(null));
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
