// Gallery: buttons, text fields, selects and choice controls in every state.

import { useState } from 'react';
import { Button, IconButton } from '../Button';
import { Checkbox, RadioGroup, Switch } from '../Choice';
import { Combobox } from '../Combobox';
import { Input, Textarea } from '../Field';
import { Select, type SelectOption } from '../Select';
import { Cell, Grid, Section } from './Demo';
import g from './Gallery.module.css';

const SOURCES: SelectOption[] = [
  { value: 'csv', label: 'CSV file' },
  { value: 'pg', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sheets', label: 'Google Sheets', disabled: true },
  { value: 'url', label: 'URL / API (JSON)' },
];
// A long list — customDropdown existed for ~130 model names.
const MODELS: SelectOption[] = Array.from({ length: 130 }, (_, i) => ({
  value: `m${i}`,
  label: `model-${String(i + 1).padStart(3, '0')}`,
}));

export function ButtonsDemo() {
  return (
    <Section id="buttons" title="Button · IconButton" note="Four variants × three heights; hover and focus shown statically.">
      <Grid>
        <Cell label="primary / secondary / ghost / danger">
          <Button variant="primary" icon="plus">
            New visual
          </Button>
          <Button icon="upload">Import</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon="trash">
            Delete
          </Button>
        </Cell>
        <Cell label="sm / md / lg">
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
        </Cell>
        <Cell label="hover · focus-visible (static)">
          <Button className={g.demoHover}>Hovered</Button>
          <Button className={g.demoFocus}>Focused</Button>
          <Button variant="primary" className={g.demoFocus}>
            Focused
          </Button>
        </Cell>
        <Cell label="disabled / loading">
          <Button variant="primary" disabled>
            Save
          </Button>
          <Button disabled>Export</Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button loading>Refreshing</Button>
        </Cell>
        <Cell label="trailing icon / block">
          <Button iconEnd="chevron-down">Sort</Button>
          <div className={g.blockDemo}>
            <Button variant="primary" block>
              Continue
            </Button>
          </div>
        </Cell>
        <Cell label="IconButton: ghost sm/md/lg · primary · hover · focus · disabled">
          <IconButton icon="more-horizontal" label="More" size="sm" />
          <IconButton icon="star" label="Star" />
          <IconButton icon="settings" label="Settings" size="lg" />
          <IconButton icon="send" label="Send" variant="primary" />
          <IconButton icon="pencil" label="Rename" className={g.demoHover} />
          <IconButton icon="copy" label="Duplicate" className={g.demoFocus} />
          <IconButton icon="trash" label="Delete" disabled />
        </Cell>
      </Grid>
    </Section>
  );
}

export function FieldsDemo() {
  const [text, setText] = useState('Revenue by region');
  const [src, setSrc] = useState<string | null>('pg');
  const [none, setNone] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>('m41');
  const [combo, setCombo] = useState<string | null>(null);
  return (
    <Section id="fields" title="Input · Textarea · Select · Combobox" note="Every field shares one 32px box, so they line up with buttons.">
      <Grid>
        <Cell label="default / with icon">
          <Input label="Name" value={text} onChange={(e) => setText(e.target.value)} />
          <Input aria-label="Search datasets" icon="search" placeholder="Search datasets" />
        </Cell>
        <Cell label="hover · focus (static) / sm">
          <Input aria-label="Hovered" placeholder="Hovered" className={g.demoBoxHover} />
          <Input aria-label="Focused" placeholder="Focused" className={g.demoBoxFocus} />
          <Input aria-label="Small" placeholder="Small" size="sm" />
        </Cell>
        <Cell label="hint / error / disabled">
          <Input label="Table name" hint="Letters, digits and underscores." defaultValue="sales_2026" />
          <Input label="Port" error="Must be a number between 1 and 65535." defaultValue="54x2" />
          <Input label="Host" disabled defaultValue="db.internal" />
        </Cell>
        <Cell label="Textarea: default / error / disabled">
          <Textarea label="Description" placeholder="What is this dataset for?" rows={3} />
          <Textarea label="Rules" error="Too long: 4,096 characters at most." rows={2} defaultValue="Always…" />
          <Textarea label="Locked" disabled rows={2} defaultValue="Read-only" />
        </Cell>
        <Cell label="Select: value / placeholder / disabled option">
          <Select label="Source" value={src} onValueChange={setSrc} options={SOURCES} />
          <Select label="Nothing chosen" value={none} onValueChange={setNone} options={SOURCES} placeholder="Pick a source" />
        </Cell>
        <Cell label="Select: error / disabled / sm">
          <Select label="Source" value={null} onValueChange={setNone} options={SOURCES} error="Choose a source first." />
          <Select label="Source" value="csv" onValueChange={setNone} options={SOURCES} disabled />
          <Select aria-label="Small" size="sm" value="csv" onValueChange={setNone} options={SOURCES} />
        </Cell>
        <Cell label="Select: a long list (130) — opens bounded, scrolls inside, flips near the edge">
          <div className={g.selectHost}>
            <Select label="Model" value={model} onValueChange={setModel} options={MODELS} />
          </div>
        </Cell>
        <Cell label="Combobox: type to filter · empty match · error">
          <Combobox label="Dataset" value={combo} onValueChange={setCombo} options={SOURCES} placeholder="Find a source" />
          <Combobox label="Owner" value={null} onValueChange={setCombo} options={[]} emptyText="No people match" />
          <Combobox label="Join key" value={null} onValueChange={setCombo} options={SOURCES} error="Pick a key column." />
        </Cell>
      </Grid>
    </Section>
  );
}

export function ChoicesDemo() {
  const [a, setA] = useState(false);
  const [b, setB] = useState(true);
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [r, setR] = useState('day');
  return (
    <Section id="choices" title="Checkbox · Switch · Radio" note="Native inputs: Space toggles, arrows move between radios.">
      <Grid>
        <Cell label="Checkbox: off / on / mixed / disabled / hint">
          <Checkbox label="Include headers" checked={a} onCheckedChange={setA} />
          <Checkbox label="Trim whitespace" checked={b} onCheckedChange={setB} />
          <Checkbox label="All columns" checked={false} indeterminate onCheckedChange={() => {}} />
          <Checkbox label="Locked on" checked disabled onCheckedChange={() => {}} />
          <Checkbox label="Locked off" checked={false} disabled onCheckedChange={() => {}} />
          <Checkbox label="Skip blank rows" hint="Rows where every cell is empty." checked onCheckedChange={() => {}} />
        </Cell>
        <Cell label="Switch: on / off / disabled / focus (static)">
          <Switch label="Auto-refresh" hint="Schedules run while a tab is open." checked={on} onCheckedChange={setOn} />
          <Switch label="Sound" checked={off} onCheckedChange={setOff} />
          <Switch label="Desktop notifications" checked={false} disabled onCheckedChange={() => {}} />
          <Switch label="Focused" checked onCheckedChange={() => {}} className={g.demoSwitchFocus} />
        </Cell>
        <Cell label="RadioGroup: vertical / horizontal / error / disabled">
          <RadioGroup
            label="Granularity"
            value={r}
            onValueChange={setR}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week', hint: 'Weeks start on Monday.' },
              { value: 'month', label: 'Month' },
              { value: 'year', label: 'Year', disabled: true },
            ]}
          />
          <RadioGroup
            label="Align"
            orientation="horizontal"
            value="left"
            onValueChange={() => {}}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
          />
          <RadioGroup
            label="Join type"
            value=""
            onValueChange={() => {}}
            error="Choose how the tables join."
            orientation="horizontal"
            options={[
              { value: 'inner', label: 'Inner' },
              { value: 'left', label: 'Left' },
            ]}
          />
          <RadioGroup
            label="Disabled group"
            disabled
            value="a"
            onValueChange={() => {}}
            orientation="horizontal"
            options={[
              { value: 'a', label: 'One' },
              { value: 'b', label: 'Two' },
            ]}
          />
        </Cell>
      </Grid>
    </Section>
  );
}
