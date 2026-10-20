// Explore's workbench on one dataset (docs/explore/00-design.md): the fields
// on the left (a bottom sheet on a phone), the question as four wells, then
// either the suggested questions or the answer and its table. The question is
// the URL's (./useExploreSpec); every edit is a new URL, so a link reproduces
// it and Back undoes it. The browser computes nothing.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Sheet } from '../../ui/Sheet';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useCanEdit } from '../projects/api';
import { Answer } from './Answer';
import { useExploreFields, type Suggestion } from './api';
import { AskBox } from './AskBox';
import { FieldList } from './FieldList';
import { Question, roleWord } from './Question';
import { isComplete, withField } from './spec';
import { Suggestions } from './Suggestions';
import { useExploreSpec } from './useExploreSpec';
import s from './Explore.module.css';

export function Explorer({ projectId, datasets, dataset }: { projectId: string; datasets: readonly DatasetSummary[]; dataset: DatasetSummary }) {
  const fields = useExploreFields(projectId, dataset.id);
  const { question, setQuestion } = useExploreSpec();
  const [, setParams] = useSearchParams();
  const canEdit = useCanEdit(projectId);
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
  const take = (sg: Suggestion) => setQuestion({ chartType: sg.chartType, encoding: sg.encoding, filters: [] });

  const rail = (
    <>
      <Select label="Dataset" size="sm" value={dataset.id} options={datasets.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))} onValueChange={pickDataset} />
      {fields.isPending ? (
        <SkeletonRows rows={9} label="Loading the fields" />
      ) : fields.isError ? (
        <ErrorState compact heading={3} title="The fields could not be read" message={fields.error.message} onRetry={() => void fields.refetch()} />
      ) : (
        <FieldList fields={list} roleOf={roleWord(question)} onPick={(f) => setQuestion(withField(question, f, kindOf))} />
      )}
    </>
  );

  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1 className={s.title}>Explore</h1>
        <p className={s.sub}>
          Ask <b className={s.subName}>{name}</b> a question: pick its fields, or start from a suggestion. Every figure is computed by the app.
          {live && (
            <span className={s.liveTag}>
              <Icon name="zap" size={12} />
              Live
            </span>
          )}
        </p>
      </header>
      <AskBox projectId={projectId} />
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
                <div className={s.cards} role="status" aria-busy="true" aria-label="Loading the suggestions">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className={s.cardSkel} />
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
