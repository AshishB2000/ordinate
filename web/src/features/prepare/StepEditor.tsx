// The step editor (legacy prepare.ts openStepEditor + buildStepForm's
// dispatch): the form for one step type, then Save step / Cancel. A form that
// is not finished says why under the buttons (the desktop's window.alert,
// inline); a step the server refuses keeps the editor open with its message.
// A calculated field never comes here — it is the formula editor's.

import { useState, type ComponentType } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import type { Step } from './api';
import { buildStep, initialDraft, type Draft } from './drafts';
import { labelOf } from './steps';
import type { FormCtx, FormProps } from './FormParts';
import { DedupeForm, DropForm, FillEmptyForm, FilterForm, GroupAggregateForm, MaskForm, RenameForm, SegmentForm, TrimForm } from './FormsBasic';
import { PivotForm, SplitForm, UnpivotForm, WindowForm } from './FormsReshape';
import { ConditionalForm, DedupeKeyForm, ParseDateForm, ReplaceForm } from './FormsClean';
import { LookupForm, UnionForm } from './FormsCombine';
import { SpatialJoinForm } from './FormGeo';
import { KeywordForm, SentimentForm, TermsForm } from './FormsText';
import s from './Prepare.module.css';

const FORMS: Record<string, ComponentType<FormProps>> = {
  filter: FilterForm,
  group_aggregate: GroupAggregateForm,
  dedupe: DedupeForm,
  fill_empty: FillEmptyForm,
  trim: TrimForm,
  drop_column: DropForm,
  rename_column: RenameForm,
  mask_hash: MaskForm,
  mask_redact: MaskForm,
  mask_generalize: MaskForm,
  split_column: SplitForm,
  unpivot: UnpivotForm,
  pivot: PivotForm,
  window: WindowForm,
  parse_date: ParseDateForm,
  dedupe_key: DedupeKeyForm,
  replace_values: ReplaceForm,
  conditional_column: ConditionalForm,
  lookup_join: LookupForm,
  union: UnionForm,
  spatial_join: SpatialJoinForm,
  text_terms: TermsForm,
  text_sentiment: SentimentForm,
  keyword_rules: KeywordForm,
  segment: SegmentForm,
};

export function StepEditor({
  type,
  index,
  existing,
  prefill,
  ctx,
  onSave,
  onCancel,
}: {
  type: string;
  /** -1 adds a step; otherwise the index being edited. */
  index: number;
  existing: Step | null;
  prefill?: Draft;
  ctx: FormCtx;
  /** Resolves to an error message, or null when the step landed. */
  onSave: (steps: Step[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(type, existing, ctx.columns, prefill));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const Form = FORMS[type];
  const set = (patch: Draft) => {
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  async function save() {
    const built = buildStep(type, draft, ctx.columns);
    if ('error' in built) {
      setProblem(built.error);
      return;
    }
    setSaving(true);
    const err = await onSave(built.steps);
    setSaving(false);
    if (err) setProblem(err);
  }

  return (
    <section className={s.editor} aria-labelledby="step-editor-title">
      <h3 className={s.editorTitle} id="step-editor-title">
        {index >= 0 ? 'Edit: ' : 'Add: '}
        {labelOf(type)}
      </h3>
      <div
        className={s.editorBody}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        }}
      >
        {Form ? <Form draft={draft} set={set} ctx={{ ...ctx, index }} /> : <p className={s.hint}>This step cannot be edited here.</p>}
      </div>
      {problem && (
        <p className={s.problem} role="alert">
          <Icon name="alert" size={12} />
          {problem}
        </p>
      )}
      <div className={s.editorActions}>
        <Button variant="primary" size="sm" loading={saving} onClick={() => void save()} disabled={!Form}>
          {saving ? 'Saving…' : 'Save step'}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
