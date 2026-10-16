// A dashboard's filters on a phone (docs/phone-dashboards): the sheet's
// controls, one full-width row each, and — for the reader, whose header has no
// room for them — the view settings (As of, Compare, Currency) under them.
// Clear all and Done at the bottom; swipe, Esc or the scrim closes. The
// selections are the reader's view state, exactly as the desktop's chips.

import { Button } from '../../../ui/Button';
import { DialogClose } from '../../../ui/Dialog';
import { Sheet } from '../../../ui/Sheet';
import type { Card } from '../../analyses/api';
import type { EditorApi } from '../../analyses/editor/context';
import { barControls, Chip } from '../../analyses/editor/FilterBar';
import { controlActive } from '../../analyses/editor/filters';
import { ResetControls } from '../ControlsExtras';
import { ViewControls } from '../DashboardChrome';
import fb from '../../analyses/editor/FilterBar.module.css';
import s from './Phone.module.css';

/** A control or parameter moved off where the author left it. */
function isOn(ed: EditorApi, c: Card): boolean {
  if (c.control?.kind !== 'parameter') return controlActive(c, ed.controlValue(c.id));
  const p = ed.doc.parameters.find((x) => x.id === c.control?.paramId);
  return JSON.stringify(ed.paramValue(c.control.paramId ?? '')) !== JSON.stringify(p?.value);
}

/** What the Filters badge counts: every control narrowing the sheet, and As of / Compare when set. */
export function activeFilters(ed: EditorApi): number {
  return barControls(ed.cards).filter((c) => isOn(ed, c)).length + (ed.view.asOf ? 1 : 0) + (ed.view.compare ? 1 : 0);
}

export function FiltersSheet({ ed, open, onOpenChange, view }: { ed: EditorApi; open: boolean; onOpenChange: (o: boolean) => void; view: boolean }) {
  const chips = barControls(ed.cards);
  const n = chips.length;
  const on = chips.filter((c) => isOn(ed, c)).length;
  const clearAll = () => {
    for (const c of chips) {
      if (c.control?.kind === 'parameter') {
        const p = ed.doc.parameters.find((x) => x.id === c.control?.paramId);
        if (p) ed.setParam(p.id, p.value);
      } else ed.setControl(c.id, undefined);
    }
    if (view) {
      ed.view.setAsOf(null);
      ed.view.setCompare(null);
    }
  };
  const any = on + (view ? (ed.view.asOf ? 1 : 0) + (ed.view.compare ? 1 : 0) : 0);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Filters"
      description={n ? `${n} on this page · ${on ? `narrowing the figures (${on})` : 'showing everything'}` : 'How this dashboard reads its data'}
      footer={
        <>
          <Button variant="ghost" disabled={!any} onClick={clearAll}>
            Clear all
          </Button>
          <DialogClose asChild>
            <Button variant="primary">Done</Button>
          </DialogClose>
        </>
      }
    >
      {n > 0 && (
        <section className={s.section} aria-label="Controls">
          <div className={`${fb.chips} ${fb.stacked}`}>
            {chips.map((c) => (
              <Chip key={c.id} card={c} />
            ))}
          </div>
          <ResetControls />
        </section>
      )}
      {view && (
        <section className={s.section} aria-labelledby="phone-view-h">
          <h3 id="phone-view-h" className={s.sectionH}>
            View
          </h3>
          <div className={s.viewRows}>
            <ViewControls />
          </div>
        </section>
      )}
    </Sheet>
  );
}
