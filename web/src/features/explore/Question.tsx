// The question as four field wells (docs/explore/00-design.md): SHOW (the
// measures, each with its aggregate), GROUP BY (with its time grain when it is
// a date), SPLIT BY and FILTERS. Every pill opens the same field list
// (./FieldList), the aggregate or grain menu, or the builder's own filter
// dialog. An edit is a new question (./spec), which the page pushes to the URL.
// Nothing here computes a figure.

import { useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Popover } from '../../ui/Popover';
import type { Agg, FilterStep } from '../visuals/api';
import { FilterDialog } from '../visuals/filters/FilterDialog';
import { FilterSummary } from '../visuals/filters/FilterRows';
import { AGG_LABELS, GRAINS } from '../visuals/model';
import { FieldList } from './FieldList';
import { EMPTY, groupBy, roleOf, ungroup, withSplit, withValues, type Field, type FieldKind, type Question as Q } from './spec';
import s from './Question.module.css';

const AGG_OPTIONS = (['sum', 'avg', 'count', 'min', 'max'] as const).map((a) => ({ value: a, label: AGG_LABELS[a] }));
/** A pill's aggregate, short: "Raw (no aggregation)" would leave no room for the field. */
const AGG_SHORT: Record<Agg, string> = { ...AGG_LABELS, none: 'Raw' };
const GRAIN_OPTIONS = [{ value: 'auto', label: 'Auto' }, ...GRAINS];
const ROLE_WORD = { measure: 'Measure', category: 'Group by', series: 'Split by' } as const;
/** A field's declared type, as the field list draws it: an id-like number is a dimension with a number's mark. */
const TYPE_ICON: Record<Field['type'], IconName> = { text: 'type-text', number: 'type-number', date: 'type-date' };

/** "Where is this field in the question?", worded for the field list's mark. */
export const roleWord = (q: Q) => (name: string): string | null => {
  const r = roleOf(q, name);
  return r ? ROLE_WORD[r] : null;
};

/** A pill that opens the field list (one kind or more) and hands back the pick. */
function Picker({ trigger, title, kinds, fields, question, onPick }: {
  trigger: ReactElement;
  title: string;
  kinds: readonly FieldKind[];
  fields: readonly Field[];
  question: Q;
  onPick: (f: Field) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover title={title} heading open={open} onOpenChange={setOpen} trigger={trigger} className={s.picker}>
      <FieldList
        fields={fields}
        kinds={kinds}
        roleOf={roleWord(question)}
        autoFocus
        onPick={(f) => {
          setOpen(false);
          onPick(f);
        }}
      />
    </Popover>
  );
}

function Well({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.well} role="group" aria-label={label}>
      <span className={s.wellLabel}>{label}</span>
      <div className={s.wellBody}>{children}</div>
    </div>
  );
}

const Remove = ({ label, title, onClick }: { label: string; title: string; onClick: () => void }) => (
  <button type="button" className={s.pillX} aria-label={label} title={title} onClick={onClick}>
    <Icon name="x" size={12} />
  </button>
);

const Add = ({ label, text, ...rest }: { label: string; text: string }) => (
  <button type="button" className={s.addPill} aria-label={label} {...rest}>
    <Icon name="plus" size={12} />
    {text}
  </button>
);

export function Question({ projectId, datasetId, fields, question, onChange, onFields }: {
  projectId: string;
  datasetId: string;
  fields: readonly Field[];
  question: Q;
  onChange: (next: Q) => void;
  /** Opens the field list in a sheet — the phone's, where the rail is not drawn. */
  onFields: () => void;
}) {
  const [editing, setEditing] = useState<{ index: number; column: string } | null>(null);
  const e = question.encoding;
  const kindOf = (name: string): FieldKind | undefined => fields.find((f) => f.name === name)?.kind;
  const typeOf = (name: string): Field['type'] => fields.find((f) => f.name === name)?.type ?? 'text';
  const set = (encoding: Q['encoding']) => onChange({ ...question, encoding });
  const setFilters = (filters: FilterStep[]) => onChange({ ...question, filters });
  const picker = (title: string, kinds: readonly FieldKind[], trigger: ReactElement, onPick: (f: Field) => void) => (
    <Picker title={title} kinds={kinds} fields={fields} question={question} trigger={trigger} onPick={onPick} />
  );
  const empty = !e.category && !e.values.length && !question.filters.length;
  const editingType = editing ? (fields.find((f) => f.name === editing.column)?.type ?? 'text') : 'text';

  return (
    <section className={s.question} aria-labelledby="explore-q">
      <div className={s.qHead}>
        <h2 id="explore-q" className={s.qTitle}>
          Question
        </h2>
        {empty && <span className={s.qHint}>Pick a field, or a well’s +</span>}
        <div className={s.qTools}>
          <Button size="sm" icon="list" className={s.fieldsBtn} onClick={onFields}>
            Fields
          </Button>
          {!empty && (
            <Button size="sm" variant="ghost" icon="rotate-ccw" className={s.clearBtn} aria-label="Clear question" onClick={() => onChange(EMPTY)}>
              Clear question
            </Button>
          )}
        </div>
      </div>
      <div className={s.wells}>
        <Well label="Show">
          {e.values.map((m, i) => (
            <span key={`${m.column}:${i}`} className={s.pill} data-kind="measure">
              <Menu
                label={`Aggregate of ${m.column}`}
                trigger={
                  <button type="button" className={s.pillAgg} aria-label={`Aggregate of ${m.column}: ${AGG_LABELS[m.aggregation]}`}>
                    {AGG_SHORT[m.aggregation]}
                    <Icon name="chevron-down" size={12} />
                  </button>
                }
                items={[
                  {
                    kind: 'radio',
                    label: 'Aggregate',
                    value: m.aggregation,
                    options: AGG_OPTIONS,
                    onChange: (a) => onChange(withValues(question, e.values.map((v, j) => (j === i ? { column: v.column, aggregation: a as Agg } : v)))),
                  },
                ]}
              />
              {picker(
                'Choose a measure',
                ['measure'],
                <button type="button" className={s.pillMain} aria-label={`Measure: ${m.column}`}>
                  <span className={s.pillText}>{m.column}</span>
                </button>,
                (f) => onChange(withValues(question, e.values.map((v, j) => (j === i ? { column: f.name, aggregation: f.aggregation ?? 'sum' } : v)))),
              )}
              <Remove label="Remove measure" title={`Take ${m.column} out`} onClick={() => onChange(withValues(question, e.values.filter((_, j) => j !== i)))} />
            </span>
          ))}
          {picker('Add a measure', ['measure'], <Add label="Add measure" text="Measure" />, (f) =>
            onChange(withValues(question, [...e.values, { column: f.name, aggregation: f.aggregation ?? 'sum' }])),
          )}
        </Well>

        <Well label="Group by">
          {e.category ? (
            <>
              <span className={s.pill} data-kind={kindOf(e.category)}>
                {picker(
                  'Group by',
                  ['dimension', 'date'],
                  <button type="button" className={s.pillMain} aria-label={`Group by: ${e.category}`}>
                    <Icon name={TYPE_ICON[typeOf(e.category)]} size={16} />
                    <span className={s.pillText}>{e.category}</span>
                  </button>,
                  (f) => onChange(groupBy(question, f, kindOf)),
                )}
                <Remove label="Remove group by" title={`Stop grouping by ${e.category}`} onClick={() => onChange(ungroup(question))} />
              </span>
              {kindOf(e.category) === 'date' && (
                <Menu
                  label="Time grain"
                  trigger={
                    <button type="button" className={`${s.pill} ${s.pillMain} ${s.grain}`} aria-label={`Time grain: ${GRAIN_OPTIONS.find((g) => g.value === (e.grain ?? 'auto'))?.label ?? 'Auto'}`}>
                      <Icon name="calendar" size={16} />
                      <span className={s.pillText}>{GRAIN_OPTIONS.find((g) => g.value === (e.grain ?? 'auto'))?.label ?? 'Auto'}</span>
                      <Icon name="chevron-down" size={12} />
                    </button>
                  }
                  items={[
                    {
                      kind: 'radio',
                      label: 'Time grain',
                      value: e.grain ?? 'auto',
                      options: GRAIN_OPTIONS,
                      onChange: (g) => {
                        const { grain: _old, ...rest } = e;
                        set(g === 'auto' ? rest : { ...rest, grain: g });
                      },
                    },
                  ]}
                />
              )}
            </>
          ) : (
            picker('Group by', ['dimension', 'date'], <Add label="Choose a group-by" text="Group by" />, (f) => onChange(groupBy(question, f, kindOf)))
          )}
        </Well>

        <Well label="Split by">
          {e.series ? (
            <span className={s.pill} data-kind={kindOf(e.series)}>
              {picker(
                'Split by',
                ['dimension', 'date'],
                <button type="button" className={s.pillMain} aria-label={`Split by: ${e.series}`}>
                  <Icon name={TYPE_ICON[typeOf(e.series)]} size={16} />
                  <span className={s.pillText}>{e.series}</span>
                </button>,
                (f) => onChange(withSplit(question, f.name)),
              )}
              <Remove label="Remove split" title={`Stop splitting by ${e.series}`} onClick={() => onChange(withSplit(question))} />
            </span>
          ) : (
            picker('Split by', ['dimension', 'date'], <Add label="Choose a split" text="Split by" />, (f) => (f.name === e.category ? undefined : onChange(withSplit(question, f.name))))
          )}
        </Well>

        <Well label="Filters">
          {question.filters.map((f, i) => (
            <span key={`${f.column}:${i}`} className={s.pill} data-kind="filter">
              <button type="button" className={s.pillMain} aria-label={`Change the filter on ${f.column}`} onClick={() => setEditing({ index: i, column: f.column })}>
                <Icon name="filter" size={16} />
                <span className={s.pillText}>
                  <b className={s.filterCol}>{f.column}</b> <FilterSummary step={f} />
                </span>
              </button>
              <Remove label="Remove filter" title={`Stop filtering on ${f.column}`} onClick={() => setFilters(question.filters.filter((_, j) => j !== i))} />
            </span>
          ))}
          {picker('Filter on', ['dimension', 'date', 'measure'], <Add label="Add filter" text="Filter" />, (f) => setEditing({ index: question.filters.length, column: f.name }))}
        </Well>
      </div>
      {editing && (
        <FilterDialog
          projectId={projectId}
          datasetId={datasetId}
          column={editing.column}
          type={editingType}
          existing={question.filters[editing.index]}
          onClose={() => setEditing(null)}
          // A min/max range is TWO steps: spliced in where the one being edited was.
          onApply={(steps) => {
            setFilters([...question.filters.slice(0, editing.index), ...steps, ...question.filters.slice(editing.index + 1)]);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
