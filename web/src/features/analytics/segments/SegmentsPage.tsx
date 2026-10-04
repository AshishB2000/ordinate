// /analytics/:projectId/:datasetId/segments — Find segments (segments.ts): two
// tabs, k-means over number columns and the RFM preset. A run is a server JOB
// (kind 'analysis'): its progress and Cancel come from the Jobs stream the
// shell already holds open — the job for THIS dataset is the one shown.
//
// Every figure on the page is the server's (src/ipc/segments.ts); this file
// picks the columns and lays the answers out.

import { useState } from 'react';
import { formatNumber } from '../../../../../src/app/format.ts';
import { rpc } from '../../../api/client';
import type { DatasetColumns } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { ErrorState } from '../../../ui/States';
import { SkeletonRows } from '../../../ui/Skeleton';
import { Tab, TabList, Tabs } from '../../../ui/Tabs';
import { DatasetRoute, WorkbenchHead } from '../Workbench';
import { call, useSegmentFeatures, type FitReply, type SegmentsInfo } from '../api';
import { fmtNum } from '../format';
import { Progress, RunError, useDatasetJob } from './SegmentsParts';
import { RfmTab } from './SegmentsRfm';
import { KmeansResults } from './SegmentsResults';
import a from '../Analytics.module.css';
import s from './Segments.module.css';

const REASON: Record<string, string> = { 'id-like': 'looks like an id', 'near-constant': 'nearly constant' };

function Kmeans({ projectId, datasetId, info }: { projectId: string; datasetId: string; info: SegmentsInfo }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(info.features.filter((f) => f.checked).map((f) => f.name)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; soft?: boolean }>({ text: '' });
  const [result, setResult] = useState<Extract<FitReply, { ok: true }> | null>(null);
  const job = useDatasetJob(datasetId, busy);
  const n = picked.size;
  const rows = info.rowCount > info.sampleCap ? `an even ${fmtNum(info.sampleCap)} of ${fmtNum(info.rowCount)} rows are fitted, every row is assigned` : `${fmtNum(info.rowCount)} rows`;

  async function run() {
    setBusy(true);
    setErr({ text: '' });
    const features = info.features.map((f) => f.name).filter((f) => picked.has(f));
    const res = await call<Extract<FitReply, { ok: true }>>(rpc('segments:fit', { projectId, datasetId, features }), 'Could not find segments.');
    setBusy(false);
    if (!res.ok) setErr(res.cancelled ? { text: 'Stopped — nothing was changed.', soft: true } : { text: res.error });
    else setResult(res);
  }

  return (
    <>
      <section className={s.card} aria-labelledby="sg-cols-h">
        <div className={s.cardHead}>
          <h2 className={s.cardH} id="sg-cols-h">
            Columns to compare
          </h2>
          <p className={s.hint}>
            Each column is put on the same scale, then rows that are alike are grouped. The number of segments, 2 to 8, is the one with the best silhouette score. Ticked by default: every number column the profile does not flag.
          </p>
        </div>
        <div className={s.chips} role="group" aria-labelledby="sg-cols-h">
          {info.features.map((f) => {
            const on = picked.has(f.name);
            const why = f.reason ? REASON[f.reason] || f.reason : '';
            return (
              <label key={f.name} className={[s.chip, on && s.isOn].filter(Boolean).join(' ')} title={why ? `Not ticked: ${why}` : undefined}>
                <input
                  type="checkbox"
                  className={s.chipBox}
                  checked={on}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(f.name);
                    else next.delete(f.name);
                    setPicked(next);
                  }}
                />
                <span>{f.name}</span>
                {why && <span className={s.chipWhy}>{why}</span>}
              </label>
            );
          })}
        </div>
        {!info.features.length ? (
          <p className={s.note}>This dataset has no number columns, so there is nothing to compare. RFM works on a date and an amount.</p>
        ) : info.otherColumns ? (
          <p className={s.note}>{`${info.otherColumns} text or date column${info.otherColumns === 1 ? ' is' : 's are'} not listed — segments compare numbers.`}</p>
        ) : null}
        <div className={s.runRow}>
          <Button variant="primary" icon="play" disabled={n < 2 || busy} onClick={() => void run()}>
            Find segments
          </Button>
          <span className={s.runHint}>{n < 2 ? 'Pick at least two columns.' : `${n} columns · ${rows}`}</span>
        </div>
        {busy && <Progress job={job} />}
        <RunError text={err.text} soft={err.soft} />
      </section>
      <KmeansResults key={result ? JSON.stringify(result.result.step) : 'none'} projectId={projectId} datasetId={datasetId} datasetName={info.name} reply={result} />
    </>
  );
}

function Segments({ projectId, datasetId, ds }: { projectId: string; datasetId: string; ds: DatasetColumns }) {
  const q = useSegmentFeatures(projectId, datasetId);
  const [tab, setTab] = useState('kmeans');
  const info = q.data && q.data.ok ? q.data : null;
  let body;
  if (q.isPending) body = <SkeletonRows rows={4} label="Reading the columns…" />;
  else if (!info) {
    body = (
      <ErrorState
        title="This dataset could not be read"
        message={q.data && !q.data.ok ? q.data.error : q.error?.message || 'Go back and open it again.'}
        onRetry={() => void q.refetch()}
      />
    );
  }
  return (
    <div className={a.wb}>
      <WorkbenchHead
        icon="layers"
        title="Find segments"
        sub={`${ds.name} · ${formatNumber(ds.rowCount)} rows`}
        projectId={projectId}
        datasetId={datasetId}
        kind="segments"
        back={{ to: `/data/${projectId}/${datasetId}`, label: `Back to ${ds.name}` }}
      />
      <div className={s.page}>
        <Tabs value={tab} onValueChange={setTab}>
          <TabList label="Segmentation method">
            <Tab value="kmeans">Segments (k-means)</Tab>
            <Tab value="rfm">Customers (RFM)</Tab>
          </TabList>
        </Tabs>
        {/* Both stay mounted (hidden), as the desktop's do: a fit survives a look at RFM. */}
        <div className={s.tabp} role="tabpanel" aria-label="Segments (k-means)" hidden={tab !== 'kmeans'}>
          {body ?? <Kmeans projectId={projectId} datasetId={datasetId} info={info as SegmentsInfo} />}
        </div>
        <div className={s.tabp} role="tabpanel" aria-label="Customers (RFM)" hidden={tab !== 'rfm'}>
          {body ?? <RfmTab projectId={projectId} datasetId={datasetId} info={info as SegmentsInfo} />}
        </div>
      </div>
    </div>
  );
}

export default function SegmentsPage() {
  return (
    <DatasetRoute title="Find segments">
      {(projectId, datasetId, ds) => <Segments key={datasetId} projectId={projectId} datasetId={datasetId} ds={ds} />}
    </DatasetRoute>
  );
}
