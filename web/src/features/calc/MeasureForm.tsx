// The MEASURE kind: a calculated measure is a saved metric whose definition is
// a formula (src/api/metrics.ts), written in the same editor a calculated
// column uses (../prepare/FormulaPieces) and saved through the Metrics tab's
// own save (../analyses/metrics/parts).
//
// The browser parses nothing. One `metric:check` per pause in typing answers
// everything shown here: the tokens that colour the text, the error and the
// span it underlines, whether the name is free, and the VALUE on the current
// data — computed by the resolver the saved metric will use, formatted by the
// server. A refusal is the server's sentence, beside the field it is about.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { Skeleton } from '../../ui/Skeleton';
import { Icon } from '../../ui/icons/Icon';
import { isFormula, type Metric, type MetricFormat, type MetricSummary } from '../analyses/metrics/api';
import { DirectionSelect, FormatFields, saveMetric, type Direction } from '../analyses/metrics/parts';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { useFunctionDocs, type Column } from '../prepare/api';
import { FormulaInput, FormulaSide, type FormulaInputHandle } from '../prepare/FormulaPieces';
import { AGG_DOCS, checkMetric, type MetricCheck } from './api';
import { QuickStarts } from './QuickStarts';
import f from '../prepare/Formula.module.css';
import c from './Calc.module.css';

/** Long enough that typing a formula is not a query per keystroke. */
const DEBOUNCE = 250;

export interface MeasureFormProps {
  projectId: string;
  datasetId: string;
  columns: readonly Column[];
  /** The project's metrics (every dataset's); this dataset's are offered as operands. */
  metrics: readonly MetricSummary[];
  /** A formula metric being edited. */
  existing?: MetricSummary;
  /** Opened from a chart: every operand must be this dataset's. */
  chart: boolean;
  onSaved: (metric: Metric) => void;
  onClose: () => void;
}

export function useMeasureForm({ projectId, datasetId, columns, metrics, existing, chart, onSaved, onClose }: MeasureFormProps): { body: ReactNode; footer: ReactNode } {
  const id = existing?.id ?? '';
  const [name, setName] = useState(existing?.name ?? '');
  const [formula, setFormula] = useState(existing && isFormula(existing.definition) ? existing.definition.formula : '');
  const [format, setFormat] = useState<MetricFormat>({ kind: 'number', decimals: 0, ...existing?.format });
  const [description, setDescription] = useState(existing?.description ?? '');
  const [direction, setDirection] = useState<Direction>(existing?.direction ?? '');
  const [check, setCheck] = useState<MetricCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState<{ error: string; field?: 'name' } | null>(null);
  const [saving, setSaving] = useState(false);
  const docs = useFunctionDocs();
  const input = useRef<FormulaInputHandle>(null);
  const seq = useRef(0);

  // One check per pause; a slower earlier reply never overwrites a newer one.
  const asked = JSON.stringify([formula, name.trim(), format.kind, format.decimals]);
  useEffect(() => {
    const [expression, named, kind, decimals] = JSON.parse(asked) as [string, string, MetricFormat['kind'], number];
    const mine = ++seq.current;
    if (!expression.trim()) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(() => {
      checkMetric({ projectId, datasetId, expression, ...(named ? { name: named } : {}), ...(id ? { id } : {}), format: { kind, decimals }, ...(chart ? { chart } : {}) }).then(
        (res) => mine === seq.current && (setCheck(res), setChecking(false)),
        () => mine === seq.current && (setCheck({ ok: false, valid: false, tokens: [], error: 'The formula could not be checked. Try again in a moment.' }), setChecking(false)),
      );
    }, DEBOUNCE);
    return () => clearTimeout(t);
  }, [asked, projectId, datasetId, id, chart]);

  const formulaError = check && !check.valid && formula.trim() ? (check.error ?? 'This formula cannot be calculated.') : '';
  const nameError = refused?.field === 'name' ? refused.error : name.trim() ? (check?.nameError ?? '') : '';
  const reason = !name.trim()
    ? 'Give the measure a name.'
    : !formula.trim()
      ? 'Write a formula first.'
      : checking || !check
        ? 'Checking…'
        : formulaError || nameError;

  async function save() {
    if (reason || saving) return;
    setSaving(true);
    const r = await saveMetric(projectId, id, datasetId, { name: name.trim(), definition: { formula: formula.trim() }, format, description, direction });
    setSaving(false);
    // In the dialog, beside its field: the work is still in these boxes.
    if ('error' in r) return setRefused(r);
    onSaved(r.metric);
    onClose();
  }

  const own = metrics.filter((m) => m.datasetId === datasetId && m.id !== id);
  const allDocs = AGG_DOCS.concat((docs.data ?? []).filter((d) => d.category !== 'lod'));
  const live = check && check.valid && !check.ok ? liveRefusalOf(check) : null;

  const body = (
    <div className={c.work}>
      <FormulaSide
        columns={columns}
        docs={allDocs}
        loading={docs.isPending}
        groups={own.length ? [{ title: 'Metrics', items: own.map((m) => ({ label: m.name, insert: `[${m.name}]`, title: m.definitionText })) }] : []}
        columnInsert={(col, type) => (type === 'number' ? `sum([${col}])` : `count([${col}])`)}
        onInsert={(text, back) => input.current?.insert(text, back)}
      />
      <div className={c.main}>
        <Input
          label="Name"
          placeholder="Margin %"
          hint="What the chart calls this series. Other formulas can use it as [Name]."
          error={nameError || undefined}
          value={name}
          maxLength={200}
          autoFocus
          onChange={(e) => (setName(e.target.value), setRefused(null))}
        />
        <QuickStarts
          measure
          columns={columns}
          metrics={own.map((m) => m.name)}
          onFill={(t) => {
            setFormula(t.expression);
            if (!name.trim()) setName(t.name);
            if (t.percent) setFormat((prev) => ({ ...prev, kind: 'percent', decimals: 1 }));
            setRefused(null);
          }}
        />
        <div className={c.block}>
          <span className={c.label} id="calc-formula-label">
            Formula
          </span>
          <FormulaInput
            ref={input}
            label="Formula"
            value={formula}
            onChange={(next) => (setFormula(next), setRefused(null))}
            tokens={check?.tokens ?? []}
            at={check && !check.valid ? (check.at ?? null) : null}
            columns={columns}
            docs={allDocs}
            refs={own.map((m) => ({ label: m.name, insert: `[${m.name}]`, sub: `metric · ${m.definitionText}` }))}
            invalid={!!formulaError}
            describedBy="calc-formula-msg"
            onSubmit={() => void save()}
          />
          <div className={f.msgs} id="calc-formula-msg" aria-live="polite">
            {formulaError ? (
              <p className={c.fieldError}>
                <Icon name="alert" size={12} />
                {formulaError}
              </p>
            ) : (
              <p className={c.hint}>Totals first, then arithmetic: sum([Profit]) / sum([Revenue]). Type [ for columns and metrics.</p>
            )}
            {refused && !refused.field && (
              <p className={c.fieldError} role="alert">
                <Icon name="alert" size={12} />
                {refused.error}
              </p>
            )}
          </div>
        </div>
        <div className={c.split}>
          <div className={c.fields}>
            <div className={c.pair}>
              <div className={c.block}>
                <span className={c.label}>Format</span>
                <FormatFields format={format} onChange={setFormat} />
              </div>
              {/* Which way is good news, for the surfaces that colour a change. */}
              <DirectionSelect value={direction} onChange={setDirection} bare />
            </div>
            <Input label="Description" placeholder="What this number means, for whoever reads it next" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </div>
          <aside className={c.preview} aria-label="Preview" aria-live="polite" aria-busy={checking || undefined}>
            <span className={c.previewHead}>Value on the current data</span>
            {!formula.trim() ? (
              <p className={c.previewEmpty}>Write a formula, or pick a quick start, to see what it comes to.</p>
            ) : !check ? (
              <span role="status" aria-label="Calculating the value">
                <Skeleton className={c.previewSkeleton} />
              </span>
            ) : live ? (
              <LiveRefusal message={live} projectId={projectId} datasetId={datasetId} />
            ) : check.valid && check.preview ? (
              <>
                <span className={checking ? `${c.previewValue} ${c.stale}` : c.previewValue}>{check.preview.display}</span>
                <span className={c.previewText}>{check.preview.definitionText}</span>
                <span className={c.previewNote}>{check.preview.asOf?.mode === 'live' ? 'Calculated by the warehouse, over all its rows.' : 'Calculated by the server, over every row.'}</span>
              </>
            ) : check.valid ? (
              <p className={c.fieldError}>
                <Icon name="alert" size={12} />
                {check.error ?? 'The value could not be calculated.'}
              </p>
            ) : (
              <>
                <span className={`${c.previewValue} ${c.stale}`}>—</span>
                <span className={c.previewText}>No value until the formula is fixed.</span>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );

  const footer = (
    <>
      <span className={f.hint}>
        <Kbd>⌘↵</Kbd> to save
      </span>
      <DialogClose asChild>
        <Button>Cancel</Button>
      </DialogClose>
      <span title={reason} className={f.saveWrap}>
        <Button variant="primary" disabled={!!reason} loading={saving} title={reason} onClick={() => void save()}>
          {id ? 'Save measure' : 'Create measure'}
        </Button>
      </span>
    </>
  );
  return { body, footer };
}
