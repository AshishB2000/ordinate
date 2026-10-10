// "Explain this change" — the side panel a chart point opens (a right-click on
// the point, or the tile's ⋯ → "Explain a change…", which starts at the chart's
// latest period). The reader picks the PERIOD and what it is COMPARED WITH from
// lists the server sent — the chart's own buckets — and everything below is
// <DriversView>: the server's sentence with its figures, the dimensions ranked
// by how much they explain, the contributors as signed bars, a ratio's rate and
// mix, and the actions.
//
// NOTHING HERE COMPUTES A FIGURE or a period: a pick is sent back as the label
// the server gave, and the server answers with the comparison. A refusal is the
// server's sentence — never an empty panel.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../../ui/Button';
import { Drawer } from '../../../ui/Dialog';
import { Select } from '../../../ui/Select';
import { Skeleton } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import type { ParamPayload, Step, VisualDef } from '../../analyses/api';
import { LiveRefusal } from '../../live/LiveOff';
import { liveRefusalOf } from '../../live/refusal';
import { DriversPending, DriversView } from '../drivers/DriversView';
import { useExplainPoint, type PointRequest } from './api';
import type { ChartPoint } from './pointAt';
import s from './Explain.module.css';

/** What a tile hands over: the SAME definition, filters and view state that drew it, and the point (or none). */
export interface ExplainTarget {
  name: string;
  projectId: string;
  datasetId: string;
  encoding: VisualDef['encoding'];
  filters: readonly Step[];
  params: ParamPayload;
  asOf?: string;
  currency?: string;
  point: Partial<ChartPoint>;
  /** A viewer's panel offers nothing that saves. */
  readOnly: boolean;
}

export function ExplainPanel({ target, onClose }: { target: ExplainTarget; onClose: () => void }) {
  const navigate = useNavigate();
  // The reader's picks, as the labels the server listed. Absent = the server's default (latest period; the one before it).
  const [pick, setPick] = useState<{ bucket?: string; baseline?: string }>({ bucket: target.point.bucket });
  const request = useMemo<PointRequest>(
    () => ({
      datasetId: target.datasetId,
      encoding: target.encoding,
      filters: [...target.filters],
      params: target.params,
      ...(target.asOf ? { asOf: target.asOf } : {}),
      ...(target.currency ? { currency: target.currency } : {}),
      point: {
        ...(pick.bucket !== undefined ? { bucket: pick.bucket } : {}),
        ...(target.point.series !== undefined ? { series: target.point.series } : {}),
        ...(pick.baseline !== undefined ? { baseline: pick.baseline } : {}),
      },
    }),
    [target, pick],
  );
  const q = useExplainPoint(target.projectId, request);
  const r = q.data;
  const busy = q.isPending || q.isPlaceholderData;
  const periods = r?.periods ?? [];
  const bucket = pick.bucket ?? r?.bucket ?? null;
  const baselines = r?.ok ? r.baselines : [];
  const live = liveRefusalOf(q.isError ? q.error : r);

  return (
    <Drawer open wide onOpenChange={(o) => !o && onClose()} title={`Explain a change · ${target.name}`} description="What drove the change between two periods of this chart">
      <div className={s.panel}>
        {q.isPending ? (
          <div className={s.controls} aria-hidden="true">
            <Skeleton className={s.skelPick} />
            <Skeleton className={s.skelPick} />
          </div>
        ) : (
          periods.length > 0 && (
            <div className={s.controls} role="group" aria-label="The two periods">
              <Select label="Period" value={bucket} options={periods.map((p) => ({ value: p.label, label: p.text }))} onValueChange={(v) => setPick({ bucket: v })} />
              <Select
                label="Compared with"
                value={r?.ok ? (pick.baseline ?? r.baseline) : null}
                options={baselines.map((b) => ({ value: b.label, label: b.text }))}
                placeholder="Nothing earlier"
                disabled={!baselines.length}
                onValueChange={(v) => setPick({ ...(bucket !== null ? { bucket } : {}), baseline: v })}
              />
            </div>
          )
        )}
        {busy ? (
          <DriversPending />
        ) : live !== null ? (
          <div className={`${s.state} ${s.framed}`}>
            <LiveRefusal message={live} projectId={target.projectId} datasetId={target.datasetId} />
          </div>
        ) : q.isError || !r ? (
          <div className={s.state}>
            <ErrorState title="This change could not be explained" message={q.isError ? q.error.message : 'The server sent no answer.'} onRetry={() => void q.refetch()} heading={3} />
          </div>
        ) : !r.ok ? (
          <div className={s.state}>
            <EmptyState icon="info" title="This change can’t be explained" heading={3}>
              {r.error}
            </EmptyState>
          </div>
        ) : (
          <DriversView
            key={`${r.bucket}|${r.baseline}`}
            projectId={target.projectId}
            request={r.result.spec}
            readOnly={target.readOnly}
            actions={(res) => (
              <Button icon="external-link" onClick={() => void navigate(`/analytics/${target.projectId}/${target.datasetId}/drivers`, { state: { request: res.spec } })}>
                Open in Analytics
              </Button>
            )}
          />
        )}
      </div>
    </Drawer>
  );
}
