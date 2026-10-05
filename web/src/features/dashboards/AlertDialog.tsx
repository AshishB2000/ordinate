// "Alert me…" (legacy alerts.ts openAlertDialog): a rule that watches ONE
// number — a KPI card's — under the filters the reader has on. It opens on the
// figure itself (the server's dashboard:metric, so the dialog is provably about
// the number on screen), then Threshold / Change / Anomaly. "Test" asks the
// server whether the rule would fire now; Save stores it. Whether a rule fires
// is always decided by the server (src/analysis/alerts.ts).

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../../api/client';
import { useDatasetColumns } from '../../api/datasets';
import { fmtWith } from '../../charts/format';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { toast } from '../../ui/Toast';
import type { Card, Step } from '../analyses/api';
import { reason, useAlerts, useAlertWrite, type AlertRule } from './api';
import s from './Alerts.module.css';

export interface AlertSubject {
  datasetId: string;
  column: string;
  aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max';
  label?: string;
  metricId?: string;
  filters: Step[];
  analysisId?: string;
  cardId?: string;
}

/** A KPI card as the dialog's subject; null when it has nothing to watch. */
export function subjectOf(card: Card, filters: Step[], analysisId: string): AlertSubject | null {
  const m = card.metric;
  if (!m || !m.datasetId || !m.column) return null;
  return { datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, label: m.label, metricId: m.metricId, filters, analysisId, cardId: card.id };
}

const OPS = [
  { value: '<', label: 'falls below' },
  { value: '<=', label: 'is at or below' },
  { value: '>', label: 'rises above' },
  { value: '>=', label: 'is at or above' },
];
const DIRS = [
  { value: 'down', label: 'falls by' },
  { value: 'up', label: 'rises by' },
  { value: 'either', label: 'moves by' },
];

export function AlertDialog({ projectId, subject, onClose }: { projectId: string; subject: AlertSubject; onClose: () => void }) {
  const alerts = useAlerts(projectId);
  // The rule on the same number, if one exists: edit it rather than add a second (alertMeFromCard).
  const existing = alerts.data?.rules.find((r) => r.datasetId === subject.datasetId && r.metric.column === subject.column && r.metric.aggregation === subject.aggregation && !r.fromWatch);
  const label = subject.label || subject.column;
  // The figure as the card shows it: a saved metric's own display string, else the column's value (alerts.ts alFillSummary).
  const current = useQuery({
    queryKey: ['alert:figure', projectId, subject],
    queryFn: async () => {
      const r = (await rpc('dashboard:metric', { projectId, datasetId: subject.datasetId, column: subject.column, aggregation: subject.aggregation, filters: subject.filters })) as { ok: boolean; value: number | null };
      const shown = subject.metricId
        ? ((await rpc('metric:values', { projectId, ids: [subject.metricId], filters: subject.filters })) as { ok: boolean; display?: string }[])[0]
        : undefined;
      return { ok: r.ok, value: r.value, display: shown?.ok ? shown.display : undefined };
    },
  });
  const cols = useDatasetColumns(projectId, subject.datasetId);
  const dates = (cols.data?.columns ?? []).filter((c) => c.type === 'date');
  const write = useAlertWrite(projectId);
  const [mode, setMode] = useState<AlertRule['compare']>(existing?.compare ?? 'threshold');
  const [op, setOp] = useState<string>(existing?.threshold?.op ?? '<');
  const [value, setValue] = useState(existing?.threshold ? String(existing.threshold.value) : '');
  const [dir, setDir] = useState<string>(existing?.change?.direction ?? 'down');
  const [pct, setPct] = useState(existing?.change ? String(existing.change.pct) : '10');
  const [vs, setVs] = useState<string>(existing?.change?.vs ?? 'previous_refresh');
  const [period, setPeriod] = useState(existing?.change?.periodColumn ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [touched, setTouched] = useState(!!existing);
  const [test, setTest] = useState<{ busy?: boolean; text?: string; fire?: boolean; error?: boolean } | null>(null);
  const cur = current.data?.ok && typeof current.data.value === 'number' ? current.data.value : null;

  const auto =
    mode === 'threshold'
      ? `${label} ${OPS.find((o) => o.value === op)?.label ?? ''} ${value || '…'}`
      : mode === 'change'
        ? `${label} ${DIRS.find((d) => d.value === dir)?.label ?? ''} ${pct || '…'}%`
        : `Unusual values in ${label}`;
  const draft = (): AlertRule => ({
    id: existing?.id ?? crypto.randomUUID(),
    name: (touched ? name : auto).trim() || auto,
    datasetId: subject.datasetId,
    metric: {
      column: subject.column,
      aggregation: subject.aggregation,
      ...(subject.filters.length ? { filters: subject.filters } : {}),
      ...(subject.label && subject.label !== subject.column ? { label: subject.label } : {}),
      ...(subject.metricId ? { metricId: subject.metricId } : {}),
    },
    compare: mode,
    enabled: existing?.enabled !== false,
    ...(mode === 'threshold' ? { threshold: { op: op as '<', value: Number(value) } } : {}),
    ...(mode === 'change' ? { change: { pct: Number(pct), direction: dir as 'down', vs: vs as 'previous_refresh', ...(vs === 'previous_period' ? { periodColumn: period } : {}) } } : {}),
    ...(subject.analysisId ? { createdFrom: { analysisId: subject.analysisId, cardId: subject.cardId ?? '' } } : {}),
  });
  const complete = mode === 'anomaly' || (mode === 'threshold' ? value.trim() !== '' && Number.isFinite(Number(value)) : Number(pct) > 0 && (vs !== 'previous_period' || !!period));

  const runTest = async () => {
    setTest({ busy: true, text: 'Checking…' });
    try {
      const r = (await rpc('alerts:test', { projectId, rule: draft() as AlertRule & { [k: string]: unknown } })) as { ok: boolean; fire: boolean; message: string };
      setTest(r.ok ? { fire: r.fire, text: `${r.fire ? 'Would fire' : 'Would not fire'}${r.message ? ` — ${r.message}` : ''}` } : { error: true, text: 'That rule is not complete.' });
    } catch (err) {
      setTest({ error: true, text: reason(err, 'Could not test the rule.') });
    }
  };
  const save = () =>
    write.mutate(
      { channel: 'alerts:save', input: { projectId, rule: draft() as AlertRule & { [k: string]: unknown } } },
      {
        onSuccess: () => {
          toast('Alert saved', { kind: 'success' });
          onClose();
        },
        onError: (e) => setTest({ error: true, text: reason(e, 'That rule is not complete.') }),
      },
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Edit alert' : 'Alert me…'}
      footer={
        <>
          <Button size="sm" onClick={() => void runTest()} disabled={!complete || test?.busy}>
            Test
          </Button>
          <span className={s.grow} />
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save} disabled={!complete} loading={write.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className={s.alSummary}>
        <span className={s.alLabel}>{label}</span>
        <span className={s.alValue}>{current.isPending ? '…' : (current.data?.display ?? (cur === null ? '—' : fmtWith(cur, 'auto')))}</span>
      </div>
      <Tabs value={mode} onValueChange={(v) => setMode(v as AlertRule['compare'])}>
        <TabList label="Kind of alert">
          <Tab value="threshold">Threshold</Tab>
          <Tab value="change">Change</Tab>
          <Tab value="anomaly">Anomaly</Tab>
        </TabList>
        <TabPanel value="threshold">
          <div className={s.alRow}>
            <Select label="When it" value={op} onValueChange={setOp} options={OPS} />
            <Input label="Value" inputMode="decimal" value={value} placeholder={cur === null ? '' : String(Math.round(cur))} onChange={(e) => setValue(e.target.value)} />
          </div>
        </TabPanel>
        <TabPanel value="change">
          <div className={s.alRow}>
            <Select label="When it" value={dir} onValueChange={setDir} options={DIRS} />
            <Input label="Percent" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
          </div>
          <div className={s.alRow}>
            <Select
              label="Compared with"
              value={vs}
              onValueChange={setVs}
              options={[
                { value: 'previous_refresh', label: 'the previous refresh' },
                { value: 'previous_period', label: 'the previous period', disabled: !dates.length },
              ]}
            />
            {vs === 'previous_period' && <Select label="Date column" value={period || null} onValueChange={setPeriod} options={dates.map((d) => ({ value: d.name, label: d.name }))} />}
          </div>
          {!dates.length && <p className={s.note}>This dataset has no date column, so only the previous refresh can be compared.</p>}
        </TabPanel>
        <TabPanel value="anomaly">
          <p className={s.note}>Fires when a refresh brings values the app’s anomaly detector flags as unusual for this column — no number to choose.</p>
        </TabPanel>
      </Tabs>
      <Input
        label="Name"
        value={touched ? name : auto}
        onChange={(e) => {
          setTouched(true);
          setName(e.target.value);
        }}
      />
      {test && (
        <p className={test.error ? `${s.alTest} ${s.alTestBad}` : test.fire ? `${s.alTest} ${s.alTestFire}` : s.alTest} role="status">
          {test.text}
        </p>
      )}
    </Dialog>
  );
}
