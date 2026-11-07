// Explore's workbench on one dataset (docs/explore/00-design.md): the fields
// on the left (a bottom sheet on a phone), the question as four wells, then
// either the suggested questions or the answer and its table. The question is
// the URL's (./useExploreSpec); every edit is a new URL, so a link reproduces
// it and Back undoes it. The browser computes nothing.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import { PageHead } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Sheet } from '../../ui/Sheet';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useCanEdit } from '../projects/api';
import { navFor, useNavigation, type NavTopic } from '../model/navigation';
import { write as rememberTopic } from '../model/topics/rememberTopic';
import { dateLadder } from '../../../../src/analysis/drillLevels.ts';
import { ScopedChip } from '../data/RowAccessOff';
import { Answer } from './Answer';
import { useExploreFields, type Suggestion } from './api';
import { AskBox } from './AskBox';
import { FieldList } from './FieldList';
import { Question, roleWord } from './Question';
import { isComplete, withField } from './spec';
import { Suggestions } from './Suggestions';
import { useExploreSpec } from './useExploreSpec';
import s from './Explore.module.css';
import cards from './Start.module.css';

export function Explorer({
  projectId,
  datasets,
  dataset,
  topics = [],
  topic,
}: {
  projectId: string;
  datasets: readonly DatasetSummary[];
  dataset: DatasetSummary;
  /** The project's topics (`model:navigation`), and the one narrowing this page: it only orders and narrows lists (D15). */
  topics?: readonly NavTopic[];
  topic?: NavTopic;
}) {
  const fields = useExploreFields(projectId, dataset.id, topic?.id);
  const { question, setQuestion } = useExploreSpec();
  const [, setParams] = useSearchParams();
  const canEdit = useCanEdit(projectId);
  const nav = useNavigation(projectId); // its failure means no hierarchies; a date still drills on the default ladder
  const [sheet, setSheet] = useState(false);
  const live = dataset.mode === 'live';
  const list = fields.data?.fields ?? [];
  const e = question.encoding;
  const name = dataset.name || 'Untitled dataset';
  const kindOf = (column: string) => list.find((f) => f.name === column)?.kind;

  // Another dataset is another question: its fields differ.
  const pickDataset = (id: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('dataset', id);
      n.delete('q');
      return n;
    });
  // The topic's datasets in its order, then the open one if it is outside; everything else stays one click away ("All datasets").
  const listed = topic ? topic.datasets.flatMap((t) => datasets.filter((d) => d.id === t.id)) : datasets;
  const options = listed.some((d) => d.id === dataset.id) ? listed : [...listed, dataset];
  const topicFields = topic?.datasets.find((t) => t.id === dataset.id)?.fields;
  const pickTopic = (id: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      rememberTopic(projectId, id || null);
      if (id) n.set('topic', id);
      else n.delete('topic');
      return n;
    }, { replace: true });
  const take = (sg: Suggestion) => setQuestion({ chartType: sg.chartType, encoding: sg.encoding, filters: [] });

  const rail = (
    <>
      {topics.length > 0 && (
        <div className={s.topicBar}>
          <Select label="Topic" size="sm" value={topic?.id ?? ''} options={[{ value: '', label: 'All' }, ...topics.map((t) => ({ value: t.id, label: t.name }))]} onValueChange={pickTopic} />
          {topic && (
            <button type="button" className={s.allDatasets} onClick={() => pickTopic('')}>
              All datasets
            </button>
          )}
        </div>
      )}
      <Select label="Dataset" size="sm" value={dataset.id} options={options.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))} onValueChange={pickDataset} />
      {fields.isPending ? (
        <SkeletonRows rows={9} label="Loading the fields" />
      ) : fields.isError ? (
        <ErrorState compact heading={3} title="The fields could not be read" message={fields.error.message} onRetry={() => void fields.refetch()} />
      ) : (
        <FieldList fields={list} hierarchies={navFor(nav.data, dataset.id)} topicFields={topicFields} roleOf={roleWord(question)} onPick={(f) => setQuestion(withField(question, f, kindOf))} />
      )}
    </>
  );

  return (
    <div className={s.page}>
      <PageHead
        title="Explore"
        status={
          <>
            {live && (
              <span className={s.liveTag}>
                <Icon name="zap" size={12} />
                Live
              </span>
            )}
            {dataset.scoped && <ScopedChip columns={!!fields.data?.hidden.length} />}
          </>
        }
        sub={
          <p>
            Ask <b className={s.subName}>{name}</b> a question: pick its fields, or start from a suggestion. Every figure is computed by the app.
          </p>
        }
      />
      <AskBox projectId={projectId} topic={topic} />
      <div className={s.bench}>
        <aside className={s.rail} aria-label="Fields">
          {rail}
        </aside>
        <div className={s.main}>
          <Question projectId={projectId} datasetId={dataset.id} fields={list} question={question} onChange={setQuestion} onFields={() => setSheet(true)} />
          {isComplete(question) ? (
            <Answer
              projectId={projectId}
              datasetId={dataset.id}
              datasetName={name}
              live={live}
              isDate={list.find((f) => f.name === e.category)?.kind === 'date'}
              canEdit={canEdit}
              question={question}
              onChange={setQuestion}
              hierarchies={navFor(nav.data, dataset.id)}
              ladder={nav.data?.dateLadder ?? dateLadder(false)}
            />
          ) : (
            <>
              {(e.category || e.values.length > 0) && (
                <p className={s.prompt} role="status">
                  <Icon name="info" size={16} />
                  {e.values.length ? 'Choose what to group by, and the answer appears here.' : 'Add a measure, and the answer appears here.'}
                </p>
              )}
              {fields.data ? (
                <Suggestions projectId={projectId} datasetId={dataset.id} datasetName={name} live={live} suggestions={fields.data.suggestions} onPick={take} />
              ) : fields.isPending ? (
                <div className={cards.cards} role="status" aria-busy="true" aria-label="Loading the suggestions">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className={cards.cardSkel} />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Fields"
        description="Tap a field to put it in the question, or to take it out."
        footer={
          <DialogClose asChild>
            <Button variant="primary" block>
              Done
            </Button>
          </DialogClose>
        }
      >
        <div className={s.sheetFields}>{rail}</div>
      </Sheet>
    </div>
  );
}
