// The TEXT family of Prepare steps — count terms, sentiment score, tag with
// keyword rules (legacy textSteps.ts). Every figure a preview shows is the
// server's (text:preview); saving goes through text:commitStep, which on a big
// table runs the text work as a job first. "Profile this column" opens the
// column's Text profile (TextProfile.tsx), whose buttons prefill these forms.

import type { ReactNode } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { previewText } from './api';
import { buildStep } from './drafts';
import { arr, Hint, NameSelect, PickSelect, PreviewBox, str, TextField, usePreview, type FormCtx, type FormProps } from './FormParts';
import { CategoryPreview, SentimentPreview, TermsPreview } from './TextPreviews';
import s from './Prepare.module.css';

export const TX_LANGS: readonly (readonly [string, string])[] = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
];
const TX_RANGES: readonly (readonly [string, string])[] = [
  ['1-1', 'Single words'],
  ['1-2', 'Words and pairs'],
  ['2-2', 'Pairs only'],
  ['1-3', 'Words, pairs and triples'],
  ['2-3', 'Pairs and triples'],
  ['3-3', 'Triples only'],
];
const TX_MATCHES: readonly (readonly [string, string])[] = [
  ['contains', 'contains'],
  ['word', 'has the word'],
  ['regex', 'matches (regex)'],
];

const textColumns = (ctx: FormCtx): string[] => ctx.columns.filter((c) => c.type === 'text').map((c) => c.name);

function useTextPreview(type: string, draft: FormProps['draft'], ctx: FormCtx) {
  const built = buildStep(type, draft, ctx.columns);
  const step = 'steps' in built ? built.steps[0] : null;
  return usePreview(step ? JSON.stringify(step) : null, () => previewText(ctx.projectId, ctx.datasetId, ctx.index, step!));
}

/** The column picker every text form opens with, and the way to its profile. */
function TextColumn({ draft, set, ctx }: FormProps) {
  const cols = textColumns(ctx);
  return (
    <div className={s.withAction}>
      <NameSelect label="Text column" value={str(draft.column)} names={cols} onChange={(column) => set({ column })} />
      {ctx.openProfile && str(draft.column) && (
        <Button size="sm" variant="ghost" icon="chart-bar" onClick={() => ctx.openProfile?.(str(draft.column))}>
          Profile this column
        </Button>
      )}
    </div>
  );
}

function Preview({ p, empty, children }: { p: ReturnType<typeof useTextPreview>; empty: string | null; children: (r: NonNullable<typeof p.data>) => ReactNode }) {
  if (empty) return <PreviewBox warn>{empty}</PreviewBox>;
  const r = p.data;
  return (
    <PreviewBox busy={p.busy} warn={!!r && !r.ok}>
      {r && r.ok ? children(r) : <div>{p.error ?? (r && !r.ok ? r.error : 'Counting…')}</div>}
    </PreviewBox>
  );
}

export function TermsForm({ draft, set, ctx }: FormProps) {
  const p = useTextPreview('text_terms', draft, ctx);
  return (
    <>
      <TextColumn draft={draft} set={set} ctx={ctx} />
      <PickSelect label="Language (stop words)" value={str(draft.lang) || 'en'} options={TX_LANGS} onChange={(lang) => set({ lang })} />
      <PickSelect label="Terms" value={str(draft.range) || '1-1'} options={TX_RANGES} onChange={(range) => set({ range })} />
      <NameSelect label="Group by (optional)" value={str(draft.by)} names={ctx.columns.map((c) => c.name)} blank="(none — across all rows)" onChange={(by) => set({ by })} />
      {str(draft.by) && (
        <PickSelect
          label="Rank terms by"
          value={str(draft.rank) || 'tfidf'}
          options={[
            ['tfidf', 'Most distinctive of each group (TF-IDF)'],
            ['count', 'Most frequent in each group'],
          ]}
          onChange={(rank) => set({ rank })}
        />
      )}
      <TextField label="Terms kept (per group)" type="number" min={1} max={1000} value={draft.top} onChange={(top) => set({ top })} />
      <Checkbox label="Keep numbers as terms" checked={!!draft.keepNumbers} onCheckedChange={(keepNumbers) => set({ keepNumbers })} />
      <Checkbox label="Add each term’s average sentiment" checked={!!draft.sentiment} onCheckedChange={(sentiment) => set({ sentiment })} />
      <Hint>
        The table becomes one row per term — term, words, count (and tfidf per group). Stop words are removed; contractions stay whole (“don’t”).
        TF-IDF treats each group as one document: a term every group uses scores 0.
      </Hint>
      <Preview p={p} empty={textColumns(ctx).length ? null : 'This dataset has no text column to count.'}>
        {(r) => <TermsPreview res={r} />}
      </Preview>
    </>
  );
}

export function SentimentForm({ draft, set, ctx }: FormProps) {
  const p = useTextPreview('text_sentiment', draft, ctx);
  return (
    <>
      <TextColumn draft={draft} set={set} ctx={ctx} />
      <TextField label="New column name" value={draft.as} placeholder={`${str(draft.column) || 'text'}_sentiment`} onChange={(as) => set({ as })} />
      <Hint>
        VADER sentiment (an English lexicon, MIT): a score from −1 (negative) to +1 (positive) per row, with 0 for text that carries none. Empty text
        stays empty. The lexicon version is recorded on the step.
      </Hint>
      <Preview p={p} empty={textColumns(ctx).length ? null : 'This dataset has no text column to score.'}>
        {(r) => <SentimentPreview res={r} />}
      </Preview>
    </>
  );
}

type Rule = { pattern?: string; match?: string; category?: string; caseSensitive?: boolean };

export function KeywordForm({ draft, set, ctx }: FormProps) {
  const rules = arr<Rule>(draft.rules);
  const put = (i: number, patch: Rule) => set({ rules: rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const terms = arr<string>(draft.terms);
  const p = useTextPreview('keyword_rules', draft, ctx);
  const hasRule = rules.some((r) => str(r.pattern).trim());
  return (
    <>
      <TextColumn draft={draft} set={set} ctx={ctx} />
      <TextField label="New column name" value={draft.as} placeholder={`${str(draft.column) || 'text'}_category`} onChange={(as) => set({ as })} />
      {terms.length > 0 && (
        <div className={s.chips}>
          <span className={s.muted}>Common words:</span>
          {terms.map((t) => (
            <button
              key={t}
              type="button"
              className={s.chipBtn}
              aria-label={`Add a rule for “${t}”`}
              onClick={() =>
                set({ rules: [...rules.filter((r) => str(r.pattern).trim()), { pattern: t, match: 'word', category: t.charAt(0).toUpperCase() + t.slice(1) }] })
              }
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <ol className={s.ruleCards}>
        {rules.map((r, i) => (
          <li key={i} className={s.ruleCard}>
            <div className={s.ruleRow}>
              <span className={s.arrow}>If text</span>
              <PickSelect ariaLabel="Match" value={str(r.match) || 'word'} options={TX_MATCHES} onChange={(match) => put(i, { match })} />
              <TextField label="Pattern" value={r.pattern} placeholder="refund" onChange={(pattern) => put(i, { pattern })} />
              <Checkbox label="Aa" title="Match upper and lower case exactly" aria-label="Match case" checked={!!r.caseSensitive} onCheckedChange={(caseSensitive) => put(i, { caseSensitive })} />
            </div>
            <div className={s.ruleRow}>
              <span className={s.arrow}>→</span>
              <TextField label="Category" value={r.category} placeholder="Billing" onChange={(category) => put(i, { category })} />
              <IconButton
                icon="arrow-up"
                size="sm"
                label="Move rule up — earlier rules win"
                disabled={i === 0}
                onClick={() => set({ rules: rules.map((x, k) => (k === i - 1 ? rules[i] : k === i ? rules[i - 1] : x)) })}
              />
              <IconButton icon="x" size="sm" label="Remove rule" onClick={() => set({ rules: rules.filter((_, k) => k !== i) })} />
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" icon="plus" onClick={() => set({ rules: [...rules, { pattern: '', match: 'word', category: '' }] })}>
          Add rule
        </Button>
      </div>
      <TextField label="Otherwise" value={draft.otherwise} placeholder="(leave empty)" onChange={(otherwise) => set({ otherwise })} />
      <Hint>The FIRST rule that matches decides the category, so order matters — move a rule up to give it priority. Matching ignores case unless the box is ticked.</Hint>
      {hasRule || !textColumns(ctx).length ? (
        <Preview p={p} empty={textColumns(ctx).length ? null : 'This dataset has no text column to tag.'}>
          {(r) => <CategoryPreview res={r} />}
        </Preview>
      ) : (
        <PreviewBox>Add a rule to see how many rows each category gets.</PreviewBox>
      )}
    </>
  );
}
