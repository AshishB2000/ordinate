// "Incremental refresh" beside a dataset's refresh schedule — on the dataset
// page and in the connection workbench's rail. The desktop's panel
// (renderer/hub/incremental.ts until T8.1), ported: the cursor column (number
// or date only), update by key or append, the lookback, how the source is read,
// the every-Nth full run and the run log. It is what makes the 5- and
// 15-minute cadences and fresh on ask available.
//
// The server decides everything here (src/data/incrementalSettings.ts): which
// columns can be the cursor, whether the source can take it ("filtered after
// fetch" when it cannot — then it cannot be turned on), and it re-checks every
// save, answering a refusal with the catalog's sentence, which this shows.

import { useId, useState, type ReactNode } from 'react';
import { formatNumber } from '../../../../src/app/format.ts';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { RadioGroup, Switch } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { stamp } from './format';
import { HOW, lookbackFields, UNITS, useIncremental, useSaveIncremental, type IncrementalView } from './incrementalApi';
import s from './Incremental.module.css';

/** What the trigger reads of a dataset (`dataset:list`'s summary). */
export interface IncrementalTarget {
  id: string;
  name: string;
  originKind?: string;
  mode?: 'live';
  incrementalOn?: true;
}

const mark = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? formatNumber(v) : String(v));
const count = (v: number | null): string => (v === null ? '—' : formatNumber(v));

/** The run log, newest first: every figure is the record's. */
function RunLog({ view }: { view: IncrementalView }) {
  if (!view.log.length) {
    return <p className={s.muted}>No runs yet. The first refresh is a full one: it reads the whole source and sets the mark.</p>;
  }
  return (
    <div className={s.logWrap}>
      <table className={s.log} aria-label="Refresh log">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Run</th>
            <th scope="col" className={s.num}>Fetched</th>
            <th scope="col" className={s.num}>Inserted</th>
            <th scope="col" className={s.num}>Updated</th>
            <th scope="col">Mark</th>
          </tr>
        </thead>
        <tbody>
          {view.log.map((e, i) => (
            <tr key={`${e.at}-${i}`} title={e.note}>
              <td>{stamp(e.at)}</td>
              <td className={s.run}>
                <span className={e.mode === 'full' ? s.full : s.incr}>{e.mode === 'full' ? 'Full' : 'Incremental'}</span>
                <span className={s.how}>{e.mode === 'full' ? e.note || HOW.full : HOW[e.how] ?? e.how}</span>
              </td>
              <td className={s.num}>{count(e.fetched)}</td>
              <td className={s.num}>{count(e.inserted)}</td>
              <td className={s.num}>{count(e.updated)}</td>
              <td className={s.mark}>{mark(e.highWater)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How a run reads this source — or why it cannot be turned on. */
function SourceLine({ view }: { view: IncrementalView }) {
  if (view.blocked) {
    return (
      <p className={s.blocked} role="note">
        <Icon name="alert" size={16} />
        <span>
          {view.fetch === 'after' && <strong>Filtered after fetch. </strong>}
          {view.blocked}
        </span>
      </p>
    );
  }
  return (
    <p className={s.source}>
      <Icon name="filter" size={16} />
      <span>
        Each run asks {view.source} only for rows at or past the mark, then merges them into the stored copy. Every {view.fullEvery}th run is a full
        refresh, which catches deleted rows and anything the cursor missed.
      </span>
    </p>
  );
}

/** The settings, then `children` (the run log), then the actions — so Save sits at the foot of the panel. */
function Form({ projectId, datasetId, view, onSaved, children }: { projectId: string; datasetId: string; view: IncrementalView; onSaved: () => void; children: ReactNode }) {
  const st = view.settings;
  const firstCursor = st && view.cursorColumns.some((c) => c.name === st.cursorColumn) ? st.cursorColumn : (view.cursorColumns[0]?.name ?? '');
  const [enabled, setEnabled] = useState(!!st?.enabled);
  const [cursor, setCursor] = useState(firstCursor);
  const [mode, setMode] = useState<'upsert' | 'append'>(st && !st.keyColumn ? 'append' : 'upsert');
  const [key, setKey] = useState(st?.keyColumn ?? '');
  // The stored lookback is seconds for a date cursor and a count of ids for a number one.
  const storedType = st ? view.cursorColumns.find((c) => c.name === st.cursorColumn)?.type : undefined;
  const lb = lookbackFields(st && st.cursorColumn === firstCursor ? st.lookback : 0, storedType);
  const [amount, setAmount] = useState(lb.amount);
  const [unit, setUnit] = useState(lb.unit);
  const [error, setError] = useState('');
  const save = useSaveIncremental(projectId, datasetId);
  const lookbackHint = `${useId()}-lookback`;
  const isDate = view.cursorColumns.find((c) => c.name === cursor)?.type === 'date';
  // Blocked: only turning it off is possible (an older record may be on over such a source).
  const locked = !!view.blocked;
  const n = Number(amount || 0);
  const lookbackOk = Number.isFinite(n) && n >= 0;
  const go = () => {
    // Off ignores the lookback; the contract still wants a number, so an unreadable one goes as 0.
    const lookback = !lookbackOk ? 0 : isDate ? n * Number(unit) : n;
    setError('');
    save.mutate(
      { enabled, cursorColumn: cursor || st?.cursorColumn || '', mode, ...(mode === 'upsert' && key ? { keyColumn: key } : {}), lookback },
      {
        onSuccess: (r) => {
          if (!r.ok) return setError(r.error);
          toast(r.settings?.enabled ? `Incremental refresh is on.${r.nextFull ? ' The next refresh is a full one: it sets the mark.' : ''}` : 'Incremental refresh is off.', { kind: 'success' });
          onSaved();
        },
        onError: (err) => setError(`The change did not go through: ${err.message}`),
      },
    );
  };
  const canSave = locked ? !!st?.enabled && !enabled : !!cursor && (!enabled || ((mode === 'append' || !!key) && lookbackOk));
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) go();
      }}
    >
      <Switch
        label="Refresh incrementally"
        hint={locked ? 'Can only be turned off here.' : 'Fetch only the rows added or changed since the last refresh.'}
        checked={enabled}
        disabled={locked && !st?.enabled}
        onCheckedChange={setEnabled}
      />
      <fieldset className={s.fields} disabled={locked || !enabled}>
        <Select
          label="Cursor column"
          hint="A column that only grows: an update time or an increasing id."
          value={cursor}
          onValueChange={(v) => setCursor(v)}
          options={view.cursorColumns.map((c) => ({ value: c.name, label: `${c.name} · ${c.type}` }))}
          disabled={locked || !enabled}
          placeholder="No number or date column"
        />
        <RadioGroup
          label="A fetched row that is already stored"
          value={mode}
          onValueChange={(v) => setMode(v as 'upsert' | 'append')}
          disabled={locked || !enabled}
          options={[
            { value: 'upsert', label: 'Update it by key', hint: 'The row with the same key is replaced. For tables whose rows change.' },
            { value: 'append', label: 'Append new rows', hint: 'Rows are only ever added, like an event log. Re-read rows are not added twice.' },
          ]}
        />
        {mode === 'upsert' && (
          <Select
            label="Key column"
            value={key || null}
            onValueChange={setKey}
            options={view.keyColumns.map((c) => ({ value: c, label: c }))}
            placeholder="Pick the column that identifies a row"
            disabled={locked || !enabled}
          />
        )}
        <div>
          <div className={s.lookback}>
            <Input
              size="sm"
              type="number"
              min={0}
              step="any"
              label="Lookback"
              aria-describedby={lookbackHint}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={locked || !enabled}
              className={s.amount}
            />
            {isDate ? (
              <Select size="sm" aria-label="Lookback unit" value={unit} onValueChange={setUnit} options={UNITS.map((u) => ({ value: u.value, label: u.label }))} disabled={locked || !enabled} className={s.unit} />
            ) : (
              <span className={s.ids}>ids</span>
            )}
          </div>
          <p id={lookbackHint} className={s.hint}>
            {isDate ? 'Re-read this much before the mark, to catch rows that arrived late.' : 'Re-read this many ids before the mark.'}
          </p>
        </div>
      </fieldset>
      {st?.enabled && view.nextFull && (
        <p className={s.next}>
          <Badge tone="warn" icon="history">
            Next refresh: full
          </Badge>
          <span>{view.nextFull}.</span>
        </p>
      )}
      {children}
      {error && (
        <p className={s.error} role="alert">
          <Icon name="alert" size={12} />
          {error}
        </p>
      )}
      <div className={s.actions}>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Body({ projectId, datasetId, onSaved }: { projectId: string; datasetId: string; onSaved: () => void }) {
  const q = useIncremental(projectId, datasetId);
  if (q.isPending) return <SkeletonRows rows={5} label="Loading the incremental refresh settings" />;
  if (q.isError) return <ErrorState heading={3} title="The settings could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  return (
    <div className={s.body}>
      <SourceLine view={q.data} />
      <Form projectId={projectId} datasetId={datasetId} view={q.data} onSaved={onSaved}>
        <section className={s.section} aria-label="Refresh log">
          <h3 className={s.h}>Refresh log</h3>
          <RunLog view={q.data} />
        </section>
      </Form>
    </div>
  );
}

/** The trigger and its panel. Only a dataset imported from a connection can refresh incrementally; a Live one is asked each time. */
export function IncrementalButton({ projectId, d, wide }: { projectId: string; d: IncrementalTarget; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  if (d.originKind !== 'connection' || d.mode === 'live') return null;
  const on = !!d.incrementalOn;
  return (
    <>
      <Button
        size="sm"
        variant={wide ? 'ghost' : 'secondary'}
        icon="layers"
        className={wide ? s.wideTrigger : undefined}
        aria-label={`Incremental refresh for ${d.name}: ${on ? 'on' : 'off'}`}
        onClick={() => setOpen(true)}
      >
        Incremental {on ? 'on' : 'off'}
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(false)}
          size="md"
          title={`Incremental refresh · ${d.name}`}
          description="Fetch only the rows added since the last refresh, instead of the whole table. It is what lets a schedule run every 5 or 15 minutes, and what fresh on ask pulls."
        >
          <Body projectId={projectId} datasetId={d.id} onSaved={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}
