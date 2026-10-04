// The Properties flyout for the selected card (legacy authoringProps.ts,
// cardKinds.ts renderKindProps, layoutKinds.ts group / divider props). Every
// field here lives on the dashboard record, so every change is an ordinary
// undoable edit. A VISUAL's fields, type and format belong to the saved visual
// and are edited in the Visuals builder — editing one changes it everywhere it
// is used, which the panel says.

import { Link } from 'react-router';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Button, buttonClass } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Input, Textarea } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { Icon } from '../../../ui/icons/Icon';
import type { Card } from '../api';
import { vizLabel } from '../VisualTile';
import { builderFor } from './AddVisual';
import { removeCards } from './arrange';
import { useEditor } from './context';
import { KIND_LABEL } from './ControlDialog';
import type { Doc } from './doc';
import { removeTab } from './geometry';
import { KpiCompare } from './KpiProps';
import { MetricLink } from './MetricLink';
import s from './Properties.module.css';

/** Edit the selected card in place (looked up by id in the draft — the record object changes with every edit). */
function useCardEdit(card: Card) {
  const ed = useEditor();
  return (label: string, fn: (c: Card, d: Doc) => void, coalesce = false) =>
    ed.edit(
      label,
      (d) => {
        const c = d.sheets[ed.sheet].cards.find((x) => x.id === card.id);
        if (c) fn(c, d);
      },
      coalesce,
    );
}

function describeDefault(control: NonNullable<Card['control']>): string {
  const d = control.default;
  if (!d) return 'none';
  if ('values' in d) return d.values.length ? `${d.values.length} value(s)` : 'none';
  if ('value' in d) return d.value || 'none';
  if ('preset' in d) return d.preset.replace(/_/g, ' ');
  return [d.from, d.to].filter(Boolean).join(' – ') || 'none';
}

function ControlProps({ card }: { card: Card }) {
  const ed = useEditor();
  const set = useCardEdit(card);
  const control = card.control as NonNullable<Card['control']>;
  const sets = useDatasets(ed.projectId);
  const cols = useDatasetColumns(ed.projectId, control.datasetId || undefined);
  const live = ed.controlValue(card.id);
  if (control.kind === 'parameter') {
    return <p className={s.note}>A parameter chip. Edit the parameter from its chip’s ⋯ menu above the sheet; the label is below.</p>;
  }
  return (
    <>
      <p className={s.note}>Kind: {KIND_LABEL[control.kind] ?? control.kind} (fixed after creation).</p>
      <Select
        label="Dataset"
        value={control.datasetId}
        options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
        onValueChange={(v) => {
          // A new dataset invalidates the live value and the stored default.
          set('Change control dataset', (c) => {
            if (!c.control) return;
            c.control.datasetId = v;
            delete c.control.default;
          });
          ed.setControl(card.id, undefined);
        }}
      />
      <Select
        label="Column"
        value={control.column}
        options={(cols.data?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
        onValueChange={(v) => {
          set('Change control column', (c) => {
            if (!c.control) return;
            c.control.column = v;
            delete c.control.default;
          });
          ed.setControl(card.id, undefined);
        }}
      />
      <p className={s.note}>Default: {describeDefault(control)}</p>
      <div className={s.row}>
        <Button size="sm" disabled={!live} onClick={() => set('Set control default', (c) => void (c.control && live && (c.control.default = live)))}>
          Use current selection as default
        </Button>
        <Button size="sm" variant="ghost" disabled={!control.default} onClick={() => set('Clear control default', (c) => void delete c.control?.default)}>
          Clear default
        </Button>
      </div>
      <p className={s.note}>Try the control on the sheet, then use the button above to save its current selection as the default. Just trying it never changes the saved dashboard on its own.</p>
    </>
  );
}

function GroupProps({ card }: { card: Card }) {
  const ed = useEditor();
  const set = useCardEdit(card);
  if (card.type === 'container' && card.container) {
    const c = card.container;
    return (
      <>
        <Input label="Title" value={c.title} placeholder="Container" onChange={(e) => set('Rename container', (x) => void (x.container && (x.container.title = e.target.value)), true)} />
        <Select
          label="Background"
          value={c.background}
          options={[
            { value: 'subtle', label: 'Subtle' },
            { value: 'surface', label: 'Card' },
            { value: 'accent', label: 'Accent tint' },
            { value: 'none', label: 'None' },
          ]}
          onValueChange={(v) => set('Container background', (x) => void (x.container && (x.container.background = v)))}
        />
        <Select
          label="Padding"
          value={c.padding}
          options={[
            { value: 'none', label: 'None' },
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Medium' },
            { value: 'lg', label: 'Large' },
          ]}
          onValueChange={(v) => set('Container padding', (x) => void (x.container && (x.container.padding = v)))}
        />
        <Checkbox label="Readers can collapse it" checked={c.collapsible} onCheckedChange={(v) => set('Container collapsible', (x) => void (x.container && (x.container.collapsible = v)))} />
        <p className={s.note}>Drag a card inside to add it; drag it out to take it out. Moving the group moves everything in it.</p>
      </>
    );
  }
  const items = card.tabs?.items ?? [];
  return (
    <>
      {items.map((t, i) => (
        <div key={t.id} className={s.tabRow}>
          <Input
            label={`Tab ${i + 1}`}
            value={t.name}
            onChange={(e) => set('Rename tab', (x) => void (x.tabs && (x.tabs.items[i].name = e.target.value || `Tab ${i + 1}`)), true)}
          />
          {items.length > 1 && (
            <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove tab ${t.name}`} onClick={() => set('Remove tab', (x, d) => removeTab(d.sheets[ed.sheet].cards, x, t.id))} />
          )}
        </div>
      ))}
      {items.length < 8 && (
        <Button size="sm" icon="plus" onClick={() => set('Add tab', (x) => void x.tabs?.items.push({ id: crypto.randomUUID(), name: `Tab ${items.length + 1}` }))}>
          Add tab
        </Button>
      )}
      <p className={s.note}>Drag a card inside to add it; drag it out to take it out. Moving the group moves everything in it.</p>
    </>
  );
}

export function Properties() {
  const ed = useEditor();
  const card = ed.cards.find((c) => c.id === ed.selected);
  if (!card) return <p className={s.hint}>Select a card on the sheet to edit its properties.</p>;
  return <CardProps key={card.id} card={card} />;
}

function CardProps({ card }: { card: Card }) {
  const ed = useEditor();
  const set = useCardEdit(card);
  const def = card.type === 'visual' && card.visualId ? ed.visuals.get(card.visualId) : undefined;
  const remove = () => {
    ed.edit('Remove card', (d) => {
      const sh = d.sheets[ed.sheet];
      sh.cards = removeCards(sh.cards, [card.id]);
    });
    ed.select(null);
  };
  return (
    <div className={s.props}>
      <section className={s.section} aria-label="Display settings">
        <h3 className={s.h}>Display settings</h3>
        {card.type === 'visual' &&
          (def ? (
            <>
              <p className={s.visualLine}>
                <strong>{def.name || 'Untitled visual'}</strong> · {vizLabel(def.chartType)}
              </p>
              <Link className={buttonClass('secondary', 'sm')} to={builderFor(ed.projectId, def.id)}>
                <Icon name="pencil" />
                <span>Edit in the Visuals builder</span>
              </Link>
              <p className={s.note}>Fields, chart type, format, interactions and tile actions are the visual’s own and are edited in the Visuals builder.</p>
            </>
          ) : (
            <p className={s.note}>The visual this card showed was deleted. Remove the card, or add another visual.</p>
          ))}
        {card.type === 'metric' && card.metric && (
          <>
            <Input label="Label" value={card.metric.label ?? ''} placeholder={card.metric.column} onChange={(e) => set('Edit KPI label', (c) => void (c.metric && (c.metric.label = e.target.value)), true)} />
            <MetricLink card={card} />
            <KpiCompare key={card.id} card={card} />
          </>
        )}
        {card.type === 'text' && (
          <>
            <Input label="Heading" value={card.heading ?? ''} onChange={(e) => set('Edit text', (c) => void (c.heading = e.target.value), true)} />
            <Textarea label="Text" rows={6} value={card.text ?? ''} hint="{{name}} shows a parameter’s value." onChange={(e) => set('Edit text', (c) => void (c.text = e.target.value), true)} />
          </>
        )}
        {card.type === 'control' && card.control && (
          <>
            <Input label="Label" value={card.control.label} onChange={(e) => set('Edit control label', (c) => void (c.control && (c.control.label = e.target.value)), true)} />
            <ControlProps card={card} />
          </>
        )}
        {card.type === 'divider' && (
          <Select
            label="Style"
            value={card.divider?.style ?? 'line'}
            options={[
              { value: 'line', label: 'A line' },
              { value: 'spacer', label: 'Empty space' },
            ]}
            onValueChange={(v) => set('Change divider', (c) => void (c.divider = { style: v === 'spacer' ? 'spacer' : 'line' }))}
          />
        )}
        {(card.type === 'container' || card.type === 'tabs') && <GroupProps card={card} />}
        {['nav', 'image', 'stats', 'summary'].includes(card.type) && <p className={s.note}>This card kind is edited where the dashboard is viewed.</p>}
      </section>
      {card.type !== 'control' && (
        <section className={s.section} aria-label="Layout">
          <h3 className={s.h}>Layout</h3>
          <p className={s.note}>Drag the card to move it, or drag its right/bottom edge to resize. With the card focused, arrow keys move it and shift+arrows resize it.</p>
        </section>
      )}
      {def && (
        <section className={s.section} aria-label="Sharing">
          <h3 className={s.h}>Sharing</h3>
          <p className={s.note}>This is a saved visual. Editing its fields changes it everywhere it is used.</p>
        </section>
      )}
      <Button variant="danger" icon="trash" onClick={remove}>
        Remove card
      </Button>
    </div>
  );
}
