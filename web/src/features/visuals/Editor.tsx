// The builder's editing state and layout (see ./BuilderPage.tsx). One draft —
// encoding, chart type, overrides, filters, overlays — previewed on the server
// 160 ms after the last edit; the chart stays up (dimmed) while the next one
// computes. Which chips show is CODE's call from the reply (./eligibility).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import type { ChartHandle } from '../../charts/Chart';
import { withGeoChartType } from '../../charts/maps/mapKinds';
import type { MapGeo } from '../../charts/maps/types';
import type { ChartDataShape, Overrides } from '../../charts/types';
import { Button } from '../../ui/Button';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useKeyStatus } from '../assistant/api';
import { pickDockProject, setDockOpen } from '../assistant/dockState';
import { rpc } from '../../api/client';
import { saveVisual, sharedData, updateVisual, usePreview, useRefreshVisuals, type Encoding, type FilterStep, type RelatedCol } from './api';
import { ChartControls, type Patch } from './ChartControls';
import { ChartPicker } from './ChartPicker';
import { ChartStage, StageNote } from './ChartStage';
import { chartCanRender, countNumericSeries, eligibleChartTypes, GRID_TYPES, needsText, PICKER_POOL } from './eligibility';
import { EncodingForm } from './EncodingForm';
import { categoryType, fitEncoding, suggestName, type Column } from './model';
import { NewVisualDialog } from './NewVisualDialog';
import { NameDialog } from './NameDialog';
import { Select } from '../../ui/Select';
import s from './Builder.module.css';

export interface Initial {
  visualId?: string;
  name: string;
  datasetId: string;
  encoding: Encoding;
  chartType: string;
  overrides: Overrides;
  filters: FilterStep[];
  analytics: Record<string, unknown>[];
}

/** `value`, settled for `ms` — the first value at once. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** What goes to the server: the grain and the overlay belong to a date category only; empty measures drop. */
function effective(enc: Encoding, isDate: boolean): Encoding {
  const e: Encoding = { ...enc, values: enc.values.filter((v) => v.column) };
  if (!isDate) {
    delete e.grain;
    delete e.overlay;
  }
  return e;
}

export function Editor({ projectId, datasets, columns, related, initial }: {
  projectId: string;
  datasets: DatasetSummary[];
  columns: Column[];
  related: RelatedCol[];
  initial: Initial;
}) {
  const navigate = useNavigate();
  const refresh = useRefreshVisuals(projectId);
  const ai = useKeyStatus();
  const [enc, setEnc] = useState(initial.encoding);
  const [chartType, setChartType] = useState(initial.chartType);
  const [overrides, setOverrides] = useState<Overrides>(initial.overrides);
  const [extras, setExtras] = useState<string[]>([]);
  const [chart, setChart] = useState<ChartHandle | null>(null);
  const [naming, setNaming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const filters = initial.filters;
  const analytics = initial.analytics;
  const { visualId, datasetId } = initial;
  const persist = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(persist.current), []);

  const isDate = categoryType(enc, columns, related) === 'date';
  const eff = useMemo(() => effective(enc, isDate), [enc, isDate]);
  const complete = !!eff.pivot || (!!eff.category && eff.values.length > 0);
  const wanted = useMemo(
    () => (complete ? { projectId, datasetId, encoding: eff, filters, ...(analytics.length ? { analytics } : {}) } : undefined),
    [complete, projectId, datasetId, eff, filters, analytics],
  );
  const preview = usePreview(useSettled(wanted, 160));
  const reply = complete ? preview.data : undefined;
  const data = reply?.data as (ChartDataShape & { geo?: MapGeo | null }) | undefined;

  // The chips: from the reply's shape and structure; a map reply is judged as its category's shape.
  const hasGeo = !!data?.geo;
  const shape = data?.geo ? (isDate ? 'time_series' : 'categorical') : (reply?.recommendedShape ?? 'unstructured');
  const recommended = data ? withGeoChartType(eligibleChartTypes(shape, countNumericSeries(data), (data.labels || []).length), data.geo) : [];
  const current = data && chartType && (recommended.includes(chartType) || chartCanRender(chartType, data, hasGeo)) ? chartType : (recommended[0] ?? '');
  const name = initial.name || 'New visual';

  const pickType = (t: string) => {
    // A calendar is one cell per DAY: an auto-grained axis would leave a handful of lonely cells.
    if (t === 'calendar' && isDate && enc.grain !== 'day') setEnc({ ...enc, grain: 'day' });
    setChartType(t);
  };

  const patch = (p: Patch) => {
    let next: Overrides;
    if (p.reset) next = {};
    else {
      next = { ...overrides, ...p };
      for (const k of Object.keys(p)) if (next[k] == null) delete next[k];
    }
    setOverrides(next);
    // A saved visual keeps its styling as it changes; a draft keeps it until the first Save.
    if (visualId) {
      window.clearTimeout(persist.current);
      persist.current = window.setTimeout(() => void updateVisual(projectId, visualId, { overrides: next }).then(() => refresh(visualId), () => undefined), 300);
    }
  };

  const save = async (finalName: string) => {
    const body = { name: finalName, chartType: current || chartType || 'column', encoding: { ...eff, ...(isDate && !eff.grain && reply?.category?.grain ? { grain: reply.category.grain } : {}) }, overrides, filters, analytics };
    if (visualId) await updateVisual(projectId, visualId, body);
    else await saveVisual({ projectId, datasetId, ...body });
    refresh(visualId);
    toast(`Saved “${finalName}”.`, { kind: 'success' });
    void navigate(`/visuals/${projectId}`);
  };

  const trySave = () => {
    if (GRID_TYPES.has(current) && !eff.pivot && !eff.cohort && !eff.eventFunnel) {
      toast(`${current === 'pivot' ? 'Pivot tables' : 'This grid'} can’t be built in the browser yet — pick another chart type to save.`, { kind: 'error' });
      return;
    }
    if (!complete) {
      toast('Pick a category and at least one measure before saving.', { kind: 'error' });
      return;
    }
    setNaming(true);
  };

  const explain = () =>
    void rpc('answer:explain', { projectId, tile: { datasetId, encoding: eff, filters, chartType: current, name: initial.name || suggestName(eff, current) } }).then(
      (r) => {
        const res = r as { ok: boolean; reason?: string };
        if (!res.ok) throw new Error(res.reason || 'This chart cannot be explained.');
        pickDockProject(projectId);
        setDockOpen(true);
      },
    ).catch((e: Error) => toast(e.message, { kind: 'error' }));

  const warnings = [...(reply?.warnings ?? [])];
  const loading = preview.isFetching && !!reply;

  return (
    <div className={s.builder}>
      <header className={s.head}>
        <Button icon="arrow-left" onClick={() => void navigate(`/visuals/${projectId}`)}>
          Back
        </Button>
        <h1 className={s.name}>{name}</h1>
        <div className={s.headActions}>
          <Select
            label="Dataset"
            className={s.dataset}
            size="sm"
            value={datasetId}
            options={datasets.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
            // Another dataset starts a fresh build — the open visual and its styling stay as saved.
            onValueChange={(id) => void navigate(`/visuals/${projectId}/new?dataset=${encodeURIComponent(id)}`)}
          />
          <Button
            size="sm"
            icon="sparkles"
            disabled={!ai.data?.isReady}
            title={ai.data && !ai.data.isReady ? 'The Assistant isn’t set up yet.' : undefined}
            onClick={() => setSuggesting(true)}
          >
            Suggest chart
          </Button>
          {visualId && (
            <Button size="sm" icon="history" title="Version history" onClick={() => void navigate(`/versions/${projectId}/visual/${visualId}`)}>
              History
            </Button>
          )}
          <Button variant="primary" onClick={trySave}>
            Save visual
          </Button>
        </div>
      </header>

      <div className={s.body}>
        <aside className={s.rail} aria-label="Encoding">
          <EncodingForm projectId={projectId} cols={columns} related={related} encoding={enc} info={reply?.category} onChange={setEnc} />
          {warnings.length > 0 && (
            <div className={s.warnings} role="status">
              {warnings.map((w, i) => (
                <div key={i} className={s.warning}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className={s.stage} aria-label="Chart">
          <div className={s.stageHead}>
            {data && recommended.length > 0 && (
              <ChartPicker recommended={recommended} pool={PICKER_POOL} data={data} selected={current} extras={extras} onSelect={pickType} onExtras={setExtras} />
            )}
            <div className={s.slot}>
              {data && current && !GRID_TYPES.has(current) && current !== 'table' && !current.startsWith('map_') && chartCanRender(current, data, hasGeo) && (
                <ChartControls
                  type={current}
                  data={{ ...data, dataShape: reply?.recommendedShape }}
                  overrides={overrides}
                  chart={chart}
                  onPatch={patch}
                  menu={{ name: initial.name || suggestName(eff, current), explain, sharedData: () => sharedData({ projectId, datasetId, encoding: eff, filters }) }}
                />
              )}
            </div>
          </div>
          {reply?.sample?.note && (
            <p className={s.sample} role="status" title={reply.sample.by ? `Stratified by ${reply.sample.by}. Saving the visual and every dashboard use all rows.` : reply.sample.note}>
              {reply.sample.note}
            </p>
          )}
          <div className={loading ? `${s.area} ${s.loading}` : s.area} data-chart-type={current || undefined}>
            {!complete ? (
              <StageNote>Pick a category and at least one measure to draw a chart.</StageNote>
            ) : preview.isError && !reply ? (
              <ErrorState compact heading={3} title="Could not compute the visual" message={preview.error.message} onRetry={() => void preview.refetch()} />
            ) : !reply ? (
              <SkeletonBlock label="Computing the visual" />
            ) : recommended.length === 0 ? (
              <StageNote>Pick a category and at least one measure to draw a chart.</StageNote>
            ) : (
              <ChartStage
                projectId={projectId}
                type={current}
                reply={reply}
                overrides={overrides}
                canRender={chartCanRender(current, data, hasGeo)}
                needs={needsText(current, data, hasGeo)}
                label={initial.name || suggestName(eff, current)}
                onChart={setChart}
              />
            )}
          </div>
        </section>
      </div>

      {naming && (
        <NameDialog
          name={initial.name || suggestName(eff, current)}
          title={visualId ? 'Rename this visual' : 'Name this visual'}
          action="Save"
          onClose={() => setNaming(false)}
          onRename={save}
        />
      )}
      {suggesting && (
        <NewVisualDialog
          projectId={projectId}
          datasetId={datasetId}
          startAtSuggest
          onClose={() => setSuggesting(false)}
          onChoose={(c) => {
            setSuggesting(false);
            if (c.kind !== 'suggested') return;
            setEnc(fitEncoding(c.encoding, columns, related));
            if (c.chartType) setChartType(c.chartType);
          }}
        />
      )}
    </div>
  );
}
