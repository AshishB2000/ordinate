// The pipeline as a list (legacy prepare.ts renderStepsList): number, summary,
// "1,250 → 1,180 rows" under it (the server's counts), and move up / move down
// / edit / remove. An empty pipeline says what a step is for.

import { IconButton } from '../../ui/Button';
import type { Step, StepCount } from './api';
import { fmtN, stepSummary } from './steps';
import s from './Prepare.module.css';

export function StepList({
  steps,
  counts,
  names,
  busy,
  onMove,
  onEdit,
  onRemove,
}: {
  steps: readonly Step[];
  counts: readonly StepCount[] | null;
  names: ReadonlyMap<string, string>;
  busy: boolean;
  onMove: (i: number, dir: -1 | 1) => void;
  onEdit: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  if (!steps.length) {
    return <p className={s.empty}>No steps yet. Add one to transform the data — the original stays intact and every step is reversible.</p>;
  }
  const aligned = counts && counts.length === steps.length ? counts : null;
  return (
    <ol className={s.steps} aria-label="Pipeline steps">
      {steps.map((step, i) => {
        const c = aligned?.[i];
        return (
          <li key={i} className={s.step}>
            <span className={s.stepNum} aria-hidden="true">
              {i + 1}
            </span>
            <span className={s.stepSummary}>
              {stepSummary(step, names)}
              {c && (
                <span className={c.before !== c.after ? `${s.stepCount} ${s.changed}` : s.stepCount}>
                  {fmtN(c.before)} → {fmtN(c.after)} rows
                </span>
              )}
            </span>
            <span className={s.stepActions}>
              <IconButton icon="arrow-up" size="sm" label={`Move step ${i + 1} up`} disabled={busy || i === 0} onClick={() => onMove(i, -1)} />
              <IconButton icon="arrow-down" size="sm" label={`Move step ${i + 1} down`} disabled={busy || i === steps.length - 1} onClick={() => onMove(i, 1)} />
              <IconButton icon="pencil" size="sm" label={`Edit step ${i + 1}`} disabled={busy} onClick={() => onEdit(i)} />
              <IconButton icon="trash" size="sm" label={`Remove step ${i + 1}`} disabled={busy} onClick={() => onRemove(i)} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
