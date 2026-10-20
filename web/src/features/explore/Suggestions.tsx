// Before a question (docs/explore/00-design.md): the server's suggested
// questions for the dataset as cards — the question in words, its chart, and a
// live thumbnail of its answer, drawn from `visual:data` like any answer (the
// cards' requests leave in one tick, so one `visual:dataBatch`). A click makes
// it the question; its answer is already cached. A Live dataset's cards keep
// their glyph: each answer there is a warehouse statement, asked when clicked.

import { useCallback, useState, type CSSProperties } from 'react';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/States';
import { accentFor, typeLabel } from '../visuals/model';
import { ChartThumb, NO_THUMB } from '../visuals/Thumb';
import { VizIcon } from '../visuals/VizIcon';
import { useAnswer, type Suggestion } from './api';
import { questionTitle } from './spec';
import s from './Explore.module.css';

/** A thumbnail's own look comes from ChartThumb; a stable object, or it redraws on every render. */
const PLAIN = {};

function Card({ projectId, datasetId, live, suggestion, onPick }: {
  projectId: string;
  datasetId: string;
  live: boolean;
  suggestion: Suggestion;
  onPick: (s: Suggestion) => void;
}) {
  const { chartType, encoding } = suggestion;
  const drawable = !live && !NO_THUMB.has(chartType);
  const answer = useAnswer(drawable ? { projectId, datasetId, encoding, filters: [] } : undefined, false);
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []);
  const data = answer.data?.data;
  return (
    <button type="button" className={s.card} onClick={() => onPick(suggestion)} data-suggestion={chartType}>
      <span className={drawn ? `${s.tile} ${s.drawn}` : s.tile} style={{ '--viz-accent': accentFor(chartType) } as CSSProperties}>
        <span className={s.glyph}>
          <VizIcon type={chartType} />
        </span>
        {drawable && answer.isPending && <Skeleton className={s.thumbSkel} />}
        {data && (data.labels ?? []).length > 0 && <ChartThumb type={chartType} data={data} overrides={PLAIN} onDrawn={onDrawn} />}
      </span>
      <span className={s.cardTitle}>{questionTitle(encoding)}</span>
      <span className={s.cardMeta}>{typeLabel(chartType)}</span>
    </button>
  );
}

export function Suggestions({ projectId, datasetId, datasetName, live, suggestions, onPick }: {
  projectId: string;
  datasetId: string;
  datasetName: string;
  live: boolean;
  suggestions: readonly Suggestion[];
  onPick: (s: Suggestion) => void;
}) {
  if (!suggestions.length) {
    return (
      <EmptyState icon="sparkles" title="No question to suggest for this dataset">
        It has nothing to group by. Pick a measure and a group-by in the question above to ask your own.
      </EmptyState>
    );
  }
  return (
    <section className={s.start} aria-labelledby="explore-start">
      <div className={s.startHead}>
        <h2 id="explore-start" className={s.startH}>
          Start with a question
        </h2>
        <p className={s.startP}>
          {live
            ? `Suggested from the fields of ${datasetName}. It is Live: each answer is asked of its warehouse when you open it.`
            : `Suggested from the fields of ${datasetName}. Open one, or build your own in the question above.`}
        </p>
      </div>
      <ul className={s.cards} aria-label="Suggested questions">
        {suggestions.map((sg) => (
          <li key={JSON.stringify(sg)}>
            <Card projectId={projectId} datasetId={datasetId} live={live} suggestion={sg} onPick={onPick} />
          </li>
        ))}
      </ul>
    </section>
  );
}
