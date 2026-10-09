// The New relationship dialog (relationshipDialog.ts). Pick the MANY side
// (rows that look something up) and the ONE side (the lookup); the server
// ranks every column pair by name, type and a sampled match rate, and the best
// pair arrives preselected with the cardinality its data supports. Saving
// counts matches over the full tables — the numbers the list shows.

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDatasetColumns, type DatasetSummary } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { call, useWrite, type Relationship, type Suggestion } from './api';
import { formatNumber, pctText } from './format';
import s from './Data.module.css';
import ms from './Model.module.css';

type Cardinality = Relationship['cardinality'];
const KINDS = [
  { value: 'many_to_one', label: 'Many to one — many rows share one lookup row' },
  { value: 'one_to_one', label: 'One to one — each row has exactly one match' },
] as const;

export function RelationshipDialog({ projectId, datasets: all, onClose }: { projectId: string; datasets: DatasetSummary[]; onClose: (savedId?: string) => void }) {
  // A Live dataset keeps its rows in the warehouse (L2.6): relating it matches rows, so it needs a copy.
  const datasets = all.filter((d) => d.mode !== 'live');
  const liveCount = all.length - datasets.length;
  const [fromDs, setFromDs] = useState(datasets[0]?.id ?? '');
  const [toDs, setToDs] = useState(datasets[1]?.id ?? '');
  const [fromCol, setFromCol] = useState<string | null>(null);
  const [toCol, setToCol] = useState<string | null>(null);
  const [kind, setKind] = useState<Cardinality>('many_to_one');
  const [error, setError] = useState('');
  const fromCols = useDatasetColumns(projectId, fromDs);
  const toCols = useDatasetColumns(projectId, toDs);
  const same = fromDs === toDs;
  const sug = useQuery({
    queryKey: ['relationship:suggest', projectId, fromDs, toDs],
    queryFn: async () => {
      const r = (await call('relationship:suggest', { projectId, fromId: fromDs, toId: toDs })) as ({ ok: true } & Suggestion) | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    enabled: !!fromDs && !!toDs && !same,
  });
  // The best pair, preselected — once per pair of datasets.
  useEffect(() => {
    const best = sug.data?.best;
    if (!best) return;
    setFromCol(best.from);
    setToCol(best.to);
    if (best.cardinality) setKind(best.cardinality);
  }, [sug.data]);

  // A pair is worth offering when its values meet, or its names clearly agree.
  const offered = (sug.data?.candidates ?? []).filter((c) => (c.rate ?? 0) > 0 || c.name >= 0.6).slice(0, 5);
  const best = sug.data?.best;
  const toName = datasets.find((d) => d.id === toDs)?.name ?? 'The lookup';
  const save = useWrite('relationship:save', ['relationship:list'], {
    quiet: true,
    onDone: (r: { ok?: boolean; error?: string; relationship?: Relationship }) => {
      if (!r.ok || !r.relationship) return setError(r.error || 'Could not save the relationship.');
      const rel = r.relationship;
      const n = (id: string) => datasets.find((d) => d.id === id)?.name ?? 'dataset';
      toast(`Related ${n(rel.from.datasetId)} to ${n(rel.to.datasetId)} on ${rel.from.column} — ${pctText(rel.matchPct)} matched.`, { kind: 'success' });
      onClose(rel.id);
    },
  });
  const dsOptions = datasets.map((d) => ({ value: d.id, label: d.name }));
  const colOptions = (q: typeof fromCols) => (q.data?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name} · ${c.type}` }));
  const pickPair = (from: string, to: string) => {
    setFromCol(from);
    setToCol(to);
  };
  const onSugKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = offered[(i + step + offered.length) % offered.length];
    pickPair(next.from, next.to);
    (e.currentTarget.parentElement?.children[(i + step + offered.length) % offered.length] as HTMLElement | undefined)?.focus();
  };
  const ready = !same && !!fromCol && !!toCol;
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New relationship"
      description="Each row of the many side looks up one row of the one side — orders to the region they ship to."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={() => {
              setError('');
              save.mutate({ projectId, relationship: { from: { datasetId: fromDs, column: fromCol! }, to: { datasetId: toDs, column: toCol! }, cardinality: kind } });
            }}
          >
            Save relationship
          </Button>
        </>
      }
    >
      {liveCount > 0 && (
        <p className={s.note} role="note">
          {liveCount === 1 ? 'One Live dataset is not offered: relating it matches rows, and its rows stay in the warehouse. Make a copy of it to relate the copy.' : `${formatNumber(liveCount)} Live datasets are not offered: relating one matches rows, and their rows stay in the warehouse. Make a copy to relate it.`}
        </p>
      )}
      <div className={ms.relSides}>
        <div className={ms.relSide}>
          <Select label="Many side" hint="The rows that look something up" value={fromDs} options={dsOptions} onValueChange={(v) => { setFromDs(v); setFromCol(null); }} />
          <Select label="Key column" value={fromCol} options={colOptions(fromCols)} placeholder={fromCols.isPending ? 'Loading columns…' : 'Choose a column'} onValueChange={setFromCol} />
        </div>
        <span className={ms.relArrow} aria-hidden="true">
          <Icon name="arrow-right" size={20} />
        </span>
        <div className={ms.relSide}>
          <Select label="One side" hint="The lookup: regions, products, customers" value={toDs} options={dsOptions} onValueChange={(v) => { setToDs(v); setToCol(null); }} />
          <Select label="Matches column" value={toCol} options={colOptions(toCols)} placeholder={toCols.isPending ? 'Loading columns…' : 'Choose a column'} onValueChange={setToCol} />
        </div>
      </div>
      <div className={s.popLabel} id="rel-sug-head">
        Suggested keys
      </div>
      {same ? (
        <p className={s.muted} role="status">Pick two different datasets.</p>
      ) : sug.isPending ? (
        <p className={s.muted} role="status">Checking which columns match…</p>
      ) : sug.isError ? (
        <p className={s.rowError} role="alert">{sug.error.message}</p>
      ) : offered.length === 0 ? (
        <p className={s.muted}>No column pair looks related. Choose the two columns yourself.</p>
      ) : (
        <div className={ms.relSug} role="radiogroup" aria-labelledby="rel-sug-head">
          {offered.map((c, i) => {
            const on = c.from === fromCol && c.to === toCol;
            const why = [c.name === 1 ? 'Same name' : c.name >= 0.6 ? 'Similar names' : '', c.typeMatch ? 'same type' : 'different types'].filter(Boolean).join(' · ');
            return (
              <div
                key={`${c.from}→${c.to}`}
                role="radio"
                aria-checked={on}
                tabIndex={on || (i === 0 && !offered.some((x) => x.from === fromCol && x.to === toCol)) ? 0 : -1}
                className={`${ms.relSugItem} ${on ? ms.relSugOn : ''}`}
                onClick={() => pickPair(c.from, c.to)}
                onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter' ? (e.preventDefault(), pickPair(c.from, c.to)) : onSugKey(e, i))}
              >
                <span className={s.mono}>
                  {c.from} → {c.to}
                </span>
                <span className={ms.meter} aria-hidden="true">
                  <span style={{ width: `${c.ratePct ?? 0}%` }} />
                </span>
                <span className={s.meta}>{c.ratePct === null ? 'Not measured' : `${pctText(c.ratePct)} match`}</span>
                <span className={s.muted}>{why}</span>
              </div>
            );
          })}
        </div>
      )}
      <Select
        label="Kind"
        hint={best?.cardinality ? 'Chosen from the data.' : undefined}
        value={kind}
        options={KINDS}
        onValueChange={(v) => setKind(v as Cardinality)}
      />
      {best?.stats && best.stats.toKeys !== best.stats.toKeyed && (
        <p className={s.muted} role="status">
          {toName} repeats some {best.to} values — each lookup uses the first matching row.
        </p>
      )}
      {error && (
        <p className={s.rowError} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
