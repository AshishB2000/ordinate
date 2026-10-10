// The filter bar between the sheet tabs and the grid (legacy dashControlBar.ts):
// the open sheet's controls as chips, each a live widget. A control filters the
// whole dashboard; its selection is view state, never saved — "Set as default"
// is the one way it reaches the record. Parameter chips move a parameter.

import { useState } from 'react';
import { Button, IconButton } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu } from '../../../ui/Menu';
import { Icon } from '../../../ui/icons/Icon';
import type { Card, Parameter } from '../api';
import { ParamDialog } from '../ParamDialog';
import { useEditor } from './context';
import { ControlDialog } from './ControlDialog';
import { ParamWidget, ControlWidget } from './ControlWidget';
import { controlActive } from './filters';
import { allControls } from './doc';
import s from './FilterBar.module.css';
import { ResetControls } from '../../dashboards/ControlsExtras';

/** The sheet's control cards in the order their author built them (a sorted COPY). */
export function barControls(cards: readonly Card[]): Card[] {
  return cards
    .filter((c) => c.type === 'control' && c.control)
    .slice()
    .sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
}

/** Remove a control card — and its parameter, once no other control moves it (paramDialog.ts removeParameterControl). */
export function removeControl(ed: ReturnType<typeof useEditor>, card: Card) {
  ed.edit('Remove control', (d) => {
    for (const sh of d.sheets) sh.cards = sh.cards.filter((c) => c.id !== card.id);
    const pid = card.control?.kind === 'parameter' ? card.control.paramId : undefined;
    if (pid && !allControls(d).some((c) => c.control?.paramId === pid)) d.parameters = d.parameters.filter((p) => p.id !== pid);
  });
  ed.setControl(card.id, undefined);
}

function Chip({ card }: { card: Card }) {
  const ed = useEditor();
  const control = card.control as NonNullable<Card['control']>;
  const [editing, setEditing] = useState(false);
  const isParam = control.kind === 'parameter';
  const param = isParam ? ed.doc.parameters.find((p) => p.id === control.paramId) : undefined;
  const label = control.label || (param ? param.name : control.column || 'Filter');
  const live = isParam && param ? ed.paramValue(param.id) : undefined;
  const active = isParam ? !!param && JSON.stringify(live) !== JSON.stringify(param.value) : controlActive(card, ed.controlValue(card.id));
  const clear = () => (isParam && param ? ed.setParam(param.id, param.value) : ed.setControl(card.id, undefined));

  const items = isParam
    ? [
        { label: 'Edit parameter…', icon: 'pencil' as const, onSelect: () => setEditing(true) },
        ...(active && param
          ? [
              {
                label: 'Save as default',
                icon: 'check' as const,
                onSelect: () =>
                  ed.edit('Save parameter default', (d) => {
                    const p = d.parameters.find((x) => x.id === param.id);
                    if (p) p.value = live as Parameter['value'];
                  }),
              },
            ]
          : []),
        { kind: 'separator' as const },
        { label: 'Remove', icon: 'trash' as const, danger: true, onSelect: () => removeControl(ed, card) },
      ]
    : [
        { label: 'Edit…', icon: 'pencil' as const, onSelect: () => setEditing(true) },
        {
          label: active ? 'Set as default' : 'Clear default',
          icon: 'check' as const,
          onSelect: () =>
            ed.edit('Set control default', (d) => {
              const c = d.sheets.flatMap((sh) => sh.cards).find((x) => x.id === card.id);
              if (!c?.control) return;
              const cur = ed.controlValue(card.id);
              if (active && cur) c.control.default = cur;
              else delete c.control.default;
            }),
        },
        { kind: 'separator' as const },
        { label: 'Remove', icon: 'trash' as const, danger: true, onSelect: () => removeControl(ed, card) },
      ];

  return (
    <div className={active ? `${s.chip} ${s.on}` : s.chip} data-card-id={card.id}>
      <span className={s.label}>
        {isParam && <Icon name="sliders" size={12} />}
        {label}
      </span>
      {isParam ? (
        param ? (
          <ParamWidget param={param} label={label} value={live} onChange={(v) => ed.setParam(param.id, v)} />
        ) : (
          <span className={s.missing}>Parameter removed</span>
        )
      ) : (
        <ControlWidget projectId={ed.projectId} control={control} value={ed.controlValue(card.id)} onChange={(v) => ed.setControl(card.id, v)} />
      )}
      {active && <IconButton icon="x" size="sm" label={`Clear ${label}`} onClick={clear} />}
      {/* Edit, the default and Remove change the dashboard: a viewer sets the control's value, and that is all. */}
      {!ed.readOnly && <Menu label={`Actions for ${label}`} align="end" trigger={<IconButton icon="more-horizontal" size="sm" label={`Actions for ${label}`} />} items={items} />}
      {editing && !isParam && (
        <ControlDialog
          projectId={ed.projectId}
          existing={control}
          onClose={() => setEditing(false)}
          onDone={(next) => {
            ed.edit('Edit control', (d) => {
              const c = d.sheets.flatMap((sh) => sh.cards).find((x) => x.id === card.id);
              if (c) c.control = next;
            });
            ed.setControl(card.id, next.default);
          }}
        />
      )}
      {editing && isParam && param && (
        <ParamDialog
          existing={param}
          label={control.label}
          others={ed.doc.parameters.filter((p) => p.id !== param.id).map((p) => p.name)}
          onClose={() => setEditing(false)}
          onDone={(next, nextLabel) => {
            ed.edit('Edit parameter', (d) => {
              const i = d.parameters.findIndex((p) => p.id === param.id);
              if (i >= 0) d.parameters[i] = { ...next, id: param.id };
              const c = d.sheets.flatMap((sh) => sh.cards).find((x) => x.id === card.id);
              if (c?.control) c.control.label = nextLabel;
            });
            // The live value was picked against the OLD definition; the edited default is what the sheet shows now.
            ed.setParam(param.id, next.value);
          }}
        />
      )}
    </div>
  );
}

export function FilterBar() {
  const ed = useEditor();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chips = barControls(ed.cards);
  if (!chips.length) return null;
  const isOn = (c: Card) =>
    c.control?.kind === 'parameter'
      ? JSON.stringify(ed.paramValue(c.control.paramId ?? '')) !== JSON.stringify(ed.doc.parameters.find((p) => p.id === c.control?.paramId)?.value)
      : controlActive(c, ed.controlValue(c.id));
  const on = chips.filter(isOn).length;
  const clearAll = () => {
    for (const c of chips) {
      if (c.control?.kind === 'parameter') {
        const p = ed.doc.parameters.find((x) => x.id === c.control?.paramId);
        if (p) ed.setParam(p.id, p.value);
      } else ed.setControl(c.id, undefined);
    }
  };
  const list = (
    <div className={s.chips}>
      {chips.map((c) => (
        <Chip key={c.id} card={c} />
      ))}
    </div>
  );
  // On a phone the chips fold into one "Filters (N)" button and a sheet (layoutFilters.ts).
  if (ed.size === 'phone') {
    const n = chips.length;
    return (
      <div className={`${s.bar} ${s.sheetBar}`} role="group" aria-label="Filters">
        <Button
          size="sm"
          icon="filter"
          className={on ? s.sheetOn : undefined}
          aria-haspopup="dialog"
          aria-label={`Filters: ${n} ${n === 1 ? 'control' : 'controls'}, ${on} active`}
          onClick={() => setSheetOpen(true)}
        >
          Filters ({n}){on > 0 && <span className={s.badge}>{on} on</span>}
        </Button>
        <Dialog
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          size="sm"
          title="Filters"
          description={`${n} on this page · ${on ? `narrowing the figures (${on})` : 'showing everything'}`}
          footer={
            <>
              <Button variant="ghost" disabled={!on} onClick={clearAll}>
                Clear all
              </Button>
              <DialogClose asChild>
                <Button variant="primary">Done</Button>
              </DialogClose>
            </>
          }
        >
          {list}
        </Dialog>
      </div>
    );
  }
  return (
    <div className={s.bar} role="group" aria-label="Filters">
      {list}
      {on > 0 && (
        <Button size="sm" variant="ghost" onClick={clearAll}>
          Clear all
        </Button>
      )}
      <ResetControls />
    </div>
  );
}
