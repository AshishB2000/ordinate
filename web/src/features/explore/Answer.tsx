// The answer to a complete question (docs/explore/00-design.md): its title in
// words, the chart types the answer suits (the builder's eligibility, from the
// reply's own shape), how fresh it is, the server's notes, the chart, and the
// same answer as a table. Every figure is the server's reply drawn as it came
// (../visuals/ChartStage, charts/DataTable) — nothing is summed, rounded or
// sorted here. The states are the kit's, <LiveRefusal> included.

import { useMemo, useState } from 'react';
import { DataTable } from '../../charts/DataTable';
import { withGeoChartType } from '../../charts/maps/mapKinds';
import type { MapGeo } from '../../charts/maps/types';
import type { ChartDataShape } from '../../charts/types';
import { AsOfCaption } from '../../ui/AsOf';
import { Button } from '../../ui/Button';
import { SkeletonBlock, SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { LiveRefusal } from '../live/LiveOff';
import { LIVE_OFF_CHARTS } from '../live/offFeatures';
import { liveRefusalOf } from '../live/refusal';
import { ChartPicker } from '../visuals/ChartPicker';
import { ChartStage } from '../visuals/ChartStage';
import { chartCanRender, countNumericSeries, eligibleChartTypes, GRID_TYPES, needsText, PICKER_POOL } from '../visuals/eligibility';
import { liveFilters } from '../visuals/filters/filterText';
import { useColorMap } from '../visuals/format/colorMap';
import { AnswerActions } from './AnswerActions';
import { useAnswer, type Ask } from './api';
import { questionTitle, type Question } from './spec';
import s from './Explore.module.css';

const REGION_MAPS = new Set(['map_choropleth', 'map_bubble']);
/** Pivot, cohort and funnel are their own shelves, not a chart of a question: the builder is their door. */
const POOL = PICKER_POOL.filter((t) => !GRID_TYPES.has(t));
const LIVE_POOL = POOL.filter((t) => !LIVE_OFF_CHARTS.has(t));

type Data = ChartDataShape & { geo?: MapGeo | null };

export function Answer({ projectId, datasetId, datasetName, live, isDate, canEdit, question, onChange }: {
  projectId: string;
  datasetId: string;
  datasetName: string;
  live: boolean;
  /** The group-by is a date (the server's declared type, from explore:suggest). */
  isDate: boolean;
  canEdit: boolean;
  question: Question;
  onChange: (next: Question) => void;
}) {
  const e = question.encoding;
  const ask: Ask = useMemo(() => ({ projectId, datasetId, encoding: e, filters: liveFilters(question.filters) }), [projectId, datasetId, e, question.filters]);
  const answer = useAnswer(ask);
  const colors = useColorMap(projectId);
  const [extras, setExtras] = useState<string[]>([]);
  const reply = answer.data;
  const data = reply?.data as Data | undefined;
  const title = questionTitle(e);

  // Which charts suit this answer — the builder's call, from the reply's shape and structure (../visuals/eligibility).
  const hasGeo = !!data?.geo;
  const shape = data?.geo ? (isDate ? 'time_series' : 'categorical') : (reply?.recommendedShape ?? 'unstructured');
  const eligible = data ? withGeoChartType(eligibleChartTypes(shape, countNumericSeries(data), (data.labels ?? []).length), data.geo) : [];
  const suited = eligible.filter((t) => !GRID_TYPES.has(t) && !(live && LIVE_OFF_CHARTS.has(t)));
  const level = data ? reply?.geoSuggest?.level : undefined;
  const offered = level && !suited.includes('map_choropleth') ? [...suited, 'map_choropleth'] : suited;
  const current = data && question.chartType && (offered.includes(question.chartType) || chartCanRender(question.chartType, data, hasGeo)) ? question.chartType : (offered[0] ?? 'table');

  /** A region map names its regions (the level the server saw in the labels); leaving one drops them. */
  const pick = (t: string) => {
    const { geo: _g, ...rest } = e;
    const encoding = REGION_MAPS.has(t) ? (e.geo || !level ? e : { ...e, geo: { level } }) : e.geo ? rest : e;
    onChange({ ...question, chartType: t, encoding });
  };

  // The project's category colours, read only: exploring never deals new ones into the stored map.
  const map = colors.data;
  const series = e.series ?? '';
  const drawn = useMemo(() => (map ? { _colorScope: { category: e.category, series, map } } : {}), [map, e.category, series]);
  const refusal = answer.isError ? liveRefusalOf(answer.error) : null;
  const empty = !!data && (data.labels ?? []).length === 0;

  return (
    <>
      <section className={s.answer} aria-labelledby="explore-answer" data-chart-type={current}>
        <header className={s.answerHead}>
          <div className={s.answerTitles}>
            <h2 id="explore-answer" className={s.answerTitle}>
              {title}
            </h2>
            <p className={s.answerMeta}>
              <span>{datasetName}</span>
              {reply?.asOf && <AsOfCaption asOf={reply.asOf} />}
            </p>
          </div>
          <AnswerActions projectId={projectId} datasetId={datasetId} canEdit={canEdit} answered={!answer.isError} question={question} chartType={current} grain={reply?.category?.grain} title={title} />
        </header>
        {data && !empty && offered.length > 0 && (
          <div className={s.types}>
            <ChartPicker recommended={offered} pool={live ? LIVE_POOL : POOL} data={data} mappable={hasGeo || !!level} selected={current} extras={extras} onSelect={pick} onExtras={setExtras} />
          </div>
        )}
        {(reply?.warnings ?? []).length > 0 && (
          <ul className={s.notes} aria-label="Notes on this answer">
            {reply!.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <div className={answer.isFetching && data ? `${s.chart} ${s.dim}` : s.chart} aria-busy={answer.isFetching || undefined}>
          {refusal !== null ? (
            <LiveRefusal message={refusal} projectId={projectId} datasetId={datasetId} />
          ) : answer.isError ? (
            <ErrorState compact heading={3} title="This question could not be answered" message={answer.error.message} onRetry={() => void answer.refetch()} />
          ) : !reply || !data ? (
            <SkeletonBlock label="Answering the question" />
          ) : empty ? (
            <EmptyState
              compact
              heading={3}
              icon="filter"
              title="No rows match this question"
              actions={question.filters.length > 0 && <Button size="sm" onClick={() => onChange({ ...question, filters: [] })}>Clear filters</Button>}
            >
              {question.filters.length > 0 ? 'The filters leave nothing to count. Loosen or clear them.' : 'The dataset has no rows to answer it with.'}
            </EmptyState>
          ) : (
            <ChartStage
              projectId={projectId}
              type={current}
              reply={reply}
              overrides={drawn}
              canRender={chartCanRender(current, data, hasGeo)}
              needs={needsText(current, data, hasGeo)}
              label={title}
              onChart={() => undefined}
            />
          )}
        </div>
      </section>
      {current !== 'table' && !answer.isError && (
        <section className={s.table} aria-labelledby="explore-table">
          <h2 id="explore-table" className={s.tableH}>
            As a table
          </h2>
          {data && !empty ? (
            <DataTable data={data} label={`${title}, as a table`} labelHeader={e.grain ? `${e.category} (${e.grain})` : e.category} pinLabels />
          ) : !data ? (
            <SkeletonTable rows={5} cols={3} label="Loading the table" />
          ) : (
            <p className={s.tableNone}>No rows.</p>
          )}
        </section>
      )}
    </>
  );
}
