// Find segments — the RFM tab (segmentsRfm.ts): pick a customer id, an order
// date and an amount; every customer is scored 1–5 on recency, frequency and
// monetary value and lands in one of eleven named segments. The breakdown,
// the R × FM map it was scored on, and Save as dataset. Every figure is the
// server's (src/analysis/rfm.ts RfmResult), shares included.

import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button, buttonClass } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import { EmptyState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { call, type RfmResult, type SegmentsInfo } from '../api';
import { fmtNum, fmtShare } from '../format';
import { Card, Kpi, Progress, RunError, useDatasetJob } from './SegmentsParts';
import s from './Segments.module.css';

type Spec = { id: string; date: string; amount: string };

/** A segment's tone — its place in the canonical eleven (the server's order). */
function toneClass(r: RfmResult, name: string): string {
  const i = r.segments.findIndex((x) => x.name === name);
  return s[`t${i < 0 ? 10 : i}`];
}

function Table({ r }: { r: RfmResult }) {
  return (
    <Card id="sg-h-rfm-segs" title="Segments" hint="All eleven, with how many customers each holds and what they look like on average.">
      <div className={s.tableScroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col" className={s.num}>Customers</th>
              <th scope="col">Share</th>
              <th scope="col" className={s.num}>Days since last order</th>
              <th scope="col" className={s.num}>Orders</th>
              <th scope="col" className={s.num}>Spend</th>
            </tr>
          </thead>
          <tbody>
            {r.segments.map((x) => (
              <tr key={x.name} className={x.count ? undefined : s.isNone}>
                <th scope="row" className={s.rfmName}>
                  <span className={`${s.swatch} ${s.toned} ${toneClass(r, x.name)}`} aria-hidden="true" />
                  <span className={s.rfmText}>
                    <span className={s.rfmLabel}>{x.name}</span>
                    <span className={s.rfmMeaning}>{x.meaning}</span>
                  </span>
                </th>
                <td className={s.num}>{fmtNum(x.count)}</td>
                <td className={s.rfmShare}>
                  <span className={s.sizeTrack}>
                    <span className={`${s.sizeBar} ${s.toned} ${toneClass(r, x.name)}`} style={{ width: `${Math.max(x.count ? 1 : 0, x.share * 100)}%` }} />
                  </span>
                  <span className={s.rfmPct}>{fmtShare(x.share)}</span>
                </td>
                <td className={s.num}>{x.recency === null ? '—' : fmtNum(x.recency, 0)}</td>
                <td className={s.num}>{x.frequency === null ? '—' : fmtNum(x.frequency, 1)}</td>
                <td className={s.num}>{x.monetary === null ? '—' : fmtNum(x.monetary, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Grid({ r }: { r: RfmResult }) {
  return (
    <Card id="sg-h-rfm-map" title="The R × FM map" hint="Rows are the recency score, columns the average of the frequency and monetary scores. Each cell is one segment.">
      <table className={s.grid}>
        <caption>Customers by recency score and frequency-monetary score</caption>
        <thead>
          <tr>
            <td className={s.corner} />
            {[1, 2, 3, 4, 5].map((fm) => (
              <th key={fm} scope="col" className={s.axis}>{`FM ${fm}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.layout.map((row, ri) => (
            <tr key={ri}>
              <th scope="row" className={s.axis}>{`R ${5 - ri}`}</th>
              {row.map((seg, ci) => {
                const n = r.grid[ri][ci];
                return (
                  <td
                    key={ci}
                    className={[s.gridCell, s.toned, toneClass(r, seg), !n && s.isZero].filter(Boolean).join(' ')}
                    title={`R ${5 - ri} · FM ${ci + 1} — ${seg}: ${fmtNum(n)} ${n === 1 ? 'customer' : 'customers'}`}
                  >
                    <span className={s.cellN}>{fmtNum(n)}</span>
                    <span className={s.cellS}>{seg}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SaveDataset({ projectId, datasetId, spec, customers }: { projectId: string; datasetId: string; spec: Spec; customers: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string; rowCount: number } | null>(null);
  const client = useQueryClient();
  async function save() {
    setBusy(true);
    setErr('');
    const res = await call<{ ok: true; dataset: { id: string; name: string; rowCount: number } }>(
      rpc('segments:rfmSave', { projectId, datasetId, spec }),
      'Could not save the dataset.',
    );
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setSaved(res.dataset);
    void client.invalidateQueries({ queryKey: ['dataset:list', projectId] });
    toast(`Saved ${res.dataset.name}`, { kind: 'success' });
  }
  return (
    <Card
      id="sg-h-rfm-save"
      title="Save as a dataset"
      hint={`Writes one row per customer — id, recency, frequency, monetary, the three scores and the segment — as a new dataset of ${fmtNum(customers)} rows, ready for charts, dashboards and joins.`}
    >
      <div className={s.saveRow}>
        <Button variant="primary" icon="database" loading={busy} disabled={!!saved} onClick={() => void save()}>
          Save as dataset
        </Button>
      </div>
      {err && (
        <p className={s.error} role="alert">
          <Icon name="alert" />
          <span>{err}</span>
        </p>
      )}
      {saved && (
        <p className={s.saved} role="status">
          <Icon name="circle-check" />
          <span>{`Saved “${saved.name}” — ${fmtNum(saved.rowCount)} customers.`}</span>
          <Link className={buttonClass('secondary', 'sm')} to={`/data/${projectId}/${saved.id}`}>
            Open dataset
          </Link>
        </p>
      )}
    </Card>
  );
}

export function RfmTab({ projectId, datasetId, info }: { projectId: string; datasetId: string; info: SegmentsInfo }) {
  const [spec, setSpec] = useState<Spec>(info.rfm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; soft?: boolean }>({ text: '' });
  const [result, setResult] = useState<{ r: RfmResult; spec: Spec } | null>(null);
  const job = useDatasetJob(datasetId, busy);
  const ready = !!spec.id && !!spec.date && !!spec.amount && new Set([spec.id, spec.date, spec.amount]).size === 3;
  const opts = (cols: SegmentsInfo['columns']) => cols.map((c) => ({ value: c.name, label: c.name }));

  async function run() {
    setBusy(true);
    setErr({ text: '' });
    const res = await call<{ ok: true; result: RfmResult }>(rpc('segments:rfm', { projectId, datasetId, spec }), 'Could not score the customers.');
    setBusy(false);
    if (!res.ok) setErr(res.cancelled ? { text: 'Stopped — nothing was changed.', soft: true } : { text: res.error });
    else setResult({ r: res.result, spec });
  }

  const r = result?.r;
  return (
    <>
      <section className={s.card} aria-labelledby="sg-rfm-h">
        <div className={s.cardHead}>
          <h2 className={s.cardH} id="sg-rfm-h">
            Who, when and how much
          </h2>
          <p className={s.hint}>One row per order. Recency is counted from the latest order date in the data, so the same data scores the same way on any day.</p>
        </div>
        <div className={s.rfmFields}>
          <Select label="Customer id" placeholder="Pick a column" value={spec.id || null} options={opts(info.columns)} onValueChange={(v) => setSpec({ ...spec, id: v })} />
          <Select label="Order date" placeholder="Pick a column" value={spec.date || null} options={opts(info.columns)} onValueChange={(v) => setSpec({ ...spec, date: v })} />
          <Select
            label="Amount"
            placeholder="Pick a column"
            value={spec.amount || null}
            options={opts(info.columns.filter((c) => c.type === 'number'))}
            onValueChange={(v) => setSpec({ ...spec, amount: v })}
          />
        </div>
        <div className={s.runRow}>
          <Button variant="primary" icon="play" disabled={!ready || busy} onClick={() => void run()}>
            Score customers
          </Button>
          <span className={s.runHint}>Rows without an id, a readable date or a number are left out and counted.</span>
        </div>
        {busy && <Progress job={job} />}
        <RunError text={err.text} soft={err.soft} />
      </section>
      {!r || !result ? (
        <EmptyState icon="user" title="Score customers by recency, frequency and spend" heading={2}>
          Every customer gets a 1–5 score for how recently, how often and how much they buy, and one of eleven named segments — from Champions to Lost. Save the scores as a dataset and chart them like any other.
        </EmptyState>
      ) : (
        <div className={s.results}>
          <div className={s.kpis}>
            <Kpi value={fmtNum(r.customers)} label="customers" />
            <Kpi value={fmtNum(r.used)} label="orders scored" />
            <Kpi value={r.asOf || '—'} label="recency measured from" />
            <Kpi value={fmtNum(r.skipped)} label={r.skipped === 1 ? 'row left out' : 'rows left out'} />
          </div>
          <Table r={r} />
          <div className={`${s.pair} ${s.pairWide}`}>
            <Grid r={r} />
            <SaveDataset key={JSON.stringify(result.spec)} projectId={projectId} datasetId={datasetId} spec={result.spec} customers={r.customers} />
          </div>
        </div>
      )}
    </>
  );
}
