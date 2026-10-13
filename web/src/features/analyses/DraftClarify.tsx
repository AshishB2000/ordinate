// The Assistant's QUESTIONS: when a request leaves open a choice that changes
// which views get built, the model may ask instead of guessing — up to three
// questions, once (src/analysis/planClarify.ts validates them and holds the
// "once"). They are the model's words, and say so; nothing here is a figure the
// app computed. A question left unanswered is simply not sent.

import type { DraftQuestion } from './api';
import { CardRadios } from './CardRadios';
import s from './Draft.module.css';

export function DraftClarify({
  questions,
  picked,
  onPick,
}: {
  questions: DraftQuestion[];
  /** The option chosen for each question, by its index; absent while unanswered. */
  picked: Record<number, string>;
  onPick: (index: number, option: string) => void;
}) {
  return (
    <div className={s.body}>
      <div className={s.interp}>
        <span className={s.interpH}>Asked by the model · AI interpretation</span>
        <p>Your request leaves these open. Answer the ones that matter to you — anything you leave, the Assistant decides.</p>
      </div>
      {questions.map((q, i) => (
        <CardRadios key={i} as="options" label={q.ask} value={picked[i]} onChange={(option) => onPick(i, option)} options={q.options.map((o) => ({ value: o, title: o }))} />
      ))}
    </div>
  );
}
