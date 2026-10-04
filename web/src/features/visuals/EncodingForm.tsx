// The encoding form (encodingForm.ts + encodingRelated.ts): Category (text and
// date columns, numbers under "Bin numeric…" — the server bins those into ten
// ranges), the date grain and the period overlay for a date category, the
// measures, Split by and Map regions. Columns of related datasets join each
// picker as "From <dataset>" groups. Controlled: it reads an encoding and
// reports a new one; what an edit MEANS (recompute, save) is the builder's.
//
// The grain and the "top 50" note are the server's: the reply says which grain
// it picked and whether it capped a long tail, and the form only shows them.

import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Select, type SelectOption } from '../../ui/Select';
import type { Agg, Encoding, Measure, Preview, RelatedCol } from './api';
import { MapRegions } from './MapRegions';
import { AGG_LABELS, AGGS, categoryType, fieldKey, GRAINS, measureColumns, measureFrom, parseKey, type Column } from './model';
import s from './Builder.module.css';

const heading = (label: string, key: string): SelectOption => ({ value: `__h:${key}`, label, disabled: true });

/** Related columns as one heading + options per dataset, nearest first (the server's order). */
function relatedOptions(related: readonly RelatedCol[], keep: (c: RelatedCol) => boolean): SelectOption[] {
  const out: SelectOption[] = [];
  let at = '';
  for (const c of related) {
    if (!keep(c)) continue;
    if (c.datasetId !== at) {
      at = c.datasetId;
      out.push(heading(`From ${c.group}`, c.datasetId));
    }
    // The dataset rides in the text too: the closed control shows the option, not its group.
    out.push({ value: c.key, label: `${c.column} · ${c.group}` });
  }
  return out;
}

export function EncodingForm({
  projectId,
  cols,
  related,
  encoding,
  info,
  onChange,
}: {
  projectId: string;
  cols: readonly Column[];
  related: readonly RelatedCol[];
  encoding: Encoding;
  /** The `category` block of the last reply: the grain the server used, its note. */
  info: Preview['category'] | undefined;
  onChange: (e: Encoding) => void;
}) {
  const set = (patch: Partial<Encoding>) => {
    const next: Encoding = { ...encoding, ...patch };
    for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  const dims = cols.filter((c) => c.type !== 'number');
  const nums = cols.filter((c) => c.type === 'number');
  const catOptions: SelectOption[] = [
    ...dims.map((c) => ({ value: c.name, label: c.name })),
    ...(nums.length ? [heading('Bin numeric…', 'bin'), ...nums.map((c) => ({ value: c.name, label: c.name }))] : []),
    ...relatedOptions(related, () => true),
  ];
  const isDate = categoryType(encoding, cols, related) === 'date';
  const measureOpts: SelectOption[] = [
    ...measureColumns(cols).map((c) => ({ value: c.name, label: c.name })),
    ...relatedOptions(related, (c) => c.type === 'number'),
  ];
  const seriesOpts: SelectOption[] = [
    { value: '', label: 'None' },
    ...dims.map((c) => ({ value: c.name, label: c.name })),
    ...relatedOptions(related, (c) => c.type !== 'number'),
  ];

  // The dimension moved: the grain belonged to the old column and the overlay to a date.
  const pickCategory = (v: string) => {
    const { column, datasetId } = parseKey(v);
    set({ category: column, categoryDatasetId: datasetId, grain: undefined });
  };
  const setMeasure = (i: number, m: Measure) => set({ values: encoding.values.map((x, j) => (j === i ? m : x)) });
  const firstMeasure = measureColumns(cols)[0]?.name ?? '';

  return (
    <div className={s.encoding}>
      <div className={s.row}>
        <Select label="Category" aria-label="Category (dimension)" value={fieldKey(encoding.category, encoding.categoryDatasetId)} options={catOptions} onValueChange={pickCategory} />
        {isDate && (
          <Select
            aria-label="Date grain"
            size="sm"
            placeholder="Auto"
            value={(encoding.grain as string | undefined) || info?.grain || null}
            options={GRAINS}
            onValueChange={(g) => set({ grain: g })}
          />
        )}
        {info?.note && <p className={s.note}>{info.note}</p>}
      </div>

      {isDate && (
        <div className={s.row}>
          <Select
            label="Compare"
            aria-label="Period overlay"
            value={encoding.overlay ?? ''}
            options={[
              { value: '', label: 'No period overlay' },
              { value: 'previous_year', label: 'Overlay: vs previous year' },
            ]}
            onValueChange={(v) => set({ overlay: v === 'previous_year' ? 'previous_year' : undefined })}
          />
          <p className={s.note}>Draws the same periods a year earlier as a muted series, on line and column charts.</p>
        </div>
      )}

      <div className={s.row} role="group" aria-labelledby="enc-measures">
        <span className={s.label} id="enc-measures">
          Measures
        </span>
        {encoding.values.map((m, i) => (
          <div key={i} className={s.valueRow}>
            {m.metricId ? (
              <span className={s.metric} title="A saved metric. Remove it to measure a column instead.">
                {m.column}
              </span>
            ) : (
              <>
                <div className={s.grow}>
                  <Select
                    aria-label="Measure column"
                    size="sm"
                    value={fieldKey(m.column, m.datasetId)}
                    options={measureOpts}
                    onValueChange={(v) => setMeasure(i, measureFrom(v, m.aggregation, m))}
                  />
                </div>
                <div className={s.agg}>
                  <Select
                    aria-label="Aggregation"
                    size="sm"
                    value={m.aggregation}
                    options={AGGS.map((a) => ({ value: a, label: AGG_LABELS[a] }))}
                    onValueChange={(a) => setMeasure(i, { ...m, aggregation: a as Agg })}
                  />
                </div>
              </>
            )}
            {m.calc && <Badge tone="accent">{String(m.calc.kind ?? 'calc').replace(/_/g, ' ')}</Badge>}
            <IconButton
              icon="x"
              size="sm"
              label="Remove measure"
              disabled={encoding.values.length <= 1}
              onClick={() => set({ values: encoding.values.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <Button size="sm" icon="plus" className={s.addSlot} onClick={() => set({ values: [...encoding.values, { column: firstMeasure, aggregation: 'sum' }] })}>
          Add measure
        </Button>
      </div>

      <div className={s.row}>
        <Select
          label="Split by"
          aria-label="Split/series column"
          value={encoding.series ? fieldKey(encoding.series, encoding.seriesDatasetId) : ''}
          options={seriesOpts}
          onValueChange={(v) => {
            const { column, datasetId } = parseKey(v);
            set({ series: column || undefined, seriesDatasetId: column ? datasetId : undefined });
          }}
        />
      </div>

      <MapRegions projectId={projectId} cols={cols} geo={encoding.geo} onChange={(geo) => set({ geo })} />
    </div>
  );
}
