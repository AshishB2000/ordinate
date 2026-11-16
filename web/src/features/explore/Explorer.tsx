// Explore's workbench on one dataset (docs/explore/00-design.md): the fields
// on the left (a bottom sheet on a phone), the question as four wells, then
// either the suggested questions or the answer and its table. The question is
// the URL's (./useExploreSpec); every edit is a new URL, so a link reproduces
// it and Back undoes it. The browser computes nothing.
//
// On a source table (an editor's, Assistant phase D) every call names it (`table`), the header offers Keep as a
// dataset, which makes its Live dataset and opens it with the same question; a table on a connection not asked live
// asks nothing and says it must be copied in first.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import { PageHead } from '../../app/blocks';
import { Button, buttonClass } from '../../ui/Button';
import { DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Sheet } from '../../ui/Sheet';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useCanEdit } from '../projects/api';
import { navFor, useNavigation, type NavTopic } from '../model/navigation';
import { endAtHidden } from '../visuals/drill/drillApi';
import { write as rememberTopic } from '../model/topics/rememberTopic';
import { dateLadder } from '../../../../src/analysis/drillLevels.ts';
import { ScopedChip } from '../data/RowAccessOff';
import { Answer } from './Answer';
import { useExploreFields, useKeepTable, type ExploreTable, type Suggestion } from './api';
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
  tables = [],
  table,
  topics = [],
  topic,
}: {
  projectId: string;
  datasets: readonly DatasetSummary[];
  /** The dataset on screen — or, with `table`, that table as one (its doc's id, its name, Live when it is asked live). */
  dataset: Pick<DatasetSummary, 'id' | 'name' | 'mode' | 'scoped'>;
  /** The editor's source tables, offered after the datasets; `table` is the one on screen. */
  tables?: readonly ExploreTable[];
  table?: ExploreTable;
  /** The project's topics (`model:navigation`), and the one narrowing this page: it only orders and narrows lists (D15). */
  topics?: readonly NavTopic[];
  topic?: NavTopic;
}) {
  const copyFirst = !!table && !table.live; // nothing to ask: its rows must be copied in first
  const fields = useExploreFields(projectId, dataset.id, topic?.id, table?.connId, !copyFirst);
  const { question, setQuestion } = useExploreSpec();
  const [, setParams] = useSearchParams();
  const canEdit = useCanEdit(projectId);
  const nav = useNavigation(projectId); // its failure means no hierarchies; a date still drills on the default ladder
  const [sheet, setSheet] = useState(false);
  const live = dataset.mode === 'live';
  const list = fields.data?.fields ?? [];
  const hierarchies = endAtHidden(navFor(nav.data, dataset.id), fields.data?.hidden);
  const e = question.encoding;
  const name = dataset.name || 'Untitled dataset';
  const kindOf = (column: string) => list.find((f) => f.name === column)?.kind;

  // Another dataset is another question: its fields differ. A table's option is `<connection>:<doc>`.
  const pickDataset = (value: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      const [conn, doc] = value.includes(':') ? value.split(':') : [null, value];
      n.set('dataset', doc);
      if (conn) n.set('table', conn);
      else n.delete('table');
      n.delete('q');
      return n;
    });
  const tableValue = (t: ExploreTable) => `${t.connId}:${t.docId}`;
  // Keep as a dataset: the table's Live dataset, opened in its place with the same question (its fields are the table's).
  const client = useQueryClient();
  const keep = useKeepTable(projectId);
  const keepTable = (t: ExploreTable) =>
    keep.mutate(t, {
      onSuccess: ({ datasetId }) =>
        void (async () => {
          await client.refetchQueries({ queryKey: ['dataset:list', projectId] }); // the page finds it in the list it opens from
          void client.invalidateQueries({ queryKey: ['sourceTable:list', projectId] });
          toast(`Kept “${t.table}” as a Live dataset.`, { kind: 'success' });
          setParams((p) => {
            const n = new URLSearchParams(p);
            n.set('dataset', datasetId);
            n.delete('table');
            return n;
          });
        })(),
      onError: (err) => toast(err.message, { kind: 'error' }),
    });
  // The topic's datasets in its order, then the open one if it is outside; everything else stays one click away ("All datasets").
  const listed = topic ? topic.datasets.flatMap((t) => datasets.filter((d) => d.id === t.id)) : datasets;
  const options = [
    ...(table || listed.some((d) => d.id === dataset.id) ? listed : [...listed, dataset]).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' })),
    ...tables.map((t) => ({ value: tableValue(t), label: t.table, hint: !t.live ? 'Copy first' : t.connection ? `Table on ${t.connection}` : 'Warehouse table' })),
  ];
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
      <Select label="Dataset" size="sm" value={table ? tableValue(table) : dataset.id} options={options} onValueChange={pickDataset} />
      {copyFirst ? null : fields.isPending ? (
        <SkeletonRows rows={9} label="Loading the fields" />
      ) : fields.isError ? (
        <ErrorState compact heading={3} title="The fields could not be read" message={fields.error.message} onRetry={() => void fields.refetch()} />
      ) : (
        <FieldList fields={list} hierarchies={hierarchies} topicFields={topicFields} roleOf={roleWord(question)} onPick={(f) => setQuestion(withField(question, f, kindOf))} />
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
            {table && (
              <span className={s.liveTag} data-source-table="">
                <Icon name="table" size={12} />
                Warehouse table, not a dataset
              </span>
            )}
            {dataset.scoped && <ScopedChip columns={!!fields.data?.hidden.length} />}
          </>
        }
        actions={
          canEdit && table?.live && ( // keeping makes a dataset: an editor's
            <Button variant="primary" icon="plus" loading={keep.isPending} onClick={() => keepTable(table)}>
              Keep as a dataset
            </Button>
          )
        }
        sub={
          copyFirst ? (
            <p>
              <b className={s.subName}>{name}</b> is {table.connection ? `a table on ${table.connection}` : 'a warehouse table'}.
            </p>
          ) : (
            <p>
              Ask <b className={s.subName}>{name}</b> a question: pick its fields, or start from a suggestion. Every figure is computed by the app.
            </p>
          )
        }
      />
      <AskBox projectId={projectId} topic={topic} />
      <div className={s.bench}>
        <aside className={s.rail} aria-label="Fields">
          {rail}
        </aside>
        <div className={s.main}>
          {copyFirst ? (
            <EmptyState
              icon="database"
              title={`Copy ${table.table} into Ordinate first`}
              actions={
                table.connection !== undefined && (
                  <Link className={buttonClass('primary')} to={`/connections/${projectId}/${table.connId}`}>
                    <Icon name="plug" />
                    <span>Open {table.connection}</span>
                  </Link>
                )
              }
            >
              {table.connection !== undefined
                ? `It is on ${table.connection}, a connection Ordinate does not ask live, so its rows have to be copied in before Explore can answer from it.`
                : 'It is on a connection Ordinate does not ask live, so an editor has to copy its rows in before Explore can answer from it.'}
            </EmptyState>
          ) : (
            <>
              <Question projectId={projectId} datasetId={dataset.id} table={table?.connId} fields={list} question={question} onChange={setQuestion} onFields={() => setSheet(true)} />
              {isComplete(question) ? (
                <Answer
                  projectId={projectId}
                  datasetId={dataset.id}
                  table={table?.connId}
                  datasetName={name}
                  live={live}
                  isDate={list.find((f) => f.name === e.category)?.kind === 'date'}
                  canEdit={canEdit && !table} // a table's answer is kept as a dataset first (the header), then saved
                  question={question}
                  onChange={setQuestion}
                  hierarchies={hierarchies}
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
                    <Suggestions projectId={projectId} datasetId={dataset.id} table={table?.connId} datasetName={name} live={live} suggestions={fields.data.suggestions} onPick={take} />
                  ) : fields.isPending ? (
                    <div className={cards.cards} role="status" aria-busy="true" aria-label="Loading the suggestions">
                      {Array.from({ length: 6 }, (_, i) => (
                        <Skeleton key={i} className={cards.cardSkel} />
                      ))}
                    </div>
                  ) : null}
                </>
              )}
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
