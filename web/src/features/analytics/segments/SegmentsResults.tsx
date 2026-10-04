// The RESULTS of a k-means fit (segmentsView.ts): the headline figures,
// segment sizes, how k was chosen, where the segments sit on the first two
// principal components, the profile (each column's mean per segment against
// overall, with a deviation bar), and Save as column. Every number — sizes,
// shares, silhouettes, means, deviations, coordinates — is the server's.

import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button, buttonClass } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { EmptyState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { Plot, axes } from '../Plot';
import { call, type FitReply } from '../api';
import { fmtFixed, fmtMean, fmtNum, fmtShare } from '../format';
import { Card, Kpi } from './SegmentsParts';
import s from './Segments.module.css';

type Fit = Extract<FitReply, { ok: true }>;

/** Segment i's colour: the chart palette tokens, so both themes follow. */
const tone = (i: number) => `var(--chart-${(i % 8) + 1})`;

function DevCell({ mean, dev }: { mean: number | null; dev: number | null }) {
  const has = dev !== null && Number.isFinite(dev);
  const mag = has ? Math.abs(dev).toFixed(1) : '';
  const sd = !has ? '' : mag === '0.0' ? '0.0 SD' : `${dev >= 0 ? '+' : '−'}${mag} SD`;
  return (
    <td title={sd ? `${sd} from the overall mean` : undefined}>
      <div className={s.dev}>
        <span className={s.devVal}>{fmtMean(mean)}</span>
        <span className={s.devTrack} aria-hidden="true">
          <span className={s.devZero} />
          {has && <span className={`${s.devBar} ${dev >= 0 ? s.up : s.down}`} style={{ width: `${(Math.min(Math.abs(dev), 2) / 2) * 50}%` }} />}
        </span>
        <span className={has && Math.abs(dev) >= 0.25 ? `${s.devSd} ${s.strong}` : s.devSd}>{sd}</span>
      </div>
    </td>
  );
}

function SaveColumn({ projectId, datasetId, datasetName, fit }: { projectId: string; datasetId: string; datasetName: string; fit: Fit['result'] }) {
  const [column, setColumn] = useState(fit.step.column);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ column: string; steps: number } | null>(null);
  const [err, setErr] = useState('');
  const client = useQueryClient();
  async function save() {
    const name = column.trim();
    if (!name) {
      setErr('Name the column first.');
      return;
    }
    setBusy(true);
    setErr('');
    const res = await call<{ ok: true; column: string; steps: number }>(
      rpc('segments:saveColumn', { projectId, datasetId, step: { ...fit.step, column: name } }),
      'Could not save the column.',
    );
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setDone(res);
    void client.invalidateQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
    toast(`Added the “${res.column}” column to ${datasetName}`, { kind: 'success' });
  }
  return (
    <Card
      id="sg-h-save"
      title="Save as a column"
      hint={`Adds a Prepare step that stores this model — each column’s mean and spread and the ${fit.k} centroids — and assigns every row on each refresh. The column is text, so it works as a dimension in any chart, filter or pivot.`}
    >
      <div className={s.saveRow}>
        <div className={s.colName}>
          <Input label="Column name" value={column} disabled={!!done} maxLength={200} onChange={(e) => setColumn(e.target.value)} />
        </div>
        <Button variant="primary" icon="check" loading={busy} disabled={!!done} onClick={() => void save()}>
          Save as column
        </Button>
      </div>
      {err && (
        <p className={s.error} role="alert">
          <Icon name="alert" />
          <span>{err}</span>
        </p>
      )}
      {done && (
        <p className={s.saved} role="status">
          <Icon name="circle-check" />
          <span>{`Saved — “${done.column}” is now a column of ${datasetName}, step ${done.steps} in Prepare.`}</span>
          <Link className={buttonClass('secondary', 'sm')} to={`/data/${projectId}/${datasetId}`}>
            Open the dataset
          </Link>
        </p>
      )}
    </Card>
  );
}

export function KmeansResults({ projectId, datasetId, datasetName, reply }: { projectId: string; datasetId: string; datasetName: string; reply: Fit | null }) {
  if (!reply) {
    return (
      <EmptyState icon="layers" title="Group rows that are alike" heading={2}>
        Pick the columns that describe a row — spend, discount, units — and Find segments groups the rows that are alike, names each group after what sets it apart and plots them. Save the grouping as a column and it becomes an ordinary dimension for charts, filters and pivots.
      </EmptyState>
    );
  }
  const r = reply.result;
  const best = r.silhouettes.find((x) => x.k === r.k);
  const rows = r.names.map((name, i) => ({ name, n: r.sizes[i], share: reply.shares.sizes[i], i }));
  if (r.empty) rows.push({ name: 'No segment — a value is missing', n: r.empty, share: reply.shares.empty, i: -1 });
  const top = Math.max(0.0001, ...r.silhouettes.map((x) => x.score));
  const [v1, v2] = r.pca.variance;
  return (
    <div className={s.results}>
      <div className={s.kpis}>
        <Kpi value={String(r.k)} label="segments" />
        <Kpi value={best ? fmtFixed(best.score, 2) : '—'} label="silhouette score" />
        <Kpi value={fmtNum(r.fitted)} label={r.fitted < r.complete ? `rows fitted, of ${fmtNum(r.complete)}` : 'rows fitted'} />
        <Kpi value={fmtNum(r.empty)} label={r.empty === 1 ? 'row without a segment' : 'rows without a segment'} />
      </div>
      <div className={s.pair}>
        <div className={s.stack}>
          <Card id="sg-h-sizes" title="Segment sizes" hint="Every row, assigned to its nearest segment. Names come from the two columns that set each segment apart most.">
            <ol className={s.sizeList}>
              {rows.map((row) => (
                <li key={row.name} className={row.i < 0 ? `${s.size} ${s.isEmpty}` : s.size}>
                  <div className={s.sizeLabel}>
                    {row.i >= 0 && <span className={s.swatch} style={{ background: tone(row.i) }} aria-hidden="true" />}
                    <span className={s.sizeName}>{row.name}</span>
                  </div>
                  <div className={s.sizeTrack}>
                    <div className={s.sizeBar} style={{ width: `${Math.max(0.5, row.share * 100)}%`, ...(row.i >= 0 ? { background: tone(row.i) } : {}) }} />
                  </div>
                  <div className={s.sizeFig}>
                    <b>{fmtNum(row.n)}</b>
                    <span>{fmtShare(row.share)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
          <Card
            id="sg-h-k"
            title="How many segments"
            hint="The silhouette score says how much closer each row is to its own segment than to the next one, from −1 to 1. The highest wins; a tie goes to fewer segments."
          >
            <ul className={s.kList}>
              {r.silhouettes.map((x) => (
                <li key={x.k} className={x.k === r.k ? `${s.kRow} ${s.isChosen}` : s.kRow}>
                  <span>{`${x.k} segments`}</span>
                  <span className={s.kTrack}>
                    <span className={s.kBar} style={{ width: `${Math.max(1, (Math.max(0, x.score) / top) * 100)}%` }} />
                  </span>
                  <span className={s.kV}>{fmtFixed(x.score, 3)}</span>
                  {x.k === r.k ? <span className={s.kBadge}>chosen</span> : <span />}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <Card
          id="sg-h-map"
          className={s.map}
          title="Where the segments sit"
          hint={`Each dot is a row, placed on the two directions that spread the rows most (principal components: ${fmtShare(v1)} and ${fmtShare(v2)} of the variation).`}
        >
          <div className={s.scatter}>
            <Plot
                label={`Scatter of ${fmtNum(r.pca.points.length)} rows on the first two principal components, coloured by segment`}
                deps={[r]}
                config={(th) => ({
                  type: 'scatter',
                  data: {
                    datasets: r.names.map((name, i) => {
                      const c = th.palette[i % 8];
                      return {
                        label: name,
                        data: r.pca.points.filter((p) => p[2] === i).map((p) => ({ x: p[0], y: p[1] })),
                        backgroundColor: c,
                        borderColor: c,
                        borderWidth: 0,
                        pointRadius: 2.5,
                        pointHoverRadius: 4,
                      };
                    }),
                  },
                  options: {
                    scales: axes(th, `PC1 · ${fmtShare(v1)}`, `PC2 · ${fmtShare(v2)}`, true),
                    plugins: {
                      legend: { position: 'bottom', labels: { color: th.muted, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12 } },
                    },
                  },
                })}
              />
          </div>
        </Card>
      </div>
      <Card id="sg-h-profile" title="Profile" hint="Each column’s mean in each segment against the overall mean. Bars show how far off overall it sits, in standard deviations (capped at ±2).">
        <div className={s.tableScroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col" className={s.num}>
                  Overall
                </th>
                {r.names.map((n, i) => (
                  <th key={n} scope="col" className={s.segTh}>
                    <span className={s.swatch} style={{ background: tone(i) }} aria-hidden="true" />
                    <span>{n}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.features.map((f, j) => (
                <tr key={f}>
                  <th scope="row" className={s.feat}>
                    {f}
                  </th>
                  <td className={s.num}>{fmtMean(r.profile.overall[j])}</td>
                  {r.names.map((n, i) => (
                    <DevCell key={n} mean={r.profile.segments[i][j]} dev={r.profile.deviation[i][j]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <SaveColumn projectId={projectId} datasetId={datasetId} datasetName={datasetName} fit={r} />
    </div>
  );
}
