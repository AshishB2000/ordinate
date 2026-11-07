// The team's verified questions as one-click answers (semantic part 3 D10). A click runs the spec through the
// server (`answer:rerun`): no model is called, so they work with none connected.

import type { VerifiedChip } from './api';
import s from './VerifiedChips.module.css';

export function VerifiedChips({ chips, onPick, disabled, className }: { chips: VerifiedChip[]; onPick: (c: VerifiedChip) => void; disabled?: boolean; className?: string }) {
  if (!chips.length) return null;
  return (
    <div className={className ?? s.wrap} role="group" aria-label="Verified answers" data-testid="verified-chips">
      <span className={s.caption}>Verified answers</span>
      {chips.map((c) => (
        <button key={c.question} type="button" className={s.chip} title={c.question} disabled={disabled} onClick={() => onPick(c)}>
          {`✓ ${c.question}`}
        </button>
      ))}
    </div>
  );
}
