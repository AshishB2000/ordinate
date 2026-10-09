// The builder's stage: the chart-type chips and the chart's controls, the
// sample note, and the chart itself — where a click on a mark opens the rows
// behind it (drill.ts wireDrillClick), a constant reference line can be
// dragged, and ⌥-click annotates a mark (chartAnnotations.ts, through
// `annotationHooks`).

import { useEffect, useState } from 'react';
import { annotationHooks } from '../../charts/annotations';
import type { ChartHandle } from '../../charts/Chart';
import type { Cx } from '../../charts/types';
import { SkeletonBlock } from '../../ui/Skeleton';
import { AsOfCaption } from '../../ui/AsOf';
import { ErrorState } from '../../ui/States';
import { newId, type Overlay } from './analytics/AnalyticsPane';
import { sharedData } from './api';
import type { Builder } from './builderState';
import { ChartControls } from './ChartControls';
import { ChartPicker } from './ChartPicker';
import { ChartStage, StageNote } from './ChartStage';
import { DrillPanel, type DrillTarget } from './drill/DrillPanel';
import { markAt } from './drill/mark';
import { chartCanRender, GRID_TYPES, needsText, PICKER_POOL } from './eligibility';
import { NameDialog } from './NameDialog';
import s from './Builder.module.css';

export function Stage({ projectId, b }: { projectId: string; b: Builder }) {
  const [chart, setChart] = useState<ChartHandle | null>(null);
  const [extras, setExtras] = useState<string[]>([]);
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [annotating, setAnnotating] = useState<{ label: string; series: number } | null>(null);
  const { data, fit, reply, current, hasGeo, recommended } = b;

  // The chart's authoring gestures, while this builder is open.
  const { setOverlays } = b;
  useEffect(() => {
    annotationHooks.onOverlayDragged = (id, value) =>
      Number.isFinite(value) && setOverlays((list) => list.map((o) => (o.id === id ? { ...o, value: { type: 'constant', value } } : o)));
    annotationHooks.onAnnotateAt = (label, series) => setAnnotating({ label, series });
    return () => {
      delete annotationHooks.onOverlayDragged;
      delete annotationHooks.onAnnotateAt;
    };
  }, [setOverlays]);

  const target = (mark: DrillTarget['mark'], steps: Cx[] = []): DrillTarget => ({
    name: b.label,
    projectId,
    datasetId: b.datasetId,
    encoding: b.eff,
    filters: [...b.live, ...steps],
    mark,
  });
  // `series` is a split value only when the encoding splits; on a multi-measure chart it is a legend entry.
  const onMark = (c: ChartHandle, e: MouseEvent, steps: Cx[], seriesName?: string) => {
    if (e.altKey) return; // ⌥-click annotates
    const m = markAt(c, e);
    if (!m) return;
    const split = !!b.eff.series;
    setDrill(target({ category: m.category, ...(split && (m.series ?? seriesName) ? { series: m.series ?? seriesName } : {}) }, steps));
  };
  const drawable = !!fit && !!current && !GRID_TYPES.has(current) && current !== 'table' && !current.startsWith('map_') && chartCanRender(current, fit, hasGeo);

  return (
    <section className={s.stage} aria-label="Chart">
      <div className={s.stageHead}>
        {fit && recommended.length > 0 && (
          <ChartPicker recommended={recommended} pool={PICKER_POOL} data={fit} selected={current} extras={extras} onSelect={b.pickType} onExtras={setExtras} />
        )}
        <div className={s.slot}>
          {drawable && (
            <ChartControls
              type={current}
              data={{ ...fit!, dataShape: reply?.recommendedShape }}
              overrides={b.overrides}
              chart={chart}
              onPatch={b.patch}
              menu={{
                name: b.label,
                explain: b.explain,
                drill: () => setDrill(target(null)),
                sharedData: () => sharedData({ projectId, datasetId: b.datasetId, encoding: b.eff, filters: b.live }),
                format: { data: fit ?? null, measures: b.measures, scope: b.scope },
              }}
            />
          )}
        </div>
      </div>
      {(reply?.sample?.note || reply?.asOf) && (
        <div className={s.stageNotes}>
          {reply.sample?.note && (
            <p className={s.sample} role="status" title={reply.sample.by ? `Stratified by ${reply.sample.by}. Saving the visual and every dashboard use all rows.` : reply.sample.note}>
              {reply.sample.note}
            </p>
          )}
          {/* How fresh the preview's figures are (L0.2). */}
          <AsOfCaption asOf={reply.asOf} className={s.asOf} />
        </div>
      )}
      <div className={b.preview.isFetching && reply ? `${s.area} ${s.loading}` : s.area} data-chart-type={current || undefined} data-chart-editable="">
        {!b.complete ? (
          <StageNote>Pick a category and at least one measure to draw a chart.</StageNote>
        ) : b.preview.isError && !reply ? (
          <ErrorState compact heading={3} title="Could not compute the visual" message={b.preview.error.message} onRetry={() => void b.preview.refetch()} />
        ) : !reply || !data ? (
          <SkeletonBlock label="Computing the visual" />
        ) : recommended.length === 0 ? (
          <StageNote>Pick a category and at least one measure to draw a chart.</StageNote>
        ) : (
          <ChartStage
            projectId={projectId}
            type={current}
            reply={reply}
            overrides={b.drawn}
            canRender={chartCanRender(current, fit, hasGeo)}
            needs={needsText(current, fit, hasGeo)}
            label={b.label}
            onChart={setChart}
            onMark={onMark}
            onPivotSort={(sort) => {
              const pivot = b.enc.pivot as Record<string, unknown> | undefined;
              if (pivot) b.setEnc({ ...b.enc, pivot: { ...pivot, sort } });
            }}
            exportData={() => sharedData({ projectId, datasetId: b.datasetId, encoding: b.eff, filters: b.live })}
          />
        )}
      </div>
      {drill && <DrillPanel target={drill} onClose={() => setDrill(null)} />}
      {annotating && (
        <NameDialog
          name=""
          title={`Annotate ${annotating.label}`}
          action="Add note"
          field="Note"
          onClose={() => setAnnotating(null)}
          onRename={async (text) => {
            const ov: Overlay = { id: newId(), kind: 'annotation', at: annotating.label, text };
            if (annotating.series > 0) ov.series = annotating.series;
            setOverlays((list) => [...list, ov]);
            setAnnotating(null);
          }}
        />
      )}
    </section>
  );
}
